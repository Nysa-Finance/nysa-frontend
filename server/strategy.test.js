import assert from 'node:assert/strict'
import { TOKENS } from '../src/config.js'
import { evaluateLoopStrategy } from './strategy.js'

const now = Date.parse('2026-11-05T12:00:00.000Z')
const market = {
  id: 'sol-usdy-usdc', visible: true, kaminoMarket: 'market-address',
  pairs: [{ collateral: 'svm-usdy', liability: 'svm-usdc' }],
}
const vaults = {
  rwa: { allocations: [{ market: 'market-address', reserve: TOKENS['svm-usdc'].reserve, collateral: ['svm-usdy'], invested: 100 }] },
}
const reserves = {
  'svm-usdy': { price: 1.1, supplyAPR: 4.5, oracleTs: now / 1000, maxAge: 60 },
  'svm-usdc': { price: 1, borrowAPR: 3, oracleTs: now / 1000, maxAge: 60 },
}
const ready = {
  market,
  allowedMarketIds: ['sol-usdy-usdc'],
  vaults,
  reserves,
  snapshotUpdatedAt: now,
  providerConfigured: true,
  productionProviderConfigured: true,
  treasuryConfigured: true,
  riskApproval: { owner: 'Risk owner', approvedAt: '2026-11-05T00:00:00.000Z' },
  programEvidenceApproved: true,
  feasibilityPassed: true,
  now,
}

const enabled = evaluateLoopStrategy(ready)
assert.ok(enabled && typeof enabled === 'object', 'strategy evaluation returns status')
assert.equal(enabled.enabled, true)
assert.equal(enabled.id, 'sol-usdy-usdc')
assert.deepEqual(enabled.unavailableReasons, [])
assert.equal(enabled.carry.estimatedCarryPct, '5.25')

const selectedLeverage = evaluateLoopStrategy({ ...ready, leverage: 1.2 })
assert.equal(selectedLeverage.carry.estimatedCarryPct, '4.8')
assert.equal(selectedLeverage.carry.basedOnLeverage, 1.2)
assert.equal(selectedLeverage.carry.asOf, '2026-11-05T12:00:00.000Z')
assert.deepEqual(selectedLeverage.carry.assumptions, {
  collateralYieldSource: 'Kamino reserve supply APR',
  liabilityBorrowSource: 'Kamino reserve borrow APR',
  collateralSupplyAprPct: 4.5,
  liabilityBorrowAprPct: 3,
  leverage: 1.2,
})
assert.equal(selectedLeverage.carry.requiresAcknowledgement, false)

const negativeCarry = evaluateLoopStrategy({
  ...ready,
  reserves: { ...reserves, 'svm-usdy': { ...reserves['svm-usdy'], supplyAPR: 0.5 } },
})
assert.equal(negativeCarry.carry.estimatedCarryPct, '-0.75')
assert.equal(negativeCarry.carry.requiresAcknowledgement, true)
assert.equal(negativeCarry.carry.acknowledgementKey, null) // no key until this carry estimate is bound to final routes and costs.
assert.ok(negativeCarry.unavailableReasons.some((x) => x.code === 'carry-acknowledgement-required'))

const allocationMissing = evaluateLoopStrategy({ ...ready, vaults: { rwa: { allocations: [] } } })
assert.ok(allocationMissing.unavailableReasons.some((x) => x.code === 'no-actual-allocation'))
const collateralReserveOnly = evaluateLoopStrategy({ ...ready, vaults: { rwa: { allocations: [{ ...vaults.rwa.allocations[0], reserve: TOKENS['svm-usdy'].reserve }] } } })
assert.ok(collateralReserveOnly.unavailableReasons.some((x) => x.code === 'no-actual-allocation'))

const inactive = evaluateLoopStrategy({ ...ready, market: { ...market, visible: false } })
assert.ok(inactive.unavailableReasons.some((x) => x.code === 'market-inactive'))

const notAllowed = evaluateLoopStrategy({ ...ready, allowedMarketIds: [] })
assert.ok(notAllowed.unavailableReasons.some((x) => x.code === 'market-not-allowlisted'))

const missingProvider = evaluateLoopStrategy({ ...ready, providerConfigured: false, treasuryConfigured: false })
assert.ok(missingProvider.unavailableReasons.some((x) => x.code === 'provider-not-configured'))
assert.ok(missingProvider.unavailableReasons.some((x) => x.code === 'fee-destination-not-configured'))

const keylessPrototype = evaluateLoopStrategy({ ...ready, productionProviderConfigured: false })
assert.ok(keylessPrototype.unavailableReasons.some((x) => x.code === 'production-provider-key-missing'))

const riskOwnerMissing = evaluateLoopStrategy({ ...ready, riskApproval: null })
assert.ok(riskOwnerMissing.unavailableReasons.some((x) => x.code === 'risk-approval-missing'))

const programNotApproved = evaluateLoopStrategy({ ...ready, programEvidenceApproved: false })
assert.ok(programNotApproved.unavailableReasons.some((x) => x.code === 'program-evidence-unreviewed'))

const noForkProof = evaluateLoopStrategy({ ...ready, feasibilityPassed: false })
assert.ok(noForkProof.unavailableReasons.some((x) => x.code === 'atomic-feasibility-unverified'))

const stale = evaluateLoopStrategy({ ...ready, snapshotUpdatedAt: now - 61_000 })
assert.ok(stale.unavailableReasons.some((x) => x.code === 'market-data-stale'))

const unknownCarry = evaluateLoopStrategy({ ...ready, reserves: { ...reserves, 'svm-usdy': { ...reserves['svm-usdy'], supplyAPR: null } } })
assert.ok(unknownCarry.unavailableReasons.some((x) => x.code === 'carry-unavailable'))
assert.equal(unknownCarry.carry.estimatedCarryPct, null)

console.log('strategy ok')
