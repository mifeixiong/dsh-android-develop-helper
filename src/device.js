/**
 * The `Device` facade — one object that owns a resolved serial and exposes the
 * whole capability surface with sane defaults.
 *
 * Two behaviours are deliberate and worth stating up front:
 *
 *  - **UI dumps are cached.**  `uiautomator` costs ~2 s per invocation on MuMu
 *    and the cost is the instrumentation start, not the tree size.  Reusing a
 *    dump for a short TTL turns five lookups into one dump.  Anything that
 *    changes the screen invalidates the cache automatically.
 *
 *  - **Compound operations return evidence.**  `tapAndWait` performs the tap,
 *    waits for the framebuffer to settle, and returns *both* the resulting UI
 *    tree and a screenshot path in a single round trip.  The previous generation
 *    of this toolchain spent most of its wall-clock time in
 *    "dump → look → dump again"; collapsing that is the single biggest latency
 *    win available without an on-device agent.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Adb, AdbError } from './adb.js'
import { Session } from './artifacts.js'
import { resolveDevice } from './devices.js'
import * as screen from './screen.js'
import * as input from './input.js'
import * as app from './app.js'
import * as logcat from './logcat.js'
import { UiSnapshot, rowsToText, clickableTarget, shortId } from './uitree.js'

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Pull the `<hierarchy …>…</hierarchy>` document out of noisy stdout. */
export function extractHierarchy(text) {
  const start = text.indexOf('<hierarchy')
  if (start < 0) return null
  const end = text.lastIndexOf('</hierarchy>')
  if (end < 0) return null
  return text.slice(start, end + '</hierarchy>'.length)
}

export class Device {
  constructor(cfg, { adb, session, serial, fingerprint = null, warnings = [] } = {}) {
    this.cfg = cfg
    this.adb = adb
    this.session = session
    this.serial = serial
    this.fingerprint = fingerprint
    this.warnings = warnings
    this._ui = null
    this._uiAt = 0
    this._screenSize = null
    this._identity = null
  }

  /**
   * Resolve a device and return a ready facade.
   * @param {object} cfg
   * @param {{label?:string, session?:Session, device?:string, probe?:boolean}} [options]
   */
  static async connect(cfg, options = {}) {
    const session =
      options.session ??
      new Session(options.label ?? 'connect', {
        artifactsDir: cfg.artifactsDir,
        keepLog: cfg.keepLog,
        echoCommands: cfg.echoCommands,
      })
    const adb = options.adb ?? new Adb({ bin: cfg.adb, timeoutMs: cfg.timeoutMs, session })
    const resolved = await resolveDevice(adb, cfg, {
      device: options.device,
      probe: options.probe,
    })
    return new Device(cfg, {
      adb,
      session,
      serial: resolved.serial,
      fingerprint: resolved.fingerprint,
      warnings: [...(resolved.warnings ?? [])],
    })
  }

  get artifactsDir() {
    return this.session?.dir ?? this.cfg.artifactsDir
  }

  /** Invalidate the cached UI tree — call after anything that changes pixels. */
  invalidate() {
    this._ui = null
    this._uiAt = 0
  }

  // ── transport passthrough ─────────────────────────────────────────────────

  shell(command, options) {
    return this.adb.shell(command, options)
  }

  shellLoose(command, options) {
    return this.adb.shellLoose(command, options)
  }

  run(args, options) {
    return this.adb.run(args, options)
  }

  // ── identity ──────────────────────────────────────────────────────────────

