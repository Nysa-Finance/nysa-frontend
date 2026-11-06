import assert from 'node:assert/strict'
import { applySwapFlowOutcome, flowContextMatches, normalizeSwapFlowDirection, pendingFlowMatches, recoverConfirmedWithdrawal, routeSwapDirection } from './swap-flow-state.js'

assert.deepEqual(normalizeSwapFlowDirection('withdraw-sell'), { inputId: 'svm-usdy', outputId: 'svm-usdc' })
assert.deepEqual(normalizeSwapFlowDirection('acquire-supply'), { inputId: 'svm-usdc', outputId: 'svm-usdy' })
assert.equal(normalizeSwapFlowDirection(null), null)
assert.deepEqual(routeSwapDirection('withdraw-sell', 'svm-usdc', 'svm-usdy'), { inputId: 'svm-usdy', outputId: 'svm-usdc' }, 'withdraw flow overrides a wrong-direction URL pair')
assert.deepEqual(routeSwapDirection('acquire-supply', 'svm-usdy', 'svm-usdc'), { inputId: 'svm-usdc', outputId: 'svm-usdy' }, 'acquire flow overrides a wrong-direction URL pair')
assert.deepEqual(routeSwapDirection(null, 'svm-usdy', 'svm-usdc'), { inputId: 'svm-usdy', outputId: 'svm-usdc' }, 'plain swap preserves an allowed URL pair')
assert.deepEqual(routeSwapDirection(null, 'svm-usdc', 'svm-usdc'), { inputId: 'svm-usdc', outputId: 'svm-usdy' }, 'plain swap rejects duplicate mints and picks the default pair')

const context = {
  wallet: 'wallet-a', flow: 'withdraw-sell', market: 'sol-usdy-usdc', routeFlow: 'withdraw-sell',
  inputId: 'svm-usdy', outputId: 'svm-usdc',
}
const pendingFlow = {
  wallet: 'wallet-a', market: 'sol-usdy-usdc', flow: 'withdraw-sell', stage: 'withdraw',
  status: 'relay-unknown', params: { swapFlow: 'withdraw-sell', swapFlowStage: 'withdraw' },
}
assert.equal(pendingFlowMatches(pendingFlow, { ...context, stage: 'withdraw' }), true, 'signed pending flow matches its active page')
assert.equal(pendingFlowMatches({
  ...pendingFlow, flow: 'acquire-supply', stage: 'supply', params: { swapFlow: 'acquire-supply', swapFlowStage: 'supply' },
}, { ...context, flow: 'acquire-supply', stage: 'supply' }), true, 'optional supply remains blocked while its signature is pending')
assert.equal(pendingFlowMatches(pendingFlow, { ...context, stage: 'withdraw', wallet: 'wallet-b' }), false, 'another wallet pending record does not block this wallet')
assert.equal(pendingFlowMatches(pendingFlow, { ...context, stage: 'withdraw', flow: 'acquire-supply' }), false, 'a different flow pending record does not mutate this flow')
assert.equal(pendingFlowMatches(pendingFlow, { ...context, stage: 'withdraw', market: 'other-market' }), false, 'another market pending record does not block this market')
assert.equal(pendingFlowMatches({ ...pendingFlow, status: 'confirmed' }, { ...context, stage: 'withdraw' }), false, 'settled flow record no longer blocks retry')
assert.equal(flowContextMatches(context, { ...context }), true)
for (const [key, value] of Object.entries({
  wallet: 'wallet-b', flow: 'acquire-supply', market: 'other-market', routeFlow: 'acquire-supply',
  inputId: 'svm-usdc', outputId: 'svm-usdy',
})) {
  assert.equal(flowContextMatches(context, { ...context, [key]: value }), false, `${key} change invalidates an in-flight flow outcome`)
}
assert.deepEqual(recoverConfirmedWithdrawal({
  wallet: 'wallet-a', market: 'sol-usdy-usdc', flow: 'withdraw-sell', stage: 'withdraw', status: 'confirmed', amountBaseUnits: '900',
}, { wallet: 'wallet-a', flow: 'withdraw-sell', market: 'sol-usdy-usdc', requestedBaseUnits: '1000' }), {
  status: 'confirmed', amountBaseUnits: '900',
}, 'confirmed withdrawal outcome survives a redundant transaction-detail lookup failure')
assert.deepEqual(recoverConfirmedWithdrawal({
  wallet: 'wallet-a', market: 'sol-usdy-usdc', flow: 'withdraw-sell', stage: 'withdraw', status: 'confirmed-amount-unknown',
}, { wallet: 'wallet-a', flow: 'withdraw-sell', market: 'sol-usdy-usdc', requestedBaseUnits: '1000' }), {
  status: 'confirmed-amount-unknown', amountBaseUnits: null,
})
assert.equal(recoverConfirmedWithdrawal({
  wallet: 'wallet-b', market: 'sol-usdy-usdc', flow: 'withdraw-sell', stage: 'withdraw', status: 'confirmed', amountBaseUnits: '900',
}, { wallet: 'wallet-a', flow: 'withdraw-sell', market: 'sol-usdy-usdc', requestedBaseUnits: '1000' }), null)
assert.deepEqual(recoverConfirmedWithdrawal({
  wallet: 'wallet-a', market: 'sol-usdy-usdc', flow: 'withdraw-sell', stage: 'withdraw', status: 'confirmed', amountBaseUnits: '1001',
}, { wallet: 'wallet-a', flow: 'withdraw-sell', market: 'sol-usdy-usdc', requestedBaseUnits: '1000' }), {
  status: 'confirmed-amount-unknown', amountBaseUnits: null,
}, 'an outcome outside the requested amount is not used to enable sale')

