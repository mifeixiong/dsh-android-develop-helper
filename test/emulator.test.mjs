import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launcherCandidates, findLauncher, LAUNCHABLE_TYPES, managerCandidates } from '../src/emulator.js'

/**
 * Every vendor install location this module knows is a Windows path
 * (`%ProgramFiles%`, `D:\Program Files`, `C:\LDPlayer`), so the vendor-specific
 * expectations below describe the list only on Windows.  On another platform
 * `launcherCandidates` / `managerCandidates` return nothing for those vendors
 * rather than a `C:\...` string that is not a path there — so the platform-bound
 * assertions are marked instead of being wrong.  That is what lets one suite pass
 * on both CI runners; before, the Linux job failed on "C:\Program Files/... is
 * not absolute", which was a real defect in the candidate list, not a test bug.
 */
const WINDOWS = process.platform === 'win32'

test('launcherCandidates knows a launcher for every launchable vendor', () => {
  const saved = process.env.ANDROID_HOME
  // The AVD launcher lives in the SDK, so the vendor list is only complete when
  // an SDK root is configured. A real directory keeps this test meaningful on
  // every platform.
  process.env.ANDROID_HOME = saved ?? path.join(os.tmpdir(), 'ahelper-fake-sdk')
  try {
    for (const vendor of LAUNCHABLE_TYPES) {
      const candidates = launcherCandidates(vendor)
      if (WINDOWS) assert.ok(candidates.length > 0, `${vendor} has no known launcher`)
      for (const candidate of candidates) {
        assert.ok(path.isAbsolute(candidate.path), `${vendor}: ${candidate.path} is not absolute`)
        assert.ok(candidate.label.length > 0)
      }
    }
  } finally {
    if (saved === undefined) delete process.env.ANDROID_HOME
    else process.env.ANDROID_HOME = saved
  }
})

test('no candidate is a path that cannot exist on this platform', () => {
  for (const vendor of LAUNCHABLE_TYPES) {
    for (const candidate of [...launcherCandidates(vendor), ...managerCandidates(vendor)]) {
      assert.ok(
        path.isAbsolute(candidate.path),
        `${vendor}: ${candidate.path} is not absolute on ${process.platform}`,
      )
    }
  }
})

test('mumu candidates lead with the manager CLI, then the shell executables', { skip: !WINDOWS }, () => {
  const candidates = launcherCandidates('mumu')
  assert.match(candidates[0].path, /MuMuManager\.exe$/)
  assert.deepEqual(candidates[0].args, ['control', '--vmindex', '0', 'launch'])
  const paths = candidates.map((c) => c.path.toLowerCase())
  assert.ok(paths.some((p) => p.includes('mumuplayer-12.0') && p.includes('shell')))
  assert.ok(paths.some((p) => p.includes('nx_main')))
})

test('managerCandidates offers a management CLI for the vendors that have one', { skip: !WINDOWS }, () => {
  assert.ok(managerCandidates('mumu').every((c) => c.kind === 'mumu'))
  assert.ok(managerCandidates('mumu').some((c) => /MuMuManager\.exe$/.test(c.path)))
  assert.ok(managerCandidates('ldplayer').some((c) => /ldconsole\.exe$/.test(c.path)))
})

test('vendors without a management CLI report nothing', () => {
  // Platform-independent: the answer is an empty list either way.
  assert.deepEqual(managerCandidates('nox'), [])
  assert.deepEqual(managerCandidates('custom'), [])
})

test('ldplayer, nox and genymotion candidates name their real executables', { skip: !WINDOWS }, () => {
  assert.ok(launcherCandidates('ldplayer').some((c) => /dnplayer\.exe$/i.test(c.path)))
  assert.ok(launcherCandidates('nox').some((c) => /Nox\.exe$/i.test(c.path)))
  assert.ok(launcherCandidates('genymotion').some((c) => /genymotion\.exe$/i.test(c.path)))
})

test('the AVD candidate points inside the configured SDK', () => {
  const saved = process.env.ANDROID_HOME
  const fakeSdk = path.join(os.tmpdir(), 'ahelper-fake-sdk')
  process.env.ANDROID_HOME = fakeSdk
  try {
    const paths = launcherCandidates('avd').map((c) => c.path)
    assert.ok(paths.some((p) => p.includes(path.join('ahelper-fake-sdk', 'emulator'))))
  } finally {
    if (saved === undefined) delete process.env.ANDROID_HOME
    else process.env.ANDROID_HOME = saved
  }
})

test('candidates carry args for the manager-style launchers', { skip: !WINDOWS }, () => {
  const manager = launcherCandidates('mumu').find((c) => /MuMuManager/i.test(c.path))
  assert.ok(Array.isArray(manager.args))
  assert.deepEqual(manager.args, ['control', '--vmindex', '0', 'launch'])
})

test('findLauncher returns null when nothing exists', () => {
  assert.equal(findLauncher('custom'), null)
  // An absolute extra root that does not exist must not throw.
  assert.equal(findLauncher('custom', [path.join(os.tmpdir(), 'definitely-not-here-12345')]), null)
})

test('findLauncher picks an explicit extra root when it exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahelper-launcher-'))
  const fake = path.join(dir, 'MuMuPlayer.exe')
  fs.writeFileSync(fake, 'not really an executable')
  try {
    const found = findLauncher('custom', [fake])
    assert.equal(found?.path, fake)
    assert.equal(found.label, 'MuMuPlayer.exe')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('findLauncher ignores directories that happen to share a launcher name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahelper-launcher-dir-'))
  const decoy = path.join(dir, 'MuMuPlayer.exe')
  fs.mkdirSync(decoy)
  try {
    assert.equal(findLauncher('custom', [decoy]), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
