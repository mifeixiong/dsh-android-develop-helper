/**
 * `android-helper` command line interface.
 *
 * Design rules:
 *   - every command can emit `--json`, so an agent never has to scrape text;
 *   - anything that mutates the screen prints what the screen became, not just
 *     "ok" — an agent that has to guess whether a tap worked will guess wrong;
 *   - the device is resolved lazily, so `config`, `devices`, `emulators` and
 *     the adb server commands still work when no emulator is running.
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, writeConfigFile, readConfigFile, EMULATOR_PRESETS, CONFIG_PATH } from './config.js'
import { probePorts, guessVendor, deviceInventory, STATE_PATH } from './devices.js'
import { launchEmulator } from './emulator.js'
import { Device } from './device.js'
import { Adb } from './adb.js'
import { rowsToText } from './uitree.js'
import { install as installApk, uninstall as uninstallApk } from './app.js'
import { apkSummary } from './apk.js'
import { renderCrash, renderTombstone, describeProcess } from './logcat.js'

const REPEATABLE = new Set(['extras', 'param', 'ports'])

const HELP = `dsh-android-develop-helper — 通过 ADB 驱动 Android 模拟器，辅助 AI 开发/调试/定位错误

用法: android-helper <命令> [参数] [选项]

设备与配置
  doctor                       自检：adb、设备、截图、UI 树、当前 Activity
  devices [--probe]           列出设备（--probe 会探测各厂商 ADB 端口并去重）
  start-emulator [--wait] [--timeout MS] [--launcher PATH]
                               启动模拟器本体（MuMu/雷电/夜神/Genymotion/AVD），
                               已有实例在跑时直接返回，不重复启动
  emulators                    扫描本机正在监听的模拟器端口及厂商推测
  instances                    向厂商管理 CLI 查询实例列表与**准确**的 ADB 端口
                               (MuMu 用 MuMuManager info -v all，雷电用 ldconsole list2)
  info                         设备信息（型号/系统/分辨率/密度/旋转）
  config [--get K] [--set K=V] 查看或写入 config.json

屏幕与界面
  shot [--scale 0.5] [--region x,y,w,h] [--out FILE] [--label L]
  ui [--refresh] [--labels-only] [--max N] [--package P] [--no-compressed]
                               默认只列出"屏幕上可见"的节点；--no-compressed 会 dump
                               整棵树（含滚出屏幕的节点），更慢也更大
  find <文本> [--id RID] [--desc D] [--exact]
  activity                     当前前台 Activity

自动化操作
  tap-xy <x> <y>
  tap-text <文本> [--exact] [--long]
  tap-id <resource-id> [--long]
  tap-desc <content-desc> [--long]
  tap-node <N>                 N 为 \`ui\` 输出的 #编号
  tap-and-wait <目标> [--mode text|id|desc|node|xy] [--scale S]
  scroll <up|down|left|right> [--times N]
  swipe <x1> <y1> <x2> <y2> [--duration MS]
  long-press <x> <y> [--duration MS]
  text <字符串> [--replace]     输入文本（--replace 先清空）
  key <按键名|keycode>

等待
  wait-text <文本> [--timeout MS] [--exact]
  wait-id <resource-id> [--timeout MS]
  wait-gone --id RID | --text T [--timeout MS]
  wait-activity <片段|正则>
  wait-idle [--timeout MS]

应用
  apk-info <apk>               本地 APK 的包名/版本/SDK（无需 aapt）
  install <apk> [--no-verify] [--no-grant]
  uninstall <包名> [--keep-data]
  start <包名|包名/Activity> [--extras k=v]... [--data URI] [--force-stop]
  stop <包名>
  clear <包名>
  grant <包名>                  补授运行时权限（pm clear 会撤销安装时的 -g 授权）
  packages [--filter S] [--all]
  pkg <包名>

日志与排错
  logcat [--grep P] [--level I] [--since T] [--package P] [--clear] [--save F] [--max N]
  diagnose <包名>               抓取崩溃相关日志并给出结论
  shell "<设备端命令>"          直接用当前设备执行 adb shell（逃生口，慎用）
  rotate [portrait|landscape|0-3]  查看或固定屏幕方向
  kill-server / start-server

全局选项
  --device <serial>            指定目标设备（多设备时必须）
  --adb <路径>                 指定 adb 可执行文件
  --emulator <类型>            mumu | ldplayer | nox | avd | genymotion | custom
  --adb-port <端口>            手动指定 ADB 端口
  --console-port <端口>        手动指定 console 端口（ADB = console + 1）
  --json                       以 JSON 输出
  --quiet                      只输出结果，不输出提示
  --echo                       回显每条 adb 命令
  --timeout <ms>               单条命令超时
  --no-probe                   自动发现时不探测端口
`

// ── argument parsing ────────────────────────────────────────────────────────

export function parseArgv(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    let key
    let value
    if (eq > 2) {
      key = token.slice(2, eq)
      value = token.slice(eq + 1)
    } else {
      key = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        value = next
        i++
      } else {
        value = true
      }
    }
    if (key.startsWith('no-') && value === true) {
      flags[key.slice(3)] = false
      continue
    }
    if (REPEATABLE.has(key)) {
      flags[key] = [...(flags[key] ?? []), value]
    } else {
      flags[key] = value
    }
  }
  return { command: positional.shift() ?? 'help', positional, flags }
}

function intOf(value, fallback = null) {
  if (value === undefined || value === null || value === true || value === '') return fallback
  const n = Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? n : fallback
}

function numOf(value, fallback = null) {
  if (value === undefined || value === null || value === true || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

// ── output helpers ──────────────────────────────────────────────────────────

function createIO(flags) {
  const json = flags.json === true
  const quiet = flags.quiet === true
  return {
    json,
    quiet,
    say(...parts) {
      if (json || quiet) return
      process.stdout.write(`${parts.join(' ')}\n`)
    },
    /** Emit either JSON or a rendered text form. */
    emit(value, render) {
      if (json) {
        process.stdout.write(`${JSON.stringify(value, replacer, 2)}\n`)
      } else if (render) {
        const text = render(value)
        if (text !== undefined && text !== null) process.stdout.write(`${text}\n`)
      }
    },
    /** Warn on stderr so `--json` consumers keep a clean stdout stream. */
    warn(message) {
      process.stderr.write(`[warn] ${message}\n`)
    },
  }
}

