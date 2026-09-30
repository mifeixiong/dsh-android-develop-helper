/**
 * Screenshots: capture, crop, downscale and PNG re-encode — with zero
 * third-party dependencies and zero device-side image libraries.
 *
 * Why not just `adb exec-out screencap -p` and hand the PNG to the model?
 * Because an AI agent pays for screenshots twice: once in tokens if the image is
 * inlined, and once in latency if it is large.  A 720x1280 phone screenshot is
 * ~180 KB of PNG; the model usually needs the layout, not the pixels.  Reading
 * `screencap`'s *raw* framebuffer lets us crop to the interesting region and
 * downscale by an exact factor before compressing, which is something you
 * cannot do to a PNG without decoding it anyway.
 *
 * Format reference (frameworks/base/cmds/screencap):
 *   header = uint32 width, uint32 height, uint32 format[, uint32 colorspace]
 *   format 1 = RGBA_8888, 2 = RGBX_8888, 3 = RGB_888, 4 = RGB_565, 5 = BGRA_8888
 * Android 9 (API 28) added the colorspace word; we detect the header size by
 * checking which layout makes the byte count line up exactly.
 */
import zlib from 'node:zlib'

export const PIXEL_FORMATS = {
  1: { name: 'RGBA_8888', bpp: 4, order: 'rgba' },
  2: { name: 'RGBX_8888', bpp: 4, order: 'rgba' },
  3: { name: 'RGB_888', bpp: 3, order: 'rgb' },
  4: { name: 'RGB_565', bpp: 2, order: 'rgb565' },
  5: { name: 'BGRA_8888', bpp: 4, order: 'bgra' },
}

/**
 * Decode a raw `screencap` framebuffer into 8-bit RGBA.
 * @param {Buffer} buffer
 * @returns {{width:number,height:number,format:string,headerBytes:number,data:Buffer}}
 */
export function decodeRawScreencap(buffer) {
  if (buffer.length < 16) throw new Error('screencap 输出过短，无法解析')
  // The first two words are stable across versions.
  const width = buffer.readUInt32LE(0)
  const height = buffer.readUInt32LE(4)
  if (width <= 0 || height <= 0 || width > 20000 || height > 20000) {
    throw new Error(`screencap 头部异常: ${width}x${height}`)
  }
  const format = buffer.readUInt32LE(8)
  const spec = PIXEL_FORMATS[format]
  if (!spec) throw new Error(`未知的 screencap 像素格式: ${format}`)

  const bodyBytes = width * height * spec.bpp
  let headerBytes = null
  for (const candidate of [16, 12]) {
    if (buffer.length === bodyBytes + candidate) {
      headerBytes = candidate
      break
    }
  }
  if (headerBytes === null) {
    // Some builds pad; accept anything that leaves at least a full frame.
    if (buffer.length >= bodyBytes + 12) headerBytes = buffer.length - bodyBytes
    else throw new Error(`screencap 数据长度不符: 期望 ${bodyBytes + 12}/${bodyBytes + 16}, 实际 ${buffer.length}`)
  }

  const data = Buffer.allocUnsafe(width * height * 4)
  const src = buffer.subarray(headerBytes)
  convertToRgba(src, data, width * height, spec)
  return { width, height, format: spec.name, headerBytes, data }
}

function convertToRgba(src, dst, pixels, spec) {
  switch (spec.order) {
    case 'rgba': {
      // fast path: 4-byte source, force opaque alpha
      for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 4, d += 4) {
        dst[d] = src[s]
        dst[d + 1] = src[s + 1]
        dst[d + 2] = src[s + 2]
        dst[d + 3] = 255
      }
      return
    }
    case 'bgra': {
      for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 4, d += 4) {
        dst[d] = src[s + 2]
        dst[d + 1] = src[s + 1]
        dst[d + 2] = src[s]
        dst[d + 3] = 255
      }
      return
    }
    case 'rgb': {
      for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 3, d += 4) {
        dst[d] = src[s]
        dst[d + 1] = src[s + 1]
        dst[d + 2] = src[s + 2]
        dst[d + 3] = 255
      }
      return
    }
    case 'rgb565': {
      for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 2, d += 4) {
        const value = src.readUInt16LE(s)
        const r = (value >> 11) & 0x1f
        const g = (value >> 5) & 0x3f
        const b = value & 0x1f
        dst[d] = (r << 3) | (r >> 2)
        dst[d + 1] = (g << 2) | (g >> 4)
        dst[d + 2] = (b << 3) | (b >> 2)
        dst[d + 3] = 255
      }
      return
    }
    default:
      throw new Error(`不支持的像素顺序: ${spec.order}`)
  }
}

/** Crop an RGBA image. Returns a new buffer; out-of-range reads clamp. */
export function cropImage(image, region) {
  const x = Math.max(0, Math.floor(region.x ?? 0))
  const y = Math.max(0, Math.floor(region.y ?? 0))
  const w = Math.min(image.width - x, Math.floor(region.width ?? image.width - x))
  const h = Math.min(image.height - y, Math.floor(region.height ?? image.height - y))
  if (w <= 0 || h <= 0) throw new Error('裁剪区域为空')
  const data = Buffer.allocUnsafe(w * h * 4)
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * image.width + x) * 4
    image.data.copy(data, row * w * 4, srcStart, srcStart + w * 4)
  }
  return { width: w, height: h, data }
}

/**
 * Downscale by an arbitrary factor.
 * `box` averages the source block (smooth gradients, best for photos/UI);
 * `nearest` samples one pixel (keeps thin text strokes crisp at high factors).
 */
