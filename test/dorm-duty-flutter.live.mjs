/**
 * End-to-end validation against the **Flutter** example.
 *
 * The Java example proves this toolkit works on classic Views. This one asks the
 * harder question: can it drive a framework that draws its own pixels?
 *
 * It can, because Flutter mirrors its semantics tree into the Android
 * accessibility hierarchy and maps `Semantics(identifier: …)` onto
 * `AccessibilityNodeInfo.setViewIdResourceName` — the `resource-id` that
 * `android_ui` prints and `android_tap` matches on. Every assertion below goes
 * through that path, so if a Flutter release ever stopped publishing identifiers
 * this test fails loudly instead of the toolkit silently degrading to coordinate
 * taps.
 *
 * Prerequisites:
 *   cd examples/dorm-duty-flutter && flutter build apk --profile
 *
 * Run with:  npm run test:flutter
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
const APK = path.join(PROJECT, 'build', 'app', 'outputs', 'flutter-apk', 'app-profile.apk')
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
  return Device.connect(cfg, { label: 'flutter-e2e' })
}

/**
 * Readable label of the first node carrying a resource-id, or null.
 *
 * Flutter publishes a semantics label as `content-desc`, not as `android:text`,
 * so the value can live in either field — the same reason `matchesSelector`
 * treats `content-desc` as text.
 */
async function textOf(device, id) {
  const { nodes } = await device.find({ id, enabledOnly: false }, { refresh: true, compressed: false })
  if (nodes.length === 0) return null
  const node = nodes[0]
  return node.text || node.contentDesc || null
}

async function exists(device, id) {
  const { nodes } = await device.find({ id, enabledOnly: false }, { refresh: true, compressed: false })
  return nodes.length > 0
}

/**
 * Wait for the semantics tree to report an id.
 *
 * A freshly launched Flutter app builds its accessibility tree only once
 * something asks for it, and the first `uiautomator dump` is often the thing
 * that asks. Polling here is therefore not flakiness cover — it is waiting for
 * the bridge to come up, and it is also the assertion that the bridge exists.
 */
async function waitForId(device, id, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await exists(device, id)) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
}