  /** Device facts, gathered in one adb round trip. */
  async identity({ refresh = false } = {}) {
    if (this._identity && !refresh) return this._identity
    const command = [
      'getprop ro.product.model',
      'getprop ro.product.brand',
      'getprop ro.build.version.release',
      'getprop ro.build.version.sdk',
      'getprop ro.build.fingerprint',
      'getprop sys.boot_completed',
      'settings get secure android_id',
      'wm size',
      'wm density',
      'dumpsys input | grep -m1 SurfaceOrientation',
    ].join(' ; ')
    const { text } = await this.adb.shellLoose(command, { timeoutMs: 25000 })
    const lines = text.split('\n').map((l) => l.trim())
    const size = parseWmSize(text)
    const rotation = parseRotation(text)
    const oriented = orientScreen(size, rotation)
    const identity = {
      serial: this.serial,
      model: lines[0] || null,
      brand: lines[1] || null,
      release: lines[2] || null,
      sdk: Number.parseInt(lines[3], 10) || null,
      fingerprint: lines[4] || null,
      bootCompleted: lines[5] === '1',
      androidId: lines[6] || null,
      screen: oriented,
      physicalScreen: size,
      density: parseDensity(text),
      rotation: oriented?.rotation ?? rotation,
    }
    this._identity = identity
    this._screenSize = oriented
    return identity
  }

  /**
   * Current display size in device pixels.
   *
   * `wm size` always reports the *natural* orientation of the panel, so on a
   * rotated screen it is wrong in both dimensions.  Everything that clamps a
   * gesture to the screen — scroll, swipe — must use the oriented size, and the
   * framebuffer from `screencap` confirms it.
   */
  async screenSize() {
    if (this._screenSize) return this._screenSize
    const identity = await this.identity()
    return identity.screen ?? { width: 720, height: 1280 }
  }

  /**
   * Pin the display to a rotation (0/90/180/270 as 0/1/2/3).
   *
   * The accelerometer is disabled first — otherwise the emulator overrides the
   * request on its next sensor tick. Geometry-dependent work (gesture clamping,
   * "is the row on screen" assertions) should pin the rotation rather than
   * inherit whatever the emulator was left in.
   */
  async setRotation(value) {
    const target = ((Math.round(Number(value)) % 4) + 4) % 4
    await this.adb.shellLoose('settings put system accelerometer_rotation 0', { timeoutMs: 10000 })
    await this.adb.shellLoose(`settings put system user_rotation ${target}`, { timeoutMs: 10000 })
    await sleep(900)
    this._identity = null
    this._screenSize = null
    this.invalidate()
    return target
  }

  /** `adb devices -l` row for this serial, if present. */
  async transport() {
    const devices = await this.adb.devices()
    return devices.find((d) => d.serial === this.serial) ?? null
  }

  // ── screen ────────────────────────────────────────────────────────────────

  /** Raw framebuffer bytes. */
  async rawScreen() {
    const result = await this.adb.run(['exec-out', 'screencap'], { timeoutMs: 30000 })
    if (result.code !== 0 || result.stdout.length === 0) {
      throw new AdbError(`screencap 失败 (exit ${result.code})`, {
        stderr: result.stderr.toString('utf8'),
      })
    }
    return result.stdout
  }

  /**
   * Capture a screenshot.
   * @param {{scale?:number, region?:object, filter?:string, save?:boolean, label?:string}} [options]
   */
  async screenshot(options = {}) {
    const { scale = 1, region = null, filter = 'box', save = true, label = 'shot' } = options
    const raw = await this.rawScreen()
    const rendered = screen.renderScreenshot(raw, { scale, region, filter, colorType: 2 })
    const result = {
      width: rendered.raw.width,
      height: rendered.raw.height,
      sourceWidth: rendered.sourceWidth,
      sourceHeight: rendered.sourceHeight,
      scale,
      hash: rendered.hash,
      bytes: rendered.png.length,
      rawBytes: raw.length,
      compressionRatio: raw.length / rendered.png.length,
      path: null,
    }
    if (save && this.session) {
      result.path = this.session.writeArtifact(`${label}.png`, rendered.png)
    }
    result.png = rendered.png
    return result
  }

  /** Cheap perceptual hash of the current frame. */
  async screenHash() {
    const raw = await this.rawScreen()
    const image = screen.decodeRawScreencap(raw)
    return screen.averageHash(image)
  }

