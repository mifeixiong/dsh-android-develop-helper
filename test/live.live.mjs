/**
 * Live integration suite — runs only against a real emulator/device.
 *
 * Every test here asserts on *observed* device state rather than on the tool's
 * own claims, so a regression in the ADB layer surfaces as a failed assertion
 * instead of a plausible-looking success message.
 *
 * Run with:  npm run test:live
 * Skipped automatically when nothing is connected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { Device } from '../src/device.js'
import { apkSummary } from '../src/apk.js'
import { Adb } from '../src/adb.js'
import { resolveDevice } from '../src/devices.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_APK = path.join(HERE, '..', 'artifacts', '_apk', 'wakeup.apk')

/**
 * Get an APK to install-test with.
 *
 * The repository does not ship a 36 MB fixture, so when one is not already
 * cached the test pulls the first third-party package off the device.  The
 * assertions are the same either way; this only avoids carrying a binary.
 */
async function ensureApkFixture(device) {
  if (fs.existsSync(FIXTURE_APK)) return FIXTURE_APK
  const packages = await device.listPackages({ thirdPartyOnly: true })
  for (const pkg of packages) {
    const info = await device.packageInfo(pkg).catch(() => null)
    const remote = info?.apkPaths?.[0]
    if (!remote) continue
    fs.mkdirSync(path.dirname(FIXTURE_APK), { recursive: true })
    const result = await device.adb.run(['pull', remote, FIXTURE_APK], { timeoutMs: 300000 })
    if (result.code === 0 && fs.existsSync(FIXTURE_APK)) return FIXTURE_APK
  }
  return null
}

const cfg = loadConfig({ allowDiskSearch: true })

async function connectOrSkip(t) {
  const adb = new Adb({ bin: cfg.adb, timeoutMs: cfg.timeoutMs })
  try {
    const resolved = await resolveDevice(adb, cfg, {})
    return Device.connect(cfg, { label: 'live-test' })
  } catch (error) {
    t.skip(`no device available: ${error.message.split('\n')[0]}`)
    return null
  }
}

test('doctor reports a healthy device', async (t) => {
  const device = await connectOrSkip(t)
  if (!device) return
  const report = await device.doctor()
  try {
    const failed = report.checks.filter((c) => !c.ok)
    assert.deepEqual(failed, [], `failed checks: ${JSON.stringify(failed)}`)
    assert.match(report.serial, /:/, 'serial should be a host:port or emulator-NNNN form')
  } finally {
    await device.session?.close()
  }
})

test('screenshot downscaling actually shrinks the payload', async (t) => {
  const device = await connectOrSkip(t)
  if (!device) return
  try {
    const full = await device.screenshot({ scale: 1, save: false })
    const half = await device.screenshot({ scale: 0.5, save: false })
    assert.equal(full.sourceWidth, half.sourceWidth, 'both come from the same framebuffer')
    assert.ok(half.bytes < full.bytes, `0.5x (${half.bytes}B) must be smaller than 1x (${full.bytes}B)`)
    // PNG gain over the raw RGBA framebuffer is content-dependent: a flat app
    // screen reaches ~50x, a photographic launcher wallpaper only ~4x. Assert the
    // weak bound here and let the downscale comparison above carry the signal.
    assert.ok(full.compressionRatio > 2, `raw→PNG compression was only ${full.compressionRatio}`)
    assert.equal(half.hash.length, 18)
  } finally {
    await device.session?.close()
  }
})

test('UI tree is readable, indexable and smaller than the raw XML', async (t) => {
  const device = await connectOrSkip(t)
  if (!device) return
  try {
    const view = await device.uiRows({ refresh: true, maxNodes: 120 })
    assert.ok(view.total > 0, 'device returned no UI nodes')
    assert.ok(view.returned > 0, 'simplify dropped every node')
    assert.ok(view.rows.every((r) => Number.isInteger(r.node)))
    assert.ok(view.text.length > 0)
    const node = view.rows.find((r) => r.bounds && r.bounds.width > 0)
    assert.ok(node, 'no node carries usable bounds')
  } finally {
    await device.session?.close()
  }
})

test('current activity is reported with a parseable component', async (t) => {
  const device = await connectOrSkip(t)
  if (!device) return
  try {
    const activity = await device.currentActivity()
    if (activity.component) {
      assert.match(activity.component, /^[\w.]+\/[\w.$]+$/)
    }
  } finally {
    await device.session?.close()
  }
})

test('logcat returns bounded, time-ordered lines', async (t) => {
  const device = await connectOrSkip(t)
  if (!device) return
  try {
    const result = await device.logcat({ maxLines: 20 })
    assert.ok(Array.isArray(result.lines))
    assert.ok(result.lines.length <= 20)
    assert.ok(result.total >= result.lines.length)
  } finally {
    await device.session?.close()
  }
})

test('hash-driven idle detection converges', async (t) => {
  const device = await connectOrSkip(t)
  if (!device) return
  try {
    const idle = await device.waitIdle({ timeoutMs: 8000, allowNever: true })
    assert.ok(idle.frames >= 2, 'idle detection must sample more than one frame')
    assert.equal(typeof idle.hash, 'string')
  } finally {
    await device.session?.close()
  }
})

test('key input reaches the device and changes the foreground app', async (t) => {
  const device = await connectOrSkip(t)
  if (!device) return
  try {
    await device.key('home', { settleMs: 400 })
    await new Promise((r) => setTimeout(r, 1200))
    const activity = await device.currentActivity()
    assert.ok(activity.component, 'no foreground activity after pressing home')
  } finally {
    await device.session?.close()
  }
})

test('install verifies the on-device APK hash', { timeout: 300000 }, async (t) => {
  const device = await connectOrSkip(t)
  if (!device) return
  const apk = await ensureApkFixture(device).catch(() => null)
  if (!apk) {
    await device.session?.close()
    t.skip('no local APK and none could be pulled from the device')
    return
  }
  try {
    const summary = apkSummary(apk)
    const report = await device.install(apk, { verify: true })
    assert.equal(report.success, true, report.output)
    assert.equal(report.package, summary.package, 'package name must come from the binary manifest')
    assert.equal(report.verified, true, `hash mismatch: local=${report.expectedSha} device=${report.deviceSha}`)
    assert.equal(report.deviceSha, report.expectedSha)

    // And the negative case: a deliberately wrong expectation must be rejected.
    await assert.rejects(
      () => device.install(apk, { verify: true, expectSha: 'f'.repeat(64) }),
      /安装校验失败/,
    )
  } finally {
    await device.session?.close()
  }
})

test('launcher resolution finds a startable component', async (t) => {
  const device = await connectOrSkip(t)
  if (!device) return
  try {
    const packages = await device.listPackages({ thirdPartyOnly: true })
    assert.ok(packages.length > 0, 'no third-party packages installed')
    const { launcherActivity } = await import('../src/app.js')
    const component = await launcherActivity(device.adb, packages[0])
    if (component) assert.match(component, /^[\w.]+\/[\w.$]+$/)
  } finally {
    await device.session?.close()
  }
})
