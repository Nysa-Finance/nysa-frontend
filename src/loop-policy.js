import Decimal from 'decimal.js'

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
export const DEFAULT_LOOP_LIMITS = Object.freeze({
  maxLeverage: 1.5,
  maxBorrowLtvRatio: 0.5,
  liquidationLtvRatio: 0.4,
  maxSlippageBps: 50,
  maxPriceImpactPct: 1,
  maxQuoteAgeSeconds: 15,
})

const finite = (value) => (typeof value === 'number' && Number.isFinite(value))
const decimalText = (value, label) => {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new TypeError(`Invalid ${label}`)
  const result = new D(String(value))
  if (!result.isFinite() || result.isNegative()) throw new TypeError(`Invalid ${label}`)
  return result
}
const compact = (value, places = 12) => value.toDecimalPlaces(places, D.ROUND_HALF_UP).toFixed().replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1')

export function projectedLtvLimitPct(maxBorrowLtvPct, liquidationLtvPct, tighterLimitPct = null) {
  if (!finite(maxBorrowLtvPct) || !finite(liquidationLtvPct) || maxBorrowLtvPct <= 0 || maxBorrowLtvPct > 100 || liquidationLtvPct <= 0 || liquidationLtvPct > 100) {
    throw new TypeError('Invalid market LTV inputs')
  }
  const marketLimit = Math.min(maxBorrowLtvPct * DEFAULT_LOOP_LIMITS.maxBorrowLtvRatio, liquidationLtvPct * DEFAULT_LOOP_LIMITS.liquidationLtvRatio)
  if (tighterLimitPct == null) return marketLimit
  if (!finite(tighterLimitPct) || tighterLimitPct <= 0 || tighterLimitPct > 100) throw new TypeError('Invalid tighter LTV limit')
  return Math.min(marketLimit, tighterLimitPct)
}

export function loopExposure(fundingAmount, targetLeverage) {
  const equity = decimalText(fundingAmount, 'funding amount')
  const leverage = decimalText(targetLeverage, 'leverage')
  if (equity.isZero()) throw new RangeError('Invalid funding amount: must be positive')
  if (leverage.lte(1) || leverage.gt(DEFAULT_LOOP_LIMITS.maxLeverage)) throw new RangeError('Invalid leverage: must be above 1 and at most 1.5')
  const grossCollateral = equity.mul(leverage)
  const debt = grossCollateral.minus(equity)
  const projectedLtv = debt.div(grossCollateral).mul(100)
  return {
    equity: compact(equity),
    grossCollateral: compact(grossCollateral),
    debt: compact(debt),
    leverage: compact(leverage),
    projectedLtvPct: projectedLtv.toDecimalPlaces(38, D.ROUND_HALF_UP).toFixed(),
  }
}

export function riskViolations(input, tighterCaps = {}) {
  const fields = ['leverage', 'projectedLtvPct', 'maxBorrowLtvPct', 'liquidationLtvPct', 'slippageBps', 'priceImpactPct', 'quoteAgeSeconds', 'oracleAgeSeconds', 'oracleHeartbeatSeconds']
  if (!input || fields.some((field) => !finite(input[field]))) return ['missing-risk-input']

  const violations = []
  const leverageCap = Math.min(DEFAULT_LOOP_LIMITS.maxLeverage, tighterCaps.maxLeverage ?? DEFAULT_LOOP_LIMITS.maxLeverage)
  const ltvCap = projectedLtvLimitPct(input.maxBorrowLtvPct, input.liquidationLtvPct, tighterCaps.maxProjectedLtvPct ?? null)
  const slippageCap = Math.min(DEFAULT_LOOP_LIMITS.maxSlippageBps, tighterCaps.maxSlippageBps ?? DEFAULT_LOOP_LIMITS.maxSlippageBps)
  const priceImpactCap = Math.min(DEFAULT_LOOP_LIMITS.maxPriceImpactPct, tighterCaps.maxPriceImpactPct ?? DEFAULT_LOOP_LIMITS.maxPriceImpactPct)
  const quoteAgeCap = Math.min(DEFAULT_LOOP_LIMITS.maxQuoteAgeSeconds, tighterCaps.maxQuoteAgeSeconds ?? DEFAULT_LOOP_LIMITS.maxQuoteAgeSeconds)
  if (![leverageCap, ltvCap, slippageCap, priceImpactCap, quoteAgeCap].every(finite)) return ['missing-risk-input']
  if (input.leverage <= 1 || input.leverage > leverageCap) violations.push('leverage-cap')
  if (input.projectedLtvPct < 0 || input.projectedLtvPct > ltvCap) violations.push('projected-ltv-cap')
  if (input.slippageBps < 0 || input.slippageBps > slippageCap) violations.push('slippage-cap')
  if (input.priceImpactPct < 0 || input.priceImpactPct > priceImpactCap) violations.push('price-impact-cap')
  if (input.quoteAgeSeconds < 0 || input.quoteAgeSeconds > quoteAgeCap) violations.push('stale-quote')
  if (input.oracleHeartbeatSeconds <= 0 || input.oracleAgeSeconds < 0 || input.oracleAgeSeconds > input.oracleHeartbeatSeconds) violations.push('stale-oracle')
  return violations
}

export function calculateCarryPct({ equity, leverage, collateralYieldPct, borrowCostPct, annualizedCosts = '0' }) {
  if (collateralYieldPct == null || borrowCostPct == null) return null
  const initial = decimalText(equity, 'equity')
  const multiple = decimalText(leverage, 'leverage')
  const yieldPct = decimalText(collateralYieldPct, 'collateral yield')
  const borrowPct = decimalText(borrowCostPct, 'borrow cost')
  const costs = decimalText(annualizedCosts, 'annualized costs')
  if (initial.isZero() || multiple.lte(1)) throw new RangeError('Invalid carry inputs')
  const grossCollateral = initial.mul(multiple)
  const debt = grossCollateral.minus(initial)
  const annualNet = grossCollateral.mul(yieldPct).div(100).minus(debt.mul(borrowPct).div(100)).minus(costs)
  return compact(annualNet.div(initial).mul(100), 8)
}

export function carryNeedsAcknowledgement(carryPct) {
  if (carryPct == null) return false
  if ((typeof carryPct !== 'string' && typeof carryPct !== 'number') || String(carryPct).trim() === '') throw new TypeError('Invalid estimated carry')
  const value = new D(String(carryPct))
  if (!value.isFinite()) throw new TypeError('Invalid estimated carry')
  return value.lte(0)
}
