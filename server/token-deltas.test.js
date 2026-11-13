import assert from 'node:assert/strict'
import { confirmedTokenDeltas } from './token-deltas.js'

const wallet = 'Wallet11111111111111111111111111111111111'
const other = 'Other111111111111111111111111111111111111'
const usdy = 'UsdY1111111111111111111111111111111111111'
const usdc = 'UsdC1111111111111111111111111111111111111'
const deltas = confirmedTokenDeltas({
  preTokenBalances: [
    { accountIndex: 0, owner: wallet, mint: usdy, uiTokenAmount: { amount: '100' } },
    { accountIndex: 1, owner: wallet, mint: usdy, uiTokenAmount: { amount: '20' } },
    { accountIndex: 2, owner: other, mint: usdy, uiTokenAmount: { amount: '1000' } },
    { accountIndex: 3, owner: wallet, mint: usdc, uiTokenAmount: { amount: '5' } },
  ],
  postTokenBalances: [
    { accountIndex: 0, owner: wallet, mint: usdy, uiTokenAmount: { amount: '160' } },
    { accountIndex: 1, owner: wallet, mint: usdy, uiTokenAmount: { amount: '20' } },
    { accountIndex: 2, owner: other, mint: usdy, uiTokenAmount: { amount: '2000' } },
    { accountIndex: 3, owner: wallet, mint: usdc, uiTokenAmount: { amount: '4' } },
  ],
})
assert.deepEqual(deltas, [
  { owner: other, mint: usdy, deltaBaseUnits: '1000' },
  { owner: wallet, mint: usdc, deltaBaseUnits: '-1' },
  { owner: wallet, mint: usdy, deltaBaseUnits: '60' },
])
assert.deepEqual(confirmedTokenDeltas({ preTokenBalances: [], postTokenBalances: [] }), [])

console.log('confirmed token deltas ok')
