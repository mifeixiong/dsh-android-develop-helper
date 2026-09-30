/**
 * Crash localisation against the **Flutter** example.
 *
 * The Java version of this test can lean on two things that Flutter does not
 * offer: AndroidRuntime prints `FATAL EXCEPTION` and the process actually dies.
 * A Dart error is reported by the Flutter engine on the `flutter` tag and the
 * process survives — so the evidence here is different, and the test asserts the
 * difference instead of pretending otherwise:
 *
 *   - the verifier is the parsed Dart stack, not a dead pid;
 *   - the location is a Dart `package:` URI and line, and the test reads that
 *     line out of `lib/duty.dart` to prove the number is real;
 *   - the app must still be running afterwards, which is checked too.
 *
 * Prerequisites:
 *   cd examples/dorm-duty-flutter && flutter build apk --debug
 *
 * A **debug** build, and that is not incidental. Line numbers only survive in a
 * JIT build: a profile build prints the exception and the frames, but the AOT
 * compiler inlines the failing call away, so its frame reads
 * `_DutyPageState._splitBill (package:…/duty_page.dart)` with no line at all —
 * nothing to open, and nothing to check. Measured on this emulator, not assumed.
 * The end-to-end test uses the profile APK instead, because there speed matters
 * and the frame text does not.
 *
 * Run with:  npm run test:flutter:crash
 * Skipped automatically when no device is connected or the APK is missing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { Device } from '../src/device.js'
import { Adb } from '../src/adb.js'
import { resolveDevice } from '../src/devices.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.join(HERE, '..', 'examples', 'dorm-duty-flutter')
const APK = path.join(PROJECT, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk')
const DUTY_DART = path.join(PROJECT, 'lib', 'duty.dart')
const PKG = 'com.example.dorm_duty_flutter'
const cfg = loadConfig({ allowDiskSearch: true })

async function connectOrSkip(t) {
  const adb = new Adb({ bin: cfg.adb, timeoutMs: cfg.timeoutMs })
  try {
    await resolveDevice(adb, cfg, {})
  } catch (error) {
    t.skip(`no device available: ${error.message.split('\n')[0]}`)
    return null
  }
  return Device.connect(cfg, { label: 'flutter-crash' })
}

/** Install, launch from a clean state and open the verification panel. */
async function launchAndOpenPanel(device) {
  await device.install(APK, { verify: true })
  await device.clearData(PKG)
  await device.grantPermissions(PKG)
  await device.start(PKG, { forceStop: true })
  await device.waitActivity('MainActivity', { timeoutMs: 40000 })
  await device.setRotation(0)
  await device.logcat({ buffers: ['main'], maxLines: 10, clear: true }).catch(() => {})

  await device.scrollTo({ text: '验证用' }, {})
  await device.tapText('验证用', { refresh: true })
  await device.waitText('分摊账单', { timeoutMs: 20000 })
}

/** Source line a parsed `file:line` points at, read from disk. */
function sourceLineOf(location) {
  const lines = fs.readFileSync(DUTY_DART, 'utf8').split(/\r?\n/)
  assert.ok(
    location.line >= 1 && location.line <= lines.length,
    `reported line ${location.line} is outside duty.dart (${lines.length} lines)`,
  )
  return lines[location.line - 1]
}

test('a Dart exception is localised to the exact source line', { timeout: 420000 }, async (t) => {
  if (!fs.existsSync(APK)) {
    t.skip(`Flutter APK not built yet: ${APK} (run flutter build apk --profile)`)
    return
  }
  const device = await connectOrSkip(t)
  if (!device) return

  try {
    await launchAndOpenPanel(device)

    // An empty roster means `members == 0`, and `splitBill` divides by zero —
    // a real bug in the app, not a `throw` written for the test.
    await device.tapId('btnSplitBill', { refresh: true })
    await new Promise((resolve) => setTimeout(resolve, 2500))

    const report = await device.diagnose(PKG, { maxLines: 6000 })

    assert.ok(report.crashes.length > 0, `no Dart crash parsed; summary=${report.summary}`)
    const crash = report.crashes[0]
    assert.equal(crash.kind, 'dart', 'the crash must be parsed as a Dart error, not a Java one')
    assert.match(String(crash.headline), /UnsupportedError|IntegerDivisionByZero|Division/i)

    assert.ok(crash.location, `no app frame found in ${JSON.stringify(crash.frames, null, 2)}`)
    assert.equal(crash.location.file, 'duty.dart')
    assert.match(crash.location.method, /splitBill/)

    // The reported line number is the claim; the file on disk is the check.
    const line = sourceLineOf(crash.location)
    assert.match(
      line,
      /totalCents ~\/ members/,
      `duty.dart:${crash.location.line} should be the division, but reads: ${line.trim()}`,
    )

    // A Dart error does not kill the process — assert that too, because the Java
    // test's strongest evidence (a dead pid) is simply unavailable here.
    assert.equal(report.running, true, 'the Flutter process must survive an uncaught Dart error')
  } finally {
    await device.session?.close()
  }
})

test('the validation crash is localised to the line that throws it', { timeout: 420000 }, async (t) => {
  if (!fs.existsSync(APK)) {
    t.skip(`Flutter APK not built yet: ${APK}`)
    return
  }
  const device = await connectOrSkip(t)
  if (!device) return

  try {
    await launchAndOpenPanel(device)

    await device.tapId('btnTestCrash', { refresh: true })
    await new Promise((resolve) => setTimeout(resolve, 2500))

    const report = await device.diagnose(PKG, { maxLines: 6000 })
    const crash = report.crashes.find((c) => /RangeError|RangeError|Index/i.test(String(c.headline)))
    assert.ok(crash, `no RangeError parsed; summary=${report.summary}`)
    assert.ok(crash.location, 'the RangeError has no app frame')
    assert.equal(crash.location.file, 'duty.dart')

    const line = sourceLineOf(crash.location)
    assert.match(
      line,
      /empty\[3\]/,
      `duty.dart:${crash.location.line} should be the out-of-range read, but reads: ${line.trim()}`,
    )
  } finally {
    await device.session?.close()
  }
})
