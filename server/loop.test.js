import assert from 'node:assert/strict'
import Decimal from 'decimal.js'
import { address } from '@solana/kit'
import { getSlippageFactor } from '@kamino-finance/klend-sdk'
import { TOKENS } from '../src/config.js'
import { buildLoopPreview, createKaminoSwapCallbacks, createLoopAcknowledgementKey } from './loop.js'
import * as loop from './loop.js'

const sdkSlippage = loop.sdkSlippagePctFromBps?.(50)
assert.equal(sdkSlippage?.toString(), '0.5') // SDK slippagePct is percent units, then internally divided by 100.
assert.equal(getSlippageFactor(sdkSlippage).toString(), '0.995') // installed SDK applies exactly 50 bps.

assert.equal(typeof loop.buildMultiplyOpenIxs, 'function')
assert.equal(typeof loop.buildMultiplyFullCloseIxs, 'function')
const sdkCalls = []
const sdkBuilder = async (params) => { sdkCalls.push(params); return [{ ixs: [{ kind: 'sdk-leverage-ix' }] }] }
const compositionCallbacks = { quoter: async () => ({ priceAInB: new Decimal(1) }), swapper: async () => [{ swapIxs: [] }] }
const openInput = { owner: 'owner', depositAmount: new Decimal(100), targetLeverage: new Decimal('1.5'), isClosingPosition: false }
const openBuilt = await loop.buildMultiplyOpenIxs(openInput, compositionCallbacks, sdkBuilder)
assert.equal(openBuilt[0].ixs[0].kind, 'sdk-leverage-ix')
assert.equal(sdkCalls.at(-1).quoter, compositionCallbacks.quoter)
assert.equal(sdkCalls.at(-1).swapper, compositionCallbacks.swapper)
assert.throws(() => loop.buildMultiplyFullCloseIxs({ isClosingPosition: false }, compositionCallbacks, sdkBuilder), /full close/i)
const closeBuilt = await loop.buildMultiplyFullCloseIxs({
  owner: 'owner', obligation: { obligationAddress: 'obligation' }, deposited: new Decimal(135), borrowed: new Decimal(60),
  withdrawAmount: new Decimal(1), isClosingPosition: true,
}, compositionCallbacks, sdkBuilder)
assert.equal(closeBuilt[0].ixs[0].kind, 'sdk-leverage-ix')
assert.equal(sdkCalls.at(-1).isClosingPosition, true)
assert.equal(sdkCalls.at(-1).withdrawAmount.toString(), '135')

const usdc = TOKENS['svm-usdc'].mint
const usdy = TOKENS['svm-usdy'].mint
const wallet = '11111111111111111111111111111111'
const feeAccount = 'SysvarRent111111111111111111111111111111111'
const instruction = { programAddress: address(wallet), accounts: [], data: new Uint8Array([1]) }
let buildRequests = []
const buildSwapFn = async (request) => {
  buildRequests.push(request)
  return {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountBaseUnits: request.inputAmountBaseUnits,
    outputAmountBaseUnits: request.outputMint === usdy ? '1098900' : '909000',
    minimumOutputBaseUnits: request.outputMint === usdy ? '1093000' : '904000',
    quoteAt: Date.now(),
  fee: { bps: 10, mint: request.outputMint, amountBaseUnits: '1100', routeDeltaVerified: true },
    feeVerified: true,
    feeAccountMintVerified: true,
    feeBalanceDeltaVerified: true,
    executable: true,
    programPolicy: { approved: true },
    programIds: [wallet, usdy],
    instructions: [instruction],
    addressesByLookupTableAddress: {},
  }
}
const callbacks = createKaminoSwapCallbacks({
  wallet,
  buildSwapFn,
  getFeeAccount: async (mint) => ({ account: feeAccount, mint }),
  tokenDecimals: { [usdc]: 6, [usdy]: 6 },
})

const inputs = { inputAmountLamports: new Decimal('1000000'), inputMint: address(usdc), outputMint: address(usdy) }
const quote = await callbacks.quoter(inputs, [])
assert.equal(quote.priceAInB.toString(), '1.0989')
assert.equal(quote.quoteResponse.outputAmountBaseUnits, '1098900')
assert.equal(buildRequests[0].feeBps, 10)
assert.equal(buildRequests[0].slippageBps, 49) // preserves a small execution margin under the SDK's 50-bps sizing buffer.
assert.equal(buildRequests[0].feeAccount, feeAccount)
assert.equal(buildRequests[0].feeAccountMint, usdy)