  /** Wait until the picture stops changing. */
  async waitIdle(options = {}) {
    const {
      timeoutMs = 8000,
      intervalMs = 220,
      stableFrames = 3,
      threshold = 0.98,
      allowNever = false,
    } = options
    const deadline = Date.now() + timeoutMs
    let previous = null
    let stable = 0
    let frames = 0
    while (Date.now() < deadline) {
      const hash = await this.screenHash()
      frames++
      if (previous && screen.similarity(hash, previous) >= threshold) stable++
      else stable = 0
      previous = hash
      if (stable >= stableFrames - 1) return { idle: true, frames, hash }
      await sleep(intervalMs)
    }
    if (allowNever) return { idle: false, frames, hash: previous }
    return { idle: false, frames, hash: previous, timedOut: true }
  }

  // ── UI tree ───────────────────────────────────────────────────────────────

  /**
   * Read the UI hierarchy (cached).
   *
   * Tries the single-round-trip `/dev/tty` form first and falls back to the
   * file-based form when the output is truncated.  `uiautomator` segfaults after
   * writing on many emulator images, so the exit code is deliberately ignored
   * and completeness is judged from the payload.
   */
  async ui({ refresh = false, compressed = true, ttlMs = null, strategy = 'auto' } = {}) {
    const ttl = ttlMs ?? this.cfg.dumpCacheTtlMs
    if (!refresh && this._ui && Date.now() - this._uiAt <= ttl) {
      return this._ui
    }
    const flag = compressed ? '--compressed' : ''
    let xml = null
    let source = null

    if (strategy === 'auto' || strategy === 'tty') {
      const result = await this.adb.run(
        ['exec-out', 'uiautomator', 'dump', ...(flag ? [flag] : []), '/dev/tty'],
        { timeoutMs: this.cfg.dumpTimeoutMs },
      )
      xml = extractHierarchy(result.stdout.toString('utf8'))
      if (xml) source = 'tty'
    }
    if (!xml && (strategy === 'auto' || strategy === 'file')) {
      const remote = '/sdcard/.ahelper_dump.xml'
      await this.adb.run(['shell', `rm -f ${remote}`], { timeoutMs: 10000 })
      await this.adb.run(
        ['shell', `uiautomator dump ${flag} ${remote}`.trim().replace(/\s+/g, ' ')],
        { timeoutMs: this.cfg.dumpTimeoutMs },
      )
      const cat = await this.adb.run(['exec-out', 'cat', remote], { timeoutMs: 20000 })
      xml = extractHierarchy(cat.stdout.toString('utf8'))
      if (xml) source = 'file'
    }
    if (!xml) {
      throw new Error(
        '无法获取 UI 树：uiautomator dump 未返回完整 <hierarchy>。' +
          '可尝试 --no-compressed，或确认屏幕未处于密码/安全界面。',
      )
    }

    const snapshot = UiSnapshot.from(xml, {})
    snapshot.source = `uiautomator:${source}`
    this._ui = snapshot
    this._uiAt = Date.now()
    return snapshot
  }

  /** Compact, model-facing view of the current screen. */
  async uiRows(options = {}) {
    const {
      refresh = false,
      compressed = true,
      labelsOnly = false,
      maxNodes = 200,
      package: packageFilter = null,
      withText = true,
    } = options
    const snapshot = await this.ui({ refresh, compressed })
    const simplified = snapshot.simplify({
      labelsOnly,
      maxNodes,
      package: packageFilter,
      includeUnlabeled: !labelsOnly,
    })
    return {
      rows: simplified.rows,
      text: withText ? rowsToText(simplified.rows) : null,
      total: snapshot.nodes.length,
      returned: simplified.rows.length,
      dropped: simplified.dropped,
      rotation: snapshot.rotation,
      source: snapshot.source,
      packages: snapshot.packages,
      screen: snapshot.screenSize,
      snapshot,
    }
  }

