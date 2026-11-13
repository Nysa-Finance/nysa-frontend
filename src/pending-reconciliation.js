const BLOCKING_STATUSES = new Set(['preparing', 'wallet-prompt', 'awaiting-signature', 'signed-pending', 'submitted', 'relay-unknown', 'pending', 'setup-confirmed', 'confirmed-amount-unknown'])

export function assertCanStartLendingAction(pending, nextAction = {}, resumeFromSetupSignature = null, reservationId = null) {
  if (pending?.reservationId && pending.reservationId === reservationId) return true
  if (pending?.status === 'setup-confirmed' && typeof resumeFromSetupSignature === 'string'
    && resumeFromSetupSignature && pending.signature === resumeFromSetupSignature) return true
  if (!pending || !BLOCKING_STATUSES.has(pending.status)) return true
  const action = pending.kind ?? pending.params?.kind ?? 'transaction'
  const signature = pending.signature ? ` (${pending.signature})` : ''
  const error = new Error(`Previous ${action}${signature} may still be pending; reconcile it before starting ${nextAction.kind ?? 'another action'}.`)
  error.code = 'PENDING_TRANSACTION'
  throw error
}

export function pendingTransactionMatches(pending, current, wallet) {
  if (!pending?.signature || pending.wallet !== wallet
    || current?.signature !== pending.signature || current?.wallet !== pending.wallet) return false
  for (const key of ['flow', 'stage', 'market', 'kind']) {
    if (pending[key] !== current[key]) return false
  }
  const params = ['wallet', 'market', 'kind', 'token', 'amount', 'amountBaseUnits', 'all', 'swapFlow', 'swapFlowStage', 'flowAmountBaseUnits',
    'loopAction', 'previewId', 'leverage', 'acknowledgementKey', 'positionId']
  for (const key of params) {
    if (pending.params?.[key] !== current.params?.[key]) return false
  }
  return true
}

export function canRetryAfterTransactionOutcome(status) {
  return !BLOCKING_STATUSES.has(status)
}

export function classifyPendingTransaction(pending, chain) {
  if (chain?.status === 'failed') return { status: 'failed', signature: pending?.signature, error: chain.error ?? 'Transaction failed on-chain.' }
  if (chain?.status !== 'confirmed') return { status: 'pending', signature: pending?.signature }
  return { status: pending?.final === false ? 'setup-confirmed' : 'confirmed', signature: pending?.signature }
}

export function markSetupTransactionConfirmed(pending) {
  if (!pending || pending.final !== false || typeof pending.signature !== 'string' || !pending.signature) {
    throw new Error('A confirmed setup transaction must retain its durable signature.')
  }
  return { ...pending, status: 'setup-confirmed', requiresUserAction: true }
}

export function recoverConfirmedSetupTransaction(pending, chain) {
  if (classifyPendingTransaction(pending, chain).status !== 'setup-confirmed') return null
  return markSetupTransactionConfirmed(pending)
}

export function canResumeSetupRecovery(recovery, activePending, signature, reservationId = null) {
  return recovery?.status === 'setup-confirmed' && recovery.requiresUserAction === true
    && recovery.signature === signature && typeof signature === 'string' && signature.length > 0
    && (!activePending || !BLOCKING_STATUSES.has(activePending.status) || activePending.reservationId === reservationId)
}

export function canCancelSetupRecovery(recovery, activePending) {
  return recovery?.status === 'setup-confirmed' && recovery.requiresUserAction === true
    && (!activePending || !BLOCKING_STATUSES.has(activePending.status))
}

/** Clear confirmed account setup and settle its matching optional flow as a retryable refusal. */
export function cancelConfirmedSetupRecovery(recovery, activePending) {
  if (!canCancelSetupRecovery(recovery, activePending)) return null
  const params = recovery.params
  if (!params?.swapFlow || !params?.swapFlowStage) return { signature: recovery.signature, outcome: null }
  if (!recovery.wallet || params.wallet !== recovery.wallet) return null
  return {
    signature: recovery.signature,
    outcome: {
      wallet: recovery.wallet,
      market: params.market,
      flow: params.swapFlow,
      stage: params.swapFlowStage,
      status: 'rejected',
      amountBaseUnits: null,
      signature: null,
      token: params.token ?? null,
    },
  }
}

/** Resume a confirmed setup transaction using the connected wallet's actual signing path. */
export async function resumeConfirmedSetupContinuation({
  pending, chain, wallet, accountAddress, continueDesktop, continueDeeplink, userInitiated = false,
} = {}) {
  const outcome = classifyPendingTransaction(pending, chain)
  if (outcome.status !== 'setup-confirmed') return { ...outcome, mode: null }
  if (!userInitiated) return { status: 'setup-confirmed', mode: null, reason: 'explicit-user-action-required' }
  if (!wallet || accountAddress !== pending.wallet || !pending.params) {
    return { status: 'setup-confirmed', mode: null, reason: 'wallet-unavailable' }
  }
  const requiresPersistedSignedBytes = !!pending.params.swapFlow && !!pending.params.swapFlowStage
  const capability = requiresPersistedSignedBytes
    ? wallet.features?.['solana:signTransaction']?.signTransaction
    : wallet.features?.['solana:signAndSendTransaction']?.signAndSendTransaction
  const canContinueDesktop = typeof capability === 'function'
  const mode = wallet.deeplink ? 'deeplink' : canContinueDesktop ? 'desktop' : null
  if (!mode) return { status: 'setup-confirmed', mode: null, reason: 'signing-capability-unavailable' }
  const resume = mode === 'deeplink' ? continueDeeplink : continueDesktop
  if (typeof resume !== 'function') throw new TypeError(`Missing ${mode} setup continuation.`)
  const result = await resume(pending.params, pending.signature)
  return { status: 'continued', mode, result }
}

/** Poll while the page is active, skip hidden tabs, prevent overlapping work, and stop cleanly on teardown. */
export function startVisibleReconciliationLoop({
  reconcile,
  isVisible = () => true,
  intervalMs = 5_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof reconcile !== 'function' || typeof isVisible !== 'function'
    || typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function'
    || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new TypeError('Invalid reconciliation loop settings.')
  let stopped = false
  let inFlight = false
  const tick = () => {
    if (stopped || inFlight || !isVisible()) return
    inFlight = true
    Promise.resolve().then(reconcile).catch(() => {}).finally(() => { inFlight = false })
  }
  const timer = setIntervalFn(tick, intervalMs)
  return () => {
    stopped = true
    clearIntervalFn(timer)
  }
}
