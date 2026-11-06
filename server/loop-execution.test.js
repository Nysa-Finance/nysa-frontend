import assert from 'node:assert/strict'
import { createLoopExecutionService, LoopExecutionError } from './loop-execution.js'
import { loopCarryStillCurrent, loopMarketRiskStillCurrent } from './loop-preview-validation.js'

const wallet = '11111111111111111111111111111111'
const positionId = `multiply:${'a'.repeat(64)}`
const messageBytes = Uint8Array.from([7, 8, 9])
const preview = {
  id: 'preview-1', wallet, marketId: 'sol-usdy-usdc', fundingAmount: '100', leverage: 1.5,
  available: true, expiresAt: 10_000,
  carry: { requiresAcknowledgement: true, acknowledgementKey: 'a'.repeat(64) },
}
const position = {
  id: positionId, wallet, market: { id: 'sol-usdy-usdc' },
  obligation: { address: 'Multiply1111111111111111111111111111111111', type: 'multiply' },
}

function fixture(overrides = {}) {
  const calls = { open: 0, close: 0, setup: 0, compile: 0, simulate: 0, send: 0 }
  const options = {
    now: () => 1_000,
    readiness: async () => ({ executionEnabled: true, unavailableReasons: [] }),
    metadataReady: async () => true,
    setupRequired: async () => true,
    getPreview: async () => preview,
    getPosition: async () => position,
    buildOpen: async () => { calls.open++; return { atomic: true, instructions: [{ kind: 'one-atomic-open' }], lookupTables: [] } },
    buildClose: async () => { calls.close++; return { atomic: true, instructions: [{ kind: 'one-atomic-close' }], lookupTables: [] } },
    buildSetup: async () => { calls.setup++; return { atomic: true, kind: 'loop-setup', instructions: [{ kind: 'metadata-only-setup' }], lookupTables: [], expiresAt: Date.now() + 10_000 } },
    compile: async () => { calls.compile++; return { tx: 'unsigned', messageBytes, size: 50, minContextSlot: 1 } },
    simulate: async () => { calls.simulate++; return { ok: true, remainingDebtBaseUnits: '0' } },
    verifySimulation: async () => true,
    decodeMessage: async (tx) => tx === 'signed' ? messageBytes : Uint8Array.from([1, 2, 3]),
    send: async ({ tx, wallet: owner }) => { calls.send++; return { signature: 'sig', tx, wallet: owner } },
    authorize: async () => true,
    authorizeSetup: async () => true,
  }
  return { service: createLoopExecutionService({ ...options, ...overrides }), calls }
}

const unavailable = fixture({ readiness: async () => ({
  executionEnabled: false, unavailableReasons: [{ code: 'route-unverified', message: 'Route evidence is missing.' }],
}) })
await assert.rejects(unavailable.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: preview.id,
  acknowledgementKey: preview.carry.acknowledgementKey,
}), (error) => error instanceof LoopExecutionError && error.status === 503 && error.unavailableReasons[0].code === 'route-unverified')
assert.equal(unavailable.calls.open, 0, 'closed upstream gates refuse before any economic builder runs')
assert.equal(unavailable.calls.compile, 0, 'closed upstream gates refuse before compiling a wallet transaction')

const metadataMissing = fixture({ metadataReady: async () => false })
await assert.rejects(metadataMissing.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: preview.id,
  acknowledgementKey: preview.carry.acknowledgementKey,
}), (error) => error instanceof LoopExecutionError && error.status === 503
  && error.unavailableReasons[0].code === 'kamino-metadata-setup-required')
assert.equal(metadataMissing.calls.open, 0, 'open cannot be authorized until the independent metadata setup is verified')

const setup = fixture({ readiness: async () => assert.fail('non-economic setup is independent of swap and entry readiness') })
const setupBuilt = await setup.service.build({ kind: 'loop-setup', wallet, market: 'sol-usdy-usdc' })
assert.equal(setupBuilt.kind, 'loop-setup')
assert.equal(setup.calls.setup, 1)
assert.equal(setup.calls.open, 0)
assert.equal((await setup.service.send({ tx: 'signed', wallet, intentId: setupBuilt.intentId })).signature, 'sig')
assert.equal(setup.calls.send, 1, 'the metadata-only setup has its own exact-message intent and relay authorization')

