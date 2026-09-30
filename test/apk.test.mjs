import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStringPool, parseBinaryManifest, readZipEntry, apkManifest } from '../src/apk.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_APK = path.join(HERE, '..', 'artifacts', '_apk', 'wakeup.apk')

// ── AXML fixture builders ───────────────────────────────────────────────────

const TYPE_STRING = 0x03
const TYPE_INT_DEC = 0x10
const NO_ENTRY = 0xffffffff

/** Build a UTF-8 string pool chunk (headerSize 28). */
function buildStringPool(strings) {
  const count = strings.length
  const headerSize = 28
  const dataStart = headerSize + count * 4
  const encoded = strings.map((value) => {
    const bytes = Buffer.from(value, 'utf8')
    const length = bytes.length < 0x80 ? Buffer.from([bytes.length]) : Buffer.from([(bytes.length >> 8) | 0x80, bytes.length & 0xff])
    return Buffer.concat([length, length, bytes, Buffer.from([0])])
  })
  const dataLength = encoded.reduce((sum, buffer) => sum + buffer.length, 0)
  const chunk = Buffer.alloc(dataStart + dataLength)
  chunk.writeUInt16LE(0x0001, 0)
  chunk.writeUInt16LE(headerSize, 2)
  chunk.writeUInt32LE(chunk.length, 4)
  chunk.writeUInt32LE(count, 8)
  chunk.writeUInt32LE(0, 12) // styleCount
  chunk.writeUInt32LE(0x100, 16) // UTF8_FLAG
  chunk.writeUInt32LE(dataStart, 20)
  chunk.writeUInt32LE(0, 24)
  let cursor = dataStart
  encoded.forEach((buffer, i) => {
    chunk.writeUInt32LE(cursor - dataStart, headerSize + i * 4)
    buffer.copy(chunk, cursor)
    cursor += buffer.length
  })
  return chunk
}

/** Build one START_ELEMENT chunk. Attributes are 20 bytes each (ns, name, raw, Res_value). */
function buildStartElement(nameIndex, attributes) {
  const headerSize = 16
  const attributeStart = 20
  const attributeSize = 20
  const size = headerSize + attributeStart + attributeSize * attributes.length
  const chunk = Buffer.alloc(size)
  chunk.writeUInt16LE(0x0102, 0)
  chunk.writeUInt16LE(headerSize, 2)
  chunk.writeUInt32LE(size, 4)
  chunk.writeUInt32LE(1, 8) // lineNumber
  chunk.writeUInt32LE(NO_ENTRY, 12) // comment
  chunk.writeUInt32LE(NO_ENTRY, 16) // ns
  chunk.writeUInt32LE(nameIndex, 20)
  chunk.writeUInt16LE(attributeStart, 24)
  chunk.writeUInt16LE(attributeSize, 26)
  chunk.writeUInt16LE(attributes.length, 28)
  chunk.writeUInt16LE(0, 30)
  chunk.writeUInt16LE(0, 32)
  chunk.writeUInt16LE(0, 34)
  attributes.forEach((attribute, i) => {
    const cursor = headerSize + attributeStart + i * attributeSize
    chunk.writeUInt32LE(NO_ENTRY, cursor)
    chunk.writeUInt32LE(attribute.nameIndex, cursor + 4)
    chunk.writeUInt32LE(attribute.rawIndex ?? NO_ENTRY, cursor + 8)
    chunk.writeUInt16LE(8, cursor + 12)
    chunk[cursor + 14] = 0
    chunk[cursor + 15] = attribute.type
    chunk.writeUInt32LE(attribute.data, cursor + 16)
  })
  return chunk
}

function buildManifest(strings, elements) {
  const pool = buildStringPool(strings)
  const body = Buffer.concat(elements)
  const header = Buffer.alloc(8)
  header.writeUInt16LE(0x0003, 0)
  header.writeUInt16LE(8, 2)
  header.writeUInt32LE(8 + pool.length + body.length, 4)
  return Buffer.concat([header, pool, body])
}

/** A synthetic manifest declaring package/versionName/versionCode/uses-sdk. */
function syntheticManifest() {
  const strings = ['manifest', 'package', 'com.demo.app', 'versionName', '1.2.3', 'versionCode', 'uses-sdk', 'minSdkVersion', 'targetSdkVersion']
  const index = Object.fromEntries(strings.map((s, i) => [s, i]))
  const manifestElement = buildStartElement(index.manifest, [
    { nameIndex: index.package, type: TYPE_STRING, data: index['com.demo.app'], rawIndex: index['com.demo.app'] },
    { nameIndex: index.versionName, type: TYPE_STRING, data: index['1.2.3'], rawIndex: index['1.2.3'] },
    { nameIndex: index.versionCode, type: TYPE_INT_DEC, data: 42 },
  ])
  const usesSdk = buildStartElement(index['uses-sdk'], [
    { nameIndex: index.minSdkVersion, type: TYPE_INT_DEC, data: 24 },
    { nameIndex: index.targetSdkVersion, type: TYPE_INT_DEC, data: 35 },
  ])
  return buildManifest(strings, [manifestElement, usesSdk])
}

