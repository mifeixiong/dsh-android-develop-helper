import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import {
  decodeRawScreencap,
  cropImage,
  scaleImage,
  encodePng,
  averageHash,
  similarity,
  hashDistance,
  renderScreenshot,
} from '../src/screen.js'

/** Build a synthetic raw screencap payload with a 12- or 16-byte header. */
function makeRaw(width, height, { headerBytes = 16, format = 1, fill = null } = {}) {
  const header = Buffer.alloc(headerBytes)
  header.writeUInt32LE(width, 0)
  header.writeUInt32LE(height, 4)
  header.writeUInt32LE(format, 8)
  if (headerBytes === 16) header.writeUInt32LE(0, 12)
  const body = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const x = i % width
    const y = Math.floor(i / width)
    body[i * 4] = fill ? fill[0] : (x * 3) & 0xff
    body[i * 4 + 1] = fill ? fill[1] : (y * 3) & 0xff
    body[i * 4 + 2] = fill ? fill[2] : 128
    body[i * 4 + 3] = 255
  }
  return Buffer.concat([header, body])
}

test('decodeRawScreencap auto-detects the 16-byte (Android 9+) header', () => {
  const image = decodeRawScreencap(makeRaw(8, 4, { headerBytes: 16 }))
  assert.equal(image.width, 8)
  assert.equal(image.height, 4)
  assert.equal(image.format, 'RGBA_8888')
  assert.equal(image.headerBytes, 16)
  assert.equal(image.data.length, 8 * 4 * 4)
})

test('decodeRawScreencap auto-detects the legacy 12-byte header', () => {
  const image = decodeRawScreencap(makeRaw(8, 4, { headerBytes: 12 }))
  assert.equal(image.headerBytes, 12)
  assert.equal(image.width, 8)
})

test('decodeRawScreencap rejects a truncated payload', () => {
  const raw = makeRaw(8, 4)
  assert.throws(() => decodeRawScreencap(raw.subarray(0, raw.length - 40)), /长度不符/)
})

test('decodeRawScreencap forces alpha opaque', () => {
  const raw = makeRaw(2, 2, { fill: [10, 20, 30] })
  raw[16 + 3] = 0 // poke a transparent pixel
  const image = decodeRawScreencap(raw)
  assert.equal(image.data[3], 255)
})

test('cropImage extracts the requested window', () => {
  const image = decodeRawScreencap(makeRaw(10, 10))
  const cropped = cropImage(image, { x: 2, y: 3, width: 4, height: 5 })
  assert.equal(cropped.width, 4)
  assert.equal(cropped.height, 5)
  assert.equal(cropped.data.length, 4 * 5 * 4)
  // pixel (0,0) of the crop equals pixel (2,3) of the source
  const srcOffset = (3 * 10 + 2) * 4
  assert.deepEqual([...cropped.data.subarray(0, 4)], [...image.data.subarray(srcOffset, srcOffset + 4)])
})

test('cropImage clamps a region larger than the image', () => {
  const image = decodeRawScreencap(makeRaw(10, 10))
  const cropped = cropImage(image, { x: 5, y: 5, width: 999, height: 999 })
  assert.equal(cropped.width, 5)
  assert.equal(cropped.height, 5)
})

test('scaleImage box filter averages and halves dimensions', () => {
  const image = decodeRawScreencap(makeRaw(8, 8, { fill: [200, 100, 50] }))
  const scaled = scaleImage(image, 0.5, { filter: 'box' })
  assert.equal(scaled.width, 4)
  assert.equal(scaled.height, 4)
  assert.equal(scaled.data[0], 200)
  assert.equal(scaled.data[1], 100)
  assert.equal(scaled.data[2], 50)
})

test('scaleImage is a no-op at factor 1', () => {
  const image = decodeRawScreencap(makeRaw(8, 8))
  assert.equal(scaleImage(image, 1), image)
})

