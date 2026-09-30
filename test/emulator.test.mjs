import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launcherCandidates, findLauncher, LAUNCHABLE_TYPES, managerCandidates } from '../src/emulator.js'

test('launcherCandidates knows a launcher for every launchable vendor', () => {
  const saved = process.env.ANDROID_HOME
  // The AVD launcher lives in the SDK, so the vendor list is only complete when
  // an SDK root is configured.
  process.env.ANDROID_HOME = saved ?? 'D:\\fake-sdk'
  try {
    for (const vendor of LAUNCHABLE_TYPES) {
      const candidates = launcherCandidates(vendor)
      assert.ok(candidates.length > 0, `${vendor} has no known launcher`)
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

test('mumu candidates lead with the manager CLI, then the shell executables', () => {
  const candidates = launcherCandidates('mumu')
  assert.match(candidates[0].path, /MuMuManager\.exe$/)
  assert.deepEqual(candidates[0].args, ['control', '--vmindex', '0', 'launch'])
  const paths = candidates.map((c) => c.path.toLowerCase())
  assert.ok(paths.some((p) => p.includes('mumuplayer-12.0') && p.includes('shell')))
  assert.ok(paths.some((p) => p.includes('nx_main')))
})

test('managerCandidates offers a management CLI for the vendors that have one', () => {
  assert.ok(managerCandidates('mumu').every((c) => c.kind === 'mumu'))
  assert.ok(managerCandidates('mumu').some((c) => /MuMuManager\.exe$/.test(c.path)))
  assert.ok(managerCandidates('ldplayer').some((c) => /ldconsole\.exe$/.test(c.path)))
  // Vendors without a management CLI simply report nothing.
  assert.deepEqual(managerCandidates('nox'), [])
  assert.deepEqual(managerCandidates('custom'), [])
})

test('ldplayer, nox and genymotion candidates name their real executables', () => {
  assert.ok(launcherCandidates('ldplayer').some((c) => /dnplayer\.exe$/i.test(c.path)))
  assert.ok(launcherCandidates('nox').some((c) => /Nox\.exe$/i.test(c.path)))
  assert.ok(launcherCandidates('genymotion').some((c) => /genymotion\.exe$/i.test(c.path)))
})

test('the AVD candidate points inside the configured SDK', () => {
  const saved = process.env.ANDROID_HOME
  process.env.ANDROID_HOME = 'D:\\fake-sdk'
  try {
    const paths = launcherCandidates('avd').map((c) => c.path)
    assert.ok(paths.some((p) => p.includes(path.join('fake-sdk', 'emulator'))))
  } finally {
    if (saved === undefined) delete process.env.ANDROID_HOME
    else process.env.ANDROID_HOME = saved
  }
})

test('candidates carry args for the manager-style launchers', () => {
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