/** Wrap a payload in a ZIP with a stored (method 0) local entry. */
function buildStoredZip(name, payload) {
  const nameBuffer = Buffer.from(name, 'utf8')
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4) // version needed
  header.writeUInt16LE(0, 6) // flags
  header.writeUInt16LE(0, 8) // method: stored
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt32LE(0, 14) // crc (unchecked by the reader)
  header.writeUInt32LE(payload.length, 18)
  header.writeUInt32LE(payload.length, 22)
  header.writeUInt16LE(nameBuffer.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, nameBuffer, payload])
}

/** Wrap a payload in a ZIP with a deflated (method 8) local entry. */
function buildDeflatedZip(name, payload) {
  const deflated = zlib.deflateRawSync(payload)
  const nameBuffer = Buffer.from(name, 'utf8')
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(8, 8) // method: deflate
  header.writeUInt32LE(0, 14)
  header.writeUInt32LE(deflated.length, 18)
  header.writeUInt32LE(payload.length, 22)
  header.writeUInt16LE(nameBuffer.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, nameBuffer, deflated])
}

// ── tests ───────────────────────────────────────────────────────────────────

test('parseStringPool decodes a UTF-8 pool', () => {
  const pool = parseStringPool(buildStringPool(['manifest', 'package', 'com.demo.app']), 0)
  assert.deepEqual(pool.strings, ['manifest', 'package', 'com.demo.app'])
  assert.equal(pool.isUtf8, true)
})

test('parseBinaryManifest extracts package, version and sdk levels', () => {
  const manifest = parseBinaryManifest(syntheticManifest())
  assert.equal(manifest.package, 'com.demo.app')
  assert.equal(manifest.versionName, '1.2.3')
  assert.equal(manifest.versionCode, 42)
  assert.equal(manifest.minSdk, 24)
  assert.equal(manifest.targetSdk, 35)
})

test('parseBinaryManifest records permissions and activities', () => {
  const strings = ['manifest', 'package', 'com.demo.app', 'uses-permission', 'name', 'android.permission.CAMERA', 'activity', 'com.demo.app.MainActivity']
  const index = Object.fromEntries(strings.map((s, i) => [s, i]))
  const buffer = buildManifest(strings, [
    buildStartElement(index.manifest, [
      { nameIndex: index.package, type: TYPE_STRING, data: index['com.demo.app'] },
    ]),
    buildStartElement(index['uses-permission'], [
      { nameIndex: index.name, type: TYPE_STRING, data: index['android.permission.CAMERA'] },
    ]),
    buildStartElement(index.activity, [
      { nameIndex: index.name, type: TYPE_STRING, data: index['com.demo.app.MainActivity'] },
    ]),
  ])
  const manifest = parseBinaryManifest(buffer)
  assert.deepEqual(manifest.permissions, ['android.permission.CAMERA'])
  assert.deepEqual(manifest.activities, ['com.demo.app.MainActivity'])
})

test('parseBinaryManifest rejects a non-AXML buffer', () => {
  assert.throws(() => parseBinaryManifest(Buffer.from('not xml at all')), /二进制 AndroidManifest/)
})

test('readZipEntry finds a stored entry', () => {
  const payload = Buffer.from('hello manifest')
  const zip = buildStoredZip('AndroidManifest.xml', payload)
  assert.deepEqual(readZipEntry(zip, 'AndroidManifest.xml'), payload)
})

test('readZipEntry inflates a deflated entry', () => {
  const payload = syntheticManifest()
  const zip = buildDeflatedZip('AndroidManifest.xml', payload)
  assert.deepEqual(readZipEntry(zip, 'AndroidManifest.xml'), payload)
})

test('readZipEntry returns null for a missing entry', () => {
  const zip = buildStoredZip('classes.dex', Buffer.from('x'))
  assert.equal(readZipEntry(zip, 'AndroidManifest.xml'), null)
})

test('readZipEntry skips earlier entries to reach a later one', () => {
  const first = buildStoredZip('res/raw/a.bin', Buffer.from('aaaa'))
  const second = buildStoredZip('AndroidManifest.xml', Buffer.from('manifest-here'))
  const zip = Buffer.concat([first, second])
  assert.deepEqual(readZipEntry(zip, 'AndroidManifest.xml'), Buffer.from('manifest-here'))
})

test('apkManifest reads a real APK when the live fixture is present', (t) => {
  if (!fs.existsSync(FIXTURE_APK)) {
    t.skip(`live fixture missing: ${FIXTURE_APK}`)
    return
  }
  const manifest = apkManifest(FIXTURE_APK)
  assert.match(manifest.package, /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)
  assert.ok(manifest.activities.length > 0)
  assert.ok(manifest.targetSdk >= 21)
})