const noAcknowledgement = fixture()
await assert.rejects(noAcknowledgement.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: preview.id,
}), /acknowledgement/i)
assert.equal(noAcknowledgement.calls.open, 0, 'missing preview acknowledgement never reaches the open builder')

const open = fixture()
const openBuilt = await open.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: preview.id,
  acknowledgementKey: preview.carry.acknowledgementKey,
})
assert.equal(openBuilt.tx, 'unsigned')
assert.equal(typeof openBuilt.intentId, 'string')
assert.equal(open.calls.open, 1)
assert.equal(open.calls.compile, 1, 'the open compiles one atomic transaction')
assert.equal(open.calls.simulate, 1)

await assert.rejects(open.service.send({ tx: 'altered', wallet, intentId: openBuilt.intentId }), /transaction changed/i)
assert.equal(open.calls.send, 0, 'altered signed message cannot reach the relay')
const sentOpen = await open.service.send({ tx: 'signed', wallet, intentId: openBuilt.intentId })
assert.equal(sentOpen.signature, 'sig')
assert.equal(open.calls.send, 1)

const carryAsOf = new Date(Date.now() - 1_000).toISOString()
const carryPreview = { ...preview, carry: {
  estimatedCarryPct: '-0.75', requiresAcknowledgement: true, acknowledgementKey: 'a'.repeat(64), asOf: carryAsOf,
  assumptions: { collateralYieldSource: 'Kamino reserve supply APR', liabilityBorrowSource: 'Kamino reserve borrow APR',
    collateralSupplyAprPct: 0.5, liabilityBorrowAprPct: 3, leverage: 1.5 },
} }
let metadataRefreshCount = 0
let currentCarry = carryPreview.carry
const metadataRefresh = fixture({
  getPreview: async () => carryPreview,
  metadataReady: async () => {
    metadataRefreshCount++
    currentCarry = { ...currentCarry, asOf: new Date(Date.now()).toISOString() }
    return true
  },
  readiness: async () => loopCarryStillCurrent(carryPreview.carry, currentCarry)
    ? ({ executionEnabled: true, unavailableReasons: [] })
    : ({ executionEnabled: false, unavailableReasons: [{ code: 'loop-preview-stale', message: 'Loop carry assumptions changed.' }] }),
})
const metadataRefreshBuilt = await metadataRefresh.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: carryPreview.id,
  acknowledgementKey: carryPreview.carry.acknowledgementKey,
})
assert.equal(metadataRefresh.calls.open, 1, 'metadata snapshot refresh with unchanged carry economics does not stale the preview before build')
assert.equal((await metadataRefresh.service.send({ tx: 'signed', wallet, intentId: metadataRefreshBuilt.intentId })).signature, 'sig',
  'the built preview remains relayable after a second fresh metadata snapshot timestamp')
let relayCurrentCarry = carryPreview.carry
const changedCarryRelay = fixture({
  getPreview: async () => carryPreview,
  metadataReady: async () => true,
  readiness: async () => loopCarryStillCurrent(carryPreview.carry, relayCurrentCarry)
    ? ({ executionEnabled: true, unavailableReasons: [] })
    : ({ executionEnabled: false, unavailableReasons: [{ code: 'loop-preview-stale', message: 'Loop carry assumptions changed.' }] }),
})
const changedCarryBuilt = await changedCarryRelay.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: carryPreview.id,
  acknowledgementKey: carryPreview.carry.acknowledgementKey,
})
relayCurrentCarry = { ...relayCurrentCarry, assumptions: { ...relayCurrentCarry.assumptions, collateralSupplyAprPct: 0.6 } }
await assert.rejects(changedCarryRelay.service.send({ tx: 'signed', wallet, intentId: changedCarryBuilt.intentId }), /carry assumptions changed/i,
  'changed carry APR remains blocked at relay even though metadata refresh timestamps are tolerated')

