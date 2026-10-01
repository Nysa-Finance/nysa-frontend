'use strict'
// Pure-JS bigint-buffer: the original package's own JS fallback, without the vulnerable native binding.
exports.toBigIntLE = (buf) => exports.toBigIntBE(Buffer.from(buf).reverse())
exports.toBigIntBE = (buf) => {
  const hex = Buffer.from(buf).toString('hex')
  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`)
}
exports.toBufferBE = (num, width) => Buffer.from(num.toString(16).padStart(width * 2, '0').slice(0, width * 2), 'hex')
exports.toBufferLE = (num, width) => exports.toBufferBE(num, width).reverse()
