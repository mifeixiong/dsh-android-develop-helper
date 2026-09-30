import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLogcatLine,
  parseCrashBlocks,
  parseDartCrashBlocks,
  parseTombstoneBlocks,
  analyze,
  renderCrash,
  renderTombstone,
  describeProcess,
  findingProcess,
} from '../src/logcat.js'

const P = '09-19 21:30:01.200  5000  5000 E AndroidRuntime: '

/** A realistic FATAL EXCEPTION as threadtime logcat emits it. */
const DIVIDE_BY_ZERO = [
  '09-19 21:30:00.100  5000  5000 I ActivityManager: Start proc 5000:com.example.dormduty/u0a123',
  `${P}FATAL EXCEPTION: main`,
  `${P}Process: com.example.dormduty, PID: 5000`,
  `${P}java.lang.ArithmeticException: divide by zero`,
  `${P}\tat com.example.dormduty.MainActivity.splitBill(MainActivity.java:210)`,
  `${P}\tat com.example.dormduty.MainActivity.onClick(MainActivity.java:150)`,
  `${P}\tat android.view.View.performClick(View.java:7659)`,
  `${P}\tat android.os.Handler.dispatchMessage(Handler.java:106)`,
  `${P}\tat android.app.ActivityThread.main(ActivityThread.java:8147)`,
  `${P}\tat java.lang.reflect.Method.invoke(Native Method)`,
  '09-19 21:30:01.250  5001  5001 I Zygote  : Process 5000 exited cleanly (1)',
]

const WITH_CAUSE = [
  `${P}FATAL EXCEPTION: main`,
  `${P}Process: com.example.app, PID: 100`,
  `${P}java.lang.IllegalStateException: wrapper failed`,
  `${P}\tat com.example.app.Wrapper.run(Wrapper.java:10)`,
  `${P}\tat android.os.Handler.handleCallback(Handler.java:942)`,
  `${P}Caused by: java.lang.NullPointerException: boom`,
  `${P}\tat com.example.app.Inner.boom(Inner.java:42)`,
  `${P}\tat com.example.app.Wrapper.run(Wrapper.java:8)`,
  `${P}\t... 11 more`,
]

test('parseLogcatLine splits the threadtime prefix', () => {
  const line = parseLogcatLine('09-19 21:30:01.200  5000  5012 E AndroidRuntime: FATAL EXCEPTION: main')
  assert.equal(line.date, '09-19')
  assert.equal(line.timestamp, '09-19 21:30:01.200')
  assert.equal(line.pid, 5000)
  assert.equal(line.tid, 5012)
  assert.equal(line.level, 'E')
  assert.equal(line.tag, 'AndroidRuntime')
  assert.equal(line.message, 'FATAL EXCEPTION: main')
})

test('parseLogcatLine tolerates an unprefixed line', () => {
  const line = parseLogcatLine('FATAL EXCEPTION: main')
  assert.equal(line.timestamp, null)
  assert.equal(line.message, 'FATAL EXCEPTION: main')
})

test('parseLogcatLine keeps a message that itself contains a colon', () => {
  const line = parseLogcatLine('09-19 21:30:01.200  1  1 E Foo: key: value: more')
  assert.equal(line.tag, 'Foo')
  assert.equal(line.message, 'key: value: more')
})

test('parseCrashBlocks extracts the exception, thread and process', () => {
  const [crash] = parseCrashBlocks(DIVIDE_BY_ZERO)
  assert.equal(crash.thread, 'main')
  assert.equal(crash.process, 'com.example.dormduty')
  assert.equal(crash.pid, 5000)
  assert.equal(crash.exception, 'java.lang.ArithmeticException')
  assert.equal(crash.message, 'divide by zero')
  assert.equal(crash.headline, 'java.lang.ArithmeticException: divide by zero')
})

test('parseCrashBlocks captures every frame in order', () => {
  const [crash] = parseCrashBlocks(DIVIDE_BY_ZERO)
  assert.equal(crash.frames.length, 6)
  assert.deepEqual(crash.frames[0], {
    method: 'com.example.dormduty.MainActivity.splitBill',
    file: 'MainActivity.java',
    line: 210,
    native: false,
    unknownSource: false,
  })
  assert.equal(crash.frames[1].line, 150)
  assert.equal(crash.frames.at(-1).native, true)
  assert.equal(crash.frames.at(-1).file, null)
})