const boundRisk = {
  collateralPriceUsd: '1.09', liabilityPriceUsd: '1', maxBorrowLtvPct: 90, liquidationLtvPct: 95,
  collateralOracleTimestamp: 990, liabilityOracleTimestamp: 990,
  collateralOracleHeartbeatSeconds: 60, liabilityOracleHeartbeatSeconds: 60,
}
const riskPreview = { ...carryPreview, sdk: { marketRisk: boundRisk } }
let relayRisk = { ...boundRisk }
let currentBlockTime = 1_000
const changedRiskRelay = fixture({
  getPreview: async () => riskPreview,
  readiness: async () => loopMarketRiskStillCurrent(riskPreview.sdk.marketRisk, relayRisk, currentBlockTime)
    ? ({ executionEnabled: true, unavailableReasons: [] })
    : ({ executionEnabled: false, unavailableReasons: [{ code: 'loop-preview-stale', message: 'Loop oracle or risk assumptions changed.' }] }),
})
const changedRiskBuilt = await changedRiskRelay.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: riskPreview.id,
  acknowledgementKey: riskPreview.carry.acknowledgementKey,
})
currentBlockTime = 1_005 // A fresh metadata/read snapshot may advance time without changing assumptions.
assert.equal((await changedRiskRelay.service.send({ tx: 'signed', wallet, intentId: changedRiskBuilt.intentId })).signature, 'sig')
const mutatedRiskRelay = fixture({
  getPreview: async () => riskPreview,
  readiness: async () => loopMarketRiskStillCurrent(riskPreview.sdk.marketRisk, relayRisk, currentBlockTime)
    ? ({ executionEnabled: true, unavailableReasons: [] })
    : ({ executionEnabled: false, unavailableReasons: [{ code: 'loop-preview-stale', message: 'Loop oracle or risk assumptions changed.' }] }),
})
const mutatedRiskBuilt = await mutatedRiskRelay.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: riskPreview.id,
  acknowledgementKey: riskPreview.carry.acknowledgementKey,
})
relayRisk = { ...relayRisk, collateralPriceUsd: '1.10' }
await assert.rejects(mutatedRiskRelay.service.send({ tx: 'signed', wallet, intentId: mutatedRiskBuilt.intentId }), /oracle or risk assumptions changed/i,
  'changed oracle price blocks relay even when unsigned token quantities remain unchanged')

const foreignClose = fixture({ getPosition: async () => ({ ...position, wallet: 'Vote111111111111111111111111111111111111111' }) })
await assert.rejects(foreignClose.service.build({ kind: 'loop-close', wallet, market: 'sol-usdy-usdc', positionId }), /owned/i)
assert.equal(foreignClose.calls.close, 0, 'foreign obligation ownership is rejected before close building')

const debtRemains = fixture({ simulate: async () => ({ ok: true, remainingDebtBaseUnits: '1' }) })
await assert.rejects(debtRemains.service.build({ kind: 'loop-close', wallet, market: 'sol-usdy-usdc', positionId }), /zero remaining debt/i)
assert.equal(debtRemains.calls.compile, 1)
assert.equal(debtRemains.calls.send, 0)

const composedFeeUnverified = fixture({ verifySimulation: async () => false })
await assert.rejects(composedFeeUnverified.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: preview.id,
  acknowledgementKey: preview.carry.acknowledgementKey,
}), /effects are not fully verified/i, 'a candidate route cannot receive an intent until the final composed simulation verifies fees')
assert.equal(composedFeeUnverified.calls.open, 1)
assert.equal(composedFeeUnverified.calls.simulate, 1)
assert.equal(composedFeeUnverified.calls.send, 0, 'an unverified composed fee delta never becomes relay authority')

const split = fixture({ buildOpen: async () => ({ atomic: false, transactions: [[{ kind: 'economic-step-one' }], [{ kind: 'economic-step-two' }]] }) })
await assert.rejects(split.service.build({
  kind: 'loop-open', wallet, market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: preview.id,
  acknowledgementKey: preview.carry.acknowledgementKey,
}), /single atomic transaction/i)
assert.equal(split.calls.compile, 0, 'split economic fallback is rejected before compilation')

const close = fixture()
const closeBuilt = await close.service.build({ kind: 'loop-close', wallet, market: 'sol-usdy-usdc', positionId })
assert.equal(closeBuilt.kind, 'loop-close')
assert.equal(close.calls.close, 1)
assert.equal(close.calls.compile, 1)
console.log('guarded atomic loop execution contracts ok')