const idle = { primaryStatus: 'idle', primaryAmountBaseUnits: null, followUpStatus: null, inputId: 'svm-usdc', outputId: 'svm-usdy' }
assert.deepEqual(applySwapFlowOutcome(idle, {
  wallet: 'wallet-a', flow: 'withdraw-sell', stage: 'withdraw', status: 'confirmed', amountBaseUnits: '123456',
}, 'wallet-a', 'withdraw-sell'), {
  ...idle, primaryStatus: 'confirmed', primaryAmountBaseUnits: '123456', inputId: 'svm-usdy', outputId: 'svm-usdc',
})

const savedSale = applySwapFlowOutcome(idle, {
  wallet: 'wallet-a', flow: 'withdraw-sell', stage: 'sell', status: 'confirmed',
  amountBaseUnits: '998', primaryAmountBaseUnits: '123456',
}, 'wallet-a', 'withdraw-sell')
assert.equal(savedSale.primaryStatus, 'confirmed', 'saved confirmed sale restores its original confirmed withdrawal amount')
assert.equal(savedSale.primaryAmountBaseUnits, '123456')
assert.equal(savedSale.followUpStatus, 'confirmed', 'saved confirmed sale restores on reload')
assert.deepEqual(applySwapFlowOutcome(idle, {
  wallet: 'wallet-b', flow: 'withdraw-sell', stage: 'withdraw', status: 'confirmed', amountBaseUnits: '1',
}, 'wallet-a', 'withdraw-sell'), idle, 'another wallet outcome is ignored')
assert.deepEqual(applySwapFlowOutcome(idle, {
  wallet: 'wallet-a', flow: 'withdraw-sell', market: 'other-market', stage: 'withdraw', status: 'confirmed', amountBaseUnits: '1',
}, 'wallet-a', 'withdraw-sell'), idle, 'an outcome from another market is ignored')
assert.deepEqual(applySwapFlowOutcome(idle, {
  wallet: 'wallet-a', flow: 'withdraw-sell', stage: 'withdraw', status: 'confirmed', amountBaseUnits: '1',
  inputId: 'svm-usdc', outputId: 'svm-usdy',
}, 'wallet-a', 'withdraw-sell'), idle, 'a wrong-direction withdrawal outcome is ignored')

let resolvedAmount
const delayedAmountLookup = new Promise((resolve) => { resolvedAmount = resolve })
let currentContext = { ...context }
const committedAmount = delayedAmountLookup.then((value) => flowContextMatches(context, currentContext) ? value : null)
currentContext = { ...currentContext, wallet: 'wallet-b' }
resolvedAmount('999999999999999999')
assert.equal(await committedAmount, null, 'wallet switch while a transaction amount is loading prevents stale amount mutation')

console.log('swap flow outcome restoration ok')
