import assert from 'node:assert/strict'
import { usd, pct, compact, hfText, dur, amt, cleanAmount, num } from './format.js'

assert.equal(usd(0.81), '$0.81')
assert.equal(usd(6600), '$6.6K')
assert.equal(usd(NaN), '—')
assert.equal(pct(3.0712), '3.07%')
assert.equal(pct(11214.304957), '11,214.30%')
assert.equal(compact(250000, 'USDY'), '250K USDY')

assert.equal(hfText(Infinity), '∞')
assert.equal(hfText(1.234), '1.23')
assert.equal(hfText(1.15), '1.15')
assert.equal(hfText(0.9996), '0.999', 'just under 1 never reads as a healthy 1.00')
assert.equal(hfText(1.0031), '1.003')
assert.deepEqual([dur(45), dur(180), dur(3600), dur(7200), dur(3 * 86400)], ['45s', '3m', '1h', '2h', '3d'])

// Dust display.
assert.equal(amt(0.000002742), '< 0.0001')
assert.equal(amt(0), '0')
assert.equal(amt(1.04422), '1.0442')
assert.equal(amt(9.99996), '9.9999') // never rounded up past what can be sent
assert.equal(amt(1234.5), '1,234.5')
assert.equal(cleanAmount('1,000', 6), '1.000')
assert.equal(cleanAmount('1,000.5', 6), '1000.5')
assert.equal(cleanAmount('1.000,5', 6), '1000.5')
assert.equal(cleanAmount('1.1234567', 6), '1.123456')
assert.equal(cleanAmount('12.', 6), '12.')
assert.equal(cleanAmount(',5', 6), '0.5')
assert.equal(cleanAmount('1 000a', 6), '1000')
// Typed amounts: comma or dot as the decimal separator; anything ambiguous or invalid is 0 (no amount).
assert.equal(num('586,985732'), 586.985732)
assert.equal(num(' 0.5 '), 0.5)
for (const bad of ['1.000,5', '1,000.5', 'abc', '-3', '', null]) assert.equal(num(bad), 0, String(bad))
console.log('format ok')
