/**
 * Starting an emulator, not just connecting to one.
 *
 * `adb connect` only reaches an instance that is already running; the objective's
 * "模拟器管理" also covers bringing one up.  Each vendor ships a different
 * launcher executable, and none of them is on `PATH`, so discovery is a list of
 * known install locations per vendor plus an optional explicit override.
 *
 * Launching is deliberately detached: the emulator outlives this process, and a
 * killed parent must not take the VM with it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { probePorts, sleep } from './devices.js'

const PLAYER = process.platform === 'win32' ? '.exe' : ''

/** Known launcher locations per vendor, most specific first. */
export function launcherCandidates(emulatorType, extraRoots = []) {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? null

  const candidates = []
  const push = (file, args = [], label = null) => {
    if (!file) return
    candidates.push({ path: file, args, label: label ?? path.basename(file) })
  }

  switch (emulatorType) {
    case 'mumu':
      // MuMu 12 exposes its instances through MuMuManager, which is the
      // script-friendly path; the shell executable is the fallback a person
      // would double-click.
      push(path.join(programFiles, 'Netease', 'MuMuPlayer-12.0', 'nx_main', `MuMuManager${PLAYER}`),
        ['control', '--vmindex', '0', 'launch'], 'MuMuManager (启动实例 0)')
      push(path.join('D:\\Program Files', 'Netease', 'MuMu', 'nx_main', `MuMuManager${PLAYER}`),
        ['control', '--vmindex', '0', 'launch'], 'MuMuManager (启动实例 0)')
      push(path.join(programFiles, 'Netease', 'MuMu', 'nx_main', `MuMuManager${PLAYER}`),
        ['control', '--vmindex', '0', 'launch'], 'MuMuManager (启动实例 0)')
      push(path.join(programFiles, 'Netease', 'MuMuPlayer-12.0', 'shell', `MuMuPlayer${PLAYER}`))
      push(path.join('D:\\Program Files', 'Netease', 'MuMuPlayer-12.0', 'shell', `MuMuPlayer${PLAYER}`))
      push(path.join('D:\\Program Files', 'Netease', 'MuMu', 'nx_main', `MuMuNxMain${PLAYER}`))
      push(path.join(programFiles, 'Netease', 'MuMu', 'nx_main', `MuMuNxMain${PLAYER}`))
      break
    case 'ldplayer':
      push(path.join('C:\\LDPlayer', 'LDPlayer9', `dnplayer${PLAYER}`))
      push(path.join('C:\\LDPlayer', 'LDPlayer4', `dnplayer${PLAYER}`))
      push(path.join(programFiles, 'LDPlayer', 'LDPlayer9', `dnplayer${PLAYER}`))
      push(path.join('D:\\LDPlayer', 'LDPlayer9', `dnplayer${PLAYER}`))
      break
    case 'nox':
      push(path.join(programFilesX86, 'Nox', 'bin', `Nox${PLAYER}`))
      push(path.join(programFiles, 'Nox', 'bin', `Nox${PLAYER}`))
      break
    case 'genymotion':
      push(path.join(programFiles, 'Genymobile', 'Genymotion', `genymotion${PLAYER}`))
      push(path.join(localAppData, 'Programs', 'Genymotion', `genymotion${PLAYER}`))
      break
    case 'avd':
      // The AVD launcher comes from the SDK's `emulator` package, which the
      // minimal build SDK does not install — see the message in `launchEmulator`.
      if (sdk) push(path.join(sdk, 'emulator', `emulator${PLAYER}`))
      break
    default:
      break
  }

  for (const root of extraRoots) {
    if (root) push(root)
  }

  return candidates
}