const providerBuildsBeforeSwap = buildRequests.length
const swapped = await callbacks.swapper(inputs, [], quote)
assert.equal(buildRequests.length, providerBuildsBeforeSwap) // compose the same route the SDK priced; do not requote between quote and swap.
assert.deepEqual(swapped[0].preActionIxs, [])
assert.deepEqual(swapped[0].swapIxs, [instruction])
assert.deepEqual(swapped[0].lookupTables, [])
assert.equal(swapped[0].quote, quote)
const changedAmountBuilds = buildRequests.length
await callbacks.swapper({ ...inputs, inputAmountLamports: new Decimal('1000001') }, [], quote)
assert.equal(buildRequests.length, changedAmountBuilds + 1)
assert.equal(buildRequests.at(-1).inputAmountBaseUnits, '1000001')

const cancelledBuild = new AbortController()
cancelledBuild.abort(new DOMException('Client disconnected.', 'AbortError'))
const cancellationCallbacks = createKaminoSwapCallbacks({
  wallet,
  signal: cancelledBuild.signal,
  getFeeAccount: async (mint) => ({ account: feeAccount, mint }),
  tokenDecimals: { [usdc]: 6, [usdy]: 6 },
  buildSwapFn: async (request) => {
    assert.equal(request.signal, cancelledBuild.signal, 'request abort signal reaches provider build')
    if (request.signal.aborted) throw request.signal.reason
    return buildSwapFn(request)
  },
})
await assert.rejects(cancellationCallbacks.quoter(inputs, []), /Client disconnected/)

assert.throws(() => createKaminoSwapCallbacks({ wallet, localForkSimulation: true, localForkRpcUrl: 'https://api.mainnet-beta.solana.com', localRouteProgramVerifier: async () => true }), /loopback/i)
let verifiedLocalPrograms
const localCallbacks = createKaminoSwapCallbacks({
  wallet, buildSwapFn, getFeeAccount: async (mint) => ({ account: feeAccount, mint }),
  tokenDecimals: { [usdc]: 6, [usdy]: 6 }, localForkSimulation: true,
  localForkRpcUrl: 'http://127.0.0.1:8899', localRouteProgramVerifier: async (built) => { verifiedLocalPrograms = built.programIds; return true },
})
const localQuote = await localCallbacks.quoter(inputs, [])
assert.equal((await localCallbacks.swapper(inputs, [], localQuote))[0].swapIxs[0].programAddress, address(wallet))
assert.equal(verifiedLocalPrograms.length, 2)

await assert.rejects(callbacks.swapper({ ...inputs, minOutAmountLamports: new Decimal('1095000') }, [], quote), /minimum output/i)

const missingFeeAccount = createKaminoSwapCallbacks({ wallet, buildSwapFn, getFeeAccount: async () => null, tokenDecimals: { [usdc]: 6, [usdy]: 6 } })
await assert.rejects(missingFeeAccount.quoter(inputs, []), /fee account/i)

const unverifiedBalanceDelta = createKaminoSwapCallbacks({
  wallet,
  getFeeAccount: async (mint) => ({ account: feeAccount, mint }),
  tokenDecimals: { [usdc]: 6, [usdy]: 6 },
  buildSwapFn: async (request) => ({
    inputMint: request.inputMint, outputMint: request.outputMint, inputAmountBaseUnits: request.inputAmountBaseUnits, quoteAt: Date.now(),
    outputAmountBaseUnits: '1098900', minimumOutputBaseUnits: '1093000',
    fee: { bps: 10, mint: request.outputMint, amountBaseUnits: '1100', routeDeltaVerified: true },
    feeVerified: false, feeAccountMintVerified: true, feeBalanceDeltaVerified: false, executable: false,
    programPolicy: { approved: true }, instructions: [instruction], addressesByLookupTableAddress: {},
  }),
})
const unverifiedQuote = await unverifiedBalanceDelta.quoter(inputs, [])
await assert.rejects(unverifiedBalanceDelta.swapper(inputs, [], unverifiedQuote), /fee|simulation/i)

