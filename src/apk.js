/**
 * APK inspection without aapt/apkanalyzer.
 *
 * `adb install` succeeding tells you nothing about *what* was installed, and the
 * post-install hash check needs the package name to resolve `pm path`.  Common
 * workarounds are bad: a regex scan over the APK bytes happily returns
 * `androidx.lifecycle_lifecycle` (a library class name) instead of the real
 * package, and requiring aapt adds a build-tools dependency this tool otherwise
 * does not have.
 *
 * So we read the real thing: pull `AndroidManifest.xml` out of the ZIP and parse
 * its binary XML (AXML) form.  The format is small and stable — a chunked
 * container, a string pool, and start-element records whose `package` attribute
 * points into that pool.
 *
 * Reference: frameworks/base/libs/androidfw/include/androidfw/ResourceTypes.h
 */
import fs from 'node:fs'
import { findZipEntry } from './zip.js'

const CHUNK = {
  NULL: 0x0000,
  STRING_POOL: 0x0001,
  XML: 0x0003,
  XML_START_NAMESPACE: 0x0100,
  XML_END_NAMESPACE: 0x0101,
  XML_START_ELEMENT: 0x0102,
  XML_END_ELEMENT: 0x0103,
  XML_CDATA: 0x0104,
  XML_RESOURCE_MAP: 0x0180,
}

const TYPE = {
  NULL: 0x00,
  REFERENCE: 0x01,
  ATTRIBUTE: 0x02,
  STRING: 0x03,
  FLOAT: 0x04,
  DIMENSION: 0x05,
  FRACTION: 0x06,
  INT_DEC: 0x10,
  INT_HEX: 0x11,
  INT_BOOLEAN: 0x12,
}

// ── ZIP ─────────────────────────────────────────────────────────────────────

/**
 * Extract one entry from an APK/ZIP.
 *
 * The central directory is authoritative and is tried first; the local-header
 * walk inside `zip.js` remains as a fallback for archives that lack one.  See
 * `zip.js` for the writer used by the Gradle-less build.
 */
export function readZipEntry(buffer, wanted) {
  return findZipEntry(buffer, wanted)
}

// ── AXML ────────────────────────────────────────────────────────────────────

/** Decode a ResStringPool chunk into an array of strings. */
export function parseStringPool(buffer, start) {
  const stringCount = buffer.readUInt32LE(start + 8)
  const styleCount = buffer.readUInt32LE(start + 12)
  const flags = buffer.readUInt32LE(start + 16)
  const stringsStart = buffer.readUInt32LE(start + 20)
  const isUtf8 = (flags & 0x100) !== 0
  const offsets = []
  for (let i = 0; i < stringCount; i++) offsets.push(buffer.readUInt32LE(start + 28 + i * 4))
  const base = start + stringsStart
  const strings = offsets.map((relative) => readPoolString(buffer, base + relative, isUtf8))
  return { strings, styleCount, isUtf8 }
}

function readPoolString(buffer, at, isUtf8) {
  try {
    if (isUtf8) {
      let cursor = at
      let length = buffer[cursor++]
      if (length & 0x80) {
        length = ((length & 0x7f) << 8) | buffer[cursor++]
      }
      let byteLength = buffer[cursor++]
      if (byteLength & 0x80) {
        byteLength = ((byteLength & 0x7f) << 8) | buffer[cursor++]
      }
      return buffer.toString('utf8', cursor, cursor + byteLength)
    }
    let cursor = at
    let length = buffer.readUInt16LE(cursor)
    cursor += 2
    if (length & 0x8000) {
      length = ((length & 0x7fff) << 16) | buffer.readUInt16LE(cursor)
      cursor += 2
    }
    return buffer.toString('utf16le', cursor, cursor + length * 2)
  } catch {
    return ''
  }
}

/**
 * Parse a binary AndroidManifest.xml.
 * @returns {{package:string|null, versionName:string|null, versionCode:number|null, minSdk:number|null, targetSdk:number|null, label:string|null, permissions:string[], activities:string[]}}
 */
