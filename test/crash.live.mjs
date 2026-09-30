/**
 * Error localisation: crash → logcat → the exact source line.
 *
 * The objective's checklist ends with "故意制造一个异常，插件能否通过 Logcat + 截图
 * 定位问题". This file is that check, made repeatable, and it asserts the strongest
 * form of the claim: the `File.java:line` the tool reports is read back out of
 * the source file on disk and must contain the expression that threw.
 *
 * Prerequisites:
 *   node tools/install-sdk.mjs
 *   node tools/build-apk.mjs --project examples/dorm-duty
 *
 * Run with:  npm run test:crash
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
const REPO = path.join(HERE, '..')
const APK = path.join(REPO, 'build', 'dorm-duty.apk')
const PKG = 'com.example.dormduty'
const SOURCE_ROOT = path.join(REPO, 'examples', 'dorm-duty', 'java')
const cfg = loadConfig({ allowDiskSearch: true })

/** Read the line the tool pointed at, straight from the checked-in source. */
function sourceLineOf(fileName, lineNumber) {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === fileName) found.push(full)
    }
  }
  walk(SOURCE_ROOT)
  if (found.length === 0) return null
  const lines = fs.readFileSync(found[0], 'utf8').split(/\r?\n/)
  return { path: found[0], text: lines[lineNumber - 1] ?? null, total: lines.length }
}

async function connectOrSkip(t) {
  const adb = new Adb({ bin: cfg.adb, timeoutMs: cfg.timeoutMs })
  try {
    await resolveDevice(adb, cfg, {})
  } catch (error) {
    t.skip(`no device available: ${error.message.split('\n')[0]}`)
    return null
  }
  return Device.connect(cfg, { label: 'crash-e2e' })
}

/** Bring the app up from a clean slate. */
async function freshLaunch(device) {
  // Assert the precondition instead of assuming it: a silently failed `pm clear`
  // leaves the previous test's roster in place, which is exactly how the
  // deliberate crash once reported `length=4; index=4` instead of `length=0`.
  const cleared = await device.clearData(PKG)
  assert.equal(cleared.success, true, `pm clear failed: ${cleared.output}`)
  await device.grantPermissions(PKG)
  await device.setRotation(0)
  await device.adb.shellLoose('logcat -c', { timeoutMs: 10000 })
  const launch = await device.start(PKG, { forceStop: true })
  assert.equal(launch.success, true, launch.output)
  await device.waitActivity('MainActivity', { timeoutMs: 20000 })
  await device.waitIdle({ timeoutMs: 5000, allowNever: true })

  const { nodes } = await device.find(
    { id: 'tvRosterSummary', enabledOnly: false },
    { refresh: true, compressed: false },
  )
  assert.equal(nodes[0]?.text, '还没有成员，先填名单再生成', 'the app did not start from a clean state')
}

/** Scroll until a resource-id is on screen, then tap it. */
async function scrollAndTap(device, id) {
  const reached = await device.scrollTo({ id }, { direction: 'down', maxScrolls: 8 })
  assert.equal(reached.found, true, `could not scroll to ${id}`)
  await device.tapId(id, { refresh: true })
}

