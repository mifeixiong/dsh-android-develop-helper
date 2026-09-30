/**
 * Run artifacts.
 *
 * Every adb command, its full stdout/stderr and its duration are written to
 * `<artifactsDir>/<timestamp>-<label>/log.txt` without truncation.  The previous
 * generation of this toolchain lost errors to shell-side `Select-Object` /
 * `2>$null` truncation; a debugging tool that silently drops stderr is worse
 * than no tool at all.
 */
import fs from 'node:fs'
import path from 'node:path'

let counter = 0

function stamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function slugify(text) {
  return String(text ?? 'run')
    .trim()
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'run'
}

export class Session {
  /**
   * @param {string} label  short run label, becomes part of the directory name
   * @param {{ artifactsDir: string, keepLog?: boolean, echoCommands?: boolean }} options
   */
  constructor(label, options = {}) {
    this.label = slugify(label)
    this.startedAt = new Date()
    this.keepLog = options.keepLog !== false
    this.echoCommands = options.echoCommands === true
    this.artifactsDir = options.artifactsDir
    this.lines = []
    this._stream = null
    this.dir = null
    this.logPath = null

    if (this.keepLog && this.artifactsDir) {
      const unique = `${stamp(this.startedAt)}-${this.label}`
      this.dir = path.join(this.artifactsDir, unique)
      try {
        fs.mkdirSync(this.dir, { recursive: true })
        this.logPath = path.join(this.dir, 'log.txt')
        this._stream = fs.createWriteStream(this.logPath, { flags: 'a' })
      } catch {
        this.dir = null
        this.logPath = null
      }
    }
  }

  /** Append one log line (also mirrored to stderr when echoing is on). */
  write(line) {
    const text = typeof line === 'string' ? line : String(line)
    this.lines.push(text)
    if (this._stream) this._stream.write(`${text}\n`)
    if (this.echoCommands) process.stderr.write(`${text}\n`)
  }

  /** Record a command invocation with its result. */
  command(bin, args, result) {
    const cmd = [bin, ...args].join(' ')
    this.write(`$ ${cmd}`)
    if (result?.durationMs !== undefined) this.write(`  -> exit ${result.code} in ${result.durationMs}ms`)
    const out = result?.stdout?.toString?.() ?? ''
    const err = result?.stderr?.toString?.() ?? ''
    if (out.trim()) this.write(indent(out.trimEnd()))
    if (err.trim()) this.write(indent(`[stderr] ${err.trimEnd()}`))
    if (result?.timedOut) this.write(indent(`[timeout] killed after ${result.durationMs}ms`))
  }

  /** Allocate a path inside the run directory (or a temp path if disabled). */
  artifactPath(name) {
    const file = `${counter++}-${slugify(name)}`
    if (!this.dir) return path.join(this.artifactsDir ?? '.', file)
    return path.join(this.dir, file)
  }

  /** Write a binary artifact; returns the path actually written. */
  writeArtifact(name, data) {
    const target = this.artifactPath(name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    this.write(`  [artifact] ${target}`)
    return target
  }

  async close() {
    if (this._stream) {
      await new Promise((resolve) => this._stream.end(resolve))
      this._stream = null
    }
  }
}

function indent(text) {
  return text
    .split('\n')
    .map((l) => `  | ${l}`)
    .join('\n')
}
