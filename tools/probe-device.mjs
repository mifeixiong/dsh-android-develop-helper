#!/usr/bin/env node
/**
 * Low-level diagnostic probe for one ADB serial.
 *
 * Use this when `doctor` reports something odd but you need to see exactly what
 * the device answers for each individual property — the CLI reads them in one
 * batched shell command, which hides *which* probe failed.
 *
 *   node tools/probe-device.mjs                       # auto-detect adb and serial
 *   node tools/probe-device.mjs <adb> <serial>
 */
import { loadConfig } from '../src/config.js'
import { Adb } from '../src/adb.js'
import { resolveDevice, deviceFingerprint } from '../src/devices.js'

const flags = {}
if (process.argv[2]) flags.adbPath = process.argv[2]
const cfg = loadConfig(flags)
const adb = new Adb({ bin: cfg.adb, timeoutMs: cfg.timeoutMs })

const serial = process.argv[3] ?? (await resolveDevice(adb, cfg, {})).serial
adb.use(serial)

console.log(`adb     : ${cfg.adb}`)
console.log(`serial  : ${serial}`)
console.log('')

const probes = [
  ['android_id', 'settings get secure android_id'],
  ['model', 'getprop ro.product.model'],
  ['brand', 'getprop ro.product.brand'],
  ['release', 'getprop ro.build.version.release'],
  ['sdk', 'getprop ro.build.version.sdk'],
  ['boot_completed', 'getprop sys.boot_completed'],
  ['build.fingerprint', 'getprop ro.build.fingerprint'],
  ['wm size', 'wm size'],
  ['wm density', 'wm density'],
  ['sha256sum', 'which sha256sum'],
  ['cmd package', 'cmd package resolve-activity --brief com.android.settings | tail -n 1'],
]

for (const [label, command] of probes) {
  const result = await adb.shellLoose(command, { timeoutMs: 15000 })
  const value = result.text.replace(/\n/g, ' | ')
  console.log(`${label.padEnd(18)} exit=${String(result.code).padStart(3)}  ${value || '(空)'}`)
}

console.log('\nfingerprint:', await deviceFingerprint(adb, serial))
