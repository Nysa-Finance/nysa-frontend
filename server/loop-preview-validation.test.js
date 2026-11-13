import assert from 'node:assert/strict'
import {
  loopCarryStillCurrent,
  loopMarketRiskFromSnapshot,
  loopMarketRiskStillCurrent,
} from './loop-preview-validation.js'

const now = Date.parse('2026-11-05T12:00:10.000Z')
const carry = {
  estimatedCarryPct: '-0.75',
  assumptions: { collateralSupplyAprPct: 0.5, liabilityBorrowAprPct: 3, leverage: 1.5 },
  requiresAcknowledgement: true,
  asOf: '2026-11-05T12:00:00.000Z',
}
assert.equal(loopCarryStillCurrent(carry, { ...carry, asOf: '2026-11-05T12:00:05.000Z' }, now), true,
  'metadata refresh may advance the snapshot time while economics remain unchanged and fresh')
assert.equal(loopCarryStillCurrent(carry, { ...carry, asOf: '2026-11-05T12:00:05.000Z', assumptions: { ...carry.assumptions, collateralSupplyAprPct: 0.6 } }, now), false,
  'changed carry source assumptions invalidate the preview')
assert.equal(loopCarryStillCurrent(carry, { ...carry, asOf: '2026-11-05T12:01:11.000Z' }, now), false,
  'a refreshed snapshot beyond the bounded freshness window invalidates the preview')
assert.equal(loopCarryStillCurrent(carry, { ...carry, asOf: '2026-11-05T12:00:11.000Z' }, now), false,
  'a future snapshot timestamp cannot authorize the preview')

const marketRisk = {
  collateralPriceUsd: '1.09', liabilityPriceUsd: '1', maxBorrowLtvPct: 90, liquidationLtvPct: 95,
  collateralOracleTimestamp: 1_798_000_000, liabilityOracleTimestamp: 1_798_000_000,
  collateralOracleHeartbeatSeconds: 60, liabilityOracleHeartbeatSeconds: 60,
}
const marketSnapshot = {
  blockTime: 1_798_000_010,
  reserves: {
    'svm-usdy': { price: 1.09, maxLtv: 90, liqLtv: 95, oracleTs: 1_798_000_000, maxAge: 60 },
    'svm-usdc': { price: 1, maxLtv: 90, liqLtv: 95, oracleTs: 1_798_000_000, maxAge: 60 },
  },
}
const snapshotRisk = loopMarketRiskFromSnapshot(marketSnapshot)
assert.equal(loopMarketRiskStillCurrent(marketRisk, snapshotRisk, marketSnapshot.blockTime), true,
  'fresh snapshot oracle values and governance limits remain bound to the preview')
assert.equal(loopMarketRiskStillCurrent(marketRisk, { ...snapshotRisk, collateralPriceUsd: '1.10' }, marketSnapshot.blockTime), false,
  'changed oracle price invalidates relay authorization')
assert.equal(loopMarketRiskStillCurrent(marketRisk, { ...snapshotRisk, maxBorrowLtvPct: 80 }, marketSnapshot.blockTime), false,
  'changed governance LTV invalidates relay authorization')
assert.equal(loopMarketRiskStillCurrent(marketRisk, { ...snapshotRisk, collateralOracleTimestamp: 1_798_000_000 - 61 }, marketSnapshot.blockTime), false,
  'stale oracle fails the reserve heartbeat check')
assert.equal(loopMarketRiskStillCurrent(marketRisk, { ...snapshotRisk, liabilityOracleTimestamp: 1_798_000_011 }, marketSnapshot.blockTime), false,
  'future oracle timestamps fail closed')

console.log('loop preview freshness and market risk binding ok')
