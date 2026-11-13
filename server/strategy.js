import { LIVE, TOKENS } from '../src/config.js'
import { calculateCarryPct, carryNeedsAcknowledgement } from '../src/loop-policy.js'

export const LOOP_ALLOWED_MARKET_IDS = Object.freeze(['sol-usdy-usdc'])
// Keep reading configured Multiply PDAs even if entry allowlisting or allocation changes, so full-close management
// can still identify existing Nysa positions.
export const LOOP_POSITION_MARKET_IDS = Object.freeze(['sol-usdy-usdc'])
export const LOOP_ACK_POLICY_VERSION = 'nysa-loop-ack-v1'
const SNAPSHOT_MAX_AGE_MS = 60_000

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const reason = (code, message) => ({ code, message })
const marketIsActive = (market) => !!market && market.visible !== false && LIVE.some((candidate) => candidate.id === market.id)

/** Shared fail-closed action policy. Full close does not inherit entry-only allocation, carry or risk-approval gates. */
export function evaluateLoopActionReadiness({
  action,
  strategy = null,
  routeReadiness = null,
  positionId = null,
  positionVerified = false,
  builderAvailable = false,
  previewAcknowledgementValid = false,
} = {}) {
  const unavailableReasons = []
  if (!['loop-open', 'loop-close'].includes(action)) {
    unavailableReasons.push(reason('unsupported-loop-action', 'This loop action is not supported.'))
    return { executionEnabled: false, unavailableReasons }
  }
  if (!routeReadiness?.executionEnabled) {
    const routeReasons = routeReadiness?.unavailableReasons
    unavailableReasons.push(...(Array.isArray(routeReasons) && routeReasons.length
      ? routeReasons
      : [reason('route-readiness-unavailable', 'Swap route readiness is unavailable.')]))
  }
  if (action === 'loop-open') {
    const strategyReasons = Array.isArray(strategy?.unavailableReasons) ? strategy.unavailableReasons : []
    const acceptedReasons = strategy?.carry?.requiresAcknowledgement && previewAcknowledgementValid
      ? strategyReasons.filter((item) => item?.code !== 'carry-acknowledgement-required')
      : strategyReasons
    if (!strategy?.enabled && acceptedReasons.length) unavailableReasons.push(...acceptedReasons)
    else if (!strategy?.enabled && strategyReasons.length === 0) unavailableReasons.push(reason('loop-entry-unavailable', 'The selected loop strategy is not available for new entry.'))
    if (strategy?.carry?.requiresAcknowledgement && !previewAcknowledgementValid) {
      unavailableReasons.push(reason('preview-acknowledgement-invalid', 'A current acknowledgement for this exact loop preview is required.'))
    }
  } else {
    if (typeof positionId !== 'string' || !/^multiply:[a-f0-9]{64}$/.test(positionId)) {
      unavailableReasons.push(reason('loop-position-identity-required', 'Select an identified Nysa Multiply position to close.'))
    } else if (!positionVerified) {
      unavailableReasons.push(reason('loop-position-owner-unverified', 'The selected Multiply position has not been verified for this wallet and market.'))
    }
  }
  if (!builderAvailable) unavailableReasons.push(reason('atomic-loop-builder-unavailable', 'Atomic loop transaction building is not enabled until its route and fork evidence pass.'))
  return { executionEnabled: unavailableReasons.length === 0, unavailableReasons }
}

function allocationExists(vaults, market, collateral, liability) {
  return Object.values(vaults ?? {}).some((vault) => (vault?.allocations ?? []).some((allocation) =>
    allocation.market === market.kaminoMarket
      // Nysa's vault is USDC-denominated, so its actual allocation points at the market's USDC reserve.
      // The allocation's collateral list establishes that this loan reserve serves the USDY collateral pair.
      && allocation.reserve === liability.reserve
      && (allocation.collateral ?? []).includes(collateral.token_id)
      && finite(allocation.invested)
      && allocation.invested > 0))
}

