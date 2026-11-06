import assert from 'node:assert/strict'
import { assertCanStartLendingAction, canCancelSetupRecovery, canResumeSetupRecovery, canRetryAfterTransactionOutcome, cancelConfirmedSetupRecovery, classifyPendingTransaction, markSetupTransactionConfirmed, pendingTransactionMatches, recoverConfirmedSetupTransaction, resumeConfirmedSetupContinuation, startVisibleReconciliationLoop } from './pending-reconciliation.js'
import { applySwapFlowOutcome } from './swap-flow-state.js'

const pending = { wallet: 'wallet-a', signature: 'sig-1' }
assert.equal(pendingTransactionMatches(pending, pending, 'wallet-a'), true)
assert.equal(pendingTransactionMatches(pending, { ...pending, signature: 'sig-2' }, 'wallet-a'), false)
assert.equal(pendingTransactionMatches(pending, pending, 'wallet-b'), false)
const lendingPending = { ...pending, market: 'sol-usdy-usdc', kind: 'withdraw', flow: 'withdraw-sell', stage: 'withdraw', params: { token: 'svm-usdy' } }
assert.equal(pendingTransactionMatches(lendingPending, { ...lendingPending }, 'wallet-a'), true)
for (const alteration of [
  { flow: 'acquire-supply' }, { stage: 'supply' }, { market: 'other-market' }, { kind: 'deposit' },
  { params: { token: 'svm-usdc' } },
]) {
  assert.equal(pendingTransactionMatches(lendingPending, { ...lendingPending, ...alteration }, 'wallet-a'), false,
    `async reconciliation rejects changed pending context ${JSON.stringify(alteration)}`)
}
const pendingLoopClose = {
  ...pending, market: 'sol-usdy-usdc', kind: 'loop-close', status: 'submitted',
  params: { wallet: 'wallet-a', market: 'sol-usdy-usdc', kind: 'loop-close', loopAction: true, positionId: 'multiply:abc' },
}
for (const positionId of ['multiply:def', undefined]) {
  assert.equal(pendingTransactionMatches(pendingLoopClose, {
    ...pendingLoopClose,
    params: { ...pendingLoopClose.params, positionId },
  }, 'wallet-a'), false, 'close reconciliation remains bound to the exact selected obligation')
}

const persistedWithdrawal = JSON.parse(JSON.stringify({
  ...lendingPending,
  status: 'relay-unknown',
  params: { wallet: 'wallet-a', market: 'sol-usdy-usdc', kind: 'withdraw', token: 'svm-usdy', swapFlow: 'withdraw-sell', swapFlowStage: 'withdraw', amountBaseUnits: '500' },
}))
assert.throws(() => assertCanStartLendingAction(persistedWithdrawal, { wallet: 'wallet-a', kind: 'deposit', flow: 'acquire-supply' }), /still pending|reconcile/i,
  'a reloaded unresolved withdrawal blocks a new action and cannot overwrite the single pending key')
assert.throws(() => assertCanStartLendingAction(persistedWithdrawal, { wallet: 'wallet-b', kind: 'deposit', flow: 'acquire-supply' }), /still pending|reconcile/i,
  'a different wallet cannot overwrite an unresolved durable lending signature')
assert.doesNotThrow(() => assertCanStartLendingAction(null, { wallet: 'wallet-a', kind: 'deposit' }))
const setupConfirmed = { ...persistedWithdrawal, status: 'setup-confirmed', signature: 'setup-sig' }
assert.doesNotThrow(() => assertCanStartLendingAction(setupConfirmed, { wallet: 'wallet-a', kind: 'withdraw' }, 'setup-sig'),
  'only the continuation carrying the confirmed setup signature may replace its marker')
assert.throws(() => assertCanStartLendingAction(setupConfirmed, { wallet: 'wallet-a', kind: 'deposit' }, 'other-sig'), /still pending|reconcile/i)
assert.throws(() => assertCanStartLendingAction({ ...setupConfirmed, signature: null }, { wallet: 'wallet-a', kind: 'withdraw' }), /still pending|reconcile/i,
  'an invalid setup marker without a signature cannot bypass the action guard')
