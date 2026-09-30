/**
 * End-to-end validation of the plugin against a real app.
 *
 * This is the objective's Phase 3 loop, made repeatable: build → install (with
 * hash verification) → launch → drive the UI by resource-id → read the app's own
 * private state over ADB → exercise the notification path → re-read device state.
 *
 * Every assertion is made against the *device*, never against the tool's own
 * report, so a regression anywhere in the ADB layer fails the test instead of
 * producing a plausible-looking success.
 *
 * Prerequisites:
 *   node tools/install-sdk.mjs
 *   node tools/build-apk.mjs --project examples/dorm-duty
 *
 * Run with:  npm run test:e2e
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
const APK = path.join(HERE, '..', 'build', 'dorm-duty.apk')
const PKG = 'com.example.dormduty'
const cfg = loadConfig({ allowDiskSearch: true })

async function connectOrSkip(t) {
  const adb = new Adb({ bin: cfg.adb, timeoutMs: cfg.timeoutMs })
  try {
    await resolveDevice(adb, cfg, {})
  } catch (error) {
    t.skip(`no device available: ${error.message.split('\n')[0]}`)
    return null
  }
  return Device.connect(cfg, { label: 'e2e' })
}

/**
 * Text of the first node matching a resource-id, or null.
 *
 * Two options are deliberate:
 *   - `enabledOnly: false`, because `find` excludes disabled nodes by default —
 *     the right default for resolving a tap target, the wrong one for reading
 *     state, and it makes "assert this button is disabled" impossible otherwise.
 *   - `compressed: false`, because a compressed uiautomator dump contains only
 *     what is currently on screen. Without it, a row that has scrolled below the
 *     fold reads as "absent" rather than "off-screen", which is how this test
 *     first failed on a landscape emulator.
 */
async function textOf(device, id) {
  const { nodes } = await device.find({ id, enabledOnly: false }, { refresh: true, compressed: false })
  return nodes.length > 0 ? nodes[0].text : null
}

async function tapAndExpect(device, id, expectId, expected) {
  await device.tapId(id, { refresh: true })
  await device.waitIdle({ timeoutMs: 4000, allowNever: true })
  const value = await textOf(device, expectId)
  assert.equal(value, expected, `after tapping ${id}, ${expectId} should be "${expected}" but was "${value}"`)
  return value
}

