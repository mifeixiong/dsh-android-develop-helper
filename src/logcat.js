/**
 * Logcat integration.
 *
 * Filtering happens in three places, cheapest first:
 *   - `-T <time>` / `-t <count>` settles the time window on the device, so we
 *     never pull 200k lines over USB and filter them here;
 *   - `--pid` narrows to one process, but a crash removes that process, so
 *     `--package` also unions in the crash buffer;
 *   - the remaining regex/level filtering runs on the collected text.
 *
 * The "did it crash" question is answered by `analyze()` rather than by the
 * caller grepping: agent runtimes and OEM builds emit several different fatal
 * signatures and a plain `grep FATAL` misses `ANR in` and native tombstones.
 */
import { pidOf } from './app.js'

export const LEVELS = { verbose: 'V', debug: 'D', info: 'I', warn: 'W', error: 'E', fatal: 'F' }

const LEVEL_ORDER = ['V', 'D', 'I', 'W', 'E', 'F']

const CRASH_SIGNATURES = [
  { kind: 'java-crash', re: /FATAL EXCEPTION/i },
  { kind: 'anr', re: /\bANR in\b/ },
  { kind: 'strict-mode', re: /StrictMode policy violation/i },
  { kind: 'oom', re: /(OutOfMemoryError|LowMemoryKiller|lowmemorykiller)/i },
  { kind: 'process-death', re: /Process\s+\S+\s+has died/i },
]

/**
 * Which process a crash finding belongs to.
 *
 * A native tombstone puts `Cmdline:` a few lines *after* the `Fatal signal` line,
 * so the scan looks forward. It stops at the start of the next event, because a
 * window that runs past the end of one crash will happily attribute it to the
 * process named in the *next* one — which is exactly how a `uiautomator` SIGSEGV
 * gets blamed on the app under test.
 */
export function findingProcess(lines, index, { lookAhead = 24 } = {}) {
  for (let i = index; i < Math.min(lines.length, index + lookAhead); i++) {
    const line = lines[i]
    if (i > index && isCrashBlockBoundary(line)) return null
    const cmdline = /Cmdline:\s*(\S+)/.exec(line)
    if (cmdline) return cmdline[1]
    const anr = /\bANR in\s+([\w.]+)/.exec(line)
    if (anr) return anr[1]
    const process = /Process:\s*([\w.]+),\s*PID:/.exec(line)
    if (process) return process[1]
    // Zygote reports a pid, not a package; treating "5000" as a process name
    // would make the line wrongly filterable.
    const died = /Process\s+([\w.]+)\s+has died/.exec(line)
    if (died && !/^\d+$/.test(died[1])) return died[1]
  }
  return null
}

/** Does this line begin a new event, ending the one being scanned? */
function isCrashBlockBoundary(line) {
  return (
    /FATAL EXCEPTION:/.test(line) ||
    /-{3,}\s*beginning of/.test(line) ||
    /Fatal signal \d+/.test(line) ||
    /\sE\s+AndroidRuntime\s*:/.test(line)
  )
}

/**
 * Parse native tombstones as **blocks**, not as individual matching lines.
 *
 * A tombstone is one multi-line record delimited by its log tags: `libc` opens it
 * and `DEBUG` carries the body, and any other tag ends it. Matching line by line
 * splits one crash into three "findings" (`Fatal signal`, the `*** ***` banner,
 * `backtrace:`) whose windows then bleed into whatever was logged next.
 */
export function parseTombstoneBlocks(lines) {
  const parsed = lines.map(parseLogcatLine)
  const blocks = []
  const seen = new Set()

  for (let i = 0; i < parsed.length; i++) {
    const head = /Fatal signal (\d+)\s*\(([^)]+)\)(?:\s*,\s*code\s*(-?\d+))?/.exec(parsed[i].message)
    if (!head) continue

    const block = {
      signal: Number(head[1]),
      signalName: head[2],
      code: head[3] !== undefined ? Number(head[3]) : null,
      pid: parsed[i].pid,
      process: null,
      timestamp: parsed[i].timestamp,
      faultAddress: /fault addr (\S+)/.exec(parsed[i].message)?.[1] ?? null,
      backtrace: [],
      raw: [],
    }

    for (let j = i; j < Math.min(parsed.length, i + 300); j++) {
      const entry = parsed[j]
      if (j > i && entry.message.trim() === '') break
      if (j > i && entry.tag !== null && entry.tag !== 'libc' && entry.tag !== 'DEBUG') break
      block.raw.push(entry.raw)
      const cmdline = /Cmdline:\s*(\S+)/.exec(entry.message)
      if (cmdline) block.process = cmdline[1]
      const frame = /^\s*#(\d+)\s+pc\s+(\S+)\s*(.*)$/.exec(entry.message)
      if (frame) block.backtrace.push({ index: Number(frame[1]), pc: frame[2], frame: frame[3].trim() })
    }

    const key = `${block.process ?? 'unknown'}|${block.pid}|${block.signal}|${block.code}`
    if (seen.has(key)) continue
    seen.add(key)
    blocks.push(block)
  }

  return blocks
}

