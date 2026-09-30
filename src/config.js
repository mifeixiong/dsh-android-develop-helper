/**
 * Configuration for dsh-android-develop-helper.
 *
 * Resolution order (highest priority first):
 *   1. explicit flags passed to the API / CLI
 *   2. environment variables (`ANDROID_HELPER_*`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`)
 *   3. `<project>/config.json`
 *   4. built-in defaults
 *
 * The point of this layer is multi-emulator support: every emulator vendor
 * allocates ADB ports differently, so "ask adb which devices exist" is not
 * enough.  MuMu 12 exposes an unpredictable port that must be read from the
 * emulator UI, LDPlayer/Nox start at 5555/62001, and an AVD can be started with
 * `-ports 5554,9999` which makes `emulator-5554` a lie about the ADB port.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_WINDOWS = process.platform === 'win32'

/** Project root (the directory holding package.json). */
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Default location of the optional user config file. */
export const CONFIG_PATH = path.join(ROOT, 'config.json')

/** Where screenshots / UI dumps / command logs are written. */
export const ARTIFACTS_DIR = path.join(ROOT, 'artifacts')

const ADB_BIN = IS_WINDOWS ? 'adb.exe' : 'adb'

/**
 * Per-vendor port knowledge.
 *
 * `ports` are TCP ports to *try connecting to* during discovery; they are
 * candidates, not claims.  `serialHints` are prefixes that appear verbatim in
 * `adb devices` output for that vendor.
 */
export const EMULATOR_PRESETS = {
  mumu: {
    label: 'MuMu 模拟器 (网易)',
    ports: [16384, 16385, 16386, 16416, 16448, 7555, 5555],
    serialHints: [],
    note: 'MuMu 12 的 ADB 端口不固定，可在模拟器右上角菜单 → 问题诊断 中查看；常见为 16384 / 7555。',
  },
  ldplayer: {
    label: '雷电模拟器 (LDPlayer)',
    ports: [5555, 5557, 5559, 5561, 62001, 62025, 62026, 62027],
    serialHints: [],
    note: '雷电多开实例从 5555 起递增，部分版本使用 62001+。',
  },
  nox: {
    label: '夜神模拟器 (Nox)',
    ports: [62001, 62025, 62026, 62027],
    serialHints: [],
    note: '夜神默认 62001，多开实例依次 +1。',
  },
  avd: {
    label: 'Android Studio AVD',
    ports: [5555, 5557, 5559, 5561, 5563],
    serialHints: ['emulator-'],
    note: '标准 console 端口 5554/5556/…，ADB 端口 = console + 1。使用 -ports a,b 启动时 ADB 端口可能与 serial 不一致，请显式配置 adbPort。',
  },
  genymotion: {
    label: 'Genymotion',
    ports: [5555],
    serialHints: [],
  },
  custom: {
    label: '自定义 / 其他',
    ports: [],
    serialHints: [],
    note: '请通过 adbPort / consolePort / deviceSerial / ports 显式指定。',
  },
}

/**
 * Ports probed during `autoDiscover` when no vendor is pinned.
 * Standard AVD range is 5554-5584; console/ADB pairs are consecutive.
 */
export function defaultPortUniverse(emulatorType) {
  const preset = EMULATOR_PRESETS[emulatorType]
  const ports = new Set(preset?.ports ?? [])
  for (let p = 5554; p <= 5585; p++) ports.add(p) // AVD / 通用
  for (let p = 7555; p <= 7557; p++) ports.add(p) // MuMu 旧版
  for (let p = 16384; p <= 16390; p++) ports.add(p) // MuMu 12
  ports.add(16416)
  ports.add(16448)
  for (let p = 62001; p <= 62030; p++) ports.add(p) // Nox / LDPlayer 多开
  return [...ports].sort((a, b) => a - b)
}

export const DEFAULTS = {
  /** Absolute path to the adb executable. `null` → auto-detect. */
  adbPath: null,
  /** mumu | ldplayer | nox | avd | genymotion | custom */
  emulatorType: 'custom',
  /** Manually specified ADB TCP port (127.0.0.1:<adbPort>). */
  adbPort: null,
  /** Manually specified console port; ADB port is inferred as consolePort + 1. */
  consolePort: null,
  /** Explicit device serial. Highest priority: skips all port inference. */
  deviceSerial: null,
  /** Run `adb devices` / port probing automatically. */
  autoDiscover: true,
  /** Extra candidate TCP ports appended to the universe. */
  ports: [],
  /** Never probe ports whose number is below this. */
  minProbePort: 1024,
  /** Per-command timeout in milliseconds. */
  timeoutMs: 30000,
  /** uiautomator dump timeout (dumps on MuMu are slow: ~2.4s, sometimes worse). */
  dumpTimeoutMs: 25000,
  /** How long a cached UI dump stays valid without `--refresh`. */
  dumpCacheTtlMs: 1500,
  /** Default package, used when the caller does not pass one. */
  defaultPackage: null,
  /** Optional ADBKeyboard IME package for non-ASCII text input. */
  adbKeyboardPackage: 'com.android.adbkeyboard',
  /**
   * Directory for artifacts (logs, screenshots, UI dumps).
   * `flags.cwd` shifts this to `<cwd>/artifacts` unless something more explicit
   * is configured — see `loadConfig`.
   */
  artifactsDir: ARTIFACTS_DIR,
  /** Keep per-run command logs. */
  keepLog: true,
  /** Print every adb command to stderr. */
  echoCommands: false,
}