  /**
   * Find nodes matching a selector.
   *
   * Disabled and zero-area nodes are excluded by default, which is what you want
   * when resolving a tap target. Pass `enabledOnly: false` to *inspect* state —
   * otherwise a disabled button simply is not there, and "assert it is disabled"
   * becomes impossible to write.
   *
   * `compressed: false` dumps the whole view tree instead of only what is
   * currently on screen. That is the difference between "the row is absent" and
   * "the row is scrolled out of view" — a compressed dump silently conflates the
   * two.
   */
  async find(selector, { refresh = false, compressed = true } = {}) {
    const snapshot = await this.ui({ refresh, compressed })
    return { snapshot, nodes: snapshot.find(selector) }
  }

  /**
   * Resolve a node to a tap point, preferring the nearest clickable ancestor.
   * @returns {{x:number,y:number,node:object,via:string}|null}
   */
  async resolveTarget(selector, { refresh = false, clickableAncestor = true } = {}) {
    const { snapshot, nodes } = await this.find(selector, { refresh })
    if (nodes.length === 0) return null
    const node = clickableAncestor ? clickableTarget(snapshot.nodes, nodes[0]) : nodes[0]
    if (!node.bounds) return null
    return {
      x: node.bounds.cx,
      y: node.bounds.cy,
      node,
      via: clickableAncestor && node !== nodes[0] ? 'clickable-ancestor' : 'direct',
      candidates: nodes.length,
    }
  }

  // ── input ─────────────────────────────────────────────────────────────────

  async tap(x, y, options = {}) {
    const result = await input.tap(this.adb, x, y, options)
    this.invalidate()
    if (options.settle !== false) await sleep(options.settleMs ?? 250)
    return result
  }

  async longPress(x, y, durationMs = 800, options = {}) {
    const result = await input.longPress(this.adb, x, y, durationMs, options)
    this.invalidate()
    if (options.settle !== false) await sleep(options.settleMs ?? 300)
    return result
  }

  async swipe(from, to, options = {}) {
    const result = await input.swipe(this.adb, from, to, options)
    this.invalidate()
    if (options.settle !== false) await sleep(options.settleMs ?? 250)
    return result
  }

  async scroll(direction, options = {}) {
    const screenSize = options.screen ?? (await this.screenSize())
    const result = await input.scroll(this.adb, direction, { ...options, screen: screenSize })
    this.invalidate()
    if (options.settle !== false) await sleep(options.settleMs ?? 250)
    return result
  }

  async text(value, options = {}) {
    const result = options.replace
      ? await input.setFocusedText(this.adb, value, options)
      : await input.inputText(this.adb, value, options)
    this.invalidate()
    return result
  }

  async key(keys, options = {}) {
    const result = await input.keyEvent(this.adb, keys, options)
    this.invalidate()
    if (options.settle !== false) await sleep(options.settleMs ?? 200)
    return result
  }

  /** Tap whatever matches a selector, with an optional automatic wait. */
  async tapSelector(selector, options = {}) {
    const target = await this.resolveTarget(selector, options)
    if (!target) {
      const rows = await this.uiRows({ refresh: true, maxNodes: 60 })
      throw new Error(
        `找不到匹配元素: ${JSON.stringify(stripRegex(selector))}\n当前界面可交互元素:\n${rows.text}`,
      )
    }
    if (options.long) await this.longPress(target.x, target.y, options.durationMs ?? 800, options)
    else await this.tap(target.x, target.y, options)
    return target
  }

  tapText(text, options = {}) {
    return this.tapSelector({ text, exact: options.exact === true, clickable: true }, options)
  }

  tapId(id, options = {}) {
    return this.tapSelector({ id, clickable: true }, options)
  }

  tapDesc(desc, options = {}) {
    return this.tapSelector({ desc, exact: options.exact === true, clickable: true }, options)
  }