const strategy = { enabled: false, unavailableReasons: [{ code: 'no-approval', message: 'Risk approval is not configured.' }], carry: { estimatedCarryPct: null } }
const preview = buildLoopPreview({
  fundingAmount: '1000', leverage: 1.5, strategy,
  maxBorrowLtvPct: 90, liquidationLtvPct: 95,
  acquisitionQuote: { fee: { mint: usdy, amountBaseUnits: '1000', bps: 10 } },
  leverageQuote: { fee: { mint: usdy, amountBaseUnits: '2000', bps: 10 } },
})
assert.equal(preview.exposure.grossCollateral, '1500')
assert.equal(preview.exposure.debt, '500')
assert.equal(preview.limits.projectedLtvPct, 38)
assert.equal(preview.risk.projectedLtvPct, '33.33333333333333333333333333333333333333')
assert.equal(preview.fees.length, 2)
assert.equal(preview.available, false)
assert.ok(preview.unavailableReasons.some((x) => x.code === 'no-approval'))

const adverseRoutePreview = buildLoopPreview({
  fundingAmount: '100', leverage: 1.5, strategy,
  maxBorrowLtvPct: 90, liquidationLtvPct: 95,
  riskInputs: { slippageBps: 50, priceImpactPct: 0.2, quoteAgeSeconds: 1, oracleAgeSeconds: 1, oracleHeartbeatSeconds: 60 },
  acquisitionQuote: { fee: { mint: usdc, amountBaseUnits: '1000', bps: 10 } },
  leverageQuote: { fee: { mint: usdy, amountBaseUnits: '1000', bps: 10 } },
  feePricesUsd: { [usdc]: 1, [usdy]: 0.8 },
  sdkPosition: {
    collateralMint: usdy, collateralDecimals: 6, collateralAmount: '135', collateralPriceUsd: '0.8',
    liabilityMint: usdc, liabilityDecimals: 6, debtBorrowAmount: '60', borrowFeeRatio: '0.01', liabilityPriceUsd: '1',
    flashBorrowAmount: '35', flashFeeRatio: '0.001',
  },
})
assert.equal(adverseRoutePreview.exposure.grossCollateral, '108')
assert.equal(adverseRoutePreview.exposure.debt, '60.6')
assert.equal(adverseRoutePreview.exposure.projectedLtvPct, '56.11111111111111111111111111111111111111')
assert.equal(adverseRoutePreview.risk.liquidationLtvPct, 95)
assert.ok(Number(adverseRoutePreview.risk.healthFactor) < 2)
assert.ok(adverseRoutePreview.risk.violations.includes('projected-ltv-cap'))
assert.equal(adverseRoutePreview.costs.find((cost) => cost.action === 'borrow-origination-fee').usd, 0.6)
assert.equal(adverseRoutePreview.costs.find((cost) => cost.action === 'flash-loan-fee').usd, 0.028)
assert.ok(adverseRoutePreview.knownCostsTotalUsd > 0.62)

