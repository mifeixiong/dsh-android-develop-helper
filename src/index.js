/**
 * Public API.
 *
 *   import { connect, loadConfig } from 'dsh-android-develop-helper'
 *   const device = await connect()
 *   const shot = await device.screenshot({ scale: 0.5 })
 *
 * Everything the CLI does is available here; the CLI is a thin presentation
 * layer over this module so the same capability can be exposed as agent tools.
 */
export { loadConfig, writeConfigFile, readConfigFile, discoverAdb, EMULATOR_PRESETS, DEFAULTS, ROOT } from './config.js'
export { Adb, AdbError, parseDevices, explainAdbFailure, isTransientAdbError } from './adb.js'
export {
  resolveDevice,
  deviceInventory,
  collectDevices,
  probePorts,
  probePort,
  guessVendor,
  withDeviceRetry,
  loadCachedDevice,
  saveCachedDevice,
  sleep,
} from './devices.js'
export { Device, extractHierarchy, orientScreen } from './device.js'
export {
  launchEmulator,
  findLauncher,
  launcherCandidates,
  LAUNCHABLE_TYPES,
  discoverVendorInstances,
  vendorAdbPorts,
  managerCandidates,
} from './emulator.js'
export { Session, slugify } from './artifacts.js'
export * as screen from './screen.js'
export * as ui from './uitree.js'
export * as input from './input.js'
export * as app from './app.js'
export * as apk from './apk.js'
export * as logs from './logcat.js'
export { parseXml, walk, decodeEntities } from './xml.js'

import { loadConfig } from './config.js'
import { Device } from './device.js'

/**
 * Resolve a device and return a connected facade.
 * @param {object} [flags]
 * @param {{label?:string, device?:string, probe?:boolean}} [options]
 */
export async function connect(flags = {}, options = {}) {
  const cfg = loadConfig(flags)
  const device = await Device.connect(cfg, options)
  return { cfg, device }
}
