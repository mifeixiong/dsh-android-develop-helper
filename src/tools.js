/**
 * DSH tool definitions.
 *
 * Deliberately nine tools, not twenty-five.  The objective is to make one
 * scenario excellent — an agent operating an emulator to build, inspect and
 * debug an app — so each tool covers a coherent area and returns enough evidence
 * that the next decision does not need a follow-up call:
 *
 *   android_devices     which emulators exist, and which one we are pinned to
 *   android_doctor      is the whole pipeline healthy
 *   android_screenshot  what the screen looks like (crop + downscale built in)
 *   android_ui          what the screen *contains*, as an indexed element list
 *   android_tap         act on an element by text / id / desc / node / point
 *   android_input       text entry, keys and gestures
 *   android_app         install / launch / stop / uninstall / inspect
 *   android_logcat      filtered logs with a crash verdict
 *   android_wait        wait for a condition instead of sleeping
 *
 * The definitions are plain objects matching the `tools` registry contract, so
 * this module has no import of the harness and can also back the CLI, an MCP
 * bridge, or a test harness.
 */
import path from 'node:path'
import fs from 'node:fs'
import { AndroidSession } from './manager.js'
import { rowsToText } from './uitree.js'

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

const OUTPUT = (properties) => ({
  schema: { type: 'object', additionalProperties: true, properties },
  render: (_args, value) => text(value?.summary ?? JSON.stringify(value, null, 2)),
})

const stringProp = (description) => ({ type: 'string', description })
const numberProp = (description) => ({ type: 'number', description })
const boolProp = (description) => ({ type: 'boolean', description })

/** Short label for one UI row, used by the renderers. */
function rowLine(row) {
  const parts = [`#${row.node}`, row.tag]
  if (row.text) parts.push(JSON.stringify(row.text))
  if (row.desc) parts.push(`desc=${JSON.stringify(row.desc)}`)
  if (row.id) parts.push(`id=${row.id}`)
  if (row.bounds) parts.push(`@${row.bounds.cx},${row.bounds.cy}`)
  if (row.flags) parts.push(`[${row.flags.join(',')}]`)
  return parts.join(' ')
}

/** A compact screen digest reused by several tools. */
function digest(rows, limit = 40) {
  const lines = rows.slice(0, limit).map(rowLine)
  if (rows.length > limit) lines.push(`… 另有 ${rows.length - limit} 条`)
  return lines.join('\n')
}

/**
 * Build the tool catalogue.
 *
 * @param {{ session?: AndroidSession, cwd?: string }} [options]
 */