function carryStatus(reserves, pair, leverage, marketId, snapshotUpdatedAt) {
  const collateral = reserves?.[pair.collateral]
  const liability = reserves?.[pair.liability]
  const supplyAprPct = collateral?.supplyAPR
  const borrowAprPct = liability?.borrowAPR
  const asOf = finite(snapshotUpdatedAt) && snapshotUpdatedAt > 0 ? new Date(snapshotUpdatedAt).toISOString() : null
  const assumptions = {
    collateralYieldSource: 'Kamino reserve supply APR',
    liabilityBorrowSource: 'Kamino reserve borrow APR',
    collateralSupplyAprPct: finite(supplyAprPct) ? supplyAprPct : null,
    liabilityBorrowAprPct: finite(borrowAprPct) ? borrowAprPct : null,
    leverage,
  }
  const finish = (estimatedCarryPct) => {
    const requiresAcknowledgement = carryNeedsAcknowledgement(estimatedCarryPct)
    return {
      estimatedCarryPct,
      collateralSupplyAprPct: finite(supplyAprPct) ? supplyAprPct : null,
      liabilityBorrowAprPct: finite(borrowAprPct) ? borrowAprPct : null,
      basedOnLeverage: leverage,
      asOf,
      assumptions,
      requiresAcknowledgement,
      // Bound only after provider routes and final SDK economics are available in the preview.
      acknowledgementKey: null,
    }
  }
  if (!finite(supplyAprPct) || !finite(borrowAprPct)) {
    return finish(null)
  }
  return finish(calculateCarryPct({ equity: '1', leverage: String(leverage), collateralYieldPct: String(supplyAprPct), borrowCostPct: String(borrowAprPct) }))
}

export function evaluateLoopStrategy({
  marketId = 'sol-usdy-usdc',
  market = LIVE.find((candidate) => candidate.id === marketId),
  allowedMarketIds = LOOP_ALLOWED_MARKET_IDS,
  vaults = {},
  reserves = {},
  snapshotUpdatedAt = 0,
  providerConfigured = false,
  productionProviderConfigured = false,
  treasuryConfigured = false,
  riskApproval = null,
  feasibilityPassed = false,
  leverage = 1.5,
  now = Date.now(),
} = {}) {
  const unavailableReasons = []
  const active = marketIsActive(market)
  if (!active) unavailableReasons.push(reason('market-inactive', 'The selected Nysa market is not active.'))
  if (!Array.isArray(allowedMarketIds) || !allowedMarketIds.includes(marketId)) unavailableReasons.push(reason('market-not-allowlisted', 'The selected market is not allowlisted for router or loop entry.'))
  if (active && Array.isArray(market.pairs)) {
    const pair = market.pairs.find((candidate) => candidate.collateral === 'svm-usdy' && candidate.liability === 'svm-usdc')
    const collateral = pair ? TOKENS[pair.collateral] : null
    const liability = pair ? TOKENS[pair.liability] : null
    if (!pair || !collateral || !liability || !allocationExists(vaults, market, collateral, liability)) {
      unavailableReasons.push(reason('no-actual-allocation', 'No configured Nysa vault has a nonzero actual allocation to USDY collateral in this market.'))
    }
    if (!finite(snapshotUpdatedAt) || snapshotUpdatedAt <= 0 || now - snapshotUpdatedAt > SNAPSHOT_MAX_AGE_MS) {
      unavailableReasons.push(reason('market-data-stale', 'Fresh market data is unavailable.'))
    }
    if (!providerConfigured) unavailableReasons.push(reason('provider-not-configured', 'A server-side swap provider is not configured.'))
    if (!productionProviderConfigured) unavailableReasons.push(reason('production-provider-key-missing', 'Production Jupiter API credentials and rate limits are not configured; keyless preview access is limited to 0.5 requests per second.'))
    if (!treasuryConfigured) unavailableReasons.push(reason('fee-destination-not-configured', 'The Nysa fee destination is not configured.'))
    const approvalAt = Date.parse(riskApproval?.approvedAt ?? '')
    if (typeof riskApproval?.owner !== 'string' || !riskApproval.owner.trim() || !Number.isFinite(approvalAt) || approvalAt > now) {
      unavailableReasons.push(reason('risk-approval-missing', 'A named Nysa risk owner has not approved this market.'))
    }
    if (!feasibilityPassed) unavailableReasons.push(reason('atomic-feasibility-unverified', 'Atomic route and flash-loan feasibility has not passed a local mainnet-fork check.'))
    if (pair) {
      const carry = carryStatus(reserves, pair, leverage, marketId, snapshotUpdatedAt)
      if (carry.estimatedCarryPct === null) unavailableReasons.push(reason('carry-unavailable', 'Verified supply yield or borrowing cost is unavailable.'))
      else if (carry.requiresAcknowledgement) unavailableReasons.push(reason('carry-acknowledgement-required', 'The current non-positive carry estimate requires acknowledgement before loop entry.'))
      return { id: marketId, marketName: market.name, pair, enabled: unavailableReasons.length === 0, unavailableReasons, carry }
    }
  }
  return { id: marketId, marketName: market?.name ?? null, pair: null, enabled: false, unavailableReasons, carry: { estimatedCarryPct: null, collateralSupplyAprPct: null, liabilityBorrowAprPct: null, basedOnLeverage: leverage } }
}
