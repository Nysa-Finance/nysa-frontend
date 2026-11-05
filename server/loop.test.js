import assert from 'node:assert/strict'
import Decimal from 'decimal.js'
import { address } from '@solana/kit'
import { getSlippageFactor } from '@kamino-finance/klend-sdk'
import { TOKENS } from '../src/config.js'
import { buildLoopPreview, createKaminoSwapCallbacks } from './loop.js'
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

console.log('loop preview ok')