export function scaleImage(image, factor, { filter = 'box' } = {}) {
  const clamped = Math.max(0.05, Math.min(1, factor))
  if (clamped >= 0.999) return image
  const w = Math.max(1, Math.round(image.width * clamped))
  const h = Math.max(1, Math.round(image.height * clamped))
  const data = Buffer.allocUnsafe(w * h * 4)
  const sx = image.width / w
  const sy = image.height / h

  if (filter === 'nearest') {
    for (let y = 0; y < h; y++) {
      const srcY = Math.min(image.height - 1, Math.floor(y * sy))
      for (let x = 0; x < w; x++) {
        const srcX = Math.min(image.width - 1, Math.floor(x * sx))
        const s = (srcY * image.width + srcX) * 4
        const d = (y * w + x) * 4
        data[d] = image.data[s]
        data[d + 1] = image.data[s + 1]
        data[d + 2] = image.data[s + 2]
        data[d + 3] = 255
      }
    }
    return { width: w, height: h, data }
  }

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * sy)))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        let s = (yy * image.width + x0) * 4
        for (let xx = x0; xx < x1; xx++, s += 4) {
          r += image.data[s]
          g += image.data[s + 1]
          b += image.data[s + 2]
          n++
        }
      }
      const d = (y * w + x) * 4
      data[d] = (r / n) | 0
      data[d + 1] = (g / n) | 0
      data[d + 2] = (b / n) | 0
      data[d + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

// ── PNG encoding ────────────────────────────────────────────────────────────

import { crc32 } from './crc32.js'

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/**
 * Encode RGBA pixels as a PNG.
 *
 * `colorType` 2 (truecolour, no alpha) is the default: screenshots are opaque,
 * and dropping alpha removes 25% of the raw bytes before deflate ever runs.
 * PNG filter type 1 (Sub) is used because it wins on flat UI fills and text.
 *
 * @param {{width:number,height:number,data:Buffer}} image
 */
export function encodePng(image, { colorType = 2, level = 6 } = {}) {
  const channels = colorType === 6 ? 4 : 3
  const { width, height, data } = image
  const stride = width * channels
  const raw = Buffer.allocUnsafe((stride + 1) * height)

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 1 // filter: Sub
    const src = y * width * 4
    const dst = rowStart + 1
    if (channels === 3) {
      for (let x = 0; x < stride; x += 3) {
        const s = src + (x / 3) * 4
        raw[dst + x] = (data[s] - (x >= 3 ? data[s - 4] : 0)) & 0xff
        raw[dst + x + 1] = (data[s + 1] - (x >= 3 ? data[s - 3] : 0)) & 0xff
        raw[dst + x + 2] = (data[s + 2] - (x >= 3 ? data[s - 2] : 0)) & 0xff
      }
    } else {
      for (let x = 0; x < stride; x++) {
        const s = src + x
        raw[dst + x] = (data[s] - (x >= 4 ? data[s - 4] : 0)) & 0xff
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Perceptual frame signature: a `size x size` average hash plus a mean-luma
 * suffix.
 *
 * Each grid cell is the *mean* colour of the pixels it covers, so the structural
 * part is independent of screen resolution — a 720x1280 phone and a 1080x1920
 * phone showing the same layout produce comparable hashes.
 *
 * The suffix exists because a pure average hash is brightness-blind: a solid
 * black frame and a solid white frame both hash to all-ones, since every cell
 * equals the mean.  That is harmless for identifying a *layout* but wrong for
 * "has the picture stopped changing?" — a fade from a scrim to a dialog keeps
 * the structure and changes only the luminance.  Two hex characters of quantised
 * mean luma close that hole.
 *
 * Total length: `size * size / 4 + 2` hex characters (18 for the default 8x8).
 */
export function averageHash(image, size = 8) {
  const gray = new Float64Array(size * size)
  const stepX = image.width / size
  const stepY = image.height / size
  let sum = 0

  for (let gy = 0; gy < size; gy++) {
    const y0 = Math.floor(gy * stepY)
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((gy + 1) * stepY)))
    for (let gx = 0; gx < size; gx++) {
      const x0 = Math.floor(gx * stepX)
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((gx + 1) * stepX)))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        let s = (y * image.width + x0) * 4
        for (let x = x0; x < x1; x++, s += 4) {
          r += image.data[s]
          g += image.data[s + 1]
          b += image.data[s + 2]
          n++
        }
      }
      const value = 0.299 * (r / n) + 0.587 * (g / n) + 0.114 * (b / n)
      gray[gy * size + gx] = value
      sum += value
    }
  }

  const mean = sum / gray.length
  let bits = ''
  for (let i = 0; i < gray.length; i++) bits += gray[i] >= mean ? '1' : '0'
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) hex += Number.parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16)
  return hex + Math.round(mean).toString(16).padStart(2, '0')
}

/** Hamming distance between two hashes from `averageHash`. */
export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    let x = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16)
    while (x) {
      distance += x & 1
      x >>= 1
    }
  }
  return distance
}

/** Fraction of hash bits that differ — 0 means "visually identical". */
export function similarity(a, b) {
  if (!a || !b) return 0
  return 1 - hashDistance(a, b) / (a.length * 4)
}

/**
 * One-stop screenshot pipeline.
 * @returns {{png:Buffer, raw:{width:number,height:number,data:Buffer}, hash:string, sourceWidth:number, sourceHeight:number, scale:number}}
 */
export function renderScreenshot(rawBuffer, { region = null, scale = 1, filter = 'box', colorType = 2, level = 6 } = {}) {
  let image = decodeRawScreencap(rawBuffer)
  const sourceWidth = image.width
  const sourceHeight = image.height
  if (region) image = cropImage(image, region)
  if (scale < 1) image = scaleImage(image, scale, { filter })
  const hash = averageHash(image)
  const png = encodePng(image, { colorType, level })
  return { png, raw: image, hash, sourceWidth, sourceHeight, scale }
}