const acknowledgementStrategy = {
  id: 'sol-usdy-usdc', enabled: false, unavailableReasons: [],
  carry: {
    estimatedCarryPct: '-0.75', collateralSupplyAprPct: 0.5, liabilityBorrowAprPct: 3,
    basedOnLeverage: 1.5, asOf: '2026-11-05T12:00:00.000Z', requiresAcknowledgement: true,
    acknowledgementKey: 'stale-pre-quote-key',
    assumptions: {
      collateralYieldSource: 'Kamino reserve supply APR', liabilityBorrowSource: 'Kamino reserve borrow APR',
      collateralSupplyAprPct: 0.5, liabilityBorrowAprPct: 3, leverage: 1.5,
    },
  },
}
const acknowledgementRisk = { slippageBps: 50, priceImpactPct: 0.2, quoteAgeSeconds: 1, oracleAgeSeconds: 1, oracleHeartbeatSeconds: 60 }
const acquisitionQuote = {
  provider: 'jupiter-v2-build', providerVersion: 'swap-v2-build', quoteAt: 1_800_000_000_000,
  inputMint: usdc, outputMint: usdy, inputAmountBaseUnits: '100000000', outputAmountBaseUnits: '89910000',
  minimumOutputBaseUnits: '89460450', slippageBps: 50, priceImpactPct: 0.2,
  fee: { bps: 10, mint: usdy, amountBaseUnits: '90000' }, routeProgramIds: ['OrcaWhirlpoolProgram1111111111111111111111'],
  routePlan: [{ percent: 100, swapInfo: { label: 'Orca Whirlpool', ammKey: 'OrcaPool11111111111111111111111111111111',
    inputMint: usdc, outputMint: usdy, inAmount: '100000000', outAmount: '90000000' } }],
}
const leverageQuote = {
  ...acquisitionQuote, quoteAt: 1_800_000_000_100, inputAmountBaseUnits: '50000000', outputAmountBaseUnits: '44955000',
  minimumOutputBaseUnits: '44730225', fee: { bps: 10, mint: usdy, amountBaseUnits: '45000' },
  routePlan: [{ percent: 100, swapInfo: { ...acquisitionQuote.routePlan[0].swapInfo, ammKey: 'AnotherOrcaPool111111111111111111111',
    inAmount: '50000000', outAmount: '45000000' } }],
}
const acknowledgementPosition = {
  collateralMint: usdy, collateralDecimals: 6, collateralAmount: '140', collateralPriceUsd: '1',
  liabilityMint: usdc, liabilityDecimals: 6, debtBorrowAmount: '40', borrowFeeRatio: '0.01', liabilityPriceUsd: '1',
  flashBorrowAmount: '20', flashFeeRatio: '0.001',
}
const makeAcknowledgementPreview = (overrides = {}) => buildLoopPreview({
  fundingAmount: '100', leverage: 1.5, strategy: acknowledgementStrategy,
  maxBorrowLtvPct: 90, liquidationLtvPct: 95, riskInputs: acknowledgementRisk,
  acquisitionQuote, leverageQuote, feePricesUsd: { [usdc]: 1, [usdy]: 1 }, sdkPosition: acknowledgementPosition,
  ...overrides,
})
const finalAcknowledgementPreview = makeAcknowledgementPreview()
assert.match(finalAcknowledgementPreview.carry.acknowledgementKey, /^[a-f0-9]{64}$/)
assert.equal(finalAcknowledgementPreview.carry.acknowledgementPolicyVersion, 'nysa-loop-ack-v1')
const acknowledgementKeyArgs = {
  strategy: acknowledgementStrategy, fundingAmount: '100', leverage: 1.5,
  acquisitionQuote, leverageQuote, preview: finalAcknowledgementPreview, sdkPosition: acknowledgementPosition,
}
assert.notEqual(createLoopAcknowledgementKey({ ...acknowledgementKeyArgs, policyVersion: 'nysa-loop-ack-v2' }), finalAcknowledgementPreview.carry.acknowledgementKey)
const changedAcknowledgementPreviews = [
  makeAcknowledgementPreview({ fundingAmount: '101' }),
  makeAcknowledgementPreview({ leverage: 1.4 }),
  makeAcknowledgementPreview({ acquisitionQuote: { ...acquisitionQuote, routePlan: [{ ...acquisitionQuote.routePlan[0], swapInfo: { ...acquisitionQuote.routePlan[0].swapInfo, ammKey: 'DifferentOrcaPool1111111111111111111111' } }] } }),
  makeAcknowledgementPreview({ acquisitionQuote: { ...acquisitionQuote, fee: { ...acquisitionQuote.fee, amountBaseUnits: '90001' } } }),
  makeAcknowledgementPreview({ sdkPosition: { ...acknowledgementPosition, flashFeeRatio: '0.002' } }),
  makeAcknowledgementPreview({ strategy: { ...acknowledgementStrategy, carry: { ...acknowledgementStrategy.carry, assumptions: { ...acknowledgementStrategy.carry.assumptions, collateralSupplyAprPct: 0.6 } } } }),
]
for (const changed of changedAcknowledgementPreviews) assert.notEqual(changed.carry.acknowledgementKey, finalAcknowledgementPreview.carry.acknowledgementKey)

console.log('loop preview ok')