export function parseBinaryManifest(buffer) {
  if (buffer.length < 8 || buffer.readUInt16LE(0) !== CHUNK.XML) {
    throw new Error('不是合法的二进制 AndroidManifest.xml')
  }
  const result = {
    package: null,
    versionName: null,
    versionCode: null,
    minSdk: null,
    targetSdk: null,
    label: null,
    permissions: [],
    activities: [],
    launcherActivity: null,
  }

  let pool = null
  let offset = buffer.readUInt16LE(2) // skip the file header
  const fileEnd = Math.min(buffer.length, buffer.readUInt32LE(4))

  while (offset + 8 <= fileEnd) {
    const type = buffer.readUInt16LE(offset)
    const headerSize = buffer.readUInt16LE(offset + 2)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    if (chunkSize <= 0 || offset + chunkSize > buffer.length) break

    if (type === CHUNK.STRING_POOL) {
      pool = parseStringPool(buffer, offset)
    } else if (type === CHUNK.XML_START_ELEMENT && pool) {
      const node = readStartElement(buffer, offset, headerSize, pool)
      if (node) applyElement(result, node)
    }
    offset += chunkSize
  }

  return result
}

function readStartElement(buffer, start, headerSize, pool) {
  const nodeHeader = Math.max(headerSize, 16)
  const ext = start + nodeHeader
  if (ext + 20 > buffer.length) return null
  const nameIndex = buffer.readUInt32LE(ext + 4)
  const attributeStart = buffer.readUInt16LE(ext + 8)
  const attributeSize = buffer.readUInt16LE(ext + 10)
  const attributeCount = buffer.readUInt16LE(ext + 12)
  const name = pool.strings[nameIndex] ?? ''
  const attributes = []
  let cursor = ext + attributeStart
  for (let i = 0; i < attributeCount; i++, cursor += attributeSize) {
    if (cursor + 20 > buffer.length) break
    const attrNameIndex = buffer.readUInt32LE(cursor + 4)
    const dataType = buffer[cursor + 15]
    const data = buffer.readUInt32LE(cursor + 16)
    attributes.push({
      name: pool.strings[attrNameIndex] ?? '',
      type: dataType,
      raw: data,
      value:
        dataType === TYPE.STRING
          ? pool.strings[data] ?? ''
          : dataType === TYPE.INT_BOOLEAN
            ? data !== 0
            : dataType === TYPE.INT_HEX
              ? `0x${data.toString(16)}`
              : data,
    })
  }
  return { name, attributes }
}

function applyElement(result, node) {
  const get = (name) => node.attributes.find((a) => a.name === name)
  switch (node.name) {
    case 'manifest': {
      result.package = get('package')?.value ?? result.package
      result.versionName = get('versionName')?.value ?? result.versionName
      const code = get('versionCode')
      if (code && typeof code.value === 'number') result.versionCode = code.value
      break
    }
    case 'uses-sdk': {
      const min = get('minSdkVersion')
      const target = get('targetSdkVersion')
      if (min && typeof min.value === 'number') result.minSdk = min.value
      if (target && typeof target.value === 'number') result.targetSdk = target.value
      break
    }
    case 'uses-permission': {
      const name = get('name')?.value
      if (typeof name === 'string') result.permissions.push(name)
      break
    }
    case 'activity': {
      const name = get('name')?.value
      if (typeof name === 'string') result.activities.push(name)
      break
    }
    default:
      break
  }
}

/** Read the application label via the resource map when present. */
export function apkManifest(apkPath) {
  const buffer = fs.readFileSync(apkPath)
  const manifest = readZipEntry(buffer, 'AndroidManifest.xml')
  if (!manifest) throw new Error('APK 中找不到 AndroidManifest.xml')
  return parseBinaryManifest(manifest)
}

/** Package name of a local APK, or null when the manifest cannot be read. */
export function apkPackageName(apkPath) {
  try {
    return apkManifest(apkPath).package
  } catch {
    return null
  }
}

/** Application label from resources.arsc-free sources: resource id → cannot resolve. */
export function apkSummary(apkPath) {
  const manifest = apkManifest(apkPath)
  return {
    ...manifest,
    sizeBytes: fs.statSync(apkPath).size,
  }
}