/** Compact rendering of one tombstone. */
export function renderTombstone(block) {
  const lines = [`native crash: signal ${block.signal} (${block.signalName})${block.code !== null ? `, code ${block.code}` : ''}`]
  if (block.process) lines.push(`  进程: ${block.process}${block.pid ? ` (pid ${block.pid})` : ''}`)
  if (block.faultAddress) lines.push(`  fault addr: ${block.faultAddress}`)
  // The top frames are libc teardown machinery; the interesting ones are deeper.
  const frames = block.backtrace.slice(0, 5)
  if (frames.length) {
    lines.push('  backtrace:')
    for (const frame of frames) lines.push(`    #${String(frame.index).padStart(2, '0')} ${frame.frame}`)
  }
  return lines.join('\n')
}

/**
 * Collect logcat lines.
 *
 * @param {object} options
 * @param {string}  [options.package]   restrict to this app
 * @param {string|number} [options.since] `-T` value: a timestamp like
 *        `"09-19 12:00:00.000"` or a relative duration in seconds (number)
 * @param {string}  [options.level]     minimum level (verbose..fatal)
 * @param {string|RegExp} [options.grep] extra text filter
 * @param {string[]} [options.buffers]  e.g. ['main','crash']
 * @param {number}  [options.maxLines]  keep the last N matching lines
 * @param {boolean} [options.clear]     `-c` before reading
 * @param {boolean} [options.includeCrashBuffer] include `-b crash` for a package query
 */
export async function logcat(adb, options = {}) {
  const {
    package: pkg = null,
    since = null,
    level = null,
    grep = null,
    tag = null,
    buffers = null,
    maxLines = 1000,
    clear = false,
    pid = null,
    timeoutMs = 60000,
  } = options

  if (clear) await adb.shellLoose('logcat -c', { timeoutMs: 10000 })

  const resolvedPid = pid ?? (pkg ? await pidOf(adb, pkg) : null)
  const effectiveBuffers = buffers ?? (pkg ? ['main', 'system', 'crash'] : ['main', 'system'])

  const args = ['-d', '-v', 'threadtime']
  for (const buffer of effectiveBuffers) args.push('-b', buffer)
  if (resolvedPid) args.push('--pid', String(resolvedPid))
  if (since !== null && since !== undefined && since !== '') {
    if (typeof since === 'number') args.push('-t', String(since))
    else args.push('-T', String(since))
  } else {
    // Bound the pull by default: an unbounded `logcat -d` on a busy device
    // can be tens of megabytes.
    args.push('-t', String(Math.max(maxLines * 4, 2000)))
  }

  const result = await adb.run(['logcat', ...args], { timeoutMs })
  let lines = result.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)

  const total = lines.length
  lines = lines.filter((line) => {
    if (level && !meetsLevel(line, level)) return false
    if (tag && !new RegExp(`\\s${tag}\\s*:`).test(line)) return false
    if (grep) {
      const re = grep instanceof RegExp ? grep : new RegExp(grep, 'i')
      if (!re.test(line)) return false
    }
    return true
  })

  const truncated = lines.length > maxLines
  if (truncated) lines = lines.slice(-maxLines)

  return {
    lines,
    text: lines.join('\n'),
    total,
    matched: lines.length,
    truncated,
    pid: resolvedPid,
    buffers: effectiveBuffers,
  }
}

function meetsLevel(line, level) {
  const wanted = LEVELS[String(level).toLowerCase()] ?? String(level).toUpperCase()
  const index = LEVEL_ORDER.indexOf(wanted)
  if (index < 0) return true
  // threadtime format: `09-19 12:00:00.000  1234  1250 I Tag     : message`
  const match = /\s([VDIWEF])\s/.exec(line)
  if (!match) return true
  return LEVEL_ORDER.indexOf(match[1]) >= index
}

/**
 * Split a `threadtime` logcat line into its fields.
 *
 * `09-19 21:30:00.123  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main`
 *
 * Lines that do not carry a prefix (a raw crash buffer, `-v brief` output) are
 * returned with the whole line as `message`, so the crash parser works on both.
 */