test('encodePng produces a decodable PNG stream', () => {
  const image = decodeRawScreencap(makeRaw(16, 16))
  const png = encodePng(image)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR')
  assert.equal(png.readUInt32BE(16), 16) // width
  assert.equal(png.readUInt32BE(20), 16) // height
  assert.equal(png[24], 8) // bit depth
  assert.equal(png[25], 2) // colour type: truecolour, no alpha
  assert.ok(png.includes(Buffer.from('IEND', 'latin1')))
})

test('encodePng IDAT round-trips through zlib', () => {
  const image = decodeRawScreencap(makeRaw(4, 2, { fill: [1, 2, 3] }))
  const png = encodePng(image)
  const idatStart = png.indexOf(Buffer.from('IDAT', 'latin1')) + 4
  const idatLength = png.readUInt32BE(idatStart - 8)
  const inflated = zlib.inflateSync(png.subarray(idatStart, idatStart + idatLength))
  assert.equal(inflated.length, (4 * 3 + 1) * 2) // (stride + filter byte) * rows
  assert.equal(inflated[0], 1) // Sub filter
})

test('encodePng supports RGBA output when asked', () => {
  const image = decodeRawScreencap(makeRaw(4, 4))
  const png = encodePng(image, { colorType: 6 })
  assert.equal(png[25], 6)
})

test('averageHash is independent of resolution', () => {
  const small = decodeRawScreencap(makeRaw(8, 8))
  const large = decodeRawScreencap(makeRaw(64, 64))
  assert.equal(averageHash(small).length, 18) // 8x8 bits (16 hex) + 2 hex mean luma
  assert.equal(averageHash(large).length, 18)
})

test('averageHash is stable for identical frames and separates different ones', () => {
  const a = decodeRawScreencap(makeRaw(32, 32, { fill: [10, 10, 10] }))
  const b = decodeRawScreencap(makeRaw(32, 32, { fill: [10, 10, 10] }))
  const c = decodeRawScreencap(makeRaw(32, 32, { fill: [240, 240, 240] }))
  assert.equal(averageHash(a), averageHash(b))
  assert.equal(similarity(averageHash(a), averageHash(b)), 1)
  assert.ok(
    similarity(averageHash(a), averageHash(c)) < 1,
    'a uniform brightness change must still register: pure aHash is brightness-blind',
  )
})

test('averageHash distinguishes structured frames of equal mean luma', () => {
  const left = decodeRawScreencap(makeRaw(32, 32))
  const inverted = { width: 32, height: 32, data: Buffer.from(left.data) }
  for (let i = 0; i < inverted.data.length; i += 4) {
    inverted.data[i] = 255 - inverted.data[i]
    inverted.data[i + 1] = 255 - inverted.data[i + 1]
    inverted.data[i + 2] = 255 - inverted.data[i + 2]
  }
  assert.notEqual(averageHash(left), averageHash(inverted))
})

test('hashDistance counts differing bits', () => {
  assert.equal(hashDistance('0', '0'), 0)
  assert.equal(hashDistance('0', 'f'), 4)
  assert.equal(hashDistance('abc', 'abcd'), Number.MAX_SAFE_INTEGER)
})

test('renderScreenshot compresses substantially and reports the geometry', () => {
  const raw = makeRaw(720, 1280)
  const result = renderScreenshot(raw, { scale: 0.5 })
  assert.equal(result.sourceWidth, 720)
  assert.equal(result.sourceHeight, 1280)
  assert.equal(result.raw.width, 360)
  assert.equal(result.raw.height, 640)
  assert.ok(result.png.length < raw.length, 'PNG must be smaller than the raw framebuffer')
  assert.equal(result.hash.length, 18)
})

test('renderScreenshot honours a crop region', () => {
  const result = renderScreenshot(makeRaw(100, 100), { region: { x: 10, y: 10, width: 20, height: 30 } })
  assert.equal(result.raw.width, 20)
  assert.equal(result.raw.height, 30)
})
