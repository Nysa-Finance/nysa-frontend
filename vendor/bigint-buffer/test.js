// Run by `npm test`: the drop-in must convert exactly like the original package.
const assert = require('node:assert')
const bb = require('./index.js')
const n = 0x0102030405060708090an
assert.strictEqual(bb.toBigIntLE(bb.toBufferLE(n, 16)), n)
assert.strictEqual(bb.toBigIntBE(bb.toBufferBE(n, 16)), n)
assert.deepStrictEqual([...bb.toBufferLE(258n, 4)], [2, 1, 0, 0])
assert.deepStrictEqual([...bb.toBufferBE(258n, 4)], [0, 0, 1, 2])
assert.strictEqual(bb.toBigIntLE(Buffer.alloc(8, 0xff)), 2n ** 64n - 1n)
assert.strictEqual(bb.toBigIntLE(Buffer.alloc(0)), 0n)
const input = Buffer.from([1, 2, 3])
bb.toBigIntLE(input)
assert.deepStrictEqual([...input], [1, 2, 3]) // input not mutated
console.log('bigint-buffer ok')