export function createTools(options = {}) {
  const session = options.session ?? new AndroidSession({})
  const cwd = options.cwd ?? process.cwd()
  const resolveLocal = (file) => (path.isAbsolute(file) ? file : path.resolve(cwd, file))

  return [
    // ── discovery ───────────────────────────────────────────────────────────
    {
      name: 'android_devices',
      description:
        'List every reachable Android emulator/device and show which one the other android_* tools are pinned to. ' +
        'Probes the vendor ADB port ranges (MuMu 16384/7555, LDPlayer 5555+, Nox 62001+, AVD 5554+) and de-duplicates ' +
        'the several serials one emulator instance exposes, so multi-emulator setups do not produce "more than one device". ' +
        'With `launch: true` it also starts the emulator itself when none is listening, which is the only step ' +
        '`adb connect` cannot do.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          probe: boolProp('Probe ADB ports (default true). Set false for a fast `adb devices` only.'),
          refresh: boolProp('Drop the cached connection and resolve again.'),
          launch: boolProp(
            'Start the emulator if nothing is listening, then wait for it to appear. ' +
              'No-op when an instance is already running.',
          ),
          launchTimeoutMs: numberProp('How long to wait for a launched emulator (default 180000).'),
        },
      },
      output: OUTPUT({ summary: stringProp('Rendered device inventory') }),
      async execute(args) {
        if (args.refresh) await session.reset()
        let launch = null
        if (args.launch) {
          const { launchEmulator } = await import('./emulator.js')
          launch = await launchEmulator(session.cfg, {
            wait: true,
            timeoutMs: clamp(args.launchTimeoutMs ?? 180000, 5000, 900000),
          })
          await session.reset()
        }
        const inventory = await session.inventory({ probe: args.probe !== false })
        const { discoverVendorInstances, resolveEmulatorType } = await import('./emulator.js')
        const emulatorType = resolveEmulatorType(session.cfg)
        const vendor = await discoverVendorInstances(emulatorType).catch(() => ({
          vendor: emulatorType,
          source: null,
          instances: [],
        }))
        const lines = inventory.devices.map(
          (d) => `${d.state === 'device' ? '●' : '○'} ${d.serial.padEnd(20)} ${d.state.padEnd(12)} ${d.model ?? '?'}`,
        )
        if (launch) {
          lines.unshift(
            launch.alreadyRunning
              ? '模拟器: 已有实例在运行'
              : launch.launched
                ? `模拟器: 已启动 ${launch.label}${launch.serial ? ` → ${launch.serial}` : ''}`
                : `模拟器: 未启动（${launch.note ?? '未知原因'}）`,
          )
        }
        if (vendor.instances.length) {
          lines.push(
            `厂商实例 (${vendor.vendor}):`,
            ...vendor.instances.map(
              (i) =>
                `  [${i.index}] ${i.name ?? '?'}  adb=${i.adbHost}:${i.adbPort}  ` +
                `${i.androidVersion ? `android=${i.androidVersion}  ` : ''}${i.running ? '运行中' : '已停止'}`,
            ),
          )
        }
        if (inventory.probedPorts.length) lines.push(`探测到开放端口: ${inventory.probedPorts.join(', ')}`)
        lines.push(`adb: ${inventory.adb}`)
        lines.push(`当前固定设备: ${inventory.selected ?? '(尚未解析，其他工具会自动解析)'}`)
        return {
          summary: lines.join('\n'),
          launch,
          vendorInstances: vendor.instances,
          vendorSource: vendor.source,
          devices: inventory.devices,
          probedPorts: inventory.probedPorts,
          distinctInstances: inventory.distinctInstances,
          selected: inventory.selected,
        }
      },
    },

    {
      name: 'android_doctor',
      description:
        'Self-check the whole Android pipeline: adb binary, device online, boot state, screen geometry, ' +
        'screenshot compression, UI-tree readability and the current Activity. Run this first when any android_* tool misbehaves.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: OUTPUT({ summary: stringProp('Rendered check list') }),
      async execute() {
        const report = await session.withDevice((device) => device.doctor(), { label: 'doctor' })
        const lines = [`设备: ${report.serial}`, `adb : ${report.adb}`, '']
        for (const check of report.checks) lines.push(`${check.ok ? '✓' : '✗'} ${check.name.padEnd(14)} ${check.detail}`)
        for (const warning of report.warnings) lines.push(`! ${warning}`)
        return { ...report, summary: lines.join('\n') }
      },
    },

    // ── observation ─────────────────────────────────────────────────────────
    {
      name: 'android_screenshot',
      description:
        'Capture the emulator screen. The framebuffer is cropped and downscaled before PNG encoding, so a 720x1280 ' +
        'screen that is 3.5 MB raw becomes tens of KB. Returns the artifact path — read that file to actually see the image.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scale: numberProp('Downscale factor, 0.05–1 (default 0.5). Use 1 only when fine detail matters.'),
          region: {
            type: 'object',
            additionalProperties: false,
            description: 'Crop before scaling. Coordinates are device pixels.',
            properties: {
              x: numberProp('Left edge'),
              y: numberProp('Top edge'),
              width: numberProp('Width'),
              height: numberProp('Height'),
            },
          },
          label: stringProp('Artifact name prefix (default "tool").'),
            },
      },
      output: OUTPUT({ summary: stringProp('Artifact path and geometry') }),
      async execute(args) {
        const shot = await session.withDevice(
          (device) =>
            device.screenshot({
              scale: clamp(args.scale ?? 0.5, 0.05, 1),
              region: args.region ?? null,
              label: args.label ?? 'tool',
            }),
          { label: 'screenshot' },
        )
        const summary =
          `${shot.path}\n${shot.sourceWidth}x${shot.sourceHeight} → ${shot.width}x${shot.height} ` +
          `(${(shot.rawBytes / 1024).toFixed(0)}KB → ${(shot.bytes / 1024).toFixed(0)}KB, ${shot.compressionRatio.toFixed(1)}x)`
        return {
          summary,
          path: shot.path,
          width: shot.width,
          height: shot.height,
          sourceWidth: shot.sourceWidth,
          sourceHeight: shot.sourceHeight,
          bytes: shot.bytes,
          hash: shot.hash,
        }
      },
    },

    {
      name: 'android_ui',
      description:
        'Read the UI hierarchy as a compact, indexed element list: `#N Tag "text" id=... @x,y [tap,scroll]`. ' +
        'The raw uiautomator XML is around 34 KB; this digest is usually under 3 KB while keeping every actionable element. ' +
        'Pass the #N index to android_tap with `node`. Results are cached briefly — pass refresh for the live screen. ' +
        'By DEFAULT only nodes currently visible on screen are included, because that is what a compressed dump reports: ' +
        'a row scrolled below the fold is simply absent, not empty. Pass `compressed: false` to dump the whole view tree ' +
        'including off-screen nodes (slower, larger), or scroll and dump again.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          refresh: boolProp('Bypass the short-lived UI cache and dump now (default false).'),
          labelsOnly: boolProp('Only elements carrying text/content-desc (much smaller output).'),
          maxNodes: numberProp('Maximum rows to return (default 120).'),
          package: stringProp('Restrict to one package name.'),
          compressed: boolProp(
            'Default true: visible nodes only, and uiautomator prunes unlabelled layout containers. ' +
              'Set false to include off-screen nodes (needed when a row is scrolled out of view).',
          ),
          includeScreenshot: boolProp('Also capture a screenshot in the same call.'),
        },
      },
      output: OUTPUT({ summary: stringProp('Indexed element list') }),
      async execute(args) {
        return session.withDevice(
          async (device) => {
            const view = await device.uiRows({
              refresh: args.refresh === true,
              labelsOnly: args.labelsOnly === true,
              maxNodes: clamp(args.maxNodes ?? 120, 1, 500),
              package: args.package ?? null,
              compressed: args.compressed !== false,
            })
            const activity = await device.currentActivity().catch(() => null)
            let screenshot = null
            if (args.includeScreenshot) {
              screenshot = (await device.screenshot({ scale: 0.5, label: 'ui' })).path
            }
            const header = [
              `activity: ${activity?.component ?? '未知'}`,
              `屏幕: ${view.screen ? `${view.screen.width}x${view.screen.height}` : '?'}  旋转 ${view.rotation}`,
              `节点: ${view.total} → ${view.returned} 条 (来源 ${view.source})`,
              screenshot ? `screenshot: ${screenshot}` : null,
            ]
              .filter(Boolean)
              .join('\n')
            return {
              summary: `${header}\n${rowsToText(view.rows)}`,
              activity: activity?.component ?? null,
              screen: view.screen,
              total: view.total,
              rows: view.rows.map((row) => ({
                node: row.node,
                tag: row.tag,
                text: row.text ?? null,
                desc: row.desc ?? null,
                id: row.id ?? null,
                center: row.bounds ? `${row.bounds.cx},${row.bounds.cy}` : null,
                flags: row.flags ?? [],
              })),
              screenshot,
            }
          },
          { label: 'ui' },
        )
      },
    },

    // ── interaction ─────────────────────────────────────────────────────────
    {
      name: 'android_tap',
      description:
        'Tap an element. Prefer a semantic target (text / id / desc / node) over raw coordinates: the element is ' +
        'resolved through the UI tree, the nearest clickable ancestor is used when a label sits inside a button, and ' +
        'the tap waits for the screen to settle. With `wait: true` it also returns the resulting element list and a ' +
        'screenshot in the same call, replacing the tap → sleep → dump → screenshot sequence.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: stringProp('Visible text to match (substring unless exact).'),
          id: stringProp('resource-id, with or without the package prefix.'),
          desc: stringProp('content-desc to match.'),
          node: numberProp('Row index from android_ui (#N).'),
          x: numberProp('Raw X coordinate; requires y.'),
          y: numberProp('Raw Y coordinate; requires x.'),
          exact: boolProp('Require exact text/desc equality.'),
          long: boolProp('Long press instead of tap.'),
          wait: boolProp('After tapping, wait for idle and return the new element list + screenshot.'),
          timeoutMs: numberProp('How long to wait for the target to appear (default 5000).'),
        },
      },
      output: OUTPUT({ summary: stringProp('Tap result and follow-up screen state') }),
      async execute(args) {
        const hasPoint = Number.isFinite(args.x) && Number.isFinite(args.y)
        const selector =
          args.node !== undefined
            ? null
            : args.id
              ? { id: args.id }
              : args.desc
                ? { desc: args.desc, exact: args.exact === true }
                : args.text
                  ? { text: args.text, exact: args.exact === true }
                  : null
        if (!hasPoint && !selector && args.node === undefined) {
          throw new Error('android_tap 需要 text / id / desc / node 之一，或同时给出 x 和 y')
        }

        return session.withDevice(
          async (device) => {
            if (args.wait === true) {
              const result = await device.tapAndWait(
                args.node !== undefined ? args.node : hasPoint ? { x: args.x, y: args.y } : selector,
                { maxNodes: 120, exact: args.exact === true, long: args.long === true },
              )
              const header = [
                `tap -> ${result.point.x},${result.point.y}  idle=${result.idle.idle}  ${result.elapsedMs}ms`,
                `activity: ${result.activity?.component ?? '未知'}`,
                `screenshot: ${result.screenshot}`,
                `# ${result.rows.length} 条可交互元素`,
              ].join('\n')
              return {
                summary: `${header}\n${digest(result.rows, 50)}`,
                point: result.point,
                idle: result.idle.idle,
                elapsedMs: result.elapsedMs,
                activity: result.activity?.component ?? null,
                screenshot: result.screenshot,
                rows: result.rows.map((row) => ({
                  node: row.node,
                  tag: row.tag,
                  text: row.text ?? null,
                  id: row.id ?? null,
                  center: row.bounds ? `${row.bounds.cx},${row.bounds.cy}` : null,
                })),
              }
            }

            let point
            if (args.node !== undefined) {
              const row = await device.tapRow(args.node, { refresh: true })
              point = { x: row.x, y: row.y, via: 'node' }
            } else if (hasPoint) {
              await device.tap(args.x, args.y)
              point = { x: args.x, y: args.y, via: 'coordinates' }
            } else {
              const target = await device.tapSelector(selector, {
                refresh: true,
                long: args.long === true,
                durationMs: args.durationMs ?? 800,
              })
              point = { x: target.x, y: target.y, via: target.via }
            }
            const activity = await device.currentActivity().catch(() => null)
            return {
              summary: `tap -> ${point.x},${point.y} (${point.via});  activity: ${activity?.component ?? '未知'}`,
              point,
              activity: activity?.component ?? null,
            }
          },
          { label: 'tap' },
        )
      },
    },

    {
      name: 'android_input',
      description:
        'Send input that is not a tap: text entry, hardware keys, swipes, scrolling and long presses. ' +
        'Text is escaped for both shells; non-ASCII text needs the ADBKeyboard IME, otherwise only the ASCII part is ' +
        'typed and a warning is returned. Prefer `scroll` over swipes with guessed coordinates.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['text', 'key', 'swipe', 'scroll', 'long_press'],
            description: 'Which input to send.',
          },
          text: stringProp('action=text: the string to type.'),
          replace: boolProp('action=text: clear the focused field first.'),
          key: stringProp('action=key: key name (home, back, enter, …) or a numeric keycode.'),
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'action=scroll: where the content moves.' },
          times: numberProp('action=scroll: repeat count (default 1).'),
          fromX: numberProp('action=swipe: start X.'),
          fromY: numberProp('action=swipe: start Y.'),
          toX: numberProp('action=swipe: end X.'),
          toY: numberProp('action=swipe: end Y.'),
          durationMs: numberProp('Gesture duration in milliseconds (swipe default 300, long press default 800).'),
        },
      },
      output: OUTPUT({ summary: stringProp('Input result') }),
      async execute(args) {
        return session.withDevice(
          async (device) => {
            switch (args.action) {
              case 'text': {
                if (typeof args.text !== 'string') throw new Error('action=text 需要 text 参数')
                const result = await device.text(args.text, { replace: args.replace === true })
                return {
                  summary: `text (${result.method}) ${result.characters} 字符${result.warning ? `\n[warn] ${result.warning}` : ''}`,
                  ...result,
                }
              }
              case 'key': {
                if (!args.key) throw new Error('action=key 需要 key 参数')
                const result = await device.key(args.key)
                return { summary: `keyevent ${result.codes.join(',')}`, ...result }
              }
              case 'swipe': {
                for (const field of ['fromX', 'fromY', 'toX', 'toY']) {
                  if (!Number.isFinite(args[field])) throw new Error(`action=swipe 需要 ${field}`)
                }
                const result = await device.swipe(
                  { x: args.fromX, y: args.fromY },
                  { x: args.toX, y: args.toY },
                  { durationMs: args.durationMs ?? 300 },
                )
                return { summary: `swipe ${args.fromX},${args.fromY} -> ${args.toX},${args.toY}`, ...result }
              }
              case 'scroll': {
                const direction = args.direction ?? 'down'
                const times = clamp(args.times ?? 1, 1, 50)
                for (let i = 0; i < times; i++) {
                  await device.scroll(direction, { durationMs: args.durationMs ?? 320 })
                  if (i < times - 1) await device.waitIdle({ timeoutMs: 2000, allowNever: true })
                }
                return { summary: `scroll ${direction} x${times}` }
              }
              case 'long_press': {
                if (!Number.isFinite(args.fromX) || !Number.isFinite(args.fromY)) {
                  throw new Error('action=long_press 需要 fromX / fromY')
                }
                const result = await device.longPress(args.fromX, args.fromY, args.durationMs ?? 800)
                return { summary: `long_press ${args.fromX},${args.fromY} (${result.durationMs}ms)`, ...result }
              }
              default:
                throw new Error(`未知 action: ${args.action}`)
            }
          },
          { label: 'input' },
        )
      },
    },

    {
      name: 'android_wait',
      description:
        'Wait for a condition instead of sleeping: text or resource-id appearing, an element disappearing, a specific ' +
        'Activity becoming foreground, or the screen becoming visually stable. On timeout it reports the current ' +
        'Activity, the visible element list and a screenshot, so a failed wait is diagnosable rather than just slow.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['for'],
        properties: {
          for: {
            type: 'string',
            enum: ['text', 'id', 'activity', 'gone', 'idle'],
            description: 'Condition to wait for.',
          },
          value: stringProp('Text, resource-id or Activity substring/regex (not needed for idle).'),
          exact: boolProp('for=text: require exact equality.'),
          timeoutMs: numberProp('Timeout in milliseconds (default 15000).'),
        },
      },
      output: OUTPUT({ summary: stringProp('Wait outcome') }),
      async execute(args) {
        return session.withDevice(
          async (device) => {
            const timeoutMs = clamp(args.timeoutMs ?? 15000, 500, 300000)
            const started = Date.now()
            switch (args.for) {
              case 'text': {
                const node = await device.waitText(args.value, { timeoutMs, exact: args.exact === true })
                return { summary: `文本 "${args.value}" 出现 (${Date.now() - started}ms) @${node.boundsRaw}`, bounds: node.boundsRaw }
              }
              case 'id': {
                const node = await device.waitId(args.value, { timeoutMs })
                return { summary: `元素 "${args.value}" 出现 (${Date.now() - started}ms) @${node.boundsRaw}`, bounds: node.boundsRaw }
              }
              case 'activity': {
                const current = await device.waitActivity(args.value, { timeoutMs })
                return { summary: `activity = ${current.component} (${Date.now() - started}ms)`, activity: current.component }
              }
              case 'gone': {
                await device.waitGone({ text: args.value, id: args.value }, { timeoutMs })
                return { summary: `元素 "${args.value}" 已消失 (${Date.now() - started}ms)` }
              }
              case 'idle': {
                const result = await device.waitIdle({ timeoutMs, allowNever: true })
                return { summary: `idle=${result.idle} frames=${result.frames} (${Date.now() - started}ms)`, ...result }
              }
              default:
                throw new Error(`未知等待条件: ${args.for}`)
            }
          },
          { label: 'wait' },
        )
      },
    },

    // ── application lifecycle ───────────────────────────────────────────────
    {
      name: 'android_app',
      description:
        'Application lifecycle and inspection. `install` verifies the on-device APK hash against the local file — ' +
        '`adb install` reports Success in cases where the package was not actually replaced, so the verification is not ' +
        'optional by default. `launch` resolves the launcher Activity itself when only a package name is given.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['current', 'install', 'launch', 'stop', 'uninstall', 'clear', 'grant', 'list', 'info', 'apk_info'],
            description: 'Operation to perform.',
          },
          package: stringProp('Target package name.'),
          apk: stringProp('action=install/apk_info: path to the APK.'),
          verify: boolProp('action=install: verify the device hash after install (default true).'),
          grant: boolProp('action=install: grant runtime permissions (default true).'),
          extras: {
            type: 'object',
            additionalProperties: true,
            description: 'action=launch: Intent extras (string/number/boolean).',
          },
          thirdPartyOnly: boolProp('action=list: only third-party packages (default true).'),
          filter: stringProp('action=list: substring filter.'),
        },
      },
      output: OUTPUT({ summary: stringProp('Operation result') }),
      async execute(args) {
        const pkg = args.package ?? session.cfg.defaultPackage ?? null
        return session.withDevice(
          async (device) => {
            switch (args.action) {
              case 'current': {
                const activity = await device.currentActivity()
                return { summary: activity.component ?? '未知', ...activity }
              }
              case 'install': {
                if (!args.apk) throw new Error('action=install 需要 apk 参数')
                const { install } = await import('./app.js')
                const report = await install(device.adb, resolveLocal(args.apk), {
                  verify: args.verify !== false,
                  grantPermissions: args.grant !== false,
                })
                const lines = [
                  `${report.success ? '✓' : '✗'} install ${report.apk} (${(report.sizeBytes / 1048576).toFixed(1)} MB)`,
                  report.package ? `package: ${report.package}` : 'package: (未识别)',
                  report.verified === true
                    ? '校验: 设备端 SHA256 与本地一致'
                    : report.verified === false
                      ? `校验失败: ${report.verifyNote ?? ''}`
                      : `校验跳过: ${report.verifyNote ?? ''}`,
                ]
                if (report.failure) lines.push(`失败原因: ${report.failure}`)
                return { summary: lines.join('\n'), ...report, apk: report.apk }
              }
              case 'launch': {
                if (!pkg && !args.package) throw new Error('action=launch 需要 package（或 package/Activity）')
                const result = await device.start(args.package ?? pkg, {
                  extras: args.extras ?? {},
                  forceStop: true,
                })
                const activity = await device.currentActivity().catch(() => null)
                return {
                  summary: `${result.success ? '✓' : '✗'} launch ${args.package ?? pkg} via ${result.method}${result.resolvedVia ? ` (${result.resolvedVia})` : ''}\n当前 Activity: ${activity?.component ?? '未知'}`,
                  ...result,
                  current: activity?.component ?? null,
                }
              }
              case 'stop': {
                if (!pkg) throw new Error('action=stop 需要 package')
                const result = await device.stop(pkg)
                return { summary: `force-stop ${pkg}`, ...result }
              }
              case 'uninstall': {
                if (!pkg) throw new Error('action=uninstall 需要 package')
                const result = await device.uninstall(pkg)
                return { summary: `${result.success ? '✓' : '✗'} uninstall ${pkg}: ${result.output}`, ...result }
              }
              case 'clear': {
                if (!pkg) throw new Error('action=clear 需要 package')
                const result = await device.clearData(pkg)
                return { summary: `${result.success ? '✓' : '✗'} pm clear ${pkg}`, ...result }
              }
              case 'grant': {
                if (!pkg) throw new Error('action=grant 需要 package')
                const result = await device.grantPermissions(pkg)
                return {
                  summary: result.granted.length
                    ? `已授予 ${result.granted.length} 个运行时权限:\n${result.granted.join('\n')}`
                    : '没有需要补授的运行时权限',
                  ...result,
                }
              }
              case 'list': {
                const packages = await device.listPackages({
                  thirdPartyOnly: args.thirdPartyOnly !== false,
                  filter: args.filter ?? null,
                })
                return { summary: packages.join('\n') || '(无匹配包)', count: packages.length, packages }
              }
              case 'info': {
                if (!pkg) throw new Error('action=info 需要 package')
                const info = await device.packageInfo(pkg)
                return {
                  summary: info.installed
                    ? `${pkg} v${info.versionName} (${info.versionCode})\n  targetSdk=${info.targetSdk} minSdk=${info.minSdk} debug=${info.debug}\n  apk=${info.apkPaths?.[0] ?? info.codePath}`
                    : `${pkg} 未安装`,
                  ...info,
                }
              }
              case 'apk_info': {
                if (!args.apk) throw new Error('action=apk_info 需要 apk 参数')
                const { apkSummary } = await import('./apk.js')
                const summary = apkSummary(resolveLocal(args.apk))
                return {
                  summary: [
                    `package: ${summary.package ?? '(未能解析)'}`,
                    `version: ${summary.versionName ?? '?'} (${summary.versionCode ?? '?'})`,
                    `sdk: min=${summary.minSdk ?? '?'} target=${summary.targetSdk ?? '?'}`,
                    `size: ${(summary.sizeBytes / 1048576).toFixed(2)} MB`,
                  ].join('\n'),
                  ...summary,
                }
              }
              default:
                throw new Error(`未知 action: ${args.action}`)
            }
          },
          { label: 'app' },
        )
      },
    },

    // ── diagnostics ─────────────────────────────────────────────────────────
    {
      name: 'android_logcat',
      description:
        'Read logcat, filtered on the device where possible (time window, pid) and then by level/tag/regex. ' +
        'With `crash: true` it does not just grep: it parses FATAL EXCEPTION blocks into the exception type, message, ' +
        'call stack and — most usefully — the first frame belonging to the app, i.e. the exact `File.java:line` to open. ' +
        'It also recognises ANRs, native tombstones, OOM kills and process deaths, which a plain `grep FATAL` misses. ' +
        'Combine with android_screenshot to capture the failing frame.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          package: stringProp('Restrict to one app (filters by pid and adds the crash buffer).'),
          grep: stringProp('Regular expression applied to each line.'),
          level: { type: 'string', enum: ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'], description: 'Minimum level.' },
          tag: stringProp('Exact log tag.'),
          since: stringProp('Only entries at or after this time, e.g. "09-19 20:00:00.000".'),
          maxLines: numberProp('Keep only the last N matching lines (default 200).'),
          clear: boolProp('Clear the buffers before reading.'),
          crash: boolProp('Return a parsed crash verdict with the failing app frame instead of raw lines.'),
        },
      },
      output: OUTPUT({ summary: stringProp('Log text and optional parsed crash') }),
      async execute(args) {
        return session.withDevice(
          async (device) => {
            if (args.crash === true) {
              const { renderCrash, renderTombstone, describeProcess } = await import('./logcat.js')
              const report = await device.diagnose(args.package ?? session.cfg.defaultPackage, {
                maxLines: clamp(args.maxLines ?? 4000, 100, 20000),
              })
              const lines = [
                `包      : ${report.package}`,
                `进程    : ${describeProcess(report)}`,
                `结论    : ${report.crashed ? '发现崩溃' : '未发现崩溃特征'}` +
                  (report.ignored?.length ? `  （已忽略 ${report.ignored.length} 条属于其他进程的崩溃记录）` : ''),
                '',
                ...report.crashes.map((c) => renderCrash(c)),
                ...report.tombstones.map((t) => renderTombstone(t)),
                ...report.findings
                  .slice(0, 4)
                  .map((f) => `--- ${f.kind}${f.process ? ` (${f.process})` : ''} ---\n${f.context.slice(0, 8).join('\n')}`),
              ]
              return { ...report, summary: lines.join('\n') }
            }
            const result = await device.logcat({
              package: args.package ?? null,
              grep: args.grep ?? null,
              level: args.level ?? null,
              tag: args.tag ?? null,
              since: args.since ?? null,
              clear: args.clear === true,
              maxLines: clamp(args.maxLines ?? 200, 1, 20000),
            })
            const lines = [result.text || '(无匹配日志)']
            if (result.truncated) lines.push(`[truncated: 共 ${result.total} 行，保留最后 ${result.matched} 行]`)
            return { ...result, summary: lines.join('\n') }
          },
          { label: 'logcat' },
        )
      },
    },
  ]
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** Tool names, for documentation and conflict checks. */
export const TOOL_NAMES = [
  'android_devices',
  'android_doctor',
  'android_screenshot',
  'android_ui',
  'android_tap',
  'android_input',
  'android_wait',
  'android_app',
  'android_logcat',
]

export { AndroidSession, fs }
