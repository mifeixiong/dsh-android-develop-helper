import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { listZipEntries, extractEntry, readZip, writeZip, findZipEntry, findMisalignedEntries } from '../src/zip.js'
import { crc32 } from '../src/crc32.js'

const text = (value) => Buffer.from(value, 'utf8')

test('crc32 matches the known check value', () => {
  // The standard CRC-32 check value for "123456789".
  assert.equal(crc32(text('123456789')), 0xcbf43926)
})

test('writeZip → listZipEntries round-trips names, sizes and content', () => {
  const entries = [
    { name: 'AndroidManifest.xml', data: text('<manifest/>') },
    { name: 'resources.arsc', data: Buffer.from([0, 1, 2, 3, 4, 5]), compress: false },
    { name: 'classes.dex', data: Buffer.alloc(300, 7), compress: false },
    { name: 'res/layout/activity_main.xml', data: text('<layout/>') },
  ]
  const archive = writeZip(entries)
  const { entries: listed } = listZipEntries(archive)
  assert.deepEqual(listed.map((e) => e.name), entries.map((e) => e.name))
  for (const entry of listed) {
    const original = entries.find((e) => e.name === entry.name)
    assert.equal(entry.uncompressedSize, original.data.length, `${entry.name} size`)
    assert.equal(entry.crc32, crc32(original.data), `${entry.name} crc`)
    assert.deepEqual(extractEntry(archive, entry), original.data, `${entry.name} content`)
  }
})

test('writeZip stores entries marked compress:false and deflates the rest', () => {
  const archive = writeZip([
    { name: 'stored.bin', data: Buffer.alloc(400, 3), compress: false },
    { name: 'deflated.bin', data: Buffer.alloc(4000, 9), compress: true },
  ])
  const { entries } = listZipEntries(archive)
  const stored = entries.find((e) => e.name === 'stored.bin')
  const deflated = entries.find((e) => e.name === 'deflated.bin')
  assert.equal(stored.method, 0, 'compress:false must be stored')
  assert.equal(stored.compressedSize, stored.uncompressedSize)
  assert.equal(deflated.method, 8, 'a compressible entry must be deflated')
  assert.ok(deflated.compressedSize < deflated.uncompressedSize, 'deflate must actually shrink')
})

test('writeZip never inflates an entry it could not compress', () => {
  // Genuinely incompressible input: deflate must not be chosen when it would
  // make the payload larger than the original.
  const incompressible = randomBytes(4096)
  const archive = writeZip([{ name: 'rand.bin', data: incompressible, compress: true }])
  const { entries } = listZipEntries(archive)
  assert.equal(entries[0].method, 0)
  assert.equal(entries[0].compressedSize, incompressible.length)
  assert.deepEqual(extractEntry(archive, entries[0]), incompressible)
})

test('every entry is 4-byte aligned by default', () => {
  const entries = [
    { name: 'a', data: text('x') },
    { name: 'a-longer-name-that-shifts-the-offset', data: Buffer.alloc(37, 1) },
    { name: 'resources.arsc', data: Buffer.alloc(129, 2), compress: false },
    { name: 'even-longer-name-to-force-a-nonzero-pad', data: text('y') },
  ]
  const archive = writeZip(entries)
  assert.deepEqual(findMisalignedEntries(archive, 4), [])
})

test('alignment holds for every entry regardless of name length', () => {
  for (let length = 1; length <= 24; length++) {
    const archive = writeZip([
      { name: `prefix-${'p'.repeat(length)}`, data: text('head') },
      { name: 'payload.bin', data: Buffer.alloc(64, length & 0xff) },
    ])
    assert.deepEqual(
      findMisalignedEntries(archive, 4),
      [],
      `name length ${length} produced a misaligned entry`,
    )
  }
})

test('findMisalignedEntries actually detects misalignment', () => {
  // `align: 1` disables padding, so `x.bin`'s data starts at 30 + 5 = 35.
  const archive = writeZip([{ name: 'x.bin', data: text('hello'), align: 1 }])
  const bad = findMisalignedEntries(archive, 4)
  assert.equal(bad.length, 1)
  assert.equal(bad[0].name, 'x.bin')
  assert.equal(bad[0].dataStart, 35)
  assert.equal(bad[0].remainder, 3)
  // The default writer is the fix.
  assert.deepEqual(findMisalignedEntries(writeZip([{ name: 'x.bin', data: text('hello') }]), 4), [])
})

test('readZip returns every file keyed by name', () => {
  const archive = writeZip([
    { name: 'one.txt', data: text('one') },
    { name: 'dir/two.txt', data: text('two') },
  ])
  const files = readZip(archive)
  assert.equal(files.size, 2)
  assert.equal(files.get('one.txt').toString(), 'one')
  assert.equal(files.get('dir/two.txt').toString(), 'two')
})

test('findZipEntry returns null for a missing name', () => {
  const archive = writeZip([{ name: 'present', data: text('here') }])
  assert.equal(findZipEntry(archive, 'absent'), null)
  assert.equal(findZipEntry(archive, 'present').toString(), 'here')
})

test('a stored entry can be inflated independently (self-consistency)', () => {
  // Deflated payloads must be readable by a stock inflater, not just by us.
  const archive = writeZip([{ name: 'x', data: Buffer.alloc(2048, 42), compress: true }])
  const { entries } = listZipEntries(archive)
  const entry = entries[0]
  const start = entry.localHeaderOffset
  const dataStart = start + 30 + archive.readUInt16LE(start + 26) + archive.readUInt16LE(start + 28)
  const inflated = zlib.inflateRawSync(archive.subarray(dataStart, dataStart + entry.compressedSize))
  assert.equal(inflated.length, 2048)
  assert.equal(inflated[0], 42)
})

test('listZipEntries rejects a non-ZIP buffer', () => {
  assert.throws(() => listZipEntries(Buffer.from('definitely not a zip archive')), /中央目录/)
})

test('the DOS timestamp survives the round trip', () => {
  const when = new Date(2026, 8, 19, 21, 30, 0)
  const archive = writeZip([{ name: 'x', data: text('y') }], { date: when })
  const { entries } = listZipEntries(archive)
  assert.equal(entries.length, 1)
})