  /** Tap by the compact row index produced by `uiRows()`. */
  async tapRow(rowIndex, options = {}) {
    const { snapshot } = await this.find({}, { refresh: options.refresh })
    const simplified = snapshot.simplify({ maxNodes: options.maxNodes ?? 200 })
    const node = simplified.index.get(rowIndex)
    if (!node) throw new Error(`节点 #${rowIndex} 不存在（本次界面共 ${simplified.rows.length} 个可交互元素）`)
    const target = clickableTarget(snapshot.nodes, node)
    await this.tap(target.bounds.cx, target.bounds.cy, options)
    return { x: target.bounds.cx, y: target.bounds.cy, node: target }
  }

  // ── app lifecycle ─────────────────────────────────────────────────────────

  currentActivity() {
    return app.currentActivity(this.adb)
  }

  packageInfo(pkg) {
    return app.packageInfo(this.adb, pkg ?? this.cfg.defaultPackage)
  }

  install(apkPath, options) {
    return app.install(this.adb, apkPath, options)
  }

  uninstall(pkg, options) {
    return app.uninstall(this.adb, pkg, options)
  }

  start(target, options) {
    this.invalidate()
    return app.start(this.adb, target, options)
  }

  stop(pkg) {
    this.invalidate()
    return app.stop(this.adb, pkg)
  }

  clearData(pkg) {
    return app.clearData(this.adb, pkg)
  }

  /** Re-grant runtime permissions (needed again after `clearData`). */
  grantPermissions(pkg) {
    return app.grantRuntimePermissions(this.adb, pkg ?? this.cfg.defaultPackage)
  }

  listPackages(options) {
    return app.listPackages(this.adb, options)
  }

  pidOf(pkg) {
    return app.pidOf(this.adb, pkg)
  }

  // ── logs ──────────────────────────────────────────────────────────────────

  logcat(options) {
    return logcat.logcat(this.adb, options)
  }

  diagnose(pkg, options) {
    return logcat.diagnose(this.adb, pkg ?? this.cfg.defaultPackage, options)
  }

  // ── waits ─────────────────────────────────────────────────────────────────

