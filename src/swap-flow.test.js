import assert from 'node:assert/strict'
import { amountToBaseUnits } from './swap-flow.js'

assert.equal(amountToBaseUnits('12.340001', 6), '12340001')
assert.equal(amountToBaseUnits('0.000001', 6), '1')
assert.equal(amountToBaseUnits('000.5', 6), '500000')
assert.equal(amountToBaseUnits('18446744073709.551615', 6), '18446744073709551615')
assert.throws(() => amountToBaseUnits('1e3', 6), /invalid amount/i)
assert.throws(() => amountToBaseUnits('1.0000001', 6), /invalid amount/i)
assert.throws(() => amountToBaseUnits('0', 6), /positive/i)
assert.throws(() => amountToBaseUnits('18446744073709.551616', 6), /token amount limit/i)

console.log('swap flow ok')