test('parseCrashBlocks points at the first frame that is not framework code', () => {
  const [crash] = parseCrashBlocks(DIVIDE_BY_ZERO, { pkg: 'com.example.dormduty' })
  assert.equal(crash.location.file, 'MainActivity.java')
  assert.equal(crash.location.line, 210)
  assert.match(crash.location.method, /splitBill$/)
  assert.equal(crash.location.fromCause, null)
})

test('parseCrashBlocks stops at the end of the trace', () => {
  const [crash] = parseCrashBlocks(DIVIDE_BY_ZERO)
  // The trailing "Process 5000 exited cleanly" line from Zygote is not a frame.
  assert.ok(!crash.frames.some((f) => f.method.includes('Zygote')))
  assert.ok(crash.raw.every((line) => !line.includes('exited cleanly')))
})

test('parseCrashBlocks follows a Caused by chain', () => {
  const [crash] = parseCrashBlocks(WITH_CAUSE, { pkg: 'com.example.app' })
  assert.equal(crash.exception, 'java.lang.IllegalStateException')
  assert.equal(crash.causes.length, 1)
  assert.equal(crash.causes[0].exception, 'java.lang.NullPointerException')
  assert.equal(crash.causes[0].message, 'boom')
  assert.equal(crash.causes[0].frames[0].file, 'Inner.java')
  assert.equal(crash.causes[0].frames[0].line, 42)
  // The outer app frame still wins as the location.
  assert.equal(crash.location.file, 'Wrapper.java')
  assert.equal(crash.location.line, 10)
})

test('parseCrashBlocks reports the cause frame when the outer frame is framework', () => {
  const lines = [
    `${P}FATAL EXCEPTION: main`,
    `${P}Process: com.example.app, PID: 7`,
    `${P}java.lang.RuntimeException: wrapped`,
    `${P}\tat android.app.ActivityThread.performLaunchActivity(ActivityThread.java:1)`,
    `${P}Caused by: java.lang.IllegalArgumentException: nope`,
    `${P}\tat com.example.app.Repo.load(Repo.java:88)`,
  ]
  const [crash] = parseCrashBlocks(lines, { pkg: 'com.example.app' })
  assert.equal(crash.location.file, 'Repo.java')
  assert.equal(crash.location.line, 88)
  assert.equal(crash.location.fromCause, true)
})

test('parseCrashBlocks drops duplicates coming from two buffers', () => {
  const duplicated = [...DIVIDE_BY_ZERO.slice(1, -1), ...DIVIDE_BY_ZERO.slice(1, -1)]
  const crashes = parseCrashBlocks(duplicated, { pkg: 'com.example.dormduty' })
  assert.equal(crashes.length, 1, 'the same crash in main and crash buffers must collapse')
})

test('parseCrashBlocks finds nothing in a clean stream', () => {
  const clean = [
    '09-19 21:30:00.100  1  1 I ActivityManager: Start proc 1:com.example.app/u0a1',
    '09-19 21:30:00.200  1  1 D Foo: all good',
  ]
  assert.deepEqual(parseCrashBlocks(clean), [])
})

test('analyze reports a parsed crash and does not double-count it as a finding', () => {
  const verdict = analyze(DIVIDE_BY_ZERO, { pkg: 'com.example.dormduty' })
  assert.equal(verdict.crashed, true)
  assert.equal(verdict.crashes.length, 1)
  assert.equal(verdict.findings.filter((f) => f.kind === 'java-crash').length, 0)
  assert.match(verdict.summary, /ArithmeticException.*MainActivity\.java:210/)
  assert.equal(verdict.location.file, 'MainActivity.java')
})

test('analyze still catches failure modes that have no stack trace', () => {
  const anr = analyze([
    '09-19 21:30:00.100  1  1 E ActivityManager: ANR in com.example.app (com.example.app/.Main)',
    '09-19 21:30:00.200  1  1 E ActivityManager: Reason: Input dispatching timed out',
  ])
  assert.equal(anr.crashed, true)
  assert.equal(anr.crashes.length, 0)
  assert.equal(anr.findings[0].kind, 'anr')

  const tombstone = analyze(TOMBSTONE(9, 'com.example.app'))
  assert.equal(tombstone.crashed, true)
  assert.equal(tombstone.tombstones.length, 1)
  assert.equal(tombstone.tombstones[0].signalName, 'SIGSEGV')
  assert.equal(tombstone.findings.length, 0, 'a tombstone is not also a raw finding')

  const death = analyze(['09-19 21:30:00.100  1  1 I Zygote  : Process 5000 has died'])
  assert.equal(death.crashed, true)
  assert.equal(death.findings[0].kind, 'process-death')
})

