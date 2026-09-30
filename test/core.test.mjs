import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDevices, explainAdbFailure, isTransientAdbError, AdbError } from '../src/adb.js'
import { parseArgv } from '../src/cli.js'
import { loadConfig, EMULATOR_PRESETS, DEFAULTS } from '../src/config.js'
import { escapeInputText, shellQuote, resolveKeycode, KEYCODES } from '../src/input.js'
import { guessVendor, probePort, probePorts } from '../src/devices.js'
import { extractHierarchy, orientScreen } from '../src/device.js'
import { classifyInstallOutput } from '../src/app.js'

test('parseDevices reads serial, state and -l properties', () => {
  const text = [
    'List of devices attached',
    '127.0.0.1:16384        device product:mayfly model:2206123SC device:mayfly transport_id:2',
    'emulator-5554          offline',
    '',
  ].join('\n')
  const devices = parseDevices(text)
  assert.equal(devices.length, 2)
  assert.equal(devices[0].serial, '127.0.0.1:16384')
  assert.equal(devices[0].state, 'device')
  assert.equal(devices[0].model, '2206123SC')
  assert.equal(devices[0].transportId, '2')
  assert.equal(devices[1].state, 'offline')
})

test('parseDevices ignores daemon chatter and blank lines', () => {
  const devices = parseDevices('* daemon started successfully *\nList of devices attached\n\n')
  assert.equal(devices.length, 0)
})

test('explainAdbFailure maps multiple devices to an actionable hint', () => {
  const { hint } = explainAdbFailure('adb: more than one device/emulator')
  assert.match(hint, /--device/)
})

test('explainAdbFailure classifies offline as transient', () => {
  const { transient, hint } = explainAdbFailure('error: device offline')
  assert.equal(transient, true)
  assert.match(hint, /offline/)
})

test('isTransientAdbError recognises transport failures only', () => {
  assert.ok(isTransientAdbError(new AdbError('x', { stderr: 'error: device offline' })))
  assert.ok(!isTransientAdbError(new AdbError('install failed: INSTALL_FAILED_INSUFFICIENT_STORAGE')))
})

test('parseArgv separates positionals, flags and repeats', () => {
  const { command, positional, flags } = parseArgv([
    'start', 'com.demo/.Main', '--extras', 'a=1', '--extras', 'b=true', '--json', '--no-probe',
  ])
  assert.equal(command, 'start')
  assert.deepEqual(positional, ['com.demo/.Main'])
  assert.deepEqual(flags.extras, ['a=1', 'b=true'])
  assert.equal(flags.json, true)
  assert.equal(flags.probe, false)
})

test('parseArgv supports --key=value and bare boolean flags', () => {
  const { flags } = parseArgv(['shot', '--scale=0.5', '--label', 'x', '--refresh'])
  assert.equal(flags.scale, '0.5')
  assert.equal(flags.label, 'x')
  assert.equal(flags.refresh, true)
})

test('loadConfig infers the ADB port from the console port', () => {
  const cfg = loadConfig({ consolePort: 5554, autoDiscover: false, allowDiskSearch: false })
  assert.equal(cfg.adbPort, 5555)
})

test('loadConfig infers the console port from the ADB port', () => {
  const cfg = loadConfig({ adbPort: 9999, autoDiscover: false, allowDiskSearch: false })
  assert.equal(cfg.consolePort, 9998)
})

test('loadConfig falls back to custom for an unknown emulator type', () => {
  const cfg = loadConfig({ emulatorType: 'nintendo', allowDiskSearch: false })
  assert.equal(cfg.emulatorType, 'custom')
  assert.ok(cfg.emulatorTypeWarning)
})

test('vendor port universes cover the documented ranges', () => {
  assert.ok(EMULATOR_PRESETS.mumu.ports.includes(16384))
  assert.ok(EMULATOR_PRESETS.mumu.ports.includes(7555))
  assert.ok(EMULATOR_PRESETS.ldplayer.ports.includes(5555))
  assert.ok(EMULATOR_PRESETS.nox.ports.includes(62001))
  assert.ok(EMULATOR_PRESETS.avd.ports.includes(5555))
})

test('port universes include user-supplied extra ports', () => {
  const cfg = loadConfig({ ports: [4444, 12345], allowDiskSearch: false })
  assert.ok(cfg.portUniverse.includes(4444))
  assert.ok(cfg.portUniverse.includes(12345))
})

test('port universe honours minProbePort', () => {
  const cfg = loadConfig({ minProbePort: 60000, allowDiskSearch: false })
  assert.ok(cfg.portUniverse.every((p) => p >= 60000))
})

test('escapeInputText escapes shell metacharacters and maps spaces', () => {
  assert.equal(escapeInputText('hello world'), 'hello%sworld')
  assert.equal(escapeInputText('a&b'), 'a\\&b')
  assert.equal(escapeInputText('say "hi"'), 'say%s\\"hi\\"')
  assert.equal(escapeInputText("it's"), "it\\'s")
})

test('shellQuote survives embedded single quotes', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
})

