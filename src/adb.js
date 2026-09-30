/**
 * Thin, dependency-free transport over the `adb` executable.
 *
 * Responsibilities kept deliberately narrow:
 *   - spawn adb and capture stdout/stderr as *buffers* (binary-safe, needed for
 *     `exec-out screencap`);
 *   - enforce a timeout and kill the process tree on Windows;
 *   - log every command and its complete output to the run artifact;
 *   - translate adb's most common failure strings into actionable errors.
 *
 * Device selection lives in `devices.js`, capability semantics live above this
 * layer.
 */
import { spawn } from 'node:child_process'

export class AdbError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AdbError'
    this.code = details.code ?? null
    this.command = details.command ?? null
    this.stdout = details.stdout ?? ''
    this.stderr = details.stderr ?? ''
    this.timedOut = details.timedOut === true
    this.hint = details.hint ?? null
  }
}

const TRANSIENT_PATTERNS = [
  /device offline/i,
  /device still connecting/i,
  /device '.*' not found/i,
  /more than one device\/emulator/i,
  /error: closed/i,
  /cannot connect to daemon/i,
]

/**
 * Turn raw adb stderr into a message plus a concrete next step.
 */
export function explainAdbFailure(stderr, stdout = '') {
  const text = `${stderr}\n${stdout}`
  if (/more than one device\/emulator/i.test(text)) {
    return {
      hint:
        '检测到多个设备/模拟器。请用 --device <serial> 显式指定目标，' +
        '或在 config.json 中固定 deviceSerial。',
      transient: false,
    }
  }
  if (/device offline/i.test(text)) {
    return {
      hint:
        '设备处于 offline。MuMu/雷电 多开会同时暴露多个端口，通常是连接到了错误端口；' +
        '请重新执行 devices --refresh 让它重新发现。',
      transient: true,
    }
  }
  if (/unauthorized/i.test(text)) {
    return { hint: '设备未授权：请在模拟器画面中允许 USB 调试。', transient: false }
  }
  if (/no devices\/emulators found|device .* not found/i.test(text)) {
    return { hint: '找不到设备：请先启动模拟器，或运行 devices --probe 探测 ADB 端口。', transient: true }
  }
  if (/cannot connect to daemon|adb server .* didn't ACK|failed to start daemon/i.test(text)) {
    return { hint: 'adb server 异常：可执行 `android-helper kill-server` 后重试。', transient: true }
  }
  if (/closed/i.test(text)) {
    return { hint: '连接被关闭：模拟器可能正在重启。', transient: true }
  }
  return { hint: null, transient: false }
}

