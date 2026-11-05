import { LIVE, TOKENS } from '../src/config.js'
import { calculateCarryPct } from '../src/loop-policy.js'

export const LOOP_ALLOWED_MARKET_IDS = Object.freeze(['sol-usdy-usdc'])
const SNAPSHOT_MAX_AGE_MS = 60_000

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const reason = (code, message) => ({ code, message })

function allocationExists(vaults, market, collateral) {
  return Object.values(vaults ?? {}).some((vault) => (vault?.allocations ?? []).some((allocation) =>
    allocation.market === market.kaminoMarket
      && allocation.reserve === collateral.reserve
      && (allocation.collateral ?? []).includes(collateral.token_id)
      && finite(allocation.invested)
      && allocation.invested > 0))
}

function carryStatus(reserves, pair, leverage) {
  const collateral = reserves?.[pair.collateral]
  const liability = reserves?.[pair.liability]
  const supplyAprPct = collateral?.supplyAPR
  const borrowAprPct = liability?.borrowAPR
  if (!finite(supplyAprPct) || !finite(borrowAprPct)) {
    return { estimatedCarryPct: null, collateralSupplyAprPct: finite(supplyAprPct) ? supplyAprPct : null, liabilityBorrowAprPct: finite(borrowAprPct) ? borrowAprPct : null, basedOnLeverage: leverage }
  }
  return {
    estimatedCarryPct: calculateCarryPct({ equity: '1', leverage: String(leverage), collateralYieldPct: String(supplyAprPct), borrowCostPct: String(borrowAprPct) }),
    collateralSupplyAprPct: supplyAprPct,
    liabilityBorrowAprPct: borrowAprPct,
    basedOnLeverage: leverage,
  }
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
  programEvidenceApproved = false,
  feasibilityPassed = false,
  leverage = 1.5,
  now = Date.now(),
} = {}) {
  const unavailableReasons = []
  if (!market || !market.visible) unavailableReasons.push(reason('market-inactive', 'The selected Nysa market is not active.'))
  if (!Array.isArray(allowedMarketIds) || !allowedMarketIds.includes(marketId)) unavailableReasons.push(reason('market-not-allowlisted', 'The selected market is not allowlisted for router or loop entry.'))
  if (market && market.visible && Array.isArray(market.pairs)) {
    const pair = market.pairs.find((candidate) => candidate.collateral === 'svm-usdy' && candidate.liability === 'svm-usdc')
    const collateral = pair ? TOKENS[pair.collateral] : null
    if (!pair || !collateral || !allocationExists(vaults, market, collateral)) {
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
    if (!programEvidenceApproved) unavailableReasons.push(reason('program-evidence-unreviewed', 'Router and DEX program security evidence is not approved.'))
    if (!feasibilityPassed) unavailableReasons.push(reason('atomic-feasibility-unverified', 'Atomic route and flash-loan feasibility has not passed a local mainnet-fork check.'))
    if (pair) {
      const carry = carryStatus(reserves, pair, leverage)
      if (carry.estimatedCarryPct === null) unavailableReasons.push(reason('carry-unavailable', 'Verified supply yield or borrowing cost is unavailable.'))
      return { id: marketId, marketName: market.name, pair, enabled: unavailableReasons.length === 0, unavailableReasons, carry }
    }
  }
  return { id: marketId, marketName: market?.name ?? null, pair: null, enabled: false, unavailableReasons, carry: { estimatedCarryPct: null, collateralSupplyAprPct: null, liabilityBorrowAprPct: null, basedOnLeverage: leverage } }
}