assert.throws(() => assertCanStartLendingAction({ ...setupConfirmed, status: 'signed-pending', signature: 'action-sig' }, { wallet: 'wallet-a', kind: 'withdraw' }, 'setup-sig'), /still pending|reconcile/i,
  'once the continuation signature is persisted, the old setup signature no longer authorizes replacing the pending action')
const setupPendingAfterLostRelay = {
  wallet: 'wallet-a', signature: 'setup-signature', status: 'relay-unknown', final: false,
  market: 'sol-usdy-usdc', kind: 'withdraw', flow: 'withdraw-sell', stage: 'withdraw',
  params: { wallet: 'wallet-a', market: 'sol-usdy-usdc', kind: 'withdraw', token: 'svm-usdy', swapFlow: 'withdraw-sell', swapFlowStage: 'withdraw' },
}
assert.deepEqual(markSetupTransactionConfirmed({ ...setupPendingAfterLostRelay, status: 'submitted', signedTransactionBase64: 'persisted-signed-bytes' }), {
  ...setupPendingAfterLostRelay, status: 'setup-confirmed', requiresUserAction: true, signedTransactionBase64: 'persisted-signed-bytes',
}, 'confirmed setup keeps its signature and signed bytes until the next step is durably signed')
const recoveredSetup = markSetupTransactionConfirmed(setupPendingAfterLostRelay)
assert.deepEqual(recoverConfirmedSetupTransaction(setupPendingAfterLostRelay, { status: 'confirmed' }), recoveredSetup)
assert.equal(recoverConfirmedSetupTransaction(setupPendingAfterLostRelay, { status: 'pending' }), null)
assert.equal(canResumeSetupRecovery(recoveredSetup, null, recoveredSetup.signature), true)
assert.equal(canResumeSetupRecovery(recoveredSetup, persistedWithdrawal, recoveredSetup.signature), false,
  'setup continuation cannot replace a different unresolved signature')
assert.equal(canResumeSetupRecovery(recoveredSetup, null, 'wrong-signature'), false)
assert.equal(canCancelSetupRecovery(recoveredSetup, null), true)
assert.equal(canCancelSetupRecovery(recoveredSetup, persistedWithdrawal), false,
  'cancel cannot discard setup recovery while an economic signature is unresolved')
const cancelledSetup = cancelConfirmedSetupRecovery(recoveredSetup, null)
assert.deepEqual(cancelledSetup.outcome, {
  wallet: 'wallet-a', market: 'sol-usdy-usdc', flow: 'withdraw-sell', stage: 'withdraw',
  status: 'rejected', amountBaseUnits: null, signature: null, token: 'svm-usdy',
}, 'cancelling confirmed setup settles its matching withdrawal as rejected without reusing the setup signature')
assert.equal(canRetryAfterTransactionOutcome(cancelledSetup.outcome.status), true,
  'cancelled setup clears the block and leaves withdrawal retryable')