test('dorm-duty-flutter: install → drive by resource-id → read private state → notify', { timeout: 600000 }, async (t) => {
  if (!fs.existsSync(APK)) {
    t.skip(`Flutter APK not built yet: ${APK} (run flutter build apk --profile)`)
    return
  }
  const device = await connectOrSkip(t)
  if (!device) return

  try {
    // ── install, with the on-device hash check ──────────────────────────────
    const report = await device.install(APK, { verify: true })
    assert.equal(report.success, true, report.output)
    assert.equal(report.package, PKG, 'the package name comes from the binary manifest, not a byte scan')
    assert.equal(report.verified, true, `hash mismatch: local=${report.expectedSha} device=${report.deviceSha}`)

    // ── launch from a clean state ───────────────────────────────────────────
    await device.clearData(PKG)
    // `pm clear` revokes what `install -g` granted; without this the app starts
    // and then cannot post its reminder.
    const grants = await device.grantPermissions(PKG)
    assert.ok(
      grants.granted.some((p) => p.endsWith('POST_NOTIFICATIONS')) || grants.failed.length === 0,
      `could not restore POST_NOTIFICATIONS: ${JSON.stringify(grants)}`,
    )
    const launch = await device.start(PKG, { forceStop: true })
    assert.equal(launch.success, true, launch.output)
    await device.waitActivity('MainActivity', { timeoutMs: 40000 })
    await device.setRotation(0)

    // ── the empty state ─────────────────────────────────────────────────────
    // This is the assertion that matters most: it only passes if Flutter pushed
    // its identifiers into the accessibility hierarchy.
    assert.equal(
      await waitForId(device, 'tvEmpty'),
      true,
      'Flutter never published its semantics tree — no resource-id ever appeared',
    )
    assert.equal(await textOf(device, 'tvEmpty'), '还没有值日表')
    assert.equal(await textOf(device, 'tvProgress'), '0 / 0')
    assert.equal(await exists(device, 'btnDone1'), false, 'no roster rows exist yet')

    // ── generate the roster ─────────────────────────────────────────────────
    await device.tapId('btnGenerate', { refresh: true })
    assert.equal(await device.waitText('zhangsan', { timeoutMs: 20000 }).then(() => true), true)

    assert.equal(await textOf(device, 'tvName1'), 'zhangsan')
    assert.equal(await textOf(device, 'tvName2'), 'lisi')
    assert.equal(await textOf(device, 'tvName3'), 'wangwu')
    // Round robin wraps: the 5th day is the 1st member again.
    assert.equal(await textOf(device, 'tvName5'), 'zhangsan')
    assert.equal(await textOf(device, 'tvProgress'), '0 / 5')
    assert.equal(await textOf(device, 'tvStatus1'), '未完成')

    // ── mark Monday complete ────────────────────────────────────────────────
    // The button label lives on the *identified* node, which is the same node a
    // tap resolves to — that is the whole point of `excludeSemantics` in the app.
    assert.equal(await textOf(device, 'btnDone1'), '完成')
    await device.tapId('btnDone1', { refresh: true })
    await device.waitText('已完成', { timeoutMs: 15000 })
    assert.equal(await textOf(device, 'tvStatus1'), '已完成')
    assert.equal(await textOf(device, 'btnDone1'), '撤销完成')
    assert.equal(await textOf(device, 'tvStatus2'), '未完成', 'the other days must be untouched')
    assert.equal(await textOf(device, 'tvProgress'), '1 / 5')

    // ── read the app's private state over ADB ───────────────────────────────
    // No `shared_preferences` here: the roster is a plain JSON file in the app's
    // private files directory, so reading it still needs `run-as`. The path is
    // the platform's `filesDir`, not `Directory.systemTemp` — the temp directory
    // followed TMPDIR, the write landed outside the sandbox, and the first
    // version of this test is what noticed.
    const roster = await device.shellLoose(`run-as ${PKG} cat files/duty_roster.json`, { timeoutMs: 20000 })
    assert.match(roster.text, /zhangsan/, 'the roster must be persisted')
    assert.match(roster.text, /"done":true/, 'Monday must be persisted as done')

    // ── post the reminder, then prove the device recorded it ────────────────
    await device.scrollTo({ text: '验证用' }, {})
    await device.tapText('验证用', { refresh: true })
    await device.waitIdle({ timeoutMs: 5000, allowNever: true })

    // Flutter publishes semantic nodes **only for what is on screen**: a control
    // scrolled out of view is not in the accessibility tree at all, not merely
    // marked invisible. So this scroll is not how the test finds the button — it
    // is the only way the button exists to be found. (`uiautomator --no-compressed`
    // does not change that: the filter is on the Flutter side.)
    const reached = await device.scrollTo({ id: 'btnNotify' }, {})
    assert.equal(reached.found, true, 'could not scroll to the reminder control')

    // The screen reports the path it writes to; the assertion above proved the
    // file is really there. Together they make a silent persistence failure
    // impossible to miss.
    assert.match(
      String(await textOf(device, 'tvStorePath')),
      /\/files\/duty_roster\.json$/,
      'the panel must name the file it actually writes',
    )
    await device.tapId('btnNotify', { refresh: true })
    await new Promise((resolve) => setTimeout(resolve, 2500))

    const count = await device.shellLoose(
      `dumpsys notification --noredact | grep -c "pkg=${PKG}"`,
      { timeoutMs: 25000 },
    )
    assert.ok(Number(count.text.trim()) > 0, `no notification recorded for ${PKG}: ${count.text}`)

    const record = await device.shellLoose(
      `dumpsys notification --noredact | grep "pkg=${PKG}" | head -1`,
      { timeoutMs: 25000 },
    )
    assert.match(record.text, /dorm_duty_reminder/, 'the notification must use the app’s own channel')

    // ── clear the roster and watch the empty state come back ────────────────
    const clearReached = await device.scrollTo({ id: 'btnClear' }, {})
    assert.equal(clearReached.found, true, 'could not scroll to the clear control')
    await device.tapId('btnClear', { refresh: true })
    await device.waitGone({ id: 'tvName1' }, { timeoutMs: 20000 })
    assert.equal(await textOf(device, 'tvProgress'), '0 / 0')
    assert.equal(await exists(device, 'tvName1'), false)
  } finally {
    await device.session?.close()
  }
})

test('dorm-duty-flutter: the plugin survives a reinstall over itself', { timeout: 600000 }, async (t) => {
  if (!fs.existsSync(APK)) {
    t.skip(`Flutter APK not built yet: ${APK}`)
    return
  }
  const device = await connectOrSkip(t)
  if (!device) return
  try {
    // Reinstalling the identical APK is the case where `adb install` prints a
    // `Success:` streaming line and a `Failure [...]` commit line together. A
    // Flutter APK is ~40 MB, so this also exercises the hash check at a size
    // where the round trip is worth measuring.
    const first = await device.install(APK, { verify: true })
    assert.equal(first.verified, true)
    const second = await device.install(APK, { verify: true })
    assert.equal(second.success, true, second.output)
    assert.equal(second.verified, true, 'reinstall must leave the verified APK in place')
  } finally {
    await device.session?.close()
  }
})