test('a deliberate exception is localised to the exact source line', { timeout: 300000 }, async (t) => {
  if (!fs.existsSync(APK)) {
    t.skip(`APK not built yet: ${APK}`)
    return
  }
  const device = await connectOrSkip(t)
  if (!device) return

  try {
    await device.install(APK, { verify: true })
    await freshLaunch(device)

    // ── the deliberate crash ───────────────────────────────────────────────
    await scrollAndTap(device, 'btnCrash')
    await new Promise((resolve) => setTimeout(resolve, 3000))

    // Evidence 1: the app is gone. The process dying is independent of logcat.
    const activity = await device.currentActivity()
    assert.notEqual(activity.package, PKG, `app should have died, but ${activity.component} is foreground`)

    // Evidence 2: the log verdict names the exception and the code location.
    const report = await device.diagnose(PKG)
    assert.equal(report.crashed, true, 'diagnose found no crash')
    assert.equal(report.crashes.length, 1, `expected one parsed crash, got ${report.crashes.length}`)
    const crash = report.crashes[0]
    assert.equal(crash.exception, 'java.lang.ArrayIndexOutOfBoundsException')
    assert.equal(crash.message, 'length=0; index=0', 'the clean slate should give an empty roster')
    assert.equal(crash.thread, 'main')
    assert.equal(crash.process, PKG)
    assert.equal(crash.location?.file, 'MainActivity.java')
    assert.ok(Number.isInteger(crash.location.line) && crash.location.line > 0, 'no line number')
    assert.match(crash.location.method, /triggerValidationCrash$/)

    // The crashed process must not be the one still running. Not asserting
    // "nothing is running" outright: Android may start the process again for a
    // pending broadcast (this app schedules an alarm), which does not undo the
    // crash. What matters is that the pid in the verdict is not the live one.
    if (report.running) {
      assert.notEqual(
        report.pidAfter,
        crash.pid,
        `pid ${report.pidAfter} is both the crashed and the running process`,
      )
    }

    // Evidence 3: the reported line really is the line that threw.
    const source = sourceLineOf(crash.location.file, crash.location.line)
    assert.ok(source, `${crash.location.file} not found under ${SOURCE_ROOT}`)
    assert.ok(
      source.text.includes('members[index]'),
      `line ${crash.location.line} of ${crash.location.file} is "${source.text?.trim()}", not the throwing expression`,
    )

    // Evidence 4: a screenshot of the failure was captured and is a real PNG.
    const shot = await device.screenshot({ scale: 0.5, label: 'crash' })
    assert.ok(shot.path && fs.existsSync(shot.path), 'no screenshot artifact')
    const header = fs.readFileSync(shot.path).subarray(0, 8)
    assert.deepEqual([...header], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'artifact is not a PNG')
  } finally {
    await device.session?.close()
  }
})

test('diagnose does not blame the app for another process\'s tombstone', { timeout: 300000 }, async (t) => {
  if (!fs.existsSync(APK)) {
    t.skip(`APK not built yet: ${APK}`)
    return
  }
  const device = await connectOrSkip(t)
  if (!device) return

  try {
    await freshLaunch(device)
    // Every uiautomator dump SIGSEGVs on this emulator image, so by now the crash
    // buffer is full of uiautomator tombstones. A naïve reader reports them as the
    // app's native crash; the tool must set them aside instead.
    await device.uiRows({ refresh: true, maxNodes: 20 })
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const report = await device.diagnose(PKG)
    assert.equal(report.crashes.length, 0, 'the app did not crash')
    assert.equal(report.tombstones.length, 0, 'no tombstone belongs to this app')
    if (report.ignored.length > 0) {
      assert.ok(
        report.ignored.every((entry) => entry.process !== PKG),
        'ignored entries must belong to other processes',
      )
    }
  } finally {
    await device.session?.close()
  }
})

test('the fixed bill split no longer throws on an empty roster', { timeout: 300000 }, async (t) => {
  if (!fs.existsSync(APK)) {
    t.skip(`APK not built yet: ${APK}`)
    return
  }
  const device = await connectOrSkip(t)
  if (!device) return

  try {
    await freshLaunch(device)

    // Same steps that used to produce
    // `java.lang.ArithmeticException: divide by zero` at MainActivity.java:197.
    const reached = await device.scrollTo({ id: 'etBillAmount' }, { direction: 'down', maxScrolls: 8 })
    assert.equal(reached.found, true, 'could not reach the bill field')
    await device.tapId('etBillAmount', { refresh: true })
    await device.text('120', { replace: true })
    await device.key('back', { settleMs: 600 })

    await scrollAndTap(device, 'btnSplitBill')
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const activity = await device.currentActivity()
    assert.equal(activity.package, PKG, 'the app must survive the guarded path')

    const report = await device.diagnose(PKG)
    assert.equal(report.crashed, false, `unexpected crash after the fix: ${report.summary}`)

    // The guard must not have produced a result either — there is no roster.
    const { nodes } = await device.find({ id: 'tvBillResult', enabledOnly: false }, { refresh: true, compressed: false })
    assert.equal(nodes[0]?.text, '还没有分摊结果')
  } finally {
    await device.session?.close()
  }
})