export function isTransientAdbError(error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`
  return TRANSIENT_PATTERNS.some((re) => re.test(text))
}

export class Adb {
  /**
   * @param {object} options
   * @param {string} options.bin          adb executable path
   * @param {number} [options.timeoutMs]  default per-command timeout
   * @param {import('./artifacts.js').Session} [options.session]
   */
  constructor(options = {}) {
    this.bin = options.bin ?? 'adb'
    this.timeoutMs = options.timeoutMs ?? 30000
    this.session = options.session ?? null
    /** Currently pinned device serial; every command carries `-s <serial>`. */
    this.serial = null
    this.defaultTimeoutMs = this.timeoutMs
  }

  /** Pin the transport to one device. */
  use(serial) {
    this.serial = serial ?? null
    return this
  }

  /**
   * Full argument vector including the `-s` selector.
   *
   * `options.serial` overrides the pinned serial for a single call.  This
   * matters during discovery: the whole point of reading a fingerprint is to
   * decide *which* serial to pin, so those probes cannot rely on `this.serial`.
   */
  argv(args, options = {}) {
    const serial = options.serial ?? this.serial
    return serial ? ['-s', serial, ...args] : [...args]
  }

  /**
   * Run adb and resolve with the raw result.
   * @returns {Promise<{code:number, stdout:Buffer, stderr:Buffer, durationMs:number, timedOut:boolean}>}
   */
  run(args, options = {}) {
    const argv = options.noSerial ? [...args] : this.argv(args, options)
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const started = Date.now()

    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(this.bin, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        reject(new AdbError(`无法启动 adb (${this.bin}): ${error.message}`, { command: argv.join(' ') }))
        return
      }

      const out = []
      const err = []
      let settled = false
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutMs)

      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new AdbError(`adb 执行失败: ${error.message}`, { command: argv.join(' ') }))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const result = {
          code: code ?? -1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err),
          durationMs: Date.now() - started,
          timedOut,
        }
        this.session?.command(this.bin, argv, result)
        resolve(result)
      })
    })
  }

  /** Run adb and throw on non-zero exit (unless `check: false`). */
  async exec(args, options = {}) {
    const result = await this.run(args, options)
    if (result.code !== 0 && options.check !== false) {
      const stderr = result.stderr.toString('utf8').trim()
      const stdout = result.stdout.toString('utf8').trim()
      const { hint } = explainAdbFailure(stderr, stdout)
      throw new AdbError(
        `adb ${args.join(' ')} 失败 (exit ${result.code}): ${stderr || stdout || 'no output'}`,
        { code: result.code, command: args.join(' '), stdout, stderr, timedOut: result.timedOut, hint },
      )
    }
    return result
  }

  /** Run `adb shell <command>` and return trimmed stdout text. */
  async shell(command, options = {}) {
    const result = await this.exec(['shell', command], options)
    return result.stdout.toString('utf8').replace(/\r\n/g, '\n').trim()
  }

  /** Run `adb shell <command>`, returning stdout even if the exit code is non-zero. */
  async shellLoose(command, options = {}) {
    const result = await this.run(['shell', command], options)
    return {
      text: result.stdout.toString('utf8').replace(/\r\n/g, '\n').trim(),
      stderr: result.stderr.toString('utf8').trim(),
      code: result.code,
    }
  }

  /** Raw (binary-safe) stdout, e.g. `exec-out screencap`. */
  async execOut(args, options = {}) {
    const result = await this.exec(['exec-out', ...args], options)
    return result.stdout
  }

  /** Run several shell commands in one adb round trip. */
  async shellBatch(commands, options = {}) {
    const joined = commands.join(' ; ')
    const text = await this.shell(joined, options)
    return text
  }

  async version() {
    const result = await this.run(['version'], { timeoutMs: 10000 })
    return result.stdout.toString('utf8').trim()
  }

  async ensureServer() {
    await this.run(['start-server'], { timeoutMs: 20000 })
  }

  async killServer() {
    await this.run(['kill-server'], { timeoutMs: 10000 })
  }

  /** `adb devices -l` parsed into records. */
  async devices() {
    const result = await this.exec(['devices', '-l'], { timeoutMs: 15000 })
    return parseDevices(result.stdout.toString('utf8'))
  }

  async connect(port, host = '127.0.0.1') {
    const result = await this.run(['connect', `${host}:${port}`], { timeoutMs: 8000 })
    const text = `${result.stdout.toString('utf8')}${result.stderr.toString('utf8')}`.trim()
    return { ok: /connected to/i.test(text), text, port }
  }

  async disconnect(target) {
    await this.run(['disconnect', target], { timeoutMs: 8000, check: false })
  }
}

/** Parse `adb devices -l` output. */
export function parseDevices(text) {
  const records = []
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('List of devices')) continue
    if (line.startsWith('*')) continue // "* daemon started successfully *"
    const match = /^(\S+)\s+(\S+)(.*)$/.exec(line)
    if (!match) continue
    const [, serial, state, rest] = match
    const props = {}
    for (const token of rest.trim().split(/\s+/)) {
      const eq = token.indexOf(':')
      if (eq > 0) props[token.slice(0, eq)] = token.slice(eq + 1)
    }
    records.push({
      serial,
      state,
      props,
      model: props.model ?? null,
      product: props.product ?? null,
      device: props.device ?? null,
      transportId: props.transport_id ?? null,
    })
  }
  return records
}

/** Kill a child process and its descendants. */
function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    }
    child.kill('SIGKILL')
  } catch {
    /* best effort */
  }
}