test('analyze reports a clean stream as clean', () => {
  const verdict = analyze(['09-19 21:30:00.100  1  1 I Foo: ok'])
  assert.equal(verdict.crashed, false)
  assert.equal(verdict.summary, '未发现崩溃特征')
  assert.equal(verdict.location, null)
})

// ── package scoping ─────────────────────────────────────────────────────────
//
// The crash buffer is device-global. `uiautomator` SIGSEGVs on every dump on
// some emulator images, so an unfiltered verdict about one app routinely reports
// another process's tombstone as the app's own native crash.

const TOMBSTONE = (pid, cmdline) => [
  `09-19 21:42:00.139  ${pid}  ${pid} F libc    : Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x7eafe1e73be0 in tid ${pid} (main), pid ${pid} (main)`,
  `09-19 21:42:00.218  ${pid + 16}  ${pid + 16} F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** ***`,
  `09-19 21:42:00.218  ${pid + 16}  ${pid + 16} F DEBUG   : Build fingerprint: 'Xiaomi/mayfly/mayfly:15/V417IR/631:user/release-keys'`,
  `09-19 21:42:00.218  ${pid + 16}  ${pid + 16} F DEBUG   : ABI: 'x86_64'`,
  `09-19 21:42:00.218  ${pid + 16}  ${pid + 16} F DEBUG   : Cmdline: ${cmdline}`,
  `09-19 21:42:00.218  ${pid + 16}  ${pid + 16} F DEBUG   : pid: ${pid}, tid: ${pid}, name: main  >>> ${cmdline} <<<`,
  `09-19 21:42:00.218  ${pid + 16}  ${pid + 16} F DEBUG   : signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x00007eafe1e73be0`,
  `09-19 21:42:00.218  ${pid + 16}  ${pid + 16} F DEBUG   : backtrace:`,
  `09-19 21:42:00.218  ${pid + 16}  ${pid + 16} F DEBUG   :       #00 pc 00007eafe1e73be0  <unknown>`,
  `09-19 21:42:00.218  ${pid + 16}  ${pid + 16} F DEBUG   :       #01 pc 000000000005846f  /apex/com.android.runtime/lib64/bionic/libc.so (__cxa_finalize+287)`,
]

test('findingProcess reads the process out of a tombstone that names it later', () => {
  const lines = TOMBSTONE(41078, 'uiautomator')
  assert.equal(findingProcess(lines, 0), 'uiautomator')
})

test('findingProcess stops at the next crash instead of borrowing its process', () => {
  // A `backtrace:` line whose scan runs past the end of its own tombstone would
  // otherwise attribute the SIGSEGV to whatever crashed next.
  const lines = [...TOMBSTONE(41078, 'uiautomator'), ...DIVIDE_BY_ZERO]
  const backtraceIndex = lines.findIndex((l) => l.includes('backtrace:'))
  assert.equal(findingProcess(lines, backtraceIndex), null)
})

test('parseTombstoneBlocks parses one tombstone as one block', () => {
  const [block] = parseTombstoneBlocks(TOMBSTONE(41078, 'uiautomator'))
  assert.equal(block.signal, 11)
  assert.equal(block.signalName, 'SIGSEGV')
  assert.equal(block.code, 1)
  assert.equal(block.process, 'uiautomator')
  assert.equal(block.pid, 41078)
  assert.equal(block.faultAddress, '0x7eafe1e73be0')
  assert.equal(block.backtrace.length, 2)
  assert.equal(block.backtrace[0].frame, '<unknown>')
  assert.match(block.backtrace[1].frame, /__cxa_finalize/)
})

test('parseTombstoneBlocks ends the block at the next non-tombstone tag', () => {
  const [block] = parseTombstoneBlocks([...TOMBSTONE(41078, 'uiautomator'), ...DIVIDE_BY_ZERO])
  assert.ok(
    block.raw.every((line) => line.includes('DEBUG') || line.includes('libc')),
    'the app FATAL EXCEPTION must not be absorbed into the tombstone',
  )
})

test('parseTombstoneBlocks finds nothing in a clean stream', () => {
  assert.deepEqual(parseTombstoneBlocks(['09-19 21:30:00.100  1  1 I Foo: ok']), [])
})

