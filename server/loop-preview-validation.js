import Decimal from 'decimal.js'
import { TOKENS } from '../src/config.js'

export const LOOP_PREVIEW_MAX_AGE_MS = 60_000

const decimal = (value) => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null
  try {
    const parsed = new Decimal(String(value))
    return parsed.isFinite() ? parsed : null
  } catch { return null }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function carryTimestamp(value) {
  if (typeof value !== 'string' || !value) return NaN
  return Date.parse(value)
}

/** Carry survives snapshot refreshes only while its economics/source identity stay equal and both reads stay fresh. */
export function loopCarryStillCurrent(previewCarry, currentCarry, now = Date.now()) {
  if (!previewCarry || !currentCarry || !Number.isFinite(now)) return false
  if (JSON.stringify(canonical(previewCarry.assumptions ?? null)) !== JSON.stringify(canonical(currentCarry.assumptions ?? null))
    || previewCarry.estimatedCarryPct !== currentCarry.estimatedCarryPct
    || (previewCarry.requiresAcknowledgement === true) !== (currentCarry.requiresAcknowledgement === true)) return false
  const previewAt = carryTimestamp(previewCarry.asOf)
  const currentAt = carryTimestamp(currentCarry.asOf)
  return Number.isFinite(previewAt) && Number.isFinite(currentAt)
    && previewAt > 0 && currentAt >= previewAt
    && previewAt <= now && currentAt <= now
    && now - previewAt <= LOOP_PREVIEW_MAX_AGE_MS
    && now - currentAt <= LOOP_PREVIEW_MAX_AGE_MS
}

/** Read the two loop reserves' current oracle and governance assumptions from the published market snapshot. */
export function loopMarketRiskFromSnapshot(snapshot) {
  const collateral = snapshot?.reserves?.[TOKENS['svm-usdy'].token_id]
  const liability = snapshot?.reserves?.[TOKENS['svm-usdc'].token_id]
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
  return !!ts && !!age && age.gt(0) && Number.isFinite(nowSeconds)
    && ts.lte(nowSeconds) && new Decimal(nowSeconds).minus(ts).lte(age)
}

/** Compare route-price/risk assumptions and require both live reserve oracles to be inside their heartbeats. */
export function loopMarketRiskStillCurrent(previewRisk, currentRisk, nowSeconds) {
  if (!previewRisk || !currentRisk || !Number.isFinite(nowSeconds)) return false
  const identityFields = [
    'collateralPriceUsd', 'liabilityPriceUsd', 'maxBorrowLtvPct', 'liquidationLtvPct',
    'collateralOracleHeartbeatSeconds', 'liabilityOracleHeartbeatSeconds',
  ]
  for (const field of identityFields) {
    const previewValue = decimal(previewRisk[field])
    const currentValue = decimal(currentRisk[field])
    if (!previewValue || !currentValue) return false
    if (field.endsWith('PriceUsd')) {
      const tolerance = Math.max(1, Math.abs(previewValue.toNumber()), Math.abs(currentValue.toNumber())) * Number.EPSILON * 4
      if (previewValue.minus(currentValue).abs().gt(tolerance)) return false
    } else if (!previewValue.eq(currentValue)) return false
  }
  if (!decimal(currentRisk.collateralPriceUsd)?.gt(0) || !decimal(currentRisk.liabilityPriceUsd)?.gt(0)) return false
  if (!decimal(currentRisk.maxBorrowLtvPct)?.gt(0) || !decimal(currentRisk.liquidationLtvPct)?.gt(0)
    || !decimal(currentRisk.maxBorrowLtvPct)?.lte(100) || !decimal(currentRisk.liquidationLtvPct)?.lte(100)) return false
  return validOracle(currentRisk.collateralOracleTimestamp, currentRisk.collateralOracleHeartbeatSeconds, nowSeconds)
    && validOracle(currentRisk.liabilityOracleTimestamp, currentRisk.liabilityOracleHeartbeatSeconds, nowSeconds)
}
