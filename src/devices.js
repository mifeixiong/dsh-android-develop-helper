/**
 * Multi-emulator device discovery and identity.
 *
 * The hard problem this file solves: **one emulator instance can answer on
 * several ADB serials** (MuMu 12 exposes 16384 *and* 7555 *and* usually
 * `emulator-5554` for the same machine), while **two instances can look
 * identical** in `adb devices -l` because every MuMu device reports the same
 * `model`.  Picking by serial string therefore produces both
 * "more than one device/emulator" and silent work against the wrong instance.
 *
 * The fix:
 *   1. gather every reachable serial (`adb devices` plus TCP probing of the
 *      vendor port universe);
 *   2. skip `offline` / `unauthorized` transports;
 *   3. group serials by a device *fingerprint* read over the wire
 *      (android_id + build fingerprint + model);
 *   4. collapse each group to one canonical serial, deterministically;
 *   5. require an explicit `--device` only when genuinely distinct devices exist.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { ROOT } from './config.js'

export const STATE_PATH = path.join(ROOT, '.device.json')

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** TCP reachability probe — cheap, no adb process involved. */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (open) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

/** Probe many ports with bounded concurrency; returns the open ones, in order. */
export async function probePorts(ports, { concurrency = 32, host = '127.0.0.1', timeoutMs = 300 } = {}) {
  const open = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, ports.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= ports.length) return
      const port = ports[index]
      if (await probePort(port, { host, timeoutMs })) open.push(port)
    }
  })
  await Promise.all(workers)
  return [...new Set(open)].sort((a, b) => a - b)
}

/** Guess which product owns an open local port. */
export function guessVendor(port) {
  if (port >= 16384 && port <= 16390) return 'mumu'
  if (port === 16416 || port === 16448) return 'mumu'
  if (port === 7555 || port === 7556) return 'mumu'
  if (port >= 62001 && port <= 62030) return 'nox-or-ldplayer'
  if (port >= 5554 && port <= 5585) return 'avd-or-ldplayer'
  return 'unknown'
}

/**
 * Read a stable identity for one serial.
 * One adb round trip; tolerates a device that is still booting.
 */
export async function deviceFingerprint(adb, serial) {
  const command =
    'echo "$(settings get secure android_id)|$(getprop ro.build.fingerprint)|' +
    '$(getprop ro.product.model)|$(getprop ro.boot.serialno)|$(getprop ro.serialno)"'
  const { text } = await adb.shellLoose(command, { timeoutMs: 12000, serial })
  const parts = text.split('|').map((p) => p.trim())
  while (parts.length < 5) parts.push('')
  const [androidId, buildFingerprint, model, bootSerial, serialNo] = parts
  const key = [androidId, model, bootSerial || serialNo].filter(Boolean).join('::')
  return {
    serial,
    androidId: androidId || null,
    buildFingerprint: buildFingerprint || null,
    model: model || null,
    bootSerial: bootSerial || null,
    serialNo: serialNo || null,
    key: key || `serial:${serial}`,
    complete: Boolean(androidId || buildFingerprint),
  }
}

/** Read the cache written by a previous resolution. */
export function loadCachedDevice(statePath = STATE_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    // Tolerate the legacy plain-text format.
    try {
      const text = fs.readFileSync(statePath, 'utf8').trim()
      return text ? { serial: text } : {}
    } catch {
      return {}
    }
  }
}