test('renderTombstone reports signal, process and backtrace', () => {
  const [block] = parseTombstoneBlocks(TOMBSTONE(41078, 'uiautomator'))
  const text = renderTombstone(block)
  assert.match(text, /signal 11 \(SIGSEGV\)/)
  assert.match(text, /进程: uiautomator/)
  assert.match(text, /__cxa_finalize/)
})

test('findingProcess reads the package from an ANR line', () => {
  const lines = ['09-19 21:30:00.100  1  1 E ActivityManager: ANR in com.example.app (com.example.app/.Main)']
  assert.equal(findingProcess(lines, 0), 'com.example.app')
})

test('findingProcess returns null when nothing names a process', () => {
  assert.equal(findingProcess(['09-19 21:30:00.100  1  1 W Foo: something odd'], 0), null)
})

test('analyze drops another process\'s tombstone instead of blaming the app', () => {
  const lines = [...DIVIDE_BY_ZERO, ...TOMBSTONE(41078, 'uiautomator')]
  const verdict = analyze(lines, { pkg: 'com.example.dormduty' })
  assert.equal(verdict.crashes.length, 1, 'the app crash survives')
  assert.equal(verdict.crashes[0].exception, 'java.lang.ArithmeticException')
  assert.equal(verdict.tombstones.length, 0, 'the uiautomator SIGSEGV must not be attributed to the app')
  assert.ok(
    verdict.ignored.some((i) => i.kind === 'native-crash' && i.process === 'uiautomator'),
    'but it must be recorded as ignored rather than silently dropped',
  )
})

test('analyze keeps a tombstone that does belong to the app', () => {
  const verdict = analyze(TOMBSTONE(1234, 'com.example.dormduty'), { pkg: 'com.example.dormduty' })
  assert.equal(verdict.crashed, true)
  assert.equal(verdict.tombstones.length, 1)
  assert.equal(verdict.tombstones[0].signal, 11)
  assert.match(verdict.summary, /native crash: signal 11 \(SIGSEGV\) in com\.example\.dormduty/)
})

test('analyze collapses repeated tombstones from one process', () => {
  const lines = [...TOMBSTONE(100, 'uiautomator'), ...TOMBSTONE(200, 'uiautomator'), ...TOMBSTONE(300, 'uiautomator')]
  const verdict = analyze(lines, { pkg: 'com.example.dormduty' })
  assert.equal(verdict.tombstones.length, 0)
  assert.equal(verdict.ignored.filter((i) => i.kind === 'native-crash').length, 1)
})

test('analyze drops a FATAL EXCEPTION belonging to a different package', () => {
  const other = [
    `${P}FATAL EXCEPTION: main`,
    `${P}Process: com.other.app, PID: 900`,
    `${P}java.lang.RuntimeException: not ours`,
    `${P}\tat com.other.app.Main.run(Main.java:5)`,
  ]
  const verdict = analyze([...DIVIDE_BY_ZERO, ...other], { pkg: 'com.example.dormduty' })
  assert.equal(verdict.crashes.length, 1)
  assert.equal(verdict.crashes[0].process, 'com.example.dormduty')
  assert.ok(verdict.ignored.some((i) => i.process === 'com.other.app'))
})

test('analyze marks an unattributable finding as unknown rather than hiding it', () => {
  const verdict = analyze(
    ['09-19 21:30:00.100  1  1 I Zygote  : Process 5000 has died', '09-19 21:30:00.200  1  1 I Foo: ok'],
    { pkg: 'com.example.dormduty' },
  )
  assert.equal(verdict.findings.length, 1)
  assert.equal(verdict.findings[0].attribution, 'unknown')
})