test('resolveKeycode accepts names, KEYCODE_ prefix and numbers', () => {
  assert.equal(resolveKeycode('home'), KEYCODES.home)
  assert.equal(resolveKeycode('KEYCODE_BACK'), KEYCODES.back)
  assert.equal(resolveKeycode('3'), 3)
  assert.equal(resolveKeycode(66), 66)
  assert.throws(() => resolveKeycode('hyperspace'), /未知按键/)
})

test('guessVendor maps port ranges to products', () => {
  assert.equal(guessVendor(16384), 'mumu')
  assert.equal(guessVendor(7555), 'mumu')
  assert.equal(guessVendor(62001), 'nox-or-ldplayer')
  assert.equal(guessVendor(5555), 'avd-or-ldplayer')
  assert.equal(guessVendor(41234), 'unknown')
})

test('orientScreen swaps the panel size on a landscape rotation', () => {
  const portrait = { width: 720, height: 1280 }
  assert.deepEqual(
    { width: orientScreen(portrait, 0).width, height: orientScreen(portrait, 0).height },
    { width: 720, height: 1280 },
  )
  assert.deepEqual(
    { width: orientScreen(portrait, 1).width, height: orientScreen(portrait, 1).height },
    { width: 1280, height: 720 },
  )
  assert.deepEqual(
    { width: orientScreen(portrait, 3).width, height: orientScreen(portrait, 3).height },
    { width: 1280, height: 720 },
  )
  assert.equal(orientScreen(portrait, 2).width, 720)
  assert.equal(orientScreen(portrait, 2).height, 1280)
})

test('orientScreen tolerates missing size and odd rotation input', () => {
  assert.equal(orientScreen(null, 1), null)
  assert.equal(orientScreen({ width: 10, height: 20 }, -1).width, 20) // -1 ≡ 3 (landscape)
  assert.equal(orientScreen({ width: 10, height: 20 }, undefined).width, 10)
  assert.equal(orientScreen({ width: 10, height: 20 }, 4).rotation, 0)
})

test('classifyInstallOutput accepts a plain success', () => {
  const verdict = classifyInstallOutput('Performing Streamed Install\nSuccess', 0)
  assert.equal(verdict.success, true)
  assert.equal(verdict.failure, null)
})

test('classifyInstallOutput rejects a failure that follows a Success line', () => {
  // The exact Android 13+ streamed-install shape: exit code 0, "Success:"
  // describes the byte stream, and the package commit failed. A naive
  // /Success/ test installs nothing and reports success.
  const output = [
    'Performing Incremental Install',
    'Performing Streamed Install',
    'Success: streamed 37341 bytes',
    'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.example.dormduty signatures do not match newer version; ignoring!]',
  ].join('\n')
  const verdict = classifyInstallOutput(output, 0)
  assert.equal(verdict.success, false)
  assert.equal(verdict.failure, 'INSTALL_FAILED_UPDATE_INCOMPATIBLE')
  assert.match(verdict.reason, /签名不一致/)
})

test('classifyInstallOutput explains the common failure codes', () => {
  assert.match(classifyInstallOutput('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]', 0).reason, /存储不足/)
  assert.match(classifyInstallOutput('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]', 0).reason, /versionCode/)
  assert.match(classifyInstallOutput('Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES]', 0).reason, /未签名/)
  // An unrecognised code still surfaces the raw code rather than nothing.
  const unknown = classifyInstallOutput('Failure [INSTALL_FAILED_WEIRD]', 0)
  assert.equal(unknown.success, false)
  assert.match(unknown.reason, /INSTALL_FAILED_WEIRD|WEIRD/)
})

test('classifyInstallOutput rejects a non-zero exit with no Failure marker', () => {
  const verdict = classifyInstallOutput('adb: error: failed to get feature set', 1)
  assert.equal(verdict.success, false)
  assert.equal(verdict.failure, 'exit 1')
})

test('classifyInstallOutput rejects silence', () => {
  const verdict = classifyInstallOutput('', 0)
  assert.equal(verdict.success, false)
  assert.equal(verdict.failure, 'no-success-marker')
})

test('extractHierarchy pulls the document out of noisy stdout', () => {
  const noisy = "warning: something\n<hierarchy rotation=\"0\"><node/></hierarchy>\nUI hierchary dumped to: /dev/tty\n"
  assert.equal(extractHierarchy(noisy), '<hierarchy rotation="0"><node/></hierarchy>')
  assert.equal(extractHierarchy('no xml here'), null)
  assert.equal(extractHierarchy('<hierarchy rotation="0">truncated'), null)
})

test('probePort reports closed ports without throwing', async () => {
  // Port 1 is reserved and never listening.
  assert.equal(await probePort(1, { timeoutMs: 200 }), false)
})

test('probePorts returns only listening ports, in order', async () => {
  const open = await probePorts([1, 2, 3], { timeoutMs: 150 })
  assert.deepEqual(open, [])
})

test('DEFAULTS declares every documented configuration key', () => {
  for (const key of ['adbPath', 'emulatorType', 'adbPort', 'consolePort', 'deviceSerial', 'autoDiscover']) {
    assert.ok(key in DEFAULTS, `missing documented config key: ${key}`)
  }
})