function replacer(key, value) {
  if (key === 'png' || key === 'snapshot' || key === 'adb' || key === 'session') return undefined
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`
  return value
}

/** Strip anything not meant for a machine consumer. */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, replacer))
}

// ── command context ─────────────────────────────────────────────────────────

function createContext(argv) {
  const { command, positional, flags } = parseArgv(argv)
  const io = createIO(flags)
  const cfg = loadConfig({
    adbPath: flags.adb,
    emulatorType: flags.emulator,
    adbPort: intOf(flags['adb-port']),
    consolePort: intOf(flags['console-port']),
    deviceSerial: flags.device,
    timeoutMs: intOf(flags.timeout),
  })
  const probe = flags.probe !== false && flags['no-probe'] !== true

  let devicePromise = null
  const getDevice = (label = command) => {
    if (!devicePromise) {
      devicePromise = Device.connect(cfg, {
        label,
        device: flags.device,
        probe,
        session: undefined,
      }).then((device) => {
        if (device.warnings?.length && !io.json && !io.quiet) {
          for (const warning of device.warnings) io.warn(warning)
        }
        if (cfg.adbMissing) io.warn(`未找到 adb 可执行文件，回退为 "${cfg.adb}"（请用 --adb 或 config --set adbPath=... 指定）`)
        return device
      })
    }
    return devicePromise
  }
  const closeDevice = async () => {
    if (!devicePromise) return
    try {
      const device = await devicePromise
      await device.session?.close()
    } catch {
      /* ignore */
    }
  }
  return { command, positional, flags, io, cfg, getDevice, closeDevice, probe }
}

// ── commands ────────────────────────────────────────────────────────────────

const commands = {
  help: () => {
    process.stdout.write(HELP)
    return 0
  },

  async doctor(ctx) {
    const device = await ctx.getDevice('doctor')
    const report = await device.doctor()
    if (ctx.io.json) {
      ctx.io.emit(jsonSafe(report))
    } else {
      const lines = [
        `设备      : ${report.serial}`,
        `adb       : ${report.adb}`,
        '',
      ]
      for (const check of report.checks) {
        lines.push(`${check.ok ? '✓' : '✗'} ${check.name.padEnd(14)} ${check.detail}`)
      }
      if (report.warnings.length) lines.push('', ...report.warnings.map((w) => `! ${w}`))
      lines.push('', `日志: ${device.session?.logPath ?? '(未写入)'}`)
      ctx.io.emit(report, () => lines.join('\n'))
    }
    return report.checks.some((c) => !c.ok) ? 1 : 0
  },

  async 'start-emulator'(ctx) {
    const report = await launchEmulator(ctx.cfg, {
      wait: ctx.flags.wait !== false,
      timeoutMs: intOf(ctx.flags.timeout, 180000),
      launcher: ctx.flags.launcher ?? null,
      onLog: (line) => ctx.io.say(line),
    })
    if (report.serial) {
      // Pin the freshly started instance so the next command does not have to
      // rediscover it.
      const device = await ctx.getDevice('start-emulator')
      report.activity = (await device.currentActivity().catch(() => null))?.component ?? null
    }
    ctx.io.emit(
      jsonSafe(report),
      (d) =>
        [
          d.alreadyRunning ? `✓ 已有实例在运行` : d.launched ? `✓ 已启动 ${d.label}` : `✗ 未启动`,
          d.serial ? `  设备: ${d.serial}${d.activity ? `  activity: ${d.activity}` : ''}` : null,
          d.waitedMs ? `  等待: ${(d.waitedMs / 1000).toFixed(1)}s` : null,
          d.note ? `  ${d.note}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
    )
    return report.launched || report.alreadyRunning ? 0 : 1
  },

  async devices(ctx) {
    const adb = new Adb({ bin: ctx.cfg.adb, timeoutMs: ctx.cfg.timeoutMs })
    const inventory = await deviceInventory(adb, ctx.cfg, { probe: ctx.probe })
    const cached = safeReadJson(STATE_PATH)
    ctx.io.emit(
      { ...jsonSafe(inventory), cached },
      (data) =>
        [
          ...data.devices.map((d) => {
            const id = d.fingerprint?.androidId ? ` android_id=${d.fingerprint.androidId}` : ''
            return `${d.state === 'device' ? '●' : '○'} ${d.serial.padEnd(20)} ${d.state.padEnd(12)} ${d.model ?? '?'}${id}`
          }),
          data.probes.length ? `探测到开放端口: ${data.probes.join(', ')}` : '未探测到额外开放端口',
          cached?.serial ? `上次解析结果: ${cached.serial}（${cached.fingerprint ?? '无指纹'}）` : '尚无解析缓存',
        ].join('\n'),
    )
    return 0
  },

  async instances(ctx) {
    const { discoverVendorInstances, managerCandidates, findLauncher, resolveEmulatorType, detectInstalledEmulator } =
      await import('./emulator.js')
    const emulatorType = resolveEmulatorType(ctx.cfg)
    const discovery = await discoverVendorInstances(emulatorType)
    const launcher = findLauncher(emulatorType)
    const payload = {
      emulatorType,
      configuredType: ctx.cfg.emulatorType,
      detected: detectInstalledEmulator(),
      manager: discovery.source,
      managerCandidates: managerCandidates(emulatorType).map((c) => c.path),
      launcher: launcher?.path ?? null,
      instances: discovery.instances,
    }
    ctx.io.emit(
      jsonSafe(payload),
      (d) =>
        [
          `模拟器类型: ${d.emulatorType}`,
          `启动器    : ${d.launcher ?? '(未找到)'}`,
          `管理 CLI  : ${d.manager ?? '(未找到)'}`,
          '',
          ...(d.instances.length
            ? d.instances.map(
                (i) =>
                  `[${i.index}] ${i.name ?? '?'}  adb=${i.adbHost}:${i.adbPort}  ` +
                  `android=${i.androidVersion ?? '?'}  ${i.running ? '运行中' : '已停止'}`,
              )
            : ['（该厂商没有可用的实例查询接口，回退到端口探测）']),
        ].join('\n'),
    )
    return 0
  },

  async emulators(ctx) {
    const ports = await probePorts(ctx.cfg.portUniverse, { timeoutMs: 300 })
    const rows = ports.map((port) => ({
      port,
      vendor: guessVendor(port),
      label: EMULATOR_PRESETS[guessVendor(port) === 'mumu' ? 'mumu' : guessVendor(port)]?.label ?? guessVendor(port),
    }))
    ctx.io.emit(
      { ports: rows, universe: ctx.cfg.portUniverse.length, emulatorType: ctx.cfg.emulatorType },
      (data) =>
        data.ports.length
          ? data.ports.map((r) => `${String(r.port).padEnd(6)} ${r.vendor}`).join('\n')
          : '没有探测到正在监听的模拟器端口（模拟器未启动？）',
    )
    return 0
  },

  async info(ctx) {
    const device = await ctx.getDevice('info')
    const identity = await device.identity({ refresh: true })
    const activity = await device.currentActivity()
    const payload = { ...identity, current: activity }
    ctx.io.emit(
      payload,
      (d) =>
        [
          `serial    : ${d.serial}`,
          `model     : ${d.brand ?? ''} ${d.model ?? ''}`.trim(),
          `android   : ${d.release} (SDK ${d.sdk})`,
          `screen    : ${d.screen ? `${d.screen.width}x${d.screen.height}` : '?'} @${d.density ?? '?'}dpi  rotation=${d.rotation}`,
          `boot      : ${d.bootCompleted ? 'completed' : 'NOT completed'}`,
          `android_id: ${d.androidId}`,
          `activity  : ${d.current?.component ?? '未知'}`,
        ].join('\n'),
    )
    return 0
  },

  async config(ctx) {
    if (ctx.flags.set) {
      const patch = {}
      for (const assignment of [ctx.flags.set].flat()) {
        const eq = String(assignment).indexOf('=')
        if (eq < 0) continue
        const key = assignment.slice(0, eq)
        let value = assignment.slice(eq + 1)
        if (/^-?\d+$/.test(value)) value = Number.parseInt(value, 10)
        else if (value === 'true') value = true
        else if (value === 'false') value = false
        patch[key] = value
      }
      const next = writeConfigFile(patch)
      ctx.io.emit(next, (d) => `已写入 ${CONFIG_PATH}\n${JSON.stringify(d, null, 2)}`)
      return 0
    }
    const file = readConfigFile()
    if (ctx.flags.get) {
      const value = ctx.cfg[ctx.flags.get] ?? file[ctx.flags.get] ?? null
      ctx.io.emit({ key: ctx.flags.get, value }, (d) => String(d.value))
      return 0
    }
    const payload = {
      configPath: CONFIG_PATH,
      resolved: {
        adb: ctx.cfg.adb,
        adbSource: ctx.cfg.adbSource,
        emulatorType: ctx.cfg.emulatorType,
        adbPort: ctx.cfg.adbPort,
        consolePort: ctx.cfg.consolePort,
        deviceSerial: ctx.cfg.deviceSerial,
        autoDiscover: ctx.cfg.autoDiscover,
        timeoutMs: ctx.cfg.timeoutMs,
        artifactsDir: ctx.cfg.artifactsDir,
        defaultPackage: ctx.cfg.defaultPackage,
      },
      portUniverse: ctx.cfg.portUniverse,
      file,
    }
    ctx.io.emit(payload, (d) =>
      [
        `配置文件    : ${d.configPath}`,
        `adb         : ${d.resolved.adb}  (来源: ${d.resolved.adbSource ?? '?'})`,
        `模拟器类型  : ${d.resolved.emulatorType}`,
        `adbPort     : ${d.resolved.adbPort ?? '(自动)'}`,
        `consolePort : ${d.resolved.consolePort ?? '(自动)'}`,
        `deviceSerial: ${d.resolved.deviceSerial ?? '(自动)'}`,
        `autoDiscover: ${d.resolved.autoDiscover}`,
        `探测端口数  : ${d.portUniverse.length}`,
        `产物目录    : ${d.resolved.artifactsDir}`,
        `文件内容    : ${JSON.stringify(d.file)}`,
      ].join('\n'),
    )
    return 0
  },

  async shot(ctx) {
    const device = await ctx.getDevice('shot')
    const region = parseRegion(ctx.flags.region)
    const result = await device.screenshot({
      scale: numOf(ctx.flags.scale, 1),
      region,
      filter: ctx.flags.filter === 'nearest' ? 'nearest' : 'box',
      label: ctx.flags.label ?? 'shot',
    })
    if (ctx.flags.out) {
      fs.mkdirSync(path.dirname(path.resolve(ctx.flags.out)), { recursive: true })
      fs.writeFileSync(ctx.flags.out, result.png)
      result.path = path.resolve(ctx.flags.out)
    }
    const payload = jsonSafe(result)
    ctx.io.emit(
      payload,
      (d) =>
        `${d.path}\n${d.sourceWidth}x${d.sourceHeight} → ${d.width}x${d.height} ` +
        `(${(d.rawBytes / 1024).toFixed(0)}KB → ${(d.bytes / 1024).toFixed(0)}KB, ${d.compressionRatio.toFixed(1)}x) hash=${d.hash}`,
    )
    return 0
  },

  async ui(ctx) {
    const device = await ctx.getDevice('ui')
    const view = await device.uiRows({
      refresh: ctx.flags.refresh === true,
      compressed: ctx.flags.compressed !== false,
      labelsOnly: ctx.flags['labels-only'] === true,
      maxNodes: intOf(ctx.flags.max, 200),
      package: ctx.flags.package ?? null,
    })
    const payload = {
      rotation: view.rotation,
      source: view.source,
      total: view.total,
      returned: view.returned,
      dropped: view.dropped,
      packages: view.packages,
      screen: view.screen,
      rows: view.rows.map((row) => ({
        node: row.node,
        tag: row.tag,
        text: row.text,
        desc: row.desc,
        id: row.id,
        hint: row.hint,
        center: `${row.bounds.cx},${row.bounds.cy}`,
        bounds: `${row.bounds.x1},${row.bounds.y1},${row.bounds.x2},${row.bounds.y2}`,
        flags: row.flags,
      })),
    }
    if (ctx.flags.full) {
      payload.xml = null
      const snapshot = await device.ui({ refresh: false })
      payload.rawNodes = snapshot.nodes.length
    }
    ctx.io.emit(payload, (d) =>
      [
        `# ${d.total} 节点 → ${d.returned} 条 (丢弃 ${d.dropped}, 来源 ${d.source}, 旋转 ${d.rotation})`,
        `# 屏幕 ${d.screen?.width}x${d.screen?.height}  包: ${d.packages.join(', ')}`,
        rowsToText(
          view.rows,
          { withBounds: true },
        ),
      ].join('\n'),
    )
    return 0
  },

  async find(ctx) {
    const device = await ctx.getDevice('find')
    const query = ctx.positional[0] ?? null
    const selector = {
      text: ctx.flags.text ?? query ?? undefined,
      id: ctx.flags.id,
      desc: ctx.flags.desc,
      className: ctx.flags.class,
      exact: ctx.flags.exact === true,
    }
    if (!selector.text && !selector.id && !selector.desc && !selector.className) {
      ctx.io.warn('请提供要查找的文本，或 --id/--desc/--class')
      return 2
    }
    const { nodes, snapshot } = await device.find(selector, { refresh: true })
    const payload = {
      query: selector,
      matches: nodes.length,
      nodes: nodes.slice(0, 30).map((node) => ({
        text: node.text,
        desc: node.contentDesc,
        id: node.resourceId,
        class: node.className,
        clickable: node.clickable,
        enabled: node.enabled,
        bounds: node.boundsRaw,
        center: node.bounds ? `${node.bounds.cx},${node.bounds.cy}` : null,
      })),
    }
    ctx.io.emit(payload, (d) =>
      d.matches === 0
        ? `未找到匹配元素: ${JSON.stringify(d.query)}`
        : d.nodes
            .map(
              (n, i) =>
                `[${i}] ${n.text ? JSON.stringify(n.text) : ''} ${n.id ? `id=${shortIdText(n.id)}` : ''} ` +
                `${n.class} @${n.center} ${n.clickable ? 'clickable' : ''} ${n.enabled ? '' : 'disabled'}`,
            )
            .join('\n'),
    )
    return nodes.length > 0 ? 0 : 1
  },

  async activity(ctx) {
    const device = await ctx.getDevice('activity')
    const current = await device.currentActivity()
    ctx.io.emit(jsonSafe(current), (d) => d.component ?? '(未知)')
    return current.component ? 0 : 1
  },

  async 'tap-xy'(ctx) {
    const [x, y] = ctx.positional.map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('用法: tap-xy <x> <y>')
    const device = await ctx.getDevice('tap')
    const point = await device.tap(x, y)
    ctx.io.emit(jsonSafe(point), (d) => `tap ${d.x},${d.y}`)
    return 0
  },

  async 'tap-text'(ctx) {
    const text = ctx.positional.join(' ')
    if (!text) throw new Error('用法: tap-text <文本>')
    const device = await ctx.getDevice('tap-text')
    const target = await device.tapText(text, {
      exact: ctx.flags.exact === true,
      long: ctx.flags.long === true,
      refresh: true,
    })
    ctx.io.emit(
      jsonSafe({ text, x: target.x, y: target.y, via: target.via, candidates: target.candidates }),
      (d) => `tap-text ${JSON.stringify(d.text)} -> ${d.x},${d.y} (${d.via})`,
    )
    return 0
  },

  async 'tap-id'(ctx) {
    const id = ctx.positional[0]
    if (!id) throw new Error('用法: tap-id <resource-id>')
    const device = await ctx.getDevice('tap-id')
    const target = await device.tapId(id, { long: ctx.flags.long === true, refresh: true })
    ctx.io.emit(
      jsonSafe({ id, x: target.x, y: target.y, via: target.via }),
      (d) => `tap-id ${d.id} -> ${d.x},${d.y} (${d.via})`,
    )
    return 0
  },

  async 'tap-desc'(ctx) {
    const desc = ctx.positional.join(' ')
    if (!desc) throw new Error('用法: tap-desc <content-desc>')
    const device = await ctx.getDevice('tap-desc')
    const target = await device.tapDesc(desc, { exact: ctx.flags.exact === true, refresh: true })
    ctx.io.emit(jsonSafe({ desc, x: target.x, y: target.y }), (d) => `tap-desc ${d.desc} -> ${d.x},${d.y}`)
    return 0
  },

  async 'tap-node'(ctx) {
    const index = intOf(ctx.positional[0])
    if (index === null) throw new Error('用法: tap-node <N>（N 来自 `ui` 输出的 #编号）')
    const device = await ctx.getDevice('tap-node')
    const result = await device.tapRow(index, { refresh: ctx.flags.refresh !== false })
    ctx.io.emit(
      jsonSafe({ node: index, x: result.x, y: result.y }),
      (d) => `tap-node #${d.node} -> ${d.x},${d.y}`,
    )
    return 0
  },

  async 'tap-and-wait'(ctx) {
    const device = await ctx.getDevice('tap-and-wait')
    const mode = ctx.flags.mode ?? (ctx.flags.id ? 'id' : ctx.flags.node ? 'node' : ctx.flags.desc ? 'desc' : 'text')
    const raw = ctx.positional.join(' ')
    let target
    if (mode === 'xy') {
      const [x, y] = raw.split(/[\s,]+/).map(Number)
      target = { x, y }
    } else if (mode === 'node') {
      target = intOf(ctx.flags.node ?? raw)
    } else if (mode === 'id') {
      target = { id: ctx.flags.id ?? raw }
    } else if (mode === 'desc') {
      target = { desc: ctx.flags.desc ?? raw }
    } else {
      target = { text: raw, exact: ctx.flags.exact === true }
    }
    const result = await device.tapAndWait(target, {
      scale: numOf(ctx.flags.scale, 0.6),
      maxNodes: intOf(ctx.flags.max, 120),
      idleTimeoutMs: intOf(ctx.flags['idle-timeout']),
    })
    const payload = {
      point: result.point,
      idle: result.idle,
      elapsedMs: result.elapsedMs,
      activity: result.activity?.component ?? null,
      screenshot: result.screenshot,
      total: result.rows.length,
      rows: result.rows.map((row) => ({
        node: row.node,
        tag: row.tag,
        text: row.text,
        desc: row.desc,
        id: row.id,
        center: `${row.bounds.cx},${row.bounds.cy}`,
        flags: row.flags,
      })),
    }
    ctx.io.emit(payload, (d) =>
      [
        `tap -> ${d.point.x},${d.point.y}  idle=${d.idle.idle}  ${d.elapsedMs}ms`,
        `activity: ${d.activity}`,
        `screenshot: ${d.screenshot}`,
        `# ${d.total} 条可交互元素`,
        rowsToText(result.rows, { withBounds: false }),
      ].join('\n'),
    )
    return 0
  },

  async scroll(ctx) {
    const direction = ctx.positional[0] ?? 'down'
    const times = intOf(ctx.flags.times, 1)
    const device = await ctx.getDevice('scroll')
    const results = []
    for (let i = 0; i < times; i++) {
      results.push(await device.scroll(direction, { durationMs: intOf(ctx.flags.duration, 320) }))
      if (i < times - 1) await device.waitIdle({ timeoutMs: 2000, allowNever: true })
    }
    ctx.io.emit(jsonSafe({ direction, times, results }), (d) => `scroll ${d.direction} x${d.times}`)
    return 0
  },

  async swipe(ctx) {
    const [x1, y1, x2, y2] = ctx.positional.map(Number)
    if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) throw new Error('用法: swipe <x1> <y1> <x2> <y2>')
    const device = await ctx.getDevice('swipe')
    const result = await device.swipe({ x: x1, y: y1 }, { x: x2, y: y2 }, { durationMs: intOf(ctx.flags.duration, 300) })
    ctx.io.emit(jsonSafe(result), (d) => `swipe ${d.from.x},${d.from.y} -> ${d.to.x},${d.to.y} (${d.durationMs}ms)`)
    return 0
  },

  async 'long-press'(ctx) {
    const [x, y] = ctx.positional.map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('用法: long-press <x> <y>')
    const device = await ctx.getDevice('long-press')
    const result = await device.longPress(x, y, intOf(ctx.flags.duration, 800))
    ctx.io.emit(jsonSafe(result), (d) => `long-press ${d.x},${d.y} (${d.durationMs}ms)`)
    return 0
  },

  async text(ctx) {
    const value = ctx.positional.join(' ')
    if (!value) throw new Error('用法: text <字符串>')
    const device = await ctx.getDevice('text')
    const result = await device.text(value, { replace: ctx.flags.replace === true })
    ctx.io.emit(jsonSafe(result), (d) => `text (${d.method}) ${d.characters} 字符${d.warning ? `\n[warn] ${d.warning}` : ''}`)
    return 0
  },

  async key(ctx) {
    const keys = ctx.positional.length ? ctx.positional : [ctx.flags.key].filter(Boolean)
    if (keys.length === 0) throw new Error('用法: key <按键名|keycode> [更多按键...]')
    const device = await ctx.getDevice('key')
    const result = await device.key(keys)
    ctx.io.emit(jsonSafe(result), (d) => `keyevent ${d.codes.join(',')}`)
    return 0
  },

  async 'wait-text'(ctx) {
    const text = ctx.positional.join(' ')
    if (!text) throw new Error('用法: wait-text <文本>')
    const device = await ctx.getDevice('wait-text')
    const started = Date.now()
    const node = await device.waitText(text, {
      timeoutMs: intOf(ctx.flags.timeout, 15000),
      exact: ctx.flags.exact === true,
    })
    ctx.io.emit(
      jsonSafe({ text, elapsedMs: Date.now() - started, bounds: node.boundsRaw }),
      (d) => `wait-text ${JSON.stringify(d.text)} 出现 (${d.elapsedMs}ms) @${d.bounds}`,
    )
    return 0
  },

  async 'wait-id'(ctx) {
    const id = ctx.positional[0] ?? ctx.flags.id
    if (!id) throw new Error('用法: wait-id <resource-id>')
    const device = await ctx.getDevice('wait-id')
    const started = Date.now()
    const node = await device.waitId(id, { timeoutMs: intOf(ctx.flags.timeout, 15000) })
    ctx.io.emit(
      jsonSafe({ id, elapsedMs: Date.now() - started, bounds: node.boundsRaw }),
      (d) => `wait-id ${d.id} 出现 (${d.elapsedMs}ms) @${d.bounds}`,
    )
    return 0
  },

  async 'wait-gone'(ctx) {
    const selector = { id: ctx.flags.id, text: ctx.flags.text }
    if (!selector.id && !selector.text) throw new Error('用法: wait-gone --id RID 或 --text T')
    const device = await ctx.getDevice('wait-gone')
    const started = Date.now()
    await device.waitGone(selector, { timeoutMs: intOf(ctx.flags.timeout, 15000) })
    ctx.io.emit(jsonSafe({ selector, elapsedMs: Date.now() - started }), (d) => `已消失 (${d.elapsedMs}ms)`)
    return 0
  },

  async 'wait-activity'(ctx) {
    const pattern = ctx.positional[0]
    if (!pattern) throw new Error('用法: wait-activity <片段|正则>')
    const device = await ctx.getDevice('wait-activity')
    const current = await device.waitActivity(pattern, { timeoutMs: intOf(ctx.flags.timeout, 20000) })
    ctx.io.emit(jsonSafe(current), (d) => `activity = ${d.component}`)
    return 0
  },

  async 'wait-idle'(ctx) {
    const device = await ctx.getDevice('wait-idle')
    const result = await device.waitIdle({ timeoutMs: intOf(ctx.flags.timeout, 8000) })
    ctx.io.emit(jsonSafe(result), (d) => `idle=${d.idle} frames=${d.frames} hash=${d.hash}`)
    return result.idle ? 0 : 1
  },

  async 'apk-info'(ctx) {
    const apk = ctx.positional[0]
    if (!apk) throw new Error('用法: apk-info <apk>')
    const summary = apkSummary(path.resolve(apk))
    ctx.io.emit(
      jsonSafe(summary),
      (d) =>
        [
          `package   : ${d.package ?? '(未能解析)'}`,
          `version   : ${d.versionName ?? '?'} (${d.versionCode ?? '?'})`,
          `sdk       : min=${d.minSdk ?? '?'} target=${d.targetSdk ?? '?'}`,
          `size      : ${(d.sizeBytes / 1048576).toFixed(2)} MB`,
          `activities: ${d.activities.length ? d.activities.slice(0, 8).join(', ') : '(无)'}`,
          `permissions: ${d.permissions.length} 个`,
        ].join('\n'),
    )
    return summary.package ? 0 : 1
  },

  async install(ctx) {
    const apk = ctx.positional[0]
    if (!apk) throw new Error('用法: install <apk>')
    const device = await ctx.getDevice('install')
    const report = await installApk(device.adb, path.resolve(apk), {
      verify: ctx.flags.verify !== false,
      grantPermissions: ctx.flags.grant !== false,
      allowDowngrade: ctx.flags.downgrade === true,
      expectSha: ctx.flags.sha ?? null,
    })
    ctx.io.emit(
      jsonSafe(report),
      (d) =>
        [
          `${d.success ? '✓' : '✗'} install ${d.apk} (${(d.sizeBytes / 1048576).toFixed(1)} MB)`,
          d.package ? `  package: ${d.package}` : '  package: (未识别)',
          d.verified === true ? '  校验: 设备端 SHA256 与本地一致' : null,
          d.verified === false ? `  校验: 不一致！${d.verifyNote ?? ''}` : null,
          d.verified === null ? `  校验: 跳过 ${d.verifyNote ?? ''}` : null,
          d.failure ? `  失败原因: ${d.failure}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
    )
    return report.success ? 0 : 1
  },

  async uninstall(ctx) {
    const pkg = ctx.positional[0] ?? ctx.cfg.defaultPackage
    if (!pkg) throw new Error('用法: uninstall <包名>')
    const device = await ctx.getDevice('uninstall')
    const report = await uninstallApk(device.adb, pkg, { keepData: ctx.flags['keep-data'] === true })
    ctx.io.emit(jsonSafe(report), (d) => `${d.success ? '✓' : '✗'} uninstall ${d.package}: ${d.output}`)
    return report.success ? 0 : 1
  },

  async start(ctx) {
    const target = ctx.positional[0]
    if (!target) throw new Error('用法: start <包名|包名/Activity>')
    const device = await ctx.getDevice('start')
    const extras = {}
    for (const pair of ctx.flags.extras ?? []) {
      const eq = String(pair).indexOf('=')
      if (eq < 0) continue
      const key = pair.slice(0, eq)
      const raw = pair.slice(eq + 1)
      extras[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw
    }
    const result = await device.start(target, {
      extras,
      data: ctx.flags.data ?? null,
      action: ctx.flags.action ?? null,
      forceStop: ctx.flags['force-stop'] === true,
    })
    await new Promise((r) => setTimeout(r, 600))
    const activity = await device.currentActivity()
    ctx.io.emit(
      jsonSafe({ ...result, current: activity }),
      (d) =>
        [
          `${d.success ? '✓' : '✗'} start ${d.target} via ${d.method}`,
          `  当前 Activity: ${activity.component ?? '未知'}`,
          d.success ? null : d.output,
        ]
          .filter(Boolean)
          .join('\n'),
    )
    return result.success ? 0 : 1
  },

  async stop(ctx) {
    const pkg = ctx.positional[0] ?? ctx.cfg.defaultPackage
    if (!pkg) throw new Error('用法: stop <包名>')
    const device = await ctx.getDevice('stop')
    const result = await device.stop(pkg)
    ctx.io.emit(jsonSafe(result), (d) => `force-stop ${d.package}`)
    return 0
  },

  async clear(ctx) {
    const pkg = ctx.positional[0] ?? ctx.cfg.defaultPackage
    if (!pkg) throw new Error('用法: clear <包名>')
    const device = await ctx.getDevice('clear')
    const result = await device.clearData(pkg)
    ctx.io.emit(jsonSafe(result), (d) => `${d.success ? '✓' : '✗'} pm clear ${d.package}`)
    return result.success ? 0 : 1
  },

  async grant(ctx) {
    const pkg = ctx.positional[0] ?? ctx.cfg.defaultPackage
    if (!pkg) throw new Error('用法: grant <包名>')
    const device = await ctx.getDevice('grant')
    const result = await device.grantPermissions(pkg)
    ctx.io.emit(
      jsonSafe(result),
      (d) =>
        d.granted.length
          ? `已授予:\n${d.granted.join('\n')}${d.failed.length ? `\n失败:\n${d.failed.map((f) => `${f.permission}: ${f.error}`).join('\n')}` : ''}`
          : '没有需要补授的运行时权限',
    )
    return result.failed.length > 0 ? 1 : 0
  },

  async packages(ctx) {
    const device = await ctx.getDevice('packages')
    const list = await device.listPackages({
      thirdPartyOnly: ctx.flags.all !== true,
      filter: ctx.flags.filter ?? null,
    })
    ctx.io.emit({ count: list.length, packages: list }, (d) => d.packages.join('\n'))
    return 0
  },

  async pkg(ctx) {
    const pkg = ctx.positional[0] ?? ctx.cfg.defaultPackage
    if (!pkg) throw new Error('用法: pkg <包名>')
    const device = await ctx.getDevice('pkg')
    const info = await device.packageInfo(pkg)
    ctx.io.emit(
      jsonSafe(info),
      (d) =>
        d.installed
          ? [
              `${d.package} v${d.versionName} (${d.versionCode})`,
              `  targetSdk=${d.targetSdk} minSdk=${d.minSdk} debug=${d.debug} enabled=${d.enabled}`,
              `  lastUpdate=${d.lastUpdateTime}`,
              `  apk=${d.apkPaths?.[0] ?? d.codePath}`,
            ].join('\n')
          : `${d.package} 未安装`,
    )
    return info.installed ? 0 : 1
  },

  async logcat(ctx) {
    const device = await ctx.getDevice('logcat')
    const result = await device.logcat({
      package: ctx.flags.package ?? null,
      grep: ctx.flags.grep ?? null,
      level: ctx.flags.level ?? null,
      tag: ctx.flags.tag ?? null,
      since: ctx.flags.since ?? null,
      clear: ctx.flags.clear === true,
      maxLines: intOf(ctx.flags.max, 1000),
    })
    jsonSafe(result)
    if (ctx.flags.save) {
      fs.writeFileSync(path.resolve(ctx.flags.save), `${result.text}\n`, 'utf8')
    }
    ctx.io.emit(
      { ...jsonSafe(result), saved: ctx.flags.save ? path.resolve(ctx.flags.save) : null },
      (d) => `${d.text}${d.truncated ? `\n[truncated: 共 ${d.total} 行，保留最后 ${d.matched} 行]` : ''}`,
    )
    return 0
  },

  async diagnose(ctx) {
    const pkg = ctx.positional[0] ?? ctx.cfg.defaultPackage
    if (!pkg) throw new Error('用法: diagnose <包名>')
    const device = await ctx.getDevice('diagnose')
    const report = await device.diagnose(pkg, { maxLines: intOf(ctx.flags.max, 4000) })
    const shot = await device.screenshot({ scale: 0.5, label: 'diagnose' }).catch(() => null)
    const activity = await device.currentActivity().catch(() => null)
    ctx.io.emit(
      jsonSafe({ ...report, screenshot: shot?.path ?? null, activity: activity?.component ?? null }),
      (d) =>
        [
          `包      : ${d.package}`,
          `进程    : ${describeProcess(d)}`,
          `当前前台: ${d.activity ?? '未知'}`,
          `结论    : ${d.crashed ? '发现崩溃' : '未发现崩溃特征'}` +
            (d.ignored?.length ? `  （已忽略 ${d.ignored.length} 条属于其他进程的崩溃记录）` : ''),
          '',
          ...d.crashes.map((c, i) => `${i > 0 ? '\n' : ''}${renderCrash(c)}`),
          ...d.tombstones.map((t) => `\n${renderTombstone(t)}`),
          ...d.findings.slice(0, 5).map((f) => `\n--- ${f.kind}${f.process ? ` (${f.process})` : ''} ---\n${f.context.join('\n')}`),
          d.screenshot ? `\n截图: ${d.screenshot}` : null,
        ]
          .filter((line) => line !== null)
          .join('\n'),
    )
    return report.crashed ? 1 : 0
  },

  async shell(ctx) {
    const command = ctx.positional.join(' ')
    if (!command) throw new Error('用法: shell "<设备端命令>"')
    const device = await ctx.getDevice('shell')
    const result = await device.shellLoose(command, { timeoutMs: intOf(ctx.flags.timeout, ctx.cfg.timeoutMs) })
    ctx.io.emit(
      jsonSafe(result),
      (d) => [d.text, d.stderr ? `[stderr] ${d.stderr}` : null].filter(Boolean).join('\n'),
    )
    return result.code === 0 ? 0 : 1
  },

  async rotate(ctx) {
    const value = ctx.positional[0]
    const mapping = { portrait: 0, landscape: 1, reverse_portrait: 2, reverse_landscape: 3 }
    const target = value === undefined ? null : (mapping[value] ?? intOf(value))
    const device = await ctx.getDevice('rotate')
    if (target === null) {
      const current = await device.identity({ refresh: true })
      ctx.io.emit(jsonSafe({ rotation: current.rotation }), (d) => `rotation=${d.rotation}`)
      return 0
    }
    const applied = await device.setRotation(target)
    const activity = await device.currentActivity().catch(() => null)
    ctx.io.emit(
      jsonSafe({ rotation: applied, activity: activity?.component ?? null }),
      (d) => `rotation=${d.rotation}  activity=${d.activity ?? '未知'}`,
    )
    return 0
  },

  async 'kill-server'(ctx) {
    const adb = new Adb({ bin: ctx.cfg.adb })
    await adb.killServer()
    ctx.io.emit({ ok: true }, () => 'adb server 已停止')
    return 0
  },

  async 'start-server'(ctx) {
    const adb = new Adb({ bin: ctx.cfg.adb })
    await adb.ensureServer()
    ctx.io.emit({ ok: true }, () => 'adb server 已启动')
    return 0
  },
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parseRegion(value) {
  if (!value || value === true) return null
  const parts = String(value).split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error('--region 需要 4 个数字: x,y,w,h')
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
}

function shortIdText(value) {
  const slash = String(value).indexOf('/')
  return slash >= 0 ? value.slice(slash + 1) : value
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ── entry ───────────────────────────────────────────────────────────────────

export async function main(argv) {
  const ctx = createContext(argv)
  try {
    const handler = commands[ctx.command]
    if (!handler) {
      process.stderr.write(`未知命令: ${ctx.command}\n\n${HELP}`)
      return 2
    }
    return (await handler(ctx)) ?? 0
  } catch (error) {
    const message = error?.message ?? String(error)
    if (ctx.io.json) {
      process.stdout.write(`${JSON.stringify({ error: message, name: error?.name ?? 'Error', hint: error?.hint ?? null }, null, 2)}\n`)
    } else {
      process.stderr.write(`\n[error] ${message}\n`)
      if (error?.hint) process.stderr.write(`[hint] ${error.hint}\n`)
    }
    return 1
  } finally {
    await ctx.closeDevice()
  }
}

export { commands, jsonSafe }