test('parseCrashBlocks keeps going through synthetic R8 frames', () => {
  // Desugaring emits `-$$Nest$m…` accessors; a method-name pattern without `-`
  // truncates the trace at the first one and hides every caller below it.
  const lines = [
    `${P}FATAL EXCEPTION: main`,
    `${P}Process: com.example.dormduty, PID: 42`,
    `${P}java.lang.ArrayIndexOutOfBoundsException: length=0; index=0`,
    `${P}\tat com.example.dormduty.MainActivity.triggerValidationCrash(MainActivity.java:234)`,
    `${P}\tat com.example.dormduty.MainActivity.-$$Nest$mtriggerValidationCrash(Unknown Source:0)`,
    `${P}\tat com.example.dormduty.MainActivity$8.onClick(MainActivity.java:132)`,
    `${P}\tat android.view.View.performClick(View.java:8081)`,
  ]
  const [crash] = parseCrashBlocks(lines, { pkg: 'com.example.dormduty' })
  assert.equal(crash.frames.length, 4)
  assert.equal(crash.frames[1].method, 'com.example.dormduty.MainActivity.-$$Nest$mtriggerValidationCrash')
  assert.equal(crash.frames[1].file, null, 'Unknown Source names no file')
  assert.equal(crash.frames[1].unknownSource, true)
  assert.equal(crash.frames[2].file, 'MainActivity.java')
  assert.equal(crash.frames[2].line, 132)
  // The location must still be the real file frame, not the synthetic one.
  assert.equal(crash.location.file, 'MainActivity.java')
  assert.equal(crash.location.line, 234)
})

test('renderCrash produces the location and a bounded stack', () => {
  const [crash] = parseCrashBlocks(DIVIDE_BY_ZERO, { pkg: 'com.example.dormduty' })
  const text = renderCrash(crash)
  assert.match(text, /java\.lang\.ArithmeticException: divide by zero/)
  assert.match(text, /线程: main/)
  assert.match(text, /MainActivity\.java:210/)
  assert.match(text, /at android\.view\.View\.performClick\(View\.java:7659\)/)
})

test('renderCrash includes the cause chain', () => {
  const [crash] = parseCrashBlocks(WITH_CAUSE, { pkg: 'com.example.app' })
  const text = renderCrash(crash)
  assert.match(text, /Caused by: java\.lang\.NullPointerException: boom/)
  assert.match(text, /Inner\.java:42/)
})

test('describeProcess distinguishes running, watched-death and already-gone', () => {
  // Running now.
  assert.match(describeProcess({ running: true, pidBefore: 10, pidAfter: 10 }), /pid 10（运行中）/)
  // We saw it alive and then gone: the strongest form of evidence.
  assert.match(describeProcess({ running: false, pidBefore: 10, pidAfter: null }), /pid 10 → 已退出（进程已死亡）/)
  // The usual case: diagnose runs after the crash, so both samples are empty.
  assert.match(describeProcess({ running: false, pidBefore: null, pidAfter: null }), /未运行（可能已崩溃）/)
})

// ── Flutter / Dart ──────────────────────────────────────────────────────────
//
// Flutter reports an uncaught Dart error on the `flutter` tag with its own frame
// format. The frame to open is the first one from the app's own package — and
// because the Dart package name (`dorm_duty`) is not the Android one
// (`com.example.dormduty`), that choice is made from the URI, not from `pkg`.

const F = '09-30 10:12:34.567  8123  8156 E flutter : '

const DART_DIVIDE_BY_ZERO = [
  `${F}[ERROR:flutter/runtime/dart_vm_initializer.cc(41)] Unhandled Exception: IntegerDivisionByZeroException: Division by zero`,
  `${F}#0      splitBill (package:dorm_duty/duty.dart:42:9)`,
  `${F}#1      _DutyPageState._onSplit.<anonymous closure> (package:dorm_duty/main.dart:118:21)`,
  `${F}#2      _InkResponseState.handleTap (package:flutter/src/material/ink_well.dart:1175:21)`,
  `${F}#3      _rootRun (dart:async/zone.dart:1434:12)`,
  `${F}<asynchronous suspension>`,
]

test('parseDartCrashBlocks reads the exception and every frame', () => {
  const [crash] = parseDartCrashBlocks(DART_DIVIDE_BY_ZERO)
  assert.equal(crash.kind, 'dart')
  assert.equal(crash.exception, 'IntegerDivisionByZeroException')
  assert.equal(crash.message, 'Division by zero')
  assert.equal(crash.frames.length, 4)
  assert.equal(crash.frames[0].method, 'splitBill')
  assert.equal(crash.frames[0].uri, 'package:dorm_duty/duty.dart')
  assert.equal(crash.frames[0].file, 'duty.dart')
  assert.equal(crash.frames[0].line, 42)
  assert.equal(crash.frames[0].column, 9)
  // A Dart function name is not an identifier chain: it can contain spaces.
  assert.equal(crash.frames[1].method, '_DutyPageState._onSplit.<anonymous closure>')
  assert.equal(crash.frames[3].uri, 'dart:async/zone.dart')
})

