export function normalizeSwapFlowDirection(flow) {
  if (flow === 'withdraw-sell') return { inputId: 'svm-usdy', outputId: 'svm-usdc' }
  if (flow === 'acquire-supply') return { inputId: 'svm-usdc', outputId: 'svm-usdy' }
  return null
}

export function flowContextMatches(context, current) {
  return !!context && !!current && context.wallet === current.wallet && context.flow === current.flow
    && context.market === current.market && context.routeFlow === current.routeFlow
    && context.inputId === current.inputId && context.outputId === current.outputId
}

const ACTIVE_LENDING_STATUSES = new Set(['awaiting-signature', 'signed-pending', 'submitted', 'relay-unknown', 'pending', 'setup-confirmed'])

export function pendingFlowMatches(pending, context) {
  const params = pending?.params ?? {}
  const wallet = pending?.wallet ?? params.wallet
  const flow = pending?.flow ?? params.swapFlow
  const stage = pending?.stage ?? params.swapFlowStage
  return !!pending && ACTIVE_LENDING_STATUSES.has(pending.status)
    && wallet === context?.wallet && flow === context?.flow && stage != null
    && pending.market === context?.market && stage === context.stage
}

export function recoverConfirmedWithdrawal(outcome, { wallet, flow, market, requestedBaseUnits } = {}) {
  if (!outcome || outcome.wallet !== wallet || outcome.flow !== flow || outcome.stage !== 'withdraw'
    || outcome.market != null && outcome.market !== market) return null
  if (outcome.status === 'confirmed-amount-unknown') return { status: 'confirmed-amount-unknown', amountBaseUnits: null }
  if (outcome.status !== 'confirmed') return null
  const amount = outcome.amountBaseUnits
  if (typeof amount !== 'string' || !/^\d+$/.test(amount) || BigInt(amount) <= 0n
    || typeof requestedBaseUnits !== 'string' || !/^\d+$/.test(requestedBaseUnits)
    || BigInt(requestedBaseUnits) <= 0n || BigInt(amount) > BigInt(requestedBaseUnits)) {
    return { status: 'confirmed-amount-unknown', amountBaseUnits: null }
  }
  return { status: 'confirmed', amountBaseUnits: amount }
}

export function applySwapFlowOutcome(current, outcome, wallet, flow) {
  if (!outcome || outcome.wallet !== wallet || outcome.flow !== flow
    || outcome.market != null && outcome.market !== 'sol-usdy-usdc') return current
  const expectedDirection = normalizeSwapFlowDirection(flow)
  if (outcome.inputId != null && (outcome.inputId !== expectedDirection?.inputId || outcome.outputId !== expectedDirection?.outputId)) return current
  const next = { ...current }
  const primaryStage = outcome.stage === 'swap' || outcome.stage === 'withdraw'
  const followUpStage = outcome.stage === 'sell' || outcome.stage === 'supply'

  if (primaryStage) {
    if (outcome.status === 'confirmed' || outcome.status === 'confirmed-amount-unknown') {
      next.primaryStatus = outcome.status
      next.primaryAmountBaseUnits = outcome.amountBaseUnits ?? null
      if (outcome.stage === 'withdraw') Object.assign(next, normalizeSwapFlowDirection(flow))
    } else if (['failed', 'rejected'].includes(outcome.status)) {
      next.primaryStatus = outcome.status
      next.primaryAmountBaseUnits = outcome.amountBaseUnits ?? null
    }
    return next
  }

  if (followUpStage) {
    const amount = outcome.primaryAmountBaseUnits ?? (outcome.stage === 'supply' ? outcome.amountBaseUnits : null)
    if (amount != null) {
      next.primaryStatus = 'confirmed'
      next.primaryAmountBaseUnits = amount
    }
    if (outcome.status === 'confirmed') next.followUpStatus = 'confirmed'
    else if (outcome.status === 'declined' || outcome.status === 'rejected') next.followUpStatus = 'declined'
    else if (outcome.status === 'failed') next.followUpStatus = 'failed'
    else if (outcome.status === 'pending' || outcome.status === 'relay-unknown') next.followUpStatus = 'pending'
  }
  return next
}