export function saveCachedDevice(record, statePath = STATE_PATH) {
  try {
    fs.writeFileSync(statePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch {
    /* cache is best-effort */
  }
}

/**
 * Collect every reachable transport.
 *
 * Port discovery has two sources, and the exact one wins: when the vendor ships
 * a management CLI (`MuMuManager`, `ldconsole`), it reports each running
 * instance's ADB port directly.  Only the ports it does not know about fall back
 * to probing the candidate range.
 *
 * @param {import('./adb.js').Adb} adb
 * @param {object} cfg
 * @param {{ probe?: boolean }} [options]
 */
export async function collectDevices(adb, cfg, options = {}) {
  const before = await adb.devices()
  let probes = []
  let vendorPorts = []
  if (options.probe) {
    const { vendorAdbPorts, resolveEmulatorType } = await import('./emulator.js')
    vendorPorts = await vendorAdbPorts(resolveEmulatorType(cfg), { timeoutMs: 15000 })
    const candidates = [...new Set([...vendorPorts, ...cfg.portUniverse])]
    const open = await probePorts(candidates, { timeoutMs: 300 })
    const known = new Set(before.map((d) => d.serial))
    for (const port of open) {
      const target = `127.0.0.1:${port}`
      if (known.has(target)) continue
      const result = await adb.connect(port)
      if (result.ok) probes.push({ port, exact: vendorPorts.includes(port), ...result })
    }
    if (probes.length > 0) await sleep(250)
  }
  const list = options.probe ? await adb.devices() : before
  return { devices: list, probes, probedPorts: probes.map((p) => p.port), vendorPorts }
}

/**
 * Resolve the one device every subsequent command should target.
 *
 * @returns {Promise<{serial:string, fingerprint:object|null, all:object[], groups:object[], probes:number[], source:string, warning?:string}>}
 */
export async function resolveDevice(adb, cfg, options = {}) {
  const explicit = options.device ?? cfg.deviceSerial ?? null
  const warnings = []

  await adb.ensureServer().catch(() => {})

  // ── 1. explicit serial wins outright ──────────────────────────────────────
  if (explicit) {
    let present = (await adb.devices()).some((d) => d.serial === explicit)
    if (!present && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(explicit)) {
      const port = Number.parseInt(explicit.split(':')[1], 10)
      await adb.connect(port, explicit.split(':')[0])
      await sleep(300)
      present = (await adb.devices()).some((d) => d.serial === explicit)
    }
    if (!present && options.probe !== false && cfg.autoDiscover) {
      // The user named a serial we cannot see: try the whole port universe once.
      const open = await probePorts(cfg.portUniverse, { timeoutMs: 300 })
      for (const port of open) await adb.connect(port)
      await sleep(300)
      present = (await adb.devices()).some((d) => d.serial === explicit)
    }
    if (!present) {
      throw new Error(
        `显式指定的设备 "${explicit}" 不在 adb devices 列表中。请确认模拟器已启动，` +
          '或运行 `android-helper devices --probe` 查看可用设备。',
      )
    }
    adb.use(explicit)
    const fingerprint = await deviceFingerprint(adb, explicit).catch(() => null)
    return { serial: explicit, fingerprint, all: await adb.devices(), groups: [], probes: [], source: 'explicit' }
  }

  // ── 2. explicit ADB port ─────────────────────────────────────────────────
  if (cfg.adbPort) {
    const serial = `127.0.0.1:${cfg.adbPort}`
    const result = await adb.connect(cfg.adbPort)
    if (!result.ok) {
      warnings.push(`adb connect 127.0.0.1:${cfg.adbPort} 未确认成功: ${result.text}`)
    }
    await sleep(300)
    const present = (await adb.devices()).some((d) => d.serial === serial && d.state === 'device')
    if (!present) {
      throw new Error(
        `配置的 adbPort=${cfg.adbPort} 无法连接（${result.text || '无输出'}）。` +
          'MuMu 12 的端口请在模拟器 右上角菜单 → 问题诊断 中确认。',
      )
    }
    adb.use(serial)
    const fingerprint = await deviceFingerprint(adb, serial).catch(() => null)
    return { serial, fingerprint, all: await adb.devices(), groups: [], probes: [], source: 'config:adbPort', warnings }
  }

  // ── 3. automatic discovery ───────────────────────────────────────────────
  if (!cfg.autoDiscover) {
    throw new Error(
      'autoDiscover=false 但没有可用的 deviceSerial / adbPort。' +
        '请至少配置其中一项，或打开 autoDiscover。',
    )
  }

  const { devices, probes } = await collectDevices(adb, cfg, { probe: true })
  const usable = devices.filter((d) => d.state === 'device')
  const offline = devices.filter((d) => d.state !== 'device')

  if (usable.length === 0) {
    const detail = devices.length > 0 ? `（忽略：${offline.map((d) => `${d.serial}=${d.state}`).join(', ')}）` : ''
    throw new Error(
      `没有可用设备。已探测端口: ${probes.map((p) => p.port).join(', ') || '无'}。` +
        `请启动模拟器后重试，或显式配置 adbPort。${detail}`,
    )
  }

  // ── 4. group by fingerprint, collapse duplicates ─────────────────────────
  const groups = new Map()
  for (const device of usable) {
    let fingerprint
    try {
      fingerprint = await deviceFingerprint(adb, device.serial)
    } catch {
      fingerprint = { serial: device.serial, key: `serial:${device.serial}`, complete: false }
    }
    const key = fingerprint.key
    if (!groups.has(key)) groups.set(key, { key, fingerprint, serials: [] })
    groups.get(key).serials.push(device.serial)
  }

  const canonical = [...groups.values()].map((group) => {
    // Prefer the serial we resolved last time (continuity), then a configured or
    // explicitly probed port, then `emulator-*`, then the lowest port.
    // Deterministic ordering beats "first seen" — MuMu exposes its instance on
    // several ports and the enumeration order is not stable across restarts.
    const cachedSerial = loadCachedDevice().serial ?? null
    const ranked = [...group.serials].sort(
      (a, b) => rankSerial(a, cfg, cachedSerial) - rankSerial(b, cfg, cachedSerial),
    )
    return { ...group, serial: ranked[0], duplicates: ranked.slice(1) }
  })

  if (canonical.length > 1) {
    const listing = canonical
      .map((g) => `  - ${g.serial}  (${g.fingerprint.model ?? '?'}); 同一实例的其他端口: ${g.duplicates.join(', ') || '无'}`)
      .join('\n')
    throw new Error(
      `检测到 ${canonical.length} 个不同的设备。请用 --device <serial> 显式指定：\n${listing}`,
    )
  }

  const chosen = canonical[0]
  if (chosen.duplicates.length > 0) {
    warnings.push(
      `同一实例被 ${chosen.duplicates.length + 1} 个 serial 暴露 ` +
        `(${[chosen.serial, ...chosen.duplicates].join(', ')})，已固定使用 ${chosen.serial}`,
    )
  }
  adb.use(chosen.serial)
  saveCachedDevice({
    resolvedAt: new Date().toISOString(),
    serial: chosen.serial,
    fingerprint: chosen.fingerprint.key,
    duplicates: chosen.duplicates,
    model: chosen.fingerprint.model,
  })

  return {
    serial: chosen.serial,
    fingerprint: chosen.fingerprint,
    all: devices,
    groups: canonical,
    probes: probes.map((p) => p.port),
    source: 'autoDiscover',
    warnings,
  }
}

/** Rank candidate serials for one physical device; lower is better. */
function rankSerial(serial, cfg, cachedSerial = null) {
  let score = 1000
  if (cachedSerial && serial === cachedSerial) score -= 300
  if (cfg.deviceSerial && serial === cfg.deviceSerial) score -= 500
  if (cfg.adbPort && serial === `127.0.0.1:${cfg.adbPort}`) score -= 400
  const port = Number.parseInt(serial.split(':')[1] ?? '', 10)
  if (cfg.portUniverse?.includes(port)) score -= 50
  if (serial.startsWith('emulator-')) score -= 20
  if (Number.isFinite(port)) score += Math.min(port, 999) / 1000
  return score
}

/**
 * Run `fn(adb)` with automatic recovery from transport-level failures.
 * A `device offline` / `not found` error usually means the emulator moved ports
 * (common on MuMu after a restart), so re-resolve once and retry.
 */
export async function withDeviceRetry(adb, cfg, fn, options = {}) {
  const { isTransientAdbError } = await import('./adb.js')
  try {
    return await fn(adb)
  } catch (error) {
    if (options.noRetry || !isTransientAdbError(error)) throw error
    const result = await resolveDevice(adb, cfg, { probe: true })
    if (options.onRetry) options.onRetry(result)
    return fn(adb)
  }
}

/** Human-readable inventory of every reachable transport. */
export async function deviceInventory(adb, cfg, options = {}) {
  const { devices, probes } = await collectDevices(adb, cfg, { probe: options.probe !== false })
  const rows = []
  for (const device of devices) {
    const row = {
      serial: device.serial,
      state: device.state,
      model: device.model,
      product: device.product,
      transportId: device.transportId,
      vendor: guessVendor(Number.parseInt(device.serial.split(':')[1] ?? '', 10)),
      fingerprint: null,
    }
    if (device.state === 'device') {
      try {
        row.fingerprint = await deviceFingerprint(adb, device.serial)
      } catch {
        /* leave null */
      }
    }
    rows.push(row)
  }
  return { devices: rows, probes, portUniverse: cfg.portUniverse }
}