test('parseDartCrashBlocks stops the trace at the first non-frame line', () => {
  const [crash] = parseDartCrashBlocks([...DART_DIVIDE_BY_ZERO, `${F}Some later log line`])
  assert.equal(crash.frames.length, 4)
  assert.ok(!crash.raw.some((line) => line.includes('Some later log line')))
})

test('the Dart location is the first app frame, not the SDK frames around it', () => {
  const [crash] = parseDartCrashBlocks(DART_DIVIDE_BY_ZERO)
  assert.equal(crash.location.file, 'duty.dart')
  assert.equal(crash.location.line, 42)
  assert.match(crash.location.method, /splitBill$/)
  assert.equal(crash.location.fromCause, null)
})

test('an SDK frame above an app frame does not become the location', () => {
  const [crash] = parseDartCrashBlocks([
    `${F}Unhandled Exception: Bad state: No element`,
    `${F}#0      _InkResponseState.handleTap (package:flutter/src/material/ink_well.dart:1175:21)`,
    `${F}#1      _DutyPageState.build (package:dorm_duty/main.dart:88:5)`,
  ])
  // Dart type names may contain spaces, so the split is on the first colon.
  assert.equal(crash.exception, 'Bad state')
  assert.equal(crash.message, 'No element')
  assert.equal(crash.location.file, 'main.dart')
  assert.equal(crash.location.line, 88)
})

test('a Dart error with no frames still reports a headline', () => {
  // What a release build prints: the error, with no Dart stack to parse.
  const [crash] = parseDartCrashBlocks([`${F}Unhandled Exception: Null check operator used on a null value`])
  assert.equal(crash.exception, 'Null check operator used on a null value')
  assert.equal(crash.frames.length, 0)
  assert.equal(crash.location, null)
  assert.match(crash.headline, /Null check operator/)
})

test('a Dart frame with a URI but no line still counts as a frame', () => {
  const [crash] = parseDartCrashBlocks([
    `${F}Unhandled Exception: StateError: boom`,
    `${F}#0      _start (package:dorm_duty/main.dart)`,
  ])
  assert.equal(crash.frames[0].uri, 'package:dorm_duty/main.dart')
  assert.equal(crash.frames[0].file, 'main.dart')
  assert.equal(crash.frames[0].line, null)
})

test('a URI that names no file cannot be a source location', () => {
  const [crash] = parseDartCrashBlocks([
    `${F}Unhandled Exception: StateError: boom`,
    `${F}#0      _start (dart:core)`,
  ])
  assert.equal(crash.frames[0].file, null)
  assert.equal(crash.location, null)
})

test('analyze reports a Dart crash instead of re-reporting it as a finding', () => {
  const verdict = analyze(DART_DIVIDE_BY_ZERO)
  assert.equal(verdict.crashed, true)
  assert.equal(verdict.crashes.length, 1)
  assert.equal(verdict.findings.filter((f) => f.kind === 'dart-crash').length, 0)
  assert.match(verdict.summary, /IntegerDivisionByZeroException.*duty\.dart:42/)
  assert.equal(verdict.location.file, 'duty.dart')
})

test('analyze orders a Java and a Dart crash by where they appear in the stream', () => {
  const javaFirst = analyze([...DIVIDE_BY_ZERO, ...DART_DIVIDE_BY_ZERO])
  assert.equal(javaFirst.crashes.length, 2)
  assert.equal(javaFirst.crashes[0].kind, 'java')
  assert.equal(javaFirst.location.file, 'MainActivity.java')

  // The reverse order must flip which crash the summary describes.
  const dartFirst = analyze([...DART_DIVIDE_BY_ZERO, ...DIVIDE_BY_ZERO])
  assert.equal(dartFirst.crashes[0].kind, 'dart')
  assert.equal(dartFirst.location.file, 'duty.dart')
})

test('renderCrash renders Dart frames with their URI', () => {
  const [crash] = parseDartCrashBlocks(DART_DIVIDE_BY_ZERO)
  const text = renderCrash(crash)
  assert.match(text, /IntegerDivisionByZeroException: Division by zero/)
  assert.match(text, /定位: duty\.dart:42/)
  assert.match(text, /at splitBill\(package:dorm_duty\/duty\.dart:42\)/)
  assert.match(text, /at _InkResponseState\.handleTap\(package:flutter/)
})
