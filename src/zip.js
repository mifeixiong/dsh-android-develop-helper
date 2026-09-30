/**
 * Minimal ZIP reader and writer.
 *
 * Two jobs, both driven by the build pipeline:
 *
 *  - **read**: `aapt2 link` emits an APK-shaped ZIP; we need every entry in it so
 *    `classes.dex` can be added and the archive re-emitted.  Reading the central
 *    directory (rather than walking local headers) is what makes this correct
 *    for archives containing data descriptors, which `aapt2` produces.
 *  - **write**: without Gradle there is no packager, and `resources.arsc` must be
 *    *stored* (not deflated) and 4-byte aligned for the platform's mmap path.
 *    Owning the writer means that alignment is guaranteed rather than hoped for
 *    from whatever `Compress-Archive` happens to do.
 *
 * Only the features an APK actually uses are implemented: stored/deflate, no
 * encryption, no ZIP64 (an APK over 4 GB is not a case worth supporting), no
 * multi-disk.
 */
import zlib from 'node:zlib'
import { crc32 } from './crc32.js'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

export class ZipError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZipError'
  }
}

/**
 * Parse the central directory.
 * @param {Buffer} buffer
 * @returns {{entries:Array<{name:string,method:number,crc32:number,compressedSize:number,uncompressedSize:number,localHeaderOffset:number,isDirectory:boolean}>, comment:string}}
 */
export function listZipEntries(buffer) {
  const eocd = findEocd(buffer)
  if (!eocd) throw new ZipError('不是合法的 ZIP：找不到中央目录结尾记录')
  const total = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []

  for (let i = 0; i < total; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new ZipError(`中央目录第 ${i} 项损坏 (offset ${offset})`)
    }
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.push({
      name,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith('/'),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }

  const commentLength = buffer.readUInt16LE(eocd + 20)
  const comment =
    commentLength > 0 ? buffer.toString('utf8', eocd + 22, eocd + 22 + commentLength) : ''
  return { entries, comment }
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i
  }
  return null
}

/**
 * Extract one entry's bytes.
 * The local header's name/extra lengths are authoritative for where the data
 * starts, because the central directory's extra field may differ.
 */
export function extractEntry(buffer, entry) {
  const start = entry.localHeaderOffset
  if (buffer.readUInt32LE(start) !== SIG_LOCAL) throw new ZipError(`条目 ${entry.name} 的本地头损坏`)
  const nameLength = buffer.readUInt16LE(start + 26)
  const extraLength = buffer.readUInt16LE(start + 28)
  const dataStart = start + 30 + nameLength + extraLength
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw new ZipError(`不支持的压缩方式 ${entry.method} (${entry.name})`)
}

/** Read every entry into memory, keyed by name. */
export function readZip(buffer) {
  const { entries } = listZipEntries(buffer)
  const files = new Map()
  for (const entry of entries) {
    if (entry.isDirectory) continue
    files.set(entry.name, extractEntry(buffer, entry))
  }
  return files
}

/**
 * Find one entry, preferring the central directory but tolerating a streamed
 * archive that has none.
 *
 * The lenient path exists because `aapt2` and some packagers can emit an archive
 * whose central directory we would rather not depend on, and because a ZIP
 * assembled by a test fixture is still a valid thing to read.
 *
 * @returns {Buffer|null}
 */
export function findZipEntry(buffer, wanted) {
  try {
    const { entries } = listZipEntries(buffer)
    const match = entries.find((entry) => entry.name === wanted)
    if (match) return extractEntry(buffer, match)
    return null
  } catch {
    return readEntryFromLocalHeaders(buffer, wanted)
  }
}

/** Walk local file headers only. Used when no central directory exists. */
function readEntryFromLocalHeaders(buffer, wanted) {
  let offset = 0
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== SIG_LOCAL) break
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    let compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength)
    const dataStart = nameStart + nameLength + extraLength

    if ((flags & 0x08) !== 0 && compressedSize === 0) {
      compressedSize = scanForNextHeader(buffer, dataStart) - dataStart
    }
    if (name === wanted) {
      const payload = buffer.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return Buffer.from(payload)
      if (method === 8) return zlib.inflateRawSync(payload)
      throw new ZipError(`不支持的压缩方式 ${method} (${name})`)
    }
    if (compressedSize === 0) break
    offset = dataStart + compressedSize
  }
  return null
}

function scanForNextHeader(buffer, from) {
  for (let i = from; i + 4 <= buffer.length; i++) {
    const signature = buffer.readUInt32LE(i)
    if (signature === SIG_LOCAL || signature === SIG_CENTRAL || signature === 0x08074b50) return i
  }
  return buffer.length
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

/**
 * Build a ZIP archive.
 *
 * @param {Array<{name:string, data:Buffer, compress?:boolean, align?:number}>} entries
 * @param {{ level?:number, date?:Date }} [options]
 * @returns {Buffer}
 */
export function writeZip(entries, options = {}) {
  const level = options.level ?? 6
  const date = options.date ?? new Date()
  const { time, date: dosDate } = toDosDateTime(date)

  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const crc = crc32(data)
    const shouldCompress = entry.compress === true || (entry.compress === undefined && !entry.align)
    const deflated = shouldCompress ? zlib.deflateRawSync(data, { level }) : null
    const useDeflate = deflated !== null && deflated.length < data.length
    const payload = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0

    // Pad the local extra field so this entry's data begins on an `align`
    // boundary — exactly what `zipalign` exists to produce, and the reason we
    // own the writer.  The padding depends on the running offset, so it has to be
    // computed from `offset`, not from the entry's own size.
    const align = entry.align ?? 4
    let extraLength = 0
    if (align > 1) {
      const base = offset + 30 + nameBuffer.length
      extraLength = (align - (base % align)) % align
    }

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(SIG_LOCAL, 0)
    localHeader.writeUInt16LE(20, 4) // version needed: 2.0
    localHeader.writeUInt16LE(0, 6) // no data descriptor
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(time, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBuffer.length, 26)
    localHeader.writeUInt16LE(extraLength, 28)

    const extra = extraLength > 0 ? Buffer.alloc(extraLength) : Buffer.alloc(0)
    chunks.push(localHeader, nameBuffer, extra, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(SIG_CENTRAL, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuffer.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([centralHeader, nameBuffer]))

    offset += localHeader.length + nameBuffer.length + extra.length + payload.length
  }

  const centralBuffer = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, eocd])
}

/**
 * Report entries whose data is not on an `align` boundary.
 * This is the check `zipalign -c` performs; running it ourselves means the build
 * fails loudly instead of shipping an unaligned APK.
 */
export function findMisalignedEntries(buffer, align = 4) {
  const { entries } = listZipEntries(buffer)
  const bad = []
  for (const entry of entries) {
    const start = entry.localHeaderOffset
    const nameLength = buffer.readUInt16LE(start + 26)
    const extraLength = buffer.readUInt16LE(start + 28)
    const dataStart = start + 30 + nameLength + extraLength
    if (dataStart % align !== 0) bad.push({ name: entry.name, dataStart, remainder: dataStart % align })
  }
  return bad
}
