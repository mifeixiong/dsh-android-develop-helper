/**
 * Connection manager.
 *
 * A DSH session may call several Android tools in a row.  Re-resolving the
 * device and reopening a UI cache on every call would multiply `adb devices`
 * probes and `uiautomator dump` runs for no benefit, so the resolved `Device`
 * is cached per configuration and reused.
 *
 * The cache is *not* a lifetime: any transport error still triggers a
 * re-resolve, and `reset()` drops the connection explicitly.
 */
import { loadConfig } from './config.js'
import { Device } from './device.js'
import { Session } from './artifacts.js'
import { Adb } from './adb.js'

export class AndroidSession {
  /**
   * @param {object} [flags] configuration overrides (adb path, ports, device…)
   */
  constructor(flags = {}) {
    this.flags = flags
    this.cfg = loadConfig(flags)
    this.device = null
    this.connecting = null
    this.connectionCount = 0
  }

  /** Stable key for the current target so a change invalidates the cache. */
  get key() {
    return [this.cfg.adb, this.cfg.emulatorType, this.cfg.adbPort, this.cfg.deviceSerial, this.flags.device]
      .map((v) => String(v ?? ''))
      .join('|')
  }

  /** Resolve (or reuse) the device. */
  async connect({ refresh = false, label = 'tool' } = {}) {
    if (refresh) this.reset()
    if (this.device) return this.device
    if (this.connecting) return this.connecting
    this.connecting = Device.connect(this.cfg, {
      label,
      device: this.flags.device,
      probe: true,
    })
      .then((device) => {
        this.device = device
        this.connectionCount++
        this.connecting = null
        return device
      })
      .catch((error) => {
        this.connecting = null
        throw error
      })
    return this.connecting
  }

  /** Drop the cached connection, closing its artifact stream. */
  async reset() {
    const device = this.device
    this.device = null
    this.connecting = null
    if (device?.session) {
      try {
        await device.session.close()
      } catch {
        /* closing is best effort */
      }
    }
  }

  /**
   * Run an operation against the device, re-resolving once when the transport
   * turns out to be stale (emulator restarted, port changed).
   *
   * Each call gets its own artifact directory.  The connection is cached across
   * calls, but its session is not: sharing one directory made every later
   * screenshot land in the folder named after whichever command connected first,
   * which makes `artifacts/` useless as a record of what happened when.
   */
  async withDevice(fn, { label = 'tool', retries = 1 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const device = await this.connect({ label })
      const previous = device.session
      const session = new Session(label, {
        artifactsDir: this.cfg.artifactsDir,
        keepLog: this.cfg.keepLog,
        echoCommands: this.cfg.echoCommands,
      })
      device.session = session
      if (device.adb) device.adb.session = session

      let failure = null
      let result
      try {
        result = await fn(device)
      } catch (error) {
        failure = error
      } finally {
        await session.close()
        device.session = previous
        if (device.adb) device.adb.session = previous
      }
      if (failure === null) return result

      const { isTransientAdbError } = await import('./adb.js')
      if (attempt >= retries || !isTransientAdbError(failure)) throw failure
      await this.reset()
    }
  }

  /** Cheap reachability probe that never throws. */
  async status() {
    try {
      const device = await this.connect()
      const transport = await device.transport().catch(() => null)
      return { connected: Boolean(transport), serial: device.serial, state: transport?.state ?? 'unknown' }
    } catch (error) {
      return { connected: false, serial: null, state: 'unavailable', error: error.message }
    }
  }

  /** Inventory without requiring a successful single-device resolution. */
  async inventory({ probe = true } = {}) {
    const adb = new Adb({ bin: this.cfg.adb, timeoutMs: this.cfg.timeoutMs })
    await adb.ensureServer().catch(() => {})
    const { collectDevices } = await import('./devices.js')
    const { devices, probes } = await collectDevices(adb, this.cfg, { probe })
    const rows = []
    const grouped = new Map()
    for (const entry of devices) {
      const row = {
        serial: entry.serial,
        state: entry.state,
        model: entry.model,
        product: entry.product,
        fingerprint: null,
      }
      if (entry.state === 'device') {
        const { deviceFingerprint } = await import('./devices.js')
        row.fingerprint = await deviceFingerprint(adb, entry.serial).catch(() => null)
        if (row.fingerprint?.key) {
          const list = grouped.get(row.fingerprint.key) ?? []
          list.push(entry.serial)
          grouped.set(row.fingerprint.key, list)
        }
      }
      rows.push(row)
    }
    return {
      adb: this.cfg.adb,
      emulatorType: this.cfg.emulatorType,
      devices: rows,
      probedPorts: probes.map((p) => p.port),
      distinctInstances: [...grouped.entries()].map(([fingerprint, serials]) => ({ fingerprint, serials })),
      selected: this.device?.serial ?? null,
    }
  }
}

/** Process-wide default session, used by the Cordis plugin. */
let defaultSession = null

export function getSession(flags = {}) {
  if (!defaultSession) defaultSession = new AndroidSession(flags)
  return defaultSession
}

export async function resetSession() {
  if (defaultSession) {
    await defaultSession.reset()
    defaultSession = null
  }
  return true
}