function envFirst(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function parseIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? n : null
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false
  return fallback
}

/** Read `<root>/config.json` if present, tolerating malformed files. */
export function readConfigFile(configPath = CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/** Persist a partial config update. */
export function writeConfigFile(patch, configPath = CONFIG_PATH) {
  const current = readConfigFile(configPath)
  const next = { ...current, ...patch }
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * Enumerate plausible adb locations without shelling out.
 * Cheap directory probes only — no recursive crawl by default.
 */
export function adbCandidatePaths(extraSearchRoots = []) {
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'

  const candidates = []
  const push = (...parts) => {
    if (parts.some((p) => p === undefined || p === null)) return
    candidates.push(path.join(...parts))
  }

  // Android SDK
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(localAppData, 'Android', 'Sdk'),
    path.join(home, 'Android', 'Sdk'),
  ].filter(Boolean)
  for (const sdk of sdkRoots) push(sdk, 'platform-tools', ADB_BIN)

  // Emulator bundles ship their own adb and it is usually the right version
  // for that emulator's own device bridge.
  push(programFiles, 'Netease', 'MuMuPlayer-12.0', 'shell', ADB_BIN)
  push(programFiles, 'Netease', 'MuMuPlayer-12.0', 'nx_main', ADB_BIN)
  push(programFiles, 'Netease', 'MuMu', 'nx_main', ADB_BIN)
  push('D:\\Program Files', 'Netease', 'MuMu', 'nx_main', ADB_BIN)
  push(programFilesX86, 'Nox', 'bin', ADB_BIN)
  push('C:\\LDPlayer', 'LDPlayer9', ADB_BIN)
  push('C:\\LDPlayer', 'LDPlayer4', ADB_BIN)
  push(programFiles, 'LDPlayer', 'LDPlayer9', ADB_BIN)

  for (const root of extraSearchRoots) {
    if (!root) continue
    push(root, 'platform-tools', ADB_BIN)
    push(root, ADB_BIN)
  }

  return [...new Set(candidates)]
}

/** Resolve a bare `adb` through PATH. */
function adbFromPath() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const full = path.join(dir, ADB_BIN)
    try {
      if (fs.statSync(full).isFile()) return full
    } catch {
      /* keep looking */
    }
  }
  return null
}

/**
 * Bounded recursive search for `adb(.exe)` under a few well-known roots.
 * Depth-limited and failure-tolerant; used only as a last resort.
 */
export function searchAdbOnDisk(roots, maxDepth = 4) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= 8) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= 8) return
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === ADB_BIN.toLowerCase()) {
        found.push(full)
        continue
      }
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase()
        if (name === 'node_modules' || name === '$recycle.bin' || name === 'windows') continue
        walk(full, depth + 1)
      }
    }
  }
  for (const root of roots) {
    try {
      if (fs.statSync(root).isDirectory()) walk(root, 0)
    } catch {
      /* ignore */
    }
  }
  return found
}

/**
 * Find an adb executable.
 * @returns {{ path: string, source: string } | null}
 */
export function discoverAdb({ extraRoots = [], allowDiskSearch = true, configured = null } = {}) {
  if (configured) {
    if (fs.existsSync(configured)) return { path: configured, source: 'config' }
    // Configured but missing: fall through, caller can warn.
  }
  for (const candidate of adbCandidatePaths(extraRoots)) {
    try {
      if (fs.statSync(candidate).isFile()) return { path: candidate, source: 'known-location' }
    } catch {
      /* keep looking */
    }
  }
  const fromPath = adbFromPath()
  if (fromPath) return { path: fromPath, source: 'PATH' }

  if (allowDiskSearch) {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
      ...extraRoots,
    ].filter(Boolean)
    const hits = searchAdbOnDisk(roots, 4)
    if (hits.length > 0) return { path: hits[0], source: 'disk-search' }
  }
  return null
}

/**
 * Build the effective configuration.
 *
 * @param {object} [flags] partial overrides (CLI flags or API options)
 * @returns {object} frozen-in-practice config object
 */
