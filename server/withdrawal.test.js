import assert from 'node:assert/strict'
import { assertRawWithdrawalWithinAllowance, requestedTokenBaseUnits, requestedWithdrawalBaseUnits, readFreshWithdrawalAllowance } from './withdrawal.js'

assert.equal(assertRawWithdrawalWithinAllowance('1500000', '1500000'), '1500000')
assert.throws(() => assertRawWithdrawalWithinAllowance('1500001', '1500000'), /fresh free-withdrawal allowance/i)
assert.throws(() => assertRawWithdrawalWithinAllowance('0', '1500000'), /positive integer/i)
assert.throws(() => assertRawWithdrawalWithinAllowance('1.5', '1500000'), /positive integer/i)
assert.throws(() => assertRawWithdrawalWithinAllowance('999', 'bad'), /fresh free-withdrawal allowance/i)
assert.equal(requestedWithdrawalBaseUnits({ amountBaseUnits: '900719925474099312345', decimals: 6 }), '900719925474099312345')
assert.equal(requestedWithdrawalBaseUnits({ amount: '1.234567', decimals: 6 }), '1234567')
assert.equal(requestedTokenBaseUnits({ amountBaseUnits: '9007199254740993', decimals: 6 }), '9007199254740993')
assert.equal(requestedTokenBaseUnits({ amount: '1.234567', decimals: 6 }), '1234567')
assert.throws(() => requestedTokenBaseUnits({ amountBaseUnits: '1.2', decimals: 6 }), /positive integer/i)
assert.throws(() => requestedTokenBaseUnits({ amountBaseUnits: '18446744073709551616', decimals: 6 }), /u64/i)
assert.throws(() => requestedWithdrawalBaseUnits({ amountBaseUnits: '1.2', amount: '1', decimals: 6 }), /positive integer/i)
assert.throws(() => requestedWithdrawalBaseUnits({ amountBaseUnits: '0', decimals: 6 }), /positive integer/i)

const refreshOrder = []
assert.deepEqual(await readFreshWithdrawalAllowance({
  wallet: 'wallet',
  refreshMarket: async () => { refreshOrder.push('market'); return { updatedAt: 1234, slot: 55 } },
  getAccount: async (wallet, fresh) => { refreshOrder.push('account'); assert.equal(wallet, 'wallet'); assert.equal(fresh, true); return { positionsBaseUnits: { 'sol-usdy-usdc': { 'svm-usdy': { maxWithdraw: '99000000000000001' } } } } },
}), { maxWithdrawBaseUnits: '99000000000000001', updatedAt: 1234, slot: 55 })
assert.deepEqual(refreshOrder, ['market', 'account'], 'allowance endpoint refreshes market before the fresh obligation read')
await assert.rejects(readFreshWithdrawalAllowance({
  wallet: 'wallet', refreshMarket: async () => { throw new Error('market refresh failed') },
  getAccount: async () => assert.fail('a stale account cannot back a failed fresh market refresh'),
}), /market refresh failed/i)

console.log('fresh withdrawal bounds ok')
