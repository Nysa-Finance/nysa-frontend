import assert from 'node:assert/strict'
import { calculateCarryPct, carryNeedsAcknowledgement, loopExposure, projectedLtvLimitPct, riskViolations } from './loop-policy.js'

assert.equal(projectedLtvLimitPct(90, 95), 38)
assert.equal(projectedLtvLimitPct(60, 80), 30)
assert.throws(() => projectedLtvLimitPct(0, 95), /LTV/)
assert.throws(() => projectedLtvLimitPct(90, 101), /LTV/)

assert.deepEqual(loopExposure('100', '1.5'), {
  equity: '100', grossCollateral: '150', debt: '50', leverage: '1.5', projectedLtvPct: '33.33333333333333333333333333333333333333',
})
assert.throws(() => loopExposure('0', '1.5'), /funding amount/)
assert.throws(() => loopExposure('100', '1.51'), /leverage/)

assert.deepEqual(riskViolations({
  leverage: 1.5, projectedLtvPct: 33.34, maxBorrowLtvPct: 90, liquidationLtvPct: 95,
  slippageBps: 50, priceImpactPct: 1, quoteAgeSeconds: 15, oracleAgeSeconds: 30, oracleHeartbeatSeconds: 30,
}), [])
assert.deepEqual(riskViolations({
  leverage: 1.6, projectedLtvPct: 39, maxBorrowLtvPct: 90, liquidationLtvPct: 95,
  slippageBps: 51, priceImpactPct: 1.1, quoteAgeSeconds: 16, oracleAgeSeconds: 31, oracleHeartbeatSeconds: 30,
}), ['leverage-cap', 'projected-ltv-cap', 'slippage-cap', 'price-impact-cap', 'stale-quote', 'stale-oracle'])
assert.ok(riskViolations({ leverage: 1.2 }).includes('missing-risk-input'))

assert.equal(calculateCarryPct({ equity: '100', leverage: '1.5', collateralYieldPct: '5', borrowCostPct: '4', annualizedCosts: '0.1' }), '5.4')
assert.equal(calculateCarryPct({ equity: '100', leverage: '1.5', collateralYieldPct: null, borrowCostPct: '4' }), null)
assert.equal(carryNeedsAcknowledgement('0'), true)
assert.equal(carryNeedsAcknowledgement('-0.01'), true)
assert.equal(carryNeedsAcknowledgement('0.01'), false)
assert.equal(carryNeedsAcknowledgement(null), false) // unknown carry is unavailable, not an acknowledgement state

console.log('loop-policy ok')
