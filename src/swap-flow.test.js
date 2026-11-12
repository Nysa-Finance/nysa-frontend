import assert from 'node:assert/strict'
import { amountToBaseUnits, baseUnitsToAmount, resolveSwapFlow } from './swap-flow.js'

assert.equal(amountToBaseUnits('12.340001', 6), '12340001')
assert.equal(amountToBaseUnits('0.000001', 6), '1')
assert.equal(amountToBaseUnits('000.5', 6), '500000')
assert.equal(amountToBaseUnits('18446744073709.551615', 6), '18446744073709551615')
assert.equal(baseUnitsToAmount('1234001', 6), '1.234001')
assert.equal(baseUnitsToAmount('1000000', 6), '1')
assert.equal(baseUnitsToAmount('1', 6), '0.000001')
assert.throws(() => amountToBaseUnits('1e3', 6), /invalid amount/i)
assert.throws(() => amountToBaseUnits('1.0000001', 6), /invalid amount/i)
assert.throws(() => amountToBaseUnits('0', 6), /positive/i)
assert.throws(() => amountToBaseUnits('18446744073709.551616', 6), /token amount limit/i)

assert.deepEqual(resolveSwapFlow({
  flow: 'acquire-supply', primaryStatus: 'confirmed', confirmedAmountBaseUnits: '4210000',
}), { status: 'offer-next', primaryAction: 'swap', action: 'supply', amountBaseUnits: '4210000' })
assert.deepEqual(resolveSwapFlow({
  flow: 'withdraw-sell', primaryStatus: 'confirmed', confirmedAmountBaseUnits: '4210000', followUpStatus: 'declined',
}), { status: 'wallet-has-token', primaryAction: 'withdraw', action: 'sell', amountBaseUnits: '4210000', followUpFailed: false })
assert.deepEqual(resolveSwapFlow({
  flow: 'acquire-supply', primaryStatus: 'confirmed', confirmedAmountBaseUnits: '4210000', followUpStatus: 'failed',
}), { status: 'wallet-has-token', primaryAction: 'swap', action: 'supply', amountBaseUnits: '4210000', followUpFailed: true })
assert.deepEqual(resolveSwapFlow({
  flow: 'withdraw-sell', primaryStatus: 'failed', confirmedAmountBaseUnits: '4210000',
}), { status: 'failed', primaryAction: 'withdraw', action: 'sell', amountBaseUnits: null })
assert.deepEqual(resolveSwapFlow({ flow: 'withdraw-sell', primaryStatus: 'idle' }), { status: 'idle', primaryAction: 'withdraw', action: 'sell', amountBaseUnits: null })
assert.deepEqual(resolveSwapFlow({ flow: 'withdraw-sell', primaryStatus: 'confirmed-amount-unknown' }), {
  status: 'pending', primaryAction: 'withdraw', action: 'sell', amountBaseUnits: null,
})
assert.throws(() => resolveSwapFlow({ flow: 'acquire-supply', primaryStatus: 'confirmed' }), /confirmed amount/i)
assert.throws(() => resolveSwapFlow({ flow: 'unknown', primaryStatus: 'confirmed', confirmedAmountBaseUnits: '1' }), /unsupported flow/i)

console.log('swap flow ok')