/** First candidate that exists on disk. */
export function findLauncher(emulatorType, extraRoots = []) {
  for (const candidate of launcherCandidates(emulatorType, extraRoots)) {
    try {
      if (fs.statSync(candidate.path).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

/**
 * Start the emulator and (optionally) wait until adb can see it.
 *
 * @param {object} cfg
 * @param {{ wait?: boolean, timeoutMs?: number, launcher?: string, args?: string[], onLog?: Function }} [options]
 * @returns {Promise<{launched:boolean, launcher:string|null, label:string|null, alreadyRunning:boolean, serial:string|null, waitedMs:number, note?:string}>}
 */
export async function launchEmulator(cfg, options = {}) {
  const { wait = true, timeoutMs = 180000, launcher = null, args = null, onLog = null } = options

  // If a device is already reachable there is nothing to start; saying so is more
  // useful than spawning a second instance.
  const open = await probePorts(cfg.portUniverse, { timeoutMs: 250 })
  if (open.length > 0) {
    return {
      launched: false,
      alreadyRunning: true,
      launcher: null,
      label: null,
      serial: null,
      waitedMs: 0,
      note: `已有模拟器在监听端口 ${open.join(', ')}，未重复启动。`,
    }
  }

  const resolved = launcher
    ? { path: launcher, args: args ?? [], label: path.basename(launcher) }
    : findLauncher(resolveEmulatorType(cfg))
  if (!resolved) {
    const type = resolveEmulatorType(cfg)
    const hint =
      type === 'avd'
        ? '未找到 AVD 启动器。最小构建 SDK 不含 emulator 包，' +
          '可执行 `sdkmanager "emulator" "system-images;android-35;google_apis;x86_64"`，' +
          '或用 --launcher 显式指定 emulator.exe 路径。'
        : `未找到 ${type} 的启动器。请用 --launcher <路径> 显式指定，` +
          '或用 `config --set emulatorType=<mumu|ldplayer|nox|avd>` 指明厂商。'
    return { launched: false, alreadyRunning: false, launcher: null, label: null, serial: null, waitedMs: 0, note: hint }
  }

  const argv = [...(resolved.args ?? []), ...(args ?? [])]
  const child = spawn(resolved.path, argv, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  onLog?.(`已启动 ${resolved.label} (pid ${child.pid})`)

  const started = Date.now()
  if (!wait) {
    return {
      launched: true,
      alreadyRunning: false,
      launcher: resolved.path,
      label: resolved.label,
      serial: null,
      waitedMs: 0,
    }
  }

  const deadline = Date.now() + timeoutMs
  let connected = []
  while (Date.now() < deadline) {
    await sleep(2500)
    connected = await probePorts(cfg.portUniverse, { timeoutMs: 250 })
    if (connected.length > 0) break
  }

  return {
    launched: true,
    alreadyRunning: false,
    launcher: resolved.path,
    label: resolved.label,
    serial: connected.length ? `127.0.0.1:${connected[0]}` : null,
    waitedMs: Date.now() - started,
    note: connected.length ? undefined : `等待 ${timeoutMs}ms 后仍未探测到模拟器端口。`,
  }
}

/** Vendors whose launcher we know about, for the help text. */
export const LAUNCHABLE_TYPES = ['mumu', 'ldplayer', 'nox', 'genymotion', 'avd']

/**
 * Which vendor is actually installed on this machine, judged by its launcher
 * being on disk.
 *
 * The configured default is `custom`, which knows no vendor ports and has no
 * management CLI — so without this, a machine with MuMu installed would still
 * probe blind until someone set `emulatorType`. Detection only *adds* knowledge;
 * an explicitly configured type always wins, and an unrecognised machine stays
 * on `custom`.
 */
export function detectInstalledEmulator() {
  for (const type of ['mumu', 'ldplayer', 'nox', 'genymotion']) {
    const launcher = findLauncher(type)
    if (launcher) return { type, evidence: launcher.path }
  }
  return null
}

/**
 * The emulator type to act on: the configured one, or whatever is installed when
 * nothing was configured.
 */
export function resolveEmulatorType(cfg = {}) {
  if (cfg.emulatorType && cfg.emulatorType !== 'custom') return cfg.emulatorType
  return detectInstalledEmulator()?.type ?? cfg.emulatorType ?? 'custom'
}

// ── vendor instance discovery ───────────────────────────────────────────────

function runCapture(command, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error.message) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** The vendor's own management CLI, when it has one. */
export function managerCandidates(emulatorType) {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const out = []
  if (emulatorType === 'mumu') {
    for (const root of [
      path.join(programFiles, 'Netease', 'MuMuPlayer-12.0', 'nx_main'),
      path.join('D:\\Program Files', 'Netease', 'MuMu', 'nx_main'),
      path.join(programFiles, 'Netease', 'MuMu', 'nx_main'),
      path.join('D:\\Program Files', 'Netease', 'MuMuPlayer-12.0', 'nx_main'),
    ]) {
      out.push({ path: path.join(root, `MuMuManager${PLAYER}`), kind: 'mumu' })
    }
  }
  if (emulatorType === 'ldplayer') {
    for (const root of ['C:\\LDPlayer\\LDPlayer9', 'C:\\LDPlayer\\LDPlayer4', 'D:\\LDPlayer\\LDPlayer9']) {
      out.push({ path: path.join(root, `ldconsole${PLAYER}`), kind: 'ldplayer' })
    }
  }
  return out
}

/**
 * Ask the vendor how many instances exist and which ADB port each listens on.
 *
 * This removes the one manual step the workflow otherwise cannot avoid.  The
 * objective notes that "MuMu 12 的 ADB 端口需要通过模拟器右上角菜单 → 问题诊断
 * 获取，并非固定值" — but `MuMuManager info -v all` reports `adb_port` directly,
 * so the number never has to be read off a dialog.
 *
 * @returns {Promise<{vendor:string, source:string, instances:Array<object>}>}
 */
export async function discoverVendorInstances(emulatorType, options = {}) {
  const { timeoutMs = 20000 } = options
  for (const manager of managerCandidates(emulatorType)) {
    let exists = false
    try {
      exists = fs.statSync(manager.path).isFile()
    } catch {
      continue
    }
    if (!exists) continue

    if (manager.kind === 'mumu') {
      const result = await runCapture(manager.path, ['info', '-v', 'all'], timeoutMs)
      const parsed = parseJsonLoose(result.stdout)
      if (!parsed) continue
      const instances = Object.values(parsed)
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => ({
          index: String(entry.index ?? '?'),
          name: entry.name ?? null,
          adbHost: entry.adb_host_ip ?? '127.0.0.1',
          adbPort: Number(entry.adb_port) || null,
          androidVersion: entry.android_version ?? null,
          running: entry.is_android_started === true,
          processStarted: entry.is_process_started === true,
          pid: entry.pid ?? null,
          state: entry.player_state ?? null,
        }))
        .filter((entry) => entry.adbPort)
      return { vendor: 'mumu', source: manager.path, instances }
    }

    if (manager.kind === 'ldplayer') {
      // `ldconsole list2` emits one CSV row per instance; field 7 is the ADB port.
      const result = await runCapture(manager.path, ['list2'], timeoutMs)
      const instances = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const fields = line.split(',')
          const adbPort = Number(fields[7])
          return {
            index: fields[0] ?? '?',
            name: fields[1] ?? null,
            adbHost: '127.0.0.1',
            adbPort: Number.isFinite(adbPort) ? adbPort : null,
            running: Number(fields[5]) === 1,
          }
        })
        .filter((entry) => entry.adbPort)
      return { vendor: 'ldplayer', source: manager.path, instances }
    }
  }
  return { vendor: emulatorType, source: null, instances: [] }
}

/** ADB ports the vendor itself reports — exact, unlike probing. */
export async function vendorAdbPorts(emulatorType, options) {
  try {
    const { instances } = await discoverVendorInstances(emulatorType, options)
    return instances.filter((i) => i.running && i.adbPort).map((i) => i.adbPort)
  } catch {
    return []
  }
}

function parseJsonLoose(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}