export function parseLogcatLine(line) {
  const match = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(\S+)\s*:\s?(.*)$/.exec(line)
  if (!match) {
    return { timestamp: null, pid: null, tid: null, level: null, tag: null, message: line.trim(), raw: line }
  }
  return {
    date: match[1],
    time: match[2],
    timestamp: `${match[1]} ${match[2]}`,
    pid: Number(match[3]),
    tid: Number(match[4]),
    level: match[5],
    tag: match[6],
    message: match[7],
    raw: line,
  }
}

/**
 * `at com.example.MainActivity.splitBill(MainActivity.java:210)`
 *
 * The method-name class allows `-` because R8/desugaring emits synthetic
 * accessors like `MainActivity.-$$Nest$mtriggerValidationCrash`, and rejecting
 * those truncates every stack trace at the first synthetic frame.
 */
const FRAME_RE = /^\s*at\s+([\w$.<>-]+)\((?:(.+?)(?::(\d+))?)?\)\s*$/
/** `java.lang.ArithmeticException: divide by zero` */
const EXCEPTION_RE = /^([a-z][\w$]*(?:\.[\w$]+)*\.(?:[\w$]*(?:Exception|Error|Throwable)))(?::\s*(.*))?$/
/** `Caused by: java.lang.NullPointerException: …` */
const CAUSE_RE = /^Caused by:\s*(.*)$/

const FRAMEWORK_FILES = new Set([
  'Activity.java', 'ActivityThread.java', 'AndroidRuntime.java', 'Handler.java', 'Looper.java',
  'Method.java', 'ReflectiveOperationException.java', 'RuntimeInit.java', 'View.java',
  'ViewGroup.java', 'ZygoteInit.java', 'Binder.java', 'MessageQueue.java', 'Choreographer.java',
  'Instrumentation.java', 'Thread.java', 'Runnable.java', 'NativeMethodAccessorImpl.java',
  'DelegatingMethodAccessorImpl.java', 'MethodAccessorImpl.java', 'HandlerDispatcher.java',
])

function parseFrame(message) {
  const match = FRAME_RE.exec(message)
  if (!match) return null
  const [, method, file, line] = match
  // `Native Method` and `Unknown Source` name no file, so neither can be the
  // "open this" location.
  const hasFile = Boolean(file) && file !== 'Native Method' && file !== 'Unknown Source'
  return {
    method,
    file: hasFile ? file : null,
    line: line ? Number(line) : null,
    native: file === 'Native Method',
    unknownSource: file === 'Unknown Source',
  }
}

function isFrameworkFrame(frame) {
  if (frame.native || frame.unknownSource) return true
  if (!frame.file) return false
  if (FRAMEWORK_FILES.has(frame.file)) return true
  return frame.file.startsWith('android.') || frame.file.startsWith('com.android.internal.')
}

/**
 * Pull every `FATAL EXCEPTION` block out of a log stream and reduce it to the
 * one thing that matters for debugging: **which line of app code threw, and why**.
 *
 * The stack trace is emitted as one log line per frame, interleaved with whatever
 * else the app was logging, so the parser walks forward only while the lines keep
 * looking like a trace. The first frame that belongs to the app — not to the
 * framework that dispatched the click — is reported as `location`.
 *
 * @param {string[]} lines
 * @param {{ pkg?: string }} [options]
 */