  /**
   * Generic poll.  Returns the first truthy probe result, or null on timeout.
   * Every wait primitive below is built from this so the timeout semantics and
   * diagnostics stay identical.
   */
  async waitFor(probe, { timeoutMs = 15000, intervalMs = 300, onTimeout = null, description = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    for (;;) {
      last = await probe()
      if (last) return last
      if (Date.now() >= deadline) {
        if (onTimeout) throw new Error(await onTimeout())
        throw new Error(`等待超时（${timeoutMs}ms）: ${description}`)
      }
      await sleep(intervalMs)
    }
  }

  async waitText(text, options = {}) {
    const { timeoutMs = 15000, exact = false, intervalMs = 350 } = options
    return this.waitFor(
      async () => {
        const { nodes } = await this.find({ text, exact }, { refresh: true })
        return nodes.length > 0 ? nodes[0] : null
      },
      {
        timeoutMs,
        intervalMs,
        description: `文本出现: ${text}`,
        onTimeout: async () => this.timeoutContext(`等待文本 "${text}" 出现`),
      },
    )
  }

  async waitId(id, options = {}) {
    const { timeoutMs = 15000, intervalMs = 350 } = options
    return this.waitFor(
      async () => {
        const { nodes } = await this.find({ id }, { refresh: true })
        return nodes.length > 0 ? nodes[0] : null
      },
      {
        timeoutMs,
        intervalMs,
        description: `元素出现: ${id}`,
        onTimeout: async () => this.timeoutContext(`等待元素 "${id}" 出现`),
      },
    )
  }

  async waitGone(selector, options = {}) {
    const { timeoutMs = 15000, intervalMs = 350 } = options
    const label = JSON.stringify(stripRegex(selector))
    return this.waitFor(
      async () => {
        const { nodes } = await this.find(selector, { refresh: true })
        return nodes.length === 0 ? { gone: true } : null
      },
      { timeoutMs, intervalMs, description: `元素消失: ${label}` },
    )
  }

  async waitActivity(pattern, options = {}) {
    const { timeoutMs = 20000, intervalMs = 400 } = options
    return this.waitFor(
      async () => {
        const current = await this.currentActivity()
        if (!current.component) return null
        const ok = pattern instanceof RegExp ? pattern.test(current.component) : current.component.includes(pattern)
        return ok ? current : null
      },
      {
        timeoutMs,
        intervalMs,
        description: `Activity 变为 ${pattern}`,
        onTimeout: async () => {
          const current = await this.currentActivity().catch(() => null)
          return `等待 Activity "${pattern}" 超时；当前为 ${current?.component ?? '未知'}`
        },
      },
    )
  }

  /** Error message that shows what the user can actually see right now. */
  async timeoutContext(what) {
    let rows = null
    let shot = null
    try {
      const view = await this.uiRows({ refresh: true, maxNodes: 40 })
      rows = view.text
    } catch (error) {
      rows = `(无法读取 UI 树: ${error.message})`
    }
    try {
      shot = (await this.screenshot({ scale: 0.5, label: 'timeout' })).path
    } catch {
      /* screenshots are best-effort in an error path */
    }
    const activity = await this.currentActivity().catch(() => null)
    return [
      `${what} 超时。`,
      `当前 Activity: ${activity?.component ?? '未知'}`,
      shot ? `截图: ${shot}` : null,
      '当前界面元素:',
      rows ?? '(无)',
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ── compound operations ───────────────────────────────────────────────────

  /**
   * Tap, wait for the screen to settle, and return UI tree + screenshot.
   * One call replaces the tap / sleep / dump / screenshot sequence.
   */
  async tapAndWait(target, options = {}) {
    const started = Date.now()
    let point = null

    if (typeof target === 'number' && options.axis === 'y' && options.x !== undefined) {
      point = { x: options.x, y: target }
      await this.tap(point.x, point.y, options)
    } else if (typeof target === 'object' && target !== null && 'x' in target && 'y' in target) {
      point = { x: target.x, y: target.y }
      await this.tap(point.x, point.y, options)
    } else if (typeof target === 'number') {
      const row = await this.tapRow(target, options)
      point = { x: row.x, y: row.y }
    } else {
      const selector = typeof target === 'string' ? { text: target, exact: options.exact === true } : target
      const resolved = await this.tapSelector(selector, { ...options, settle: false })
      point = { x: resolved.x, y: resolved.y }
    }

    const idle = await this.waitIdle({
      timeoutMs: options.idleTimeoutMs ?? 6000,
      allowNever: true,
    })
    const view = await this.uiRows({ refresh: true, maxNodes: options.maxNodes ?? 120 })
    const shot = await this.screenshot({ scale: options.scale ?? 0.6, label: options.label ?? 'tap' })
    const activity = await this.currentActivity().catch(() => null)

    return {
      point,
      idle,
      elapsedMs: Date.now() - started,
      activity,
      rows: view.rows,
      text: view.text,
      screenshot: shot.path,
      screen: { width: shot.sourceWidth, height: shot.sourceHeight },
    }
  }

  /** Scroll until a selector matches, or give up. */
  async scrollTo(selector, options = {}) {
    const {
      direction = 'down',
      maxScrolls = 10,
      timeoutMs = 40000,
      refresh = true,
    } = options
    const deadline = Date.now() + timeoutMs
    for (let attempt = 0; attempt <= maxScrolls; attempt++) {
      const { nodes } = await this.find(selector, { refresh })
      if (nodes.length > 0) {
        const node = clickableTarget((await this.ui()).nodes, nodes[0])
        return { found: true, attempts: attempt, node, point: { x: node.bounds.cx, y: node.bounds.cy } }
      }
      if (Date.now() >= deadline || attempt === maxScrolls) break
      await this.scroll(direction, options)
      await this.waitIdle({ timeoutMs: 2500, allowNever: true })
    }
    return { found: false, attempts: maxScrolls }
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  /** Everything a doctor command wants to know, without thrashing the device. */
  async doctor() {
    const report = { serial: this.serial, adb: this.adb.bin, warnings: [...this.warnings], checks: [] }
    const add = (name, ok, detail) => report.checks.push({ name, ok, detail })

    add('adb 可执行文件', Boolean(this.adb.bin), this.adb.bin)
    const transport = await this.transport().catch(() => null)
    add('设备在线', transport?.state === 'device', transport ? `${transport.serial} (${transport.state})` : '未找到')

    const identity = await this.identity({ refresh: true }).catch((error) => ({ error: error.message }))
    if (identity.error) add('设备属性', false, identity.error)
    else {
      add('设备属性', true, `${identity.brand ?? '?'} ${identity.model ?? '?'} / Android ${identity.release ?? '?'} (SDK ${identity.sdk ?? '?'})`)
      add('开机完成', identity.bootCompleted, String(identity.bootCompleted))
      add('屏幕', Boolean(identity.screen), identity.screen ? `${identity.screen.width}x${identity.screen.height} @${identity.density ?? '?'}dpi, 旋转 ${identity.rotation ?? 0}` : '未知')
    }

    try {
      const shot = await this.screenshot({ scale: 0.5, save: false, label: 'doctor' })
      add('截图', shot.bytes > 0, `${shot.sourceWidth}x${shot.sourceHeight} → ${shot.width}x${shot.height}, ${(shot.bytes / 1024).toFixed(0)} KB (原 ${(shot.rawBytes / 1024).toFixed(0)} KB)`)
    } catch (error) {
      add('截图', false, error.message)
    }

    try {
      const view = await this.uiRows({ refresh: true, maxNodes: 200 })
      add('UI 树', view.returned > 0, `${view.total} 节点 → 精简为 ${view.returned} 条 (来源 ${view.source})`)
    } catch (error) {
      add('UI 树', false, error.message)
    }

    const activity = await this.currentActivity().catch(() => null)
    add('当前 Activity', Boolean(activity?.component), activity?.component ?? '未知')

    return report
  }
}

function parseWmSize(text) {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(text)
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(text)
  const match = override ?? physical
  if (!match) return null
  return { width: Number(match[1]), height: Number(match[2]), overridden: Boolean(override) }
}

/**
 * Swap width and height for a landscape orientation.
 *
 * `SurfaceOrientation` is 0/1/2/3 for 0°/90°/180°/270°; odd values are the
 * landscape ones, where the framebuffer is wider than the panel's natural size.
 * Getting this wrong makes `scroll` clamp to a portrait box on a landscape
 * screen, which produces short, drifting swipes instead of a real scroll.
 */
export function orientScreen(size, rotation) {
  if (!size) return null
  const normalized = ((Math.round(Number(rotation) || 0) % 4) + 4) % 4
  if (normalized % 2 === 1) {
    return { width: size.height, height: size.width, overridden: size.overridden, rotation: normalized, swapped: true }
  }
  return { ...size, rotation: normalized, swapped: false }
}

function parseDensity(text) {
  const override = /Override density:\s*(\d+)/.exec(text)
  const physical = /Physical density:\s*(\d+)/.exec(text)
  return Number((override ?? physical)?.[1] ?? 0) || null
}

function parseRotation(text) {
  const match = /SurfaceOrientation:\s*(\d+)/.exec(text)
  if (match) return Number(match[1])
  return 0
}

function stripRegex(object) {
  const out = {}
  for (const [key, value] of Object.entries(object ?? {})) {
    out[key] = value instanceof RegExp ? value.source : value
  }
  return out
}

export { screen, input, app, logcat, rowsToText, shortId, fs, path }
