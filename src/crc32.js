/**
 * CRC-32 (IEEE 802.3), shared by the PNG encoder and the ZIP writer.
 *
 * Both formats need the same polynomial and the same table-driven loop, so it
 * lives here rather than being duplicated with a subtle table difference.
 */

const TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** @param {Buffer|Uint8Array} buffer */
export function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