assert.deepEqual(applySwapFlowOutcome({
  primaryStatus: 'pending', primaryAmountBaseUnits: null, followUpStatus: null,
  inputId: 'svm-usdy', outputId: 'svm-usdc',
}, cancelledSetup.outcome, 'wallet-a', 'withdraw-sell'), {
  primaryStatus: 'rejected', primaryAmountBaseUnits: null, followUpStatus: null,
  inputId: 'svm-usdy', outputId: 'svm-usdc',
}, 'the Swap page restores the cancelled withdrawal to its retryable primary state')
let desktopContinuation = null
let desktopResumeSignature = null
let deeplinkContinuation = null
const desktopResume = await resumeConfirmedSetupContinuation({
  pending: setupPendingAfterLostRelay,
  chain: { status: 'confirmed' },
  wallet: { name: 'Phantom', features: { 'solana:signTransaction': { signTransaction() {} } } },
  accountAddress: 'wallet-a',
  userInitiated: true,
  continueDesktop: async (params, signature) => { desktopContinuation = params; desktopResumeSignature = signature; return 'final-action-signature' },
  continueDeeplink: async (params) => { deeplinkContinuation = params },
})
assert.equal(desktopResume.mode, 'desktop', 'a confirmed setup timeout resumes through the connected desktop signing capability')
assert.equal(desktopResume.result, 'final-action-signature')
assert.deepEqual(desktopContinuation, setupPendingAfterLostRelay.params)
assert.equal(desktopResumeSignature, 'setup-signature', 'desktop continuation carries the confirmed setup signature as its resume token')
assert.equal(deeplinkContinuation, null)
let mobileContinuation = null
const mobileResume = await resumeConfirmedSetupContinuation({
  pending: setupPendingAfterLostRelay,
  chain: { status: 'confirmed' },
  wallet: { deeplink: true },
  accountAddress: 'wallet-a',
  userInitiated: true,
  continueDesktop: async () => assert.fail('deeplink wallet must not use desktop continuation'),
  continueDeeplink: async (params) => { mobileContinuation = params },
})
assert.equal(mobileResume.mode, 'deeplink')
assert.deepEqual(mobileContinuation, setupPendingAfterLostRelay.params)
let standardContinuation = null
const standardResume = await resumeConfirmedSetupContinuation({
  pending: { ...setupPendingAfterLostRelay, flow: null, stage: null, params: { wallet: 'wallet-a', kind: 'deposit' } },
  chain: { status: 'confirmed' },
  wallet: { name: 'Standard wallet', features: { 'solana:signAndSendTransaction': { signAndSendTransaction() {} } } },
  accountAddress: 'wallet-a',
  userInitiated: true,
  continueDesktop: async (params) => { standardContinuation = params; return 'deposit-signature' },
  continueDeeplink: async () => assert.fail('standard wallet must not take the deeplink path'),
})
assert.equal(standardResume.mode, 'desktop')
assert.equal(standardResume.result, 'deposit-signature')
assert.deepEqual(standardContinuation, { wallet: 'wallet-a', kind: 'deposit' })
let sendAndSendContinuation = null
const sendAndSendResume = await resumeConfirmedSetupContinuation({
  pending: { ...setupPendingAfterLostRelay, flow: null, stage: null, params: { wallet: 'wallet-a', kind: 'deposit' } },
  chain: { status: 'confirmed' },
  wallet: { name: 'Sign-and-send only', features: { 'solana:signAndSendTransaction': { signAndSendTransaction() {} } } },
  accountAddress: 'wallet-a',
  userInitiated: true,
  continueDesktop: async (params, signature) => { sendAndSendContinuation = { params, signature }; return 'deposit-signature' },
})
assert.equal(sendAndSendResume.mode, 'desktop', 'ordinary lending continuation supports desktop signAndSend-only wallets')
assert.deepEqual(sendAndSendContinuation, { params: { wallet: 'wallet-a', kind: 'deposit' }, signature: 'setup-signature' })
const flowNeedsPersistedBytes = await resumeConfirmedSetupContinuation({
  pending: setupPendingAfterLostRelay,
  chain: { status: 'confirmed' },
  wallet: { name: 'Sign-and-send only', features: { 'solana:signAndSendTransaction': { signAndSendTransaction() {} } } },
  accountAddress: 'wallet-a', continueDesktop: async () => assert.fail('flow continuation needs exact signed bytes'),
})
assert.equal(flowNeedsPersistedBytes.mode, null, 'recoverable Swap flows still require the sign-only relay path')
let walletPrompts = 0
const passiveRecoveryTick = await resumeConfirmedSetupContinuation({
  pending: recoveredSetup, chain: { status: 'confirmed' },
  wallet: { name: 'Phantom', features: { 'solana:signTransaction': { signTransaction() {} } } },
  accountAddress: 'wallet-a',
  userInitiated: false,
  continueDesktop: async () => { walletPrompts++; throw new Error('User rejected the transaction') },
})
assert.equal(passiveRecoveryTick.reason, 'explicit-user-action-required')
assert.equal(walletPrompts, 0, 'a reconciliation tick cannot automatically prompt for an economic signature')
await assert.rejects(resumeConfirmedSetupContinuation({
  pending: recoveredSetup, chain: { status: 'confirmed' },
  wallet: { name: 'Phantom', features: { 'solana:signTransaction': { signTransaction() {} } } },
  accountAddress: 'wallet-a', userInitiated: true,
  continueDesktop: async () => { walletPrompts++; throw new Error('User rejected the transaction') },
}), /User rejected/i)
for (let tick = 0; tick < 3; tick++) {
  assert.equal(recoverConfirmedSetupTransaction(recoveredSetup, { status: 'confirmed' }).signature, recoveredSetup.signature)
  const passiveTick = await resumeConfirmedSetupContinuation({
    pending: recoveredSetup, chain: { status: 'confirmed' },
    wallet: { name: 'Phantom', features: { 'solana:signTransaction': { signTransaction() {} } } },
    accountAddress: 'wallet-a',
    continueDesktop: async () => { walletPrompts++; },
  })
  assert.equal(passiveTick.reason, 'explicit-user-action-required')
}
assert.equal(walletPrompts, 1, 'reconciliation ticks do not repeat wallet prompts after a rejection')
const explicitRetry = await resumeConfirmedSetupContinuation({
  pending: recoveredSetup, chain: { status: 'confirmed' },
  wallet: { name: 'Phantom', features: { 'solana:signTransaction': { signTransaction() {} } } },
  accountAddress: 'wallet-a', userInitiated: true,
  continueDesktop: async () => { walletPrompts++; return 'retry-signature' },
})
assert.equal(explicitRetry.result, 'retry-signature', 'explicit resume remains available after rejection')
assert.equal(canCancelSetupRecovery(recoveredSetup, null), true, 'explicit cancel remains available after rejection')
for (const status of ['preparing', 'wallet-prompt', 'awaiting-signature', 'signed-pending', 'submitted', 'relay-unknown', 'pending', 'setup-confirmed', 'confirmed-amount-unknown']) {
  assert.equal(canRetryAfterTransactionOutcome(status), false, `${status} blocks a duplicate action`)
}
assert.doesNotThrow(() => assertCanStartLendingAction(
  { reservationId: 'action-1', status: 'preparing' }, { kind: 'deposit' }, null, 'action-1',
), 'an action may advance its own persisted reservation through build and confirmation')
assert.throws(() => assertCanStartLendingAction(
  { reservationId: 'action-1', status: 'preparing' }, { kind: 'borrow' }, null, 'action-2',
), (error) => error.code === 'PENDING_TRANSACTION', 'a different action cannot replace a build reservation')
assert.throws(() => assertCanStartLendingAction(
  { reservationId: 'action-1', status: 'wallet-prompt' }, { kind: 'borrow' }, null, 'action-2',
), (error) => error.code === 'PENDING_TRANSACTION', 'a different action cannot replace a wallet-prompt reservation')
assert.equal(canRetryAfterTransactionOutcome('rejected'), true, 'definitely rejected action may be retried')
assert.equal(canRetryAfterTransactionOutcome('failed'), true, 'settled failure may be retried')
assert.deepEqual(classifyPendingTransaction(pending, { status: 'pending' }), { status: 'pending', signature: 'sig-1' })
assert.deepEqual(classifyPendingTransaction(pending, { status: 'failed', error: 'custom program error' }), { status: 'failed', signature: 'sig-1', error: 'custom program error' })
assert.deepEqual(classifyPendingTransaction({ ...pending, final: false }, { status: 'confirmed' }), { status: 'setup-confirmed', signature: 'sig-1' })
assert.deepEqual(classifyPendingTransaction({ ...pending, final: true }, { status: 'confirmed' }), { status: 'confirmed', signature: 'sig-1' })

let timerCallback, cleared = false, calls = 0, finish
let visible = false
const loop = startVisibleReconciliationLoop({
  reconcile: () => { calls++; return new Promise((resolve) => { finish = resolve }) },
  isVisible: () => visible,
  intervalMs: 100,
  setIntervalFn: (callback, interval) => { assert.equal(interval, 100); timerCallback = callback; return 'timer' },
  clearIntervalFn: (timer) => { assert.equal(timer, 'timer'); cleared = true },
})
timerCallback()
await Promise.resolve()
assert.equal(calls, 0, 'hidden tab does not poll signatures')
visible = true
timerCallback()
await Promise.resolve()
assert.equal(calls, 1)
timerCallback()
assert.equal(calls, 1, 'overlapping signature polls are skipped')
finish()
await new Promise((resolve) => setImmediate(resolve))
timerCallback()
await Promise.resolve()
assert.equal(calls, 2, 'active page polls again after previous reconciliation finishes')
loop()
assert.equal(cleared, true)
finish()
await Promise.resolve()
timerCallback()
assert.equal(calls, 2, 'stopped reconciliation timer does not start new work')

console.log('pending reconciliation loop ok')