export function parseCrashBlocks(lines, options = {}) {
  const { pkg = null } = options
  const parsed = lines.map(parseLogcatLine)
  const crashes = []

  for (let i = 0; i < parsed.length; i++) {
    const head = /^FATAL EXCEPTION:\s*(.*)$/.exec(parsed[i].message)
    if (!head) continue

    const crash = {
      thread: head[1]?.trim() || null,
      process: null,
      pid: parsed[i].pid,
      timestamp: parsed[i].timestamp,
      exception: null,
      message: null,
      frames: [],
      causes: [],
      raw: [],
    }
    crash.raw.push(parsed[i].raw)

    let current = crash
    let lastWasFrame = false
    for (let j = i + 1; j < Math.min(parsed.length, i + 400); j++) {
      const message = parsed[j].message
      if (message.trim() === '') break

      const process = /^Process:\s*([\w.]+),\s*PID:\s*(\d+)/.exec(message)
      if (process) {
        crash.process = process[1]
        crash.pid = Number(process[2]) || crash.pid
        crash.raw.push(parsed[j].raw)
        lastWasFrame = false
        continue
      }

      const cause = CAUSE_RE.exec(message)
      if (cause) {
        const inner = EXCEPTION_RE.exec(cause[1])
        current = {
          exception: inner ? inner[1] : cause[1].split(':')[0].trim(),
          message: inner?.[2]?.trim() || null,
          frames: [],
        }
        crash.causes.push(current)
        crash.raw.push(parsed[j].raw)
        lastWasFrame = false
        continue
      }

      const frame = parseFrame(message)
      if (frame) {
        current.frames.push(frame)
        crash.raw.push(parsed[j].raw)
        lastWasFrame = true
        continue
      }

      if (/^\s*\.\.\.\s*\d+\s+more\s*$/.test(message)) {
        crash.raw.push(parsed[j].raw)
        lastWasFrame = false
        continue
      }

      const exception = EXCEPTION_RE.exec(message.trim())
      if (exception && !lastWasFrame) {
        if (current === crash) {
          crash.exception = exception[1]
          crash.message = exception[2]?.trim() || null
        }
        crash.raw.push(parsed[j].raw)
        continue
      }

      break
    }

    if (crash.exception || crash.frames.length > 0) crashes.push(crash)
  }

  // The same crash often appears in both the main and the crash buffer.
  const seen = new Set()
  const unique = []
  for (const crash of crashes) {
    const key = `${crash.exception}|${crash.frames[0]?.method ?? ''}|${crash.frames[0]?.line ?? ''}|${crash.pid}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(decorateCrash(crash, pkg))
  }
  return unique
}

/** Add the frame a developer should open first. */
function decorateCrash(crash, pkg) {
  const all = [...crash.frames, ...crash.causes.flatMap((c) => c.frames)]
  const appFrame = all.find((frame) => {
    if (pkg && frame.method?.startsWith(pkg)) return true
    return !isFrameworkFrame(frame)
  })
  const location = appFrame
    ? { file: appFrame.file, line: appFrame.line, method: appFrame.method, fromCause: crash.frames.includes(appFrame) ? null : true }
    : null
  const headline = crash.exception
    ? `${crash.exception}${crash.message ? `: ${crash.message}` : ''}`
    : (crash.frames[0]?.method ?? 'FATAL EXCEPTION')
  return { ...crash, location, headline }
}

/** Compact, model-facing rendering of one parsed crash. */
export function renderCrash(crash) {
  const lines = [`崩溃: ${crash.headline}`]
  if (crash.thread) lines.push(`  线程: ${crash.thread}`)
  if (crash.process) lines.push(`  进程: ${crash.process}${crash.pid ? ` (pid ${crash.pid})` : ''}`)
  if (crash.location) {
    const where = crash.location.file
      ? `${crash.location.file}${crash.location.line ? `:${crash.location.line}` : ''}`
      : crash.location.method
    lines.push(`  定位: ${where}${crash.location.method ? `  ← ${crash.location.method}` : ''}${crash.location.fromCause ? ' (Caused by)' : ''}`)
  }
  const frames = crash.frames.slice(0, 8)
  if (frames.length) {
    lines.push('  调用栈:')
    for (const frame of frames) {
      lines.push(`    at ${frame.method}(${frame.file ?? 'Native Method'}${frame.line ? `:${frame.line}` : ''})`)
    }
  }
  for (const cause of crash.causes) {
    lines.push(`  Caused by: ${cause.exception}${cause.message ? `: ${cause.message}` : ''}`)
    for (const frame of cause.frames.slice(0, 4)) {
      lines.push(`    at ${frame.method}(${frame.file ?? 'Native Method'}${frame.line ? `:${frame.line}` : ''})`)
    }
  }
  return lines.join('\n')
}

/**
 * Turn a log stream into a verdict about *why* something failed.
 *
 * Three evidence kinds, each parsed for what it is:
 *   - `crashes`     parsed Java `FATAL EXCEPTION` blocks, with the app frame;
 *   - `tombstones`  native crash blocks, with the signal and backtrace;
 *   - `findings`    the looser signatures (ANR, StrictMode, OOM, process death)
 *                   that have no stack trace to parse.
 *
 * When `pkg` is given, anything attributable to a *different* process moves to
 * `ignored` rather than being reported.  The crash buffer is device-global and
 * `uiautomator` SIGSEGVs on every dump on some emulator images, so without that
 * filter a verdict about one app is mostly other processes' noise.
 *
 * @returns {{crashed:boolean, crashes:object[], tombstones:object[], findings:object[], ignored:object[], summary:string, location:object|null}}
 */
export function analyze(lines, options = {}) {
  const { pkg = null, maxFindings = 6 } = options
  const input = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/)

  const allCrashes = parseCrashBlocks(input, { pkg })
  const allTombstones = parseTombstoneBlocks(input)
  const crashes = []
  const tombstones = []
  const findings = []
  const ignored = []
  const seen = new Set()
  const ignoredSeen = new Set()

  /**
   * Record something attributable to another process.
   *
   * Deduplicated by `(kind, process)` rather than by line: `ignored` is a summary
   * of what was set aside, not a second log dump.
   */
  const ignore = (entry) => {
    const key = `${entry.kind}|${entry.process ?? 'unknown'}`
    if (ignoredSeen.has(key)) return
    ignoredSeen.add(key)
    ignored.push(entry)
  }

  for (const crash of allCrashes) {
    if (pkg && crash.process && crash.process !== pkg) {
      ignore({ kind: 'java-crash', process: crash.process, headline: crash.headline })
    } else {
      crashes.push(crash)
    }
  }

  for (const block of allTombstones) {
    if (pkg && block.process && block.process !== pkg) {
      ignore({ kind: 'native-crash', process: block.process, line: `signal ${block.signal} (${block.signalName})` })
    } else {
      tombstones.push(block)
    }
  }

  for (let i = 0; i < input.length; i++) {
    const line = input[i]
    for (const signature of CRASH_SIGNATURES) {
      // A parsed FATAL EXCEPTION is reported through `crashes`, and a parsed
      // tombstone through `tombstones`; neither is repeated as a raw finding.
      if (signature.kind === 'java-crash' && allCrashes.length > 0) continue
      if (!signature.re.test(line)) continue

      const process = findingProcess(input, i)
      if (pkg && process && process !== pkg) {
        ignore({ kind: signature.kind, process, line: line.trim() })
        break
      }
      const key = `${signature.kind}|${process ?? 'unknown'}`
      if (seen.has(key)) break
      seen.add(key)
      findings.push({
        kind: signature.kind,
        line: line.trim(),
        index: i,
        process,
        attribution: process ? 'exact' : 'unknown',
        context: input.slice(i, i + 12).map((l) => l.trimEnd()),
      })
      break
    }
  }

  const firstCrash = crashes[0]
  const firstTombstone = tombstones[0]
  const firstFinding = findings[0]
  const summary = firstCrash
    ? `${firstCrash.headline}${firstCrash.location?.file ? ` @ ${firstCrash.location.file}:${firstCrash.location.line}` : ''}`
    : firstTombstone
      ? `native crash: signal ${firstTombstone.signal} (${firstTombstone.signalName})${firstTombstone.process ? ` in ${firstTombstone.process}` : ''}`
      : firstFinding
        ? `${firstFinding.kind}${firstFinding.process ? ` (${firstFinding.process})` : ''}: ${firstFinding.line.trim()}`
        : '未发现崩溃特征'

  return {
    crashed: crashes.length > 0 || tombstones.length > 0 || findings.length > 0,
    crashes,
    tombstones,
    findings: findings.slice(0, maxFindings),
    ignored,
    summary,
    location: firstCrash?.location ?? null,
  }
}

/**
 * Convenience: read the crash-relevant slice for one package and localise it.
 *
 * The crash buffer is read first and merged ahead of the main buffer, so the
 * parsed exception is the one that actually happened rather than an older one
 * still sitting in the ring buffer.
 */
export async function diagnose(adb, pkg, { maxLines = 4000 } = {}) {
  const pidBefore = await pidOf(adb, pkg)
  const crashBuffer = await logcat(adb, { buffers: ['crash'], maxLines: 600, timeoutMs: 30000 })
  const scoped = await logcat(adb, {
    package: pkg,
    buffers: ['main', 'system'],
    maxLines,
    timeoutMs: 90000,
  })
  const merged = [...crashBuffer.lines, ...scoped.lines]
  const verdict = analyze(merged, { pkg })
  const pidAfter = await pidOf(adb, pkg)

  return {
    package: pkg,
    pid: pidBefore,
    pidAfter,
    /** Is the process alive *now*? */
    running: pidAfter !== null,
    /**
     * Was it alive before we looked, and gone after?
     *
     * `diagnose` is normally called once the crash has already happened, so this
     * is usually `false` even for a fatal crash — the pid was already gone when
     * the first sample was taken. `running: false` together with a parsed crash is
     * the evidence; this field only adds the stronger "we watched it die" case.
     */
    processDied: pidBefore !== null && pidAfter === null,
    ...verdict,
    lineCount: merged.length,
  }
}

/** One-line description of the process state, for a report header. */
export function describeProcess(report) {
  if (report.running) return `pid ${report.pidAfter}（运行中）`
  if (report.pidBefore !== null && report.pidAfter === null) {
    return `pid ${report.pidBefore} → 已退出（进程已死亡）`
  }
  return '未运行（可能已崩溃）'
}

export { pidOf }
