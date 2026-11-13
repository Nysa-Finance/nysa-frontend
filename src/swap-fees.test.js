import assert from 'node:assert/strict'
import { calculateSwapFeeBaseUnits, formatBaseUnits, parseBaseUnits } from './swap-fees.js'

assert.equal(calculateSwapFeeBaseUnits('100000000'), 100000n) // 100 USDC at 10 bps = 0.10 USDC
assert.equal(calculateSwapFeeBaseUnits('10000000000'), 10000000n) // 10,000 USDC = 10 USDC
assert.equal(calculateSwapFeeBaseUnits('99999999'), 99999n) // fee is rounded down per event
assert.equal(calculateSwapFeeBaseUnits('1'), 0n) // a sub-base-unit fee cannot be charged
assert.equal(calculateSwapFeeBaseUnits('100000000', 25), 250000n)
assert.equal(formatBaseUnits(1234567n, 6), '1.234567')
assert.equal(formatBaseUnits(1000000n, 6), '1')
assert.equal(formatBaseUnits(0n, 6), '0')
assert.equal(parseBaseUnits('1.234567', 6), 1234567n)
assert.equal(parseBaseUnits('1', 0), 1n)

for (const amount of ['-1', '1.2', '1e6', '']) assert.throws(() => calculateSwapFeeBaseUnits(amount), /base-unit amount/)
for (const bps of [-1, 10001, 1.5, '10']) assert.throws(() => calculateSwapFeeBaseUnits('100', bps), /basis points/)
for (const [amount, decimals] of [['-1', 6], ['1.1234567', 6], ['1e3', 6], ['', 6], ['1', -1], ['1', 256]]) {
  assert.throws(() => parseBaseUnits(amount, decimals), /amount|decimals/i)
}
for (const [amount, decimals] of [[-1n, 6], [1n, -1], [1n, 256]]) {
  assert.throws(() => formatBaseUnits(amount, decimals), /amount|decimals/i)
}

console.log('swap-fees ok')