export function loadConfig(flags = {}) {
  const file = readConfigFile(flags.configPath ?? CONFIG_PATH)

  const pick = (key, envNames, parse = (v) => v) => {
    if (flags[key] !== undefined && flags[key] !== null) return parse(flags[key])
    const env = envFirst(...envNames)
    if (env !== undefined) return parse(env)
    if (file[key] !== undefined && file[key] !== null) return parse(file[key])
    return DEFAULTS[key]
  }

  // Run artifacts: explicit flag > env > config file > caller's cwd > package dir.
  // The `cwd` step is what matters for a bundle install: the package then lives
  // in the profile's node_modules, and accumulating screenshots and adb logs
  // there both pollutes an installed dependency and loses them on the next
  // install.  The CLI passes no `cwd` and keeps writing next to the repo.
  const artifactsDir =
    (flags.artifactsDir !== undefined && flags.artifactsDir !== null
      ? String(flags.artifactsDir)
      : undefined) ??
    envFirst('ANDROID_HELPER_ARTIFACTS') ??
    (file.artifactsDir !== undefined && file.artifactsDir !== null ? String(file.artifactsDir) : undefined) ??
    (flags.cwd ? path.join(String(flags.cwd), 'artifacts') : DEFAULTS.artifactsDir)

  const cfg = {
    adbPath: pick('adbPath', ['ANDROID_HELPER_ADB', 'ADB_PATH']),
    emulatorType: pick('emulatorType', ['ANDROID_HELPER_EMULATOR', 'ANDROID_EMULATOR'], (v) =>
      String(v).toLowerCase(),
    ),
    adbPort: pick('adbPort', ['ANDROID_HELPER_ADB_PORT'], parseIntOrNull),
    consolePort: pick('consolePort', ['ANDROID_HELPER_CONSOLE_PORT'], parseIntOrNull),
    deviceSerial: pick('deviceSerial', ['ANDROID_HELPER_SERIAL', 'ANDROID_SERIAL']),
    autoDiscover: pick('autoDiscover', ['ANDROID_HELPER_AUTO_DISCOVER'], (v) =>
      parseBool(v, DEFAULTS.autoDiscover),
    ),
    ports: pick('ports', ['ANDROID_HELPER_PORTS'], (v) =>
      Array.isArray(v)
        ? v.map((p) => Number.parseInt(p, 10)).filter(Number.isFinite)
        : String(v)
            .split(/[,\s]+/)
            .map((p) => Number.parseInt(p, 10))
            .filter(Number.isFinite),
    ),
    minProbePort: pick('minProbePort', ['ANDROID_HELPER_MIN_PORT'], parseIntOrNull) ?? DEFAULTS.minProbePort,
    timeoutMs: pick('timeoutMs', ['ANDROID_HELPER_TIMEOUT_MS'], parseIntOrNull) ?? DEFAULTS.timeoutMs,
    dumpTimeoutMs:
      pick('dumpTimeoutMs', ['ANDROID_HELPER_DUMP_TIMEOUT_MS'], parseIntOrNull) ?? DEFAULTS.dumpTimeoutMs,
    dumpCacheTtlMs:
      pick('dumpCacheTtlMs', ['ANDROID_HELPER_DUMP_TTL_MS'], parseIntOrNull) ?? DEFAULTS.dumpCacheTtlMs,
    defaultPackage: pick('defaultPackage', ['ANDROID_HELPER_PACKAGE']),
    adbKeyboardPackage:
      pick('adbKeyboardPackage', ['ANDROID_HELPER_ADB_KEYBOARD']) ?? DEFAULTS.adbKeyboardPackage,
    artifactsDir,
    keepLog: pick('keepLog', ['ANDROID_HELPER_KEEP_LOG'], (v) => parseBool(v, DEFAULTS.keepLog)),
    echoCommands: pick('echoCommands', ['ANDROID_HELPER_ECHO'], (v) =>
      parseBool(v, DEFAULTS.echoCommands),
    ),
    allowDiskSearch: parseBool(flags.allowDiskSearch, true),
  }

  if (!EMULATOR_PRESETS[cfg.emulatorType]) {
    cfg.emulatorType = 'custom'
    cfg.emulatorTypeWarning = `unknown emulatorType, falling back to "custom"`
  }

  // Port inference: consolePort and adbPort differ by exactly 1 for AVD-style
  // emulators.  Only infer when it does not contradict an explicit value.
  if (cfg.adbPort === null && cfg.consolePort !== null) cfg.adbPort = cfg.consolePort + 1
  if (cfg.consolePort === null && cfg.adbPort !== null) cfg.consolePort = cfg.adbPort - 1

  const resolved = discoverAdb({
    extraRoots: flags.extraAdbRoots ?? [],
    allowDiskSearch: flags.allowDiskSearch !== false,
    configured: cfg.adbPath,
  })
  cfg.adb = resolved?.path ?? null
  cfg.adbSource = resolved?.source ?? null
  if (!cfg.adb) {
    cfg.adb = ADB_BIN // last resort: hope PATH resolves it at spawn time
    cfg.adbSource = 'unresolved'
    cfg.adbMissing = true
  } else if (cfg.adbPath && cfg.adb !== cfg.adbPath) {
    cfg.adbPathWarning = `configured adbPath does not exist: ${cfg.adbPath}`
  }

  cfg.portUniverse = [...new Set([...defaultPortUniverse(cfg.emulatorType), ...(cfg.ports ?? [])])]
    .filter((p) => Number.isFinite(p) && p >= cfg.minProbePort && p <= 65535)
    .sort((a, b) => a - b)

  return cfg
}

export { IS_WINDOWS, ADB_BIN }