test('dorm-duty app: build → install → drive → inspect → notify', { timeout: 300000 }, async (t) => {
  if (!fs.existsSync(APK)) {
    t.skip(`APK not built yet: ${APK} (run tools/build-apk.mjs)`)
    return
  }
  const device = await connectOrSkip(t)
  if (!device) return

  try {
    // ── install ────────────────────────────────────────────────────────────
    const report = await device.install(APK, { verify: true })
    assert.equal(report.success, true, report.output)
    assert.equal(report.package, PKG)
    assert.equal(report.verified, true, `hash mismatch: local=${report.expectedSha} device=${report.deviceSha}`)

    // ── launch from a clean state ──────────────────────────────────────────
    await device.clearData(PKG)
    // `pm clear` revokes the runtime permissions that `install -g` granted, so
    // the app would start and silently fail to notify. Re-grant before launching.
    const grants = await device.grantPermissions(PKG)
    assert.ok(
      grants.granted.some((p) => p.endsWith('POST_NOTIFICATIONS')) ||
        grants.failed.length === 0,
      `could not restore POST_NOTIFICATIONS: ${JSON.stringify(grants)}`,
    )
    const launch = await device.start(PKG, { forceStop: true })
    assert.equal(launch.success, true, launch.output)
    await device.waitActivity('MainActivity', { timeoutMs: 20000 })

    // Pin the orientation so the geometry is deterministic. An emulator left in
    // landscape reports a shorter screen, and the lower weekday rows then fall
    // outside the compressed dump — which is how this test first failed.
    const rotation = await device.setRotation(0)
    assert.equal(rotation, 0)

    // The empty state must be exactly that: no roster, every action disabled.
    assert.equal(await textOf(device, 'tvRosterSummary'), '还没有成员，先填名单再生成')
    const emptyButtons = (
      await device.find({ id: 'btnDone1', enabledOnly: false }, { refresh: true, compressed: false })
    ).nodes
    assert.equal(emptyButtons.length, 1, 'btnDone1 should exist in the empty state')
    assert.equal(emptyButtons[0].enabled, false, 'mark-complete must be disabled before a roster exists')

    // ── step 1: fill the roster ────────────────────────────────────────────
    await device.tapId('btnExample', { refresh: true })
    await device.waitText('zhangsan', { timeoutMs: 15000 })

    assert.equal(await textOf(device, 'tvName1'), 'zhangsan')
    assert.equal(await textOf(device, 'tvName2'), 'lisi')
    assert.equal(await textOf(device, 'tvName3'), 'wangwu')
    assert.equal(await textOf(device, 'tvName4'), 'zhaoliu')
    // Round robin wraps: the 5th day is the 1st member again.
    assert.equal(await textOf(device, 'tvName5'), 'zhangsan')
    assert.match(await textOf(device, 'tvRosterSummary'), /4/)

    // ── step 2: mark Monday complete ───────────────────────────────────────
    await tapAndExpect(device, 'btnDone1', 'tvStatus1', '已完成')
    assert.equal(await textOf(device, 'btnDone1'), '撤销完成')
    // The other days must be untouched.
    assert.equal(await textOf(device, 'tvStatus2'), '未完成')

    // ── step 3: read the app's private state over ADB ──────────────────────
    const prefs = await device.shellLoose(
      `run-as ${PKG} cat shared_prefs/dorm_duty.xml`,
      { timeoutMs: 15000 },
    )
    assert.match(prefs.text, /name="done">1/, 'Monday must be persisted as done')
    assert.match(prefs.text, /zhangsan/, 'the roster must be persisted')

    // ── step 4: reset the completion marks ─────────────────────────────────
    assert.equal(await device.scrollTo({ id: 'btnResetDone' }, {}).then((r) => r.found), true)
    await device.tapId('btnResetDone', { refresh: true })
    await device.waitIdle({ timeoutMs: 4000, allowNever: true })
    assert.equal(await textOf(device, 'tvStatus1'), '未完成')

    // ── step 5: schedule the daily reminder ────────────────────────────────
    const reached = await device.scrollTo({ id: 'btnToggleReminder' }, {})
    assert.equal(reached.found, true, 'could not scroll to the reminder controls')
    await tapAndExpect(device, 'btnToggleReminder', 'tvReminderStatus', '已开启')

    const alarm = await device.shellLoose('dumpsys alarm | grep -A2 com.example.dormduty', { timeoutMs: 20000 })
    assert.match(alarm.text, /RTC_WAKEUP/, 'no wakeup alarm was scheduled for the reminder')
    assert.match(alarm.text, /com\.example\.dormduty\.REMIND/, 'the alarm is not ours')

    // ── step 6: post the reminder now ──────────────────────────────────────
    await device.tapId('btnTestReminder', { refresh: true })
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const notifications = await device.shellLoose(
      `dumpsys notification --noredact | grep -c "pkg=${PKG}"`,
      { timeoutMs: 20000 },
    )
    assert.ok(
      Number(notifications.text.trim()) > 0,
      `no notification recorded for ${PKG}: ${notifications.text}`,
    )

    const record = await device.shellLoose(
      `dumpsys notification --noredact | grep "pkg=${PKG}" | head -1`,
      { timeoutMs: 20000 },
    )
    assert.match(record.text, /dorm_duty_reminder/, 'the notification must use the reminder channel')
  } finally {
    await device.session?.close()
  }
})

test('dorm-duty app: the plugin survives a reinstall over itself', { timeout: 300000 }, async (t) => {
  if (!fs.existsSync(APK)) {
    t.skip(`APK not built yet: ${APK}`)
    return
  }
  const device = await connectOrSkip(t)
  if (!device) return
  try {
    // Reinstalling the identical APK is the case where `adb install` prints a
    // `Success:` streaming line and a `Failure [...]` commit line together; the
    // verification must not be fooled either way.
    const first = await device.install(APK, { verify: true })
    assert.equal(first.verified, true)
    const second = await device.install(APK, { verify: true })
    assert.equal(second.success, true, second.output)
    assert.equal(second.verified, true, 'reinstall must leave the verified APK in place')
  } finally {
    await device.session?.close()
  }
})
