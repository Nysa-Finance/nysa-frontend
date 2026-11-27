import Decimal from 'decimal.js'
import { loopByMarket } from '../src/config.js'

export const LOOP_PREVIEW_MAX_AGE_MS = 150_000 // a preview lives 90s, and its snapshot may be older than the preview

const decimal = (value) => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null
  try {
    const parsed = new Decimal(String(value))
    return parsed.isFinite() ? parsed : null
  } catch {
    return null
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  )
}

function carryTimestamp(value) {
  if (typeof value !== 'string' || !value) return NaN
  return Date.parse(value)
}

// Rates move with every snapshot (the USDC borrow APR follows utilization), so the carry survives a refresh while its
// sources stay the same, it moves by at most 0.25 percentage points, its acknowledgement need is unchanged and both
// reads stay fresh.
const RATE_FIELDS = ['collateralSupplyAprPct', 'collateralNativeApyPct', 'liabilityBorrowAprPct']
const sources = (assumptions) =>
  assumptions && Object.fromEntries(Object.entries(assumptions).filter(([key]) => !RATE_FIELDS.includes(key)))
export function loopCarryStillCurrent(previewCarry, currentCarry, now = Date.now()) {
  if (!previewCarry || !currentCarry || !Number.isFinite(now)) return false
  const previewPct = decimal(previewCarry.estimatedCarryPct),
    currentPct = decimal(currentCarry.estimatedCarryPct)
  if (
    JSON.stringify(canonical(sources(previewCarry.assumptions ?? null))) !==
      JSON.stringify(canonical(sources(currentCarry.assumptions ?? null))) ||
    !previewPct ||
    !currentPct ||
    previewPct.minus(currentPct).abs().gt(0.25) ||
    (previewCarry.requiresAcknowledgement === true) !== (currentCarry.requiresAcknowledgement === true)
  )
    return false
  const previewAt = carryTimestamp(previewCarry.asOf)
  const currentAt = carryTimestamp(currentCarry.asOf)
  return (
    Number.isFinite(previewAt) &&
    Number.isFinite(currentAt) &&
    previewAt > 0 &&
    currentAt >= previewAt &&
    previewAt <= now &&
    currentAt <= now &&
    now - previewAt <= LOOP_PREVIEW_MAX_AGE_MS &&
    now - currentAt <= LOOP_PREVIEW_MAX_AGE_MS
  )
}

export function loopMarketRiskFromSnapshot(snapshot, marketId) {
  const loop = loopByMarket(marketId)
  const collateral = snapshot?.reserves?.[marketId]?.[loop?.collateral]
  const liability = snapshot?.reserves?.[marketId]?.[loop?.debt]
  if (!collateral || !liability) return null
  return {
    collateralPriceUsd: collateral.price,
    liabilityPriceUsd: liability.price,
    maxBorrowLtvPct: collateral.maxLtv,
    liquidationLtvPct: collateral.liqLtv,
    collateralOracleTimestamp: collateral.oracleTs,
    liabilityOracleTimestamp: liability.oracleTs,
    collateralOracleHeartbeatSeconds: collateral.maxAge,
    liabilityOracleHeartbeatSeconds: liability.maxAge,
  }
}

function validOracle(timestamp, heartbeat, nowSeconds) {
  const ts = decimal(timestamp)
  const age = decimal(heartbeat)
  return (
    !!ts &&
    !!age &&
    age.gt(0) &&
    Number.isFinite(nowSeconds) &&
    ts.lte(nowSeconds) &&
    new Decimal(nowSeconds).minus(ts).lte(age)
  )
}

// Both live reserve oracles must be inside their heartbeats.
export function loopMarketRiskStillCurrent(previewRisk, currentRisk, nowSeconds) {
  if (!previewRisk || !currentRisk || !Number.isFinite(nowSeconds)) return false
  const identityFields = [
    'collateralPriceUsd',
    'liabilityPriceUsd',
    'maxBorrowLtvPct',
    'liquidationLtvPct',
    'collateralOracleHeartbeatSeconds',
    'liabilityOracleHeartbeatSeconds',
  ]
  for (const field of identityFields) {
    const previewValue = decimal(previewRisk[field])
    const currentValue = decimal(currentRisk[field])
    if (!previewValue || !currentValue) return false
    if (field.endsWith('PriceUsd')) {
      // Oracles update every ~30s, so a preview rarely meets an identical price at build. Up to 0.1% is accepted: the
      // build rechecks LTV, slippage and the swap's minimum output against current prices anyway.
      if (previewValue.minus(currentValue).abs().gt(previewValue.abs().mul(0.001))) return false
    } else if (!previewValue.eq(currentValue)) return false
  }
  if (!decimal(currentRisk.collateralPriceUsd)?.gt(0) || !decimal(currentRisk.liabilityPriceUsd)?.gt(0)) return false
  if (
    !decimal(currentRisk.maxBorrowLtvPct)?.gt(0) ||
    !decimal(currentRisk.liquidationLtvPct)?.gt(0) ||
    !decimal(currentRisk.maxBorrowLtvPct)?.lte(100) ||
    !decimal(currentRisk.liquidationLtvPct)?.lte(100)
  )
    return false
  return (
    validOracle(currentRisk.collateralOracleTimestamp, currentRisk.collateralOracleHeartbeatSeconds, nowSeconds) &&
    validOracle(currentRisk.liabilityOracleTimestamp, currentRisk.liabilityOracleHeartbeatSeconds, nowSeconds)
  )
}
