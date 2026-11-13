import assert from 'node:assert/strict'
import Decimal from 'decimal.js'
import { address, createNoopSigner } from '@solana/kit'
import BN from 'bn.js'
import { flashBorrowReserveLiquidity, flashRepayReserveLiquidity, getSlippageFactor, KaminoObligation, MultiplyObligation, PROGRAM_ID, UserMetadata } from '@kamino-finance/klend-sdk'
import { LIVE, TOKENS } from '../src/config.js'
import { buildLoopMetadataSetupBundle, buildLoopPreview, createKaminoSwapCallbacks, createLoopAcknowledgementKey, verifyLoopMetadataSetupSimulation } from './loop.js'
import * as loop from './loop.js'

const sdkSlippage = loop.sdkSlippagePctFromBps?.(50)
assert.equal(sdkSlippage?.toString(), '0.5') // SDK slippagePct is percent units, then internally divided by 100.
assert.equal(getSlippageFactor(sdkSlippage).toString(), '0.995') // installed SDK applies exactly 50 bps.

assert.equal(typeof loop.buildMultiplyOpenIxs, 'function')
assert.equal(typeof loop.buildMultiplyFullCloseIxs, 'function')
assert.equal(typeof loop.quoteMultiplyOpenAtFinalAmount, 'function')
const convergenceQuotes = []
let convergenceOverride = null
const convergenceCallbacks = {
  quoter: async (inputs) => {
    const amount = String(convergenceOverride?.inputAmountBaseUnits ?? inputs.inputAmountLamports)
    const quoteResponse = { inputAmountBaseUnits: amount, inputMint: 'debt', outputMint: 'collateral', quoteAt: 1 }
    convergenceQuotes.push(quoteResponse)
    return { priceAInB: new Decimal(1), quoteResponse }
  },
  setPricingQuote(route) { convergenceOverride = route },
}
let convergenceSdkCalls = 0
const convergedOpen = await loop.quoteMultiplyOpenAtFinalAmount({ inputMint: 'debt', outputMint: 'collateral' }, convergenceCallbacks,
  async (_inputs, callbacks) => {
    convergenceSdkCalls++
    const quote = await callbacks.quoter({ inputMint: 'debt', outputMint: 'collateral', inputAmountLamports: new Decimal(100) })
    return { initialInputs: { swapQuote: quote }, swapInputs: { inputAmountLamports: new Decimal(convergenceSdkCalls === 1 ? 110 : quote.quoteResponse.inputAmountBaseUnits) } }
  })
assert.equal(convergedOpen.leverageQuote.inputAmountBaseUnits, '110', 'preview pins the route quoted for the SDK final rounded input')
assert.equal(convergedOpen.sdkPreview.swapInputs.inputAmountLamports.toString(), '110')
assert.ok(convergenceSdkCalls >= 2, 'preview reruns SDK sizing after replacing the preliminary route quote')
assert.equal(convergenceOverride.inputAmountBaseUnits, '110', 'the exact final route remains pinned for the later atomic builder')
await assert.rejects(loop.quoteMultiplyOpenAtFinalAmount({ inputMint: 'debt', outputMint: 'collateral' }, {
  quoter: async (inputs) => ({ priceAInB: new Decimal(1), quoteResponse: { inputAmountBaseUnits: String(inputs.inputAmountLamports), inputMint: 'debt', outputMint: 'collateral' } }),
  setPricingQuote() {},
}, async () => ({ initialInputs: { swapQuote: { quoteResponse: { inputAmountBaseUnits: '100', inputMint: 'debt', outputMint: 'collateral' } } }, swapInputs: { inputAmountLamports: new Decimal(101) } }), { maxIterations: 2 }),
/did not converge/i, 'a route amount that cannot reach the SDK final input fails closed')
const sdkCalls = []
const sdkBuilder = async (params) => { sdkCalls.push(params); return [{ ixs: [{ kind: 'sdk-leverage-ix' }] }] }
const compositionCallbacks = { quoter: async () => ({ priceAInB: new Decimal(1) }), swapper: async () => [{ swapIxs: [] }] }
const openInput = { owner: 'owner', depositAmount: new Decimal(100), targetLeverage: new Decimal('1.5'), isClosingPosition: false }
const openBuilt = await loop.buildMultiplyOpenIxs(openInput, compositionCallbacks, sdkBuilder)
assert.equal(openBuilt[0].ixs[0].kind, 'sdk-leverage-ix')
assert.equal(sdkCalls.at(-1).quoter, compositionCallbacks.quoter)
assert.equal(sdkCalls.at(-1).swapper, compositionCallbacks.swapper)
assert.equal(sdkCalls.at(-1).obligationTypeTagOverride, 1, 'loop open always derives a separate Multiply obligation')
assert.throws(() => loop.buildMultiplyOpenIxs({ ...openInput, targetLeverage: new Decimal('1.51') }, compositionCallbacks, sdkBuilder), /leverage/i)
assert.throws(() => loop.buildMultiplyOpenIxs({ ...openInput, obligation: { refreshedStats: { userTotalDeposit: new Decimal(1) } } }, compositionCallbacks, sdkBuilder), /top.?up|existing/i)
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
const appTokenProgram = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
let appCollateralPrice = new Decimal('1.09')
let appCollateralOracleTimestamp = 1
let appCollateralMaxAge = 60
let appMaxBorrowLtv = 0.9
let appLiquidationLtv = 0.95
const appCollateral = {
  address: address(LIVE[0].reserves['svm-usdy']), stats: {
    decimals: TOKENS['svm-usdy'].decimals,
    get loanToValue() { return appMaxBorrowLtv },
    get liquidationThreshold() { return appLiquidationLtv },
  },
  state: { config: { tokenInfo: { get maxAgePriceSeconds() { return appCollateralMaxAge } } } },
  tokenOraclePrice: { get timestamp() { return appCollateralOracleTimestamp } },
  getLiquidityMint: () => address(usdy), getMintFactor: () => new Decimal(1_000_000),
  getOracleMarketPrice: () => appCollateralPrice, getLiquidityTokenProgram: () => appTokenProgram,
  getEstimatedCollateralExchangeRate: () => new Decimal('0.6'),
}
const appLiability = {
  address: address(LIVE[0].reserves['svm-usdc']), stats: { decimals: TOKENS['svm-usdc'].decimals, loanToValue: 0.9, liquidationThreshold: 0.95 },
  state: { config: { tokenInfo: { maxAgePriceSeconds: 60 } } },
  tokenOraclePrice: { timestamp: 1 },
  getLiquidityMint: () => address(usdc), getMintFactor: () => new Decimal(1_000_000),
  getOracleMarketPrice: () => new Decimal(1), getLiquidityTokenProgram: () => appTokenProgram,
  getBorrowFee: () => new Decimal('0.01'),
  calculateFees: (amount, fee) => ({ protocolFees: amount.mul(fee), referrerFees: new Decimal(0) }),
}
const appMarket = {
  state: { referralFeeBps: 0 },
  programId: address(PROGRAM_ID),
  getExistingReserveByAddress: (reserve) => String(reserve) === String(appCollateral.address) ? appCollateral : appLiability,
  getUserMetadata: async (owner) => [address('SysvarRent111111111111111111111111111111111'), { owner: String(owner) }],
  getObligationByWallet: async () => null,
}
const appInstruction = { programAddress: address(wallet), accounts: [], data: new Uint8Array([1]) }
const appContext = () => ({
  owner: address(wallet), marketConfig: { ...LIVE[0], kaminoMarket: LIVE[0].kaminoMarket }, market: appMarket,
  currentLedgerInstant: { blockTime: 1 }, collateral: TOKENS['svm-usdy'], liability: TOKENS['svm-usdc'],
  collateralReserve: appCollateral, liabilityReserve: appLiability,
})
// A complete fee-verified route: buildLoopOpenApplication compares it field by field (loopRoutesMatchWithinRounding).
const appRoute = {
  inputMint: usdc, outputMint: usdy, outputAmountBaseUnits: '100000000', minimumOutputBaseUnits: '99500000', routePlan: [],
  feeAccount: wallet, feeAccountMint: usdy, feeAccountMintVerified: true,
  fee: { bps: 10, mint: usdy, amountBaseUnits: '1000', routeDeltaVerified: true },
}
const appPreview = {
  id: 'app-preview', wallet, marketId: 'sol-usdy-usdc', fundingAmount: '100', leverage: 1.5,
  sdk: {
    flashBorrowFee: '0.01', collateralToDeposit: '120', debtToBorrow: '50', leverageSwapInputBaseUnits: '50000000', leverageSwapMinimumOutputBaseUnits: '53000000',
    marketRisk: {
      collateralPriceUsd: '1.09', liabilityPriceUsd: '1', maxBorrowLtvPct: '90', liquidationLtvPct: '95',
      collateralOracleTimestamp: 1, liabilityOracleTimestamp: 1,
      collateralOracleHeartbeatSeconds: 60, liabilityOracleHeartbeatSeconds: 60,
    },
  },
  exposure: { collateralPriceUsd: '1.09', liabilityPriceUsd: '1' }, limits: { projectedLtvPct: 80, maxLeverage: 1.5 },
  applicationContext: {
    wallet, fundingAmount: '100', fundingBaseUnits: '100000000', leverage: 1.5,
    leverageQuote: { ...appRoute, inputAmountBaseUnits: '50000000' },
    callbacks: { beginComposition() { appOpenBegan = true }, sealQuotes() { appOpenSealed = true } },
  },
}
let appOpenBegan = false, appOpenSealed = false, appCloseBegan = false, appCloseSealed = false
let appOpenSdkInputs, appCloseSdkInputs
const finalOpenApplication = await loop.buildLoopOpenApplication({
  wallet, amount: '100', leverage: 1.5, preview: appPreview, flashBorrowType: 'debt',
  refreshMarket: async () => {}, contextReader: appContext,
  applicationBuilder: async ({ sdkInputs, callbacks }) => {
    appOpenSdkInputs = sdkInputs
    assert.equal(callbacks, appPreview.applicationContext.callbacks)
    return {
      atomic: true, instructions: [appInstruction], lookupTables: [], feeEvents: [], simulationAccounts: [],
      quotePlan: {
        acquisitionQuote: null, leverageQuote: appPreview.applicationContext.leverageQuote,
        leverageSwapInputBaseUnits: appPreview.sdk.leverageSwapInputBaseUnits,
        leverageSwapMinimumOutputBaseUnits: appPreview.sdk.leverageSwapMinimumOutputBaseUnits,
        flashBorrowFee: appPreview.sdk.flashBorrowFee, collateralToDeposit: appPreview.sdk.collateralToDeposit,
        debtToBorrow: appPreview.sdk.debtToBorrow,
      },
    }
  },
})
assert.equal(finalOpenApplication.simulationContext.kind, 'loop-open')
assert.equal(appOpenSdkInputs.flashBorrowType, 'debt', 'local verifier can exercise the selected SDK flash-borrow branch')
assert.equal(appOpenBegan && appOpenSealed, true, 'open composition always brackets quote cache mutation')
assert.equal(finalOpenApplication.simulationContext.authorizedPosition.debtBaseUnits, '50500000',
  'final open simulation authorizes the SDK protocol fee on top of requested borrow proceeds')
assert.equal(finalOpenApplication.simulationContext.authorizedPosition.collateralCTokenBaseUnits, '72000000',
  'final open simulation authorizes collateral cTokens at the current non-unit reserve exchange rate')
assert.ok(finalOpenApplication.ownerTokenAccounts.some((item) => item.mint === usdy),
  'open simulation tracks the wallet USDY account so acquisition shortfalls cannot spend existing USDY')
appCollateralPrice = new Decimal('1.10')
await assert.rejects(loop.buildLoopOpenApplication({
  wallet, amount: '100', leverage: 1.5, preview: appPreview,
  refreshMarket: async () => {}, contextReader: appContext,
  applicationBuilder: async () => { throw new Error('changed oracle assumptions must fail before composition') },
}), /oracle|market risk|assumption/i,
'fresh build rejects a changed oracle price rather than authorizing poststate with preview prices')
appCollateralPrice = new Decimal('1.09')
appCollateralOracleTimestamp = -60
await assert.rejects(loop.buildLoopOpenApplication({
  wallet, amount: '100', leverage: 1.5, preview: appPreview,
  refreshMarket: async () => {}, contextReader: appContext,
  applicationBuilder: async () => { throw new Error('stale oracle must fail before composition') },
}), /oracle|heartbeat|stale/i, 'fresh build rejects an oracle timestamp outside its reserve heartbeat')
appCollateralOracleTimestamp = 1
appMaxBorrowLtv = 0.8
await assert.rejects(loop.buildLoopOpenApplication({
  wallet, amount: '100', leverage: 1.5, preview: appPreview,
  refreshMarket: async () => {}, contextReader: appContext,
  applicationBuilder: async () => { throw new Error('changed governance LTV must fail before composition') },
}), /oracle|market risk|assumption|ltv/i, 'fresh build rejects changed governance LTV from the preview')
appMaxBorrowLtv = 0.9

const appMultiplyType = new MultiplyObligation(appCollateral.getLiquidityMint(), appLiability.getLiquidityMint(), address(PROGRAM_ID))
const appObligationAddress = String(await appMultiplyType.toPda(address(LIVE[0].kaminoMarket), address(wallet)))
const appObligation = {
  obligationAddress: address(appObligationAddress), state: {
    owner: address(wallet),
    deposits: [{ depositReserve: appCollateral.address, depositedAmount: new BN('100000000') }],
    borrows: [{ borrowReserve: appLiability.address, borrowedAmountSf: new BN('50000000000000000000000000') }],
  },
  getDepositByReserve: () => ({ amount: '100000000', mintFactor: '1000000' }),
  getBorrowByReserve: () => ({ amount: '50000000', mintFactor: '1000000' }),
}
appMarket.getObligationByWallet = async () => appObligation
const finalCloseApplication = await loop.buildLoopCloseApplication({
  wallet, flashBorrowType: 'debt', refreshMarket: async () => {}, contextReader: appContext,
  callbacks: { setPricingQuote() {}, beginComposition() { appCloseBegan = true }, sealQuotes() { appCloseSealed = true } },
  position: { wallet, market: { id: 'sol-usdy-usdc' }, obligation: { address: appObligationAddress, type: 'multiply' } },
  applicationBuilder: async ({ sdkInputs }) => {
    appCloseSdkInputs = sdkInputs
    return { atomic: true, instructions: [appInstruction], lookupTables: [], feeEvents: [], simulationAccounts: [] }
  },
})
assert.equal(finalCloseApplication.simulationContext.kind, 'loop-close')
assert.equal(appCloseSdkInputs.withdrawAmount.toString(), '100', 'final close builder receives the entire exact collateral position')
assert.equal(appCloseSdkInputs.flashBorrowType, 'debt')
assert.equal(appCloseBegan && appCloseSealed, true, 'close route composition clears pinned open pricing and reseals quotes')
const appClosePosition = { wallet, market: { id: 'sol-usdy-usdc' }, obligation: { address: appObligationAddress, type: 'multiply' } }
const extraReserve = address('Sysvar1nstructions1111111111111111111111111')
appMarket.getObligationByWallet = async () => ({
  ...appObligation,
  state: { ...appObligation.state, deposits: [...appObligation.state.deposits,
    { depositReserve: extraReserve, depositedAmount: new BN(1) }] },
})
await assert.rejects(loop.buildLoopCloseApplication({
  wallet, refreshMarket: async () => {}, contextReader: appContext,
  position: appClosePosition,
  applicationBuilder: async () => { throw new Error('unsupported extra-reserve position must fail before composing close instructions') },
}), /extra active collateral reserves/i, 'fresh close builder rejects positive reserve state beyond the supported USDY/USDC pair')
appMarket.getObligationByWallet = async () => ({
  ...appObligation,
  state: { ...appObligation.state, borrows: [...appObligation.state.borrows,
    { borrowReserve: extraReserve, borrowedAmountSf: new BN(1) }] },
})
await assert.rejects(loop.buildLoopCloseApplication({
  wallet, refreshMarket: async () => {}, contextReader: appContext, position: appClosePosition,
  applicationBuilder: async () => { throw new Error('unsupported extra-reserve position must fail before composing close instructions') },
}), /extra active borrow reserves/i, 'fresh close builder rejects positive extra debt reserve state')
appMarket.getObligationByWallet = async () => appObligation
const feeAccount = 'SysvarRent111111111111111111111111111111111'
const instruction = { programAddress: address(wallet), accounts: [], data: new Uint8Array([1]) }
let buildRequests = []
const composedSwapBuilds = []
const validatedRouteRequests = []
const buildSwapFn = async (request) => {
  buildRequests.push(request)
  return {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountBaseUnits: request.inputAmountBaseUnits,
    feeAccount: request.feeAccount,
    feeAccountMint: request.feeAccountMint,
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
  validateRoute: async (request, built) => { validatedRouteRequests.push({ request, built }) },
  onSwapComposed: async (built) => composedSwapBuilds.push(built),
})

const inputs = { inputAmountLamports: new Decimal('1000000'), inputMint: address(usdc), outputMint: address(usdy) }
const quote = await callbacks.quoter(inputs, [])
assert.equal(quote.priceAInB.toString(), '1.0989')
assert.equal(quote.quoteResponse.outputAmountBaseUnits, '1098900')
const previewRoute = quote.quoteResponse
assert.equal(buildRequests[0].feeBps, 10)
assert.equal(buildRequests[0].slippageBps, 49) // preserves a small execution margin under the SDK's 50-bps sizing buffer.
assert.equal(buildRequests[0].feeAccount, feeAccount)
assert.equal(buildRequests[0].feeAccountMint, usdy)
assert.equal(validatedRouteRequests.length, 1, 'the shared route validator runs before a quote reaches SDK callbacks')
assert.equal(validatedRouteRequests[0].request.wallet, wallet, 'the shared route validator receives the active wallet')
assert.equal(validatedRouteRequests[0].built.inputAmountBaseUnits, quote.quoteResponse.inputAmountBaseUnits,
  'the shared route validator checks the exact quote economics returned to the SDK callback')
assert.equal(quote.quoteResponse.compositionValidated, true, 'only a route that passed the shared validator is marked composable')
callbacks.beginComposition()
const quoteAtBuild = await callbacks.quoter(inputs, [])
assert.equal(quoteAtBuild.quoteResponse, quote.quoteResponse,
  'build-time route revalidation preserves the exact preliminary quote captured in the preview')

const providerBuildsBeforeSwap = buildRequests.length
const swapped = await callbacks.swapper(inputs, [], quoteAtBuild)
assert.equal(quote.quoteResponse, previewRoute, 'composition revalidation preserves the exact quote object bound to the preview')
assert.equal(buildRequests.length, providerBuildsBeforeSwap) // compose the same route the SDK priced; do not requote between quote and swap.
assert.deepEqual(composedSwapBuilds, [quoteAtBuild.quoteResponse], 'observer receives the exact provider quote used to compose transaction instructions')
assert.deepEqual(swapped[0].preActionIxs, [])
assert.deepEqual(swapped[0].swapIxs, [instruction])
assert.deepEqual(swapped[0].lookupTables, [])
assert.equal(swapped[0].quote, quoteAtBuild)
const changedAmountBuilds = buildRequests.length
await callbacks.swapper({ ...inputs, inputAmountLamports: new Decimal('1000001') }, [], quote)
assert.equal(buildRequests.length, changedAmountBuilds + 1)
assert.equal(buildRequests.at(-1).inputAmountBaseUnits, '1000001')
assert.equal(composedSwapBuilds.at(-1).inputAmountBaseUnits, '1000001', 'observer receives the replacement quote actually composed after amount changes')
callbacks.sealQuotes()
await assert.rejects(callbacks.quoter({ ...inputs, inputAmountLamports: new Decimal('1000002') }, []), /amount changed/i,
  'preview quotes cannot be silently replaced after preview authorization is sealed')
callbacks.beginComposition()
const changedCompositionQuote = await callbacks.quoter({ ...inputs, inputAmountLamports: new Decimal('1000002') }, [])
await callbacks.swapper({ ...inputs, inputAmountLamports: new Decimal('1000002') }, [], changedCompositionQuote)
assert.equal(composedSwapBuilds.at(-1).inputAmountBaseUnits, '1000002',
  'the atomic builder captures any amount-adjusted composition route before preview economics are rechecked')
callbacks.sealQuotes()

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
  validateRoute: async () => {},
  tokenDecimals: { [usdc]: 6, [usdy]: 6 }, localForkSimulation: true,
  localForkRpcUrl: 'http://127.0.0.1:8899', localRouteProgramVerifier: async (built) => { verifiedLocalPrograms = built.programIds; return true },
})
const localQuote = await localCallbacks.quoter(inputs, [])
assert.equal((await localCallbacks.swapper(inputs, [], localQuote))[0].swapIxs[0].programAddress, address(wallet))
assert.equal(verifiedLocalPrograms.length, 2)
assert.equal(await localCallbacks.authorizeComposedRoute({ ...localQuote.quoteResponse, programPolicy: { approved: false } }), true,
  'local application composition uses the explicit loopback verifier instead of fabricated production program approval')
const localRouteDenied = createKaminoSwapCallbacks({
  wallet, buildSwapFn, getFeeAccount: async (mint) => ({ account: feeAccount, mint }), validateRoute: async () => {},
  tokenDecimals: { [usdc]: 6, [usdy]: 6 }, localForkSimulation: true,
  localForkRpcUrl: 'http://127.0.0.1:8899', localRouteProgramVerifier: async () => false,
})
assert.equal(await localRouteDenied.authorizeComposedRoute({ ...localQuote.quoteResponse, programPolicy: { approved: false } }), false,
  'local composition stays blocked when deployed route programs are not verified on the loopback validator')

await assert.rejects(callbacks.swapper({ ...inputs, minOutAmountLamports: new Decimal('1095000') }, [], quote), /minimum output/i)

const missingFeeAccount = createKaminoSwapCallbacks({ wallet, buildSwapFn, getFeeAccount: async () => null, tokenDecimals: { [usdc]: 6, [usdy]: 6 } })
await assert.rejects(missingFeeAccount.quoter(inputs, []), /fee account/i)

const unverifiedBalanceDelta = createKaminoSwapCallbacks({
  wallet,
  validateRoute: async () => {},
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
const compositionCandidate = await unverifiedBalanceDelta.quoter(inputs, [])
assert.equal(compositionCandidate.quoteResponse.compositionValidated, true,
  'route policy and validator authorize composition before aggregate simulation')
assert.equal(compositionCandidate.quoteResponse.executable, false,
  'route composition validation does not claim economic execution approval before fee-delta simulation')
await unverifiedBalanceDelta.swapper(inputs, [], compositionCandidate)
assert.equal(unverifiedBalanceDelta.composedQuotes().at(-1).executable, false,
  'composed routes remain non-executable until final composed fee deltas are simulated')

assert.equal(typeof loop.verifyAtomicLoopFeeDeltas, 'function')
assert.deepEqual(loop.verifyAtomicLoopFeeDeltas(
  [
    { account: 'treasury-usdy', mint: usdy, amountBaseUnits: '100', bps: 10 },
    { account: 'treasury-usdy', mint: usdy, amountBaseUnits: '200', bps: 10 },
  ],
  [{ account: 'treasury-usdy', mint: usdy, deltaBaseUnits: '300' }],
), [{ account: 'treasury-usdy', mint: usdy, deltaBaseUnits: '300' }])
assert.throws(() => loop.verifyAtomicLoopFeeDeltas(
  [{ account: 'treasury-usdy', mint: usdy, amountBaseUnits: '100', bps: 10 }],
  [{ account: 'treasury-usdy', mint: usdy, deltaBaseUnits: '89' }],
), /fee account balance delta/i)

assert.equal(typeof loop.buildAtomicMultiplyOpenApplication, 'function')
assert.equal(typeof loop.buildAtomicMultiplyFullCloseApplication, 'function')
const routeFixture = (inputMint, outputMint, feeAccount) => ({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', outputAmountBaseUnits: '89910000',
  quoteAt: Date.now() - 1,
  fee: { bps: 10, mint: outputMint, amountBaseUnits: '90000', routeDeltaVerified: true },
  feeAccount, feeAccountMint: outputMint, feeAccountMintVerified: true, feeBalanceDeltaVerified: false,
  programPolicy: { approved: true }, executable: false,
  programIds: [wallet, usdy], instructions: [instruction], addressesByLookupTableAddress: {},
})
const routeLookupTable = 'SysvarC1ock11111111111111111111111111111111'
const leverageApplicationRoute = {
  ...routeFixture(usdc, usdy, 'TreasuryUSDY111111111111111111111111111111'),
  addressesByLookupTableAddress: { [routeLookupTable]: [wallet] },
}
const openApplication = await loop.buildAtomicMultiplyOpenApplication({
  wallet,
  sdkInputs: { ...openInput, owner: 'owner' },
  callbacks: compositionCallbacks,
  validateRoute: async () => {},
  builder: async () => [{ ixs: [instruction], lookupTables: [], quote: { ...leverageApplicationRoute, inputAmountBaseUnits: '50000000' } }],
})
assert.equal(openApplication.atomic, true)
assert.equal(openApplication.quotePlan.acquisitionQuote, null,
  'USDY-funded application has no initial acquisition route')
assert.equal(openApplication.quotePlan.leverageQuote.compositionValidated, true,
  'direct application builders revalidate and mark the exact leverage route before composition')
assert.equal(openApplication.instructions.length, 1, 'the SDK Multiply transaction has no initial acquisition instructions')
assert.equal(openApplication.feeEvents.length, 1)
assert.deepEqual(openApplication.addressesByLookupTableAddress, { [routeLookupTable]: [wallet] },
  'final local compilation can verify the exact lookup-table addresses used by every composed route')
const staleCompositionCallbacks = createKaminoSwapCallbacks({
  wallet,
  getFeeAccount: async (mint) => ({ account: mint === usdc ? 'TreasuryUSDC111111111111111111111111111111' : 'TreasuryUSDY111111111111111111111111111111', mint }),
  tokenDecimals: { [usdc]: 6, [usdy]: 6 },
  validateRoute: async () => {},
  buildSwapFn: async (request) => {
    const route = routeFixture(request.inputMint, request.outputMint,
      request.outputMint === usdc ? 'TreasuryUSDC111111111111111111111111111111' : 'TreasuryUSDY111111111111111111111111111111')
    return {
      ...route,
      inputAmountBaseUnits: request.inputAmountBaseUnits,
      outputAmountBaseUnits: request.inputAmountBaseUnits === '40000000' ? '35964000' : '44955000',
      fee: { ...route.fee, amountBaseUnits: request.inputAmountBaseUnits === '40000000' ? '36000' : '45000' },
    }
  },
})
const staleSdkQuote = await staleCompositionCallbacks.quoter({
  inputMint: address(usdc), outputMint: address(usdy), inputAmountLamports: new Decimal('40000000'),
}, [])
const exactCompositionNow = Date.now() + 1000
const composedAmountApplication = await loop.buildAtomicMultiplyOpenApplication({
  wallet, sdkInputs: { ...openInput, owner: 'owner' }, callbacks: staleCompositionCallbacks,
  validateRoute: async () => {}, now: exactCompositionNow,
  builder: async () => {
    await staleCompositionCallbacks.swapper({
      inputMint: address(usdc), outputMint: address(usdy), inputAmountLamports: new Decimal('50000000'),
    }, [], staleSdkQuote)
    return [{
      ixs: [instruction], lookupTables: [], quote: staleSdkQuote.quoteResponse,
      swapInputs: { inputAmountLamports: new Decimal('50000000'), minOutAmountLamports: new Decimal('44000000') },
    }]
  },
})
assert.equal(composedAmountApplication.quotePlan.leverageQuote.inputAmountBaseUnits, '50000000',
  'fee-aware application economics use the exact changed-amount route composed by the SDK swapper, not its earlier quote')
assert.equal(composedAmountApplication.quotePlan.leverageQuote.fee.amountBaseUnits, '45000')
assert.equal(composedAmountApplication.feeEvents[0].amountBaseUnits, '45000', 'the collected fee matches the route actually composed')
const setupAta = address('SysvarRent111111111111111111111111111111111')
const setupCompute = { programAddress: address('ComputeBudget111111111111111111111111111111'), accounts: [], data: new Uint8Array([3]) }
const duplicateSetupCompute = { ...setupCompute, data: Uint8Array.from(setupCompute.data) }
const setupAtaInstruction = {
  programAddress: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  accounts: [{ address: wallet }, { address: setupAta }], data: new Uint8Array([1]),
}
const flashProgram = address(PROGRAM_ID)
const flashCommon = {
  userTransferAuthority: createNoopSigner(address(wallet)), lendingMarketAuthority: setupAta,
  lendingMarket: setupAta, reserve: setupAta, reserveLiquidityMint: setupAta,
  reserveLiquidityFeeReceiver: setupAta, referrerTokenState: { __option: 'None' },
  referrerAccount: { __option: 'None' }, sysvarInfo: address('Sysvar1nstructions1111111111111111111111111'),
  tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
}
const sdkFlashBorrow = flashBorrowReserveLiquidity({ liquidityAmount: new BN(123) }, {
  ...flashCommon, reserveSourceLiquidity: setupAta, userDestinationLiquidity: setupAta,
}, [], flashProgram)
const sdkFlashRepay = (borrowInstructionIndex) => flashRepayReserveLiquidity({ liquidityAmount: new BN(123), borrowInstructionIndex }, {
  ...flashCommon, reserveDestinationLiquidity: setupAta, userSourceLiquidity: setupAta,
}, [], flashProgram)
const sdkEconomicInstruction = { ...instruction, programAddress: address('SysvarC1ock11111111111111111111111111111111') }
const setupComposition = await loop.buildAtomicMultiplyOpenApplication({
  wallet, sdkInputs: { ...openInput, owner: 'owner' }, callbacks: compositionCallbacks,
  validateRoute: async () => {},
  builder: async () => [{
    ixs: [duplicateSetupCompute, setupAtaInstruction, sdkFlashBorrow, sdkEconomicInstruction, sdkFlashRepay(2)],
    lookupTables: [], quote: routeFixture(usdc, usdy, 'TreasuryUSDY111111111111111111111111111111'),
  }],
})
assert.equal(setupComposition.instructions.filter((ix) => String(ix.programAddress) === String(setupCompute.programAddress)).length, 1,
  'composed open deduplicates repeated SDK/router compute budget instructions')
assert.equal(setupComposition.instructions.filter((ix) => String(ix.programAddress) === String(setupAtaInstruction.programAddress)).length, 1,
  'composed open retains one associated token setup from the Multiply SDK')
const composedBorrowIndex = setupComposition.instructions.findIndex((ix) => Buffer.from(ix.data).subarray(0, 8).equals(Buffer.from(sdkFlashBorrow.data).subarray(0, 8)))
const composedRepay = setupComposition.instructions.find((ix) => Buffer.from(ix.data).subarray(0, 8).equals(Buffer.from(sdkFlashRepay(0).data).subarray(0, 8)))
assert.equal(composedBorrowIndex, 2, 'SDK compute-budget and token-account setup precede the flash borrow')
assert.equal(composedRepay.data[16], composedBorrowIndex, 'SDK flash repay borrowInstructionIndex remains valid after instruction normalization')
await assert.rejects(loop.buildAtomicMultiplyOpenApplication({
  wallet, sdkInputs: openInput, callbacks: compositionCallbacks,
  validateRoute: async () => {},
  builder: async () => [{ ixs: [instruction] }, { ixs: [instruction] }],
}), /one Kamino SDK transaction|single atomic/i)
const closeApplication = await loop.buildAtomicMultiplyFullCloseApplication({
  sdkInputs: { owner: 'owner', obligation: {}, deposited: new Decimal(135), borrowed: new Decimal(60), isClosingPosition: true },
  callbacks: compositionCallbacks,
  validateRoute: async () => {},
  builder: async () => [{ ixs: [instruction], lookupTables: [], swapInputs: { inputAmountLamports: new Decimal(500) },
    flashLoanInfo: { flashLoanFee: new Decimal('0.001') }, quote: {
    ...routeFixture(usdy, usdc, 'TreasuryUSDC111111111111111111111111111111'),
    fee: { bps: 10, mint: usdc, amountBaseUnits: '90000', routeDeltaVerified: true },
  } }],
})
assert.equal(closeApplication.atomic, true)
assert.equal(closeApplication.instructions.length, 1)
assert.equal(closeApplication.quotePlan.flashBorrowFee, '0.001', 'local verifier consumes the final close builder fee plan')

assert.equal(loop.obligationRawAmountBaseUnits?.('1234567'), '1234567',
  'Kamino obligation amounts already use base units and must not be multiplied by the reserve mint factor again')
assert.equal(loop.obligationRawAmountBaseUnits('1.5'), '2', 'fractional accrued base units round upward when checking repayment')
assert.equal(loop.sdkAmountWithProtocolRounding('150.0000009', 6, 'floor'), '150',
  'authorized collateral matches Kamino deposit floor rounding')
assert.equal(loop.sdkAmountWithProtocolRounding('50.0000001', 6, 'ceil'), '50.000001',
  'authorized debt matches Kamino borrow ceil rounding')
assert.equal(loop.sdkAmountBaseUnitsWithProtocolRounding('150.0000039', 6, 'floor'), '150000003',
  'open bounds retain the exact collateral raw amount after protocol floor rounding')
assert.equal(loop.sdkAmountBaseUnitsWithProtocolRounding('50.0000001', 6, 'ceil'), '50000001',
  'open bounds retain the exact debt raw amount after protocol ceil rounding')
assert.equal(typeof loop.sdkBorrowDebtBaseUnitsWithProtocolFee, 'function')
const feeReserve = {
  getBorrowFee: () => new Decimal('0.000000055'),
  calculateFees: (amount, fee, _calculation, _referralFeeBps, _hasReferrer) => ({
    protocolFees: amount.mul(fee), referrerFees: new Decimal(0),
  }),
}
assert.equal(loop.sdkBorrowDebtBaseUnitsWithProtocolFee('100.000001', 6, { state: { referralFeeBps: 0 } }, feeReserve), '100000007',
  'authorized raw debt includes Kamino exclusive origination fee rounded half-up to base units')
assert.equal(typeof loop.sdkDepositPositionBaseUnitsWithExchangeRate, 'function')
const convertedDeposit = loop.sdkDepositPositionBaseUnitsWithExchangeRate('150.0000039', 6, '0.6')
assert.deepEqual({
  liquidityBaseUnits: convertedDeposit.liquidityBaseUnits,
  cTokenBaseUnits: convertedDeposit.cTokenBaseUnits,
  positionBaseUnits: convertedDeposit.positionBaseUnits,
}, {
  liquidityBaseUnits: '150000003', cTokenBaseUnits: '90000001', positionBaseUnits: '150000002',
}, 'authorized collateral matches on-chain floor cToken minting and hydrated exchange-rate amount')
const hydrationReserveAddress = address('SysvarRent111111111111111111111111111111111')
const hydrationMarketAddress = address('SysvarC1ock11111111111111111111111111111111')
const hydrationReserve = {
  address: hydrationReserveAddress,
  stats: { loanToValue: 0, liquidationThreshold: 0, borrowFactor: 100 },
  getLiquidityMint: () => address(usdy),
  getMintFactor: () => new Decimal(1_000_000),
  getOracleMarketPrice: () => new Decimal(1),
}
const emptyOrder = {
  debtLiquidityMint: address('11111111111111111111111111111111'),
  remainingDebtAmount: new BN(0), filledDebtDestination: address('11111111111111111111111111111111'),
  minDebtTermSeconds: new BN(0), fillableUntilTimestamp: new BN(0), maxBorrowRateBps: 0,
  enableAutoRolloverOnFilledBorrows: 0, placedAtTimestamp: new BN(0), lastUpdatedAtTimestamp: new BN(0), requestedDebtAmount: new BN(0),
}
const hydrationMarket = { getReserveByAddress: (candidate) => String(candidate) === String(hydrationReserveAddress) ? hydrationReserve : null }
const hydratedObligation = new KaminoObligation(hydrationMarket, hydrationMarketAddress, {
  tag: new BN(1), elevationGroup: 0, borrows: [],
  deposits: [{ depositReserve: hydrationReserveAddress, depositedAmount: new BN(convertedDeposit.cTokenBaseUnits) }],
  headBorrowOrder: emptyOrder, tailBorrowOrders: [emptyOrder, emptyOrder],
}, new Map([[hydrationReserveAddress, new Decimal('0.6')]]), new Map())
assert.equal(convertedDeposit.positionRawAmount, hydratedObligation.getDepositByReserve(hydrationReserveAddress).amount.toString(),
  'authorized liquidity matches the installed KaminoObligation hydration precision for repeating exchange rates')
assert.deepEqual(loop.obligationSimulationBalances(hydratedObligation), {
  deposits: [{ reserve: String(hydrationReserveAddress), cTokenBaseUnits: '90000001',
    amountBaseUnits: hydratedObligation.getDepositByReserve(hydrationReserveAddress).amount.toString() }],
  borrows: [],
}, 'simulation exports exact raw cToken state and the SDK-hydrated liquidity amount for the full obligation')

const simulationBuilt = {
  feeEvents: [{ account: 'treasury-usdy', mint: usdy, amountBaseUnits: '100', bps: 10 }],
  ownerTokenAccounts: [
    { account: 'owner-usdc', mint: usdc },
    { account: 'owner-usdy', mint: usdy },
  ],
  simulationContext: {
    kind: 'loop-open', wallet,
    collateralMintFactor: '1000000', liabilityMintFactor: '1000000',
    fundingBaseUnits: '100000000',
    authorizedPosition: {
      collateralAmount: '150', debtAmount: '50',
      collateralBaseUnits: '150000000', collateralCTokenBaseUnits: '90000000', debtBaseUnits: '50000000',
      collateralPriceUsd: '1', debtPriceUsd: '1',
      maxLeverage: 1.5, maxProjectedLtvPct: 38,
    },
  },
}
const validOpenSimulation = {
  ok: true, positionOwner: wallet, positionCollateralAmount: '150', positionDebtAmount: '50',
  positionCollateralBaseUnits: '150000000', positionCollateralCTokenBaseUnits: '90000000', positionDebtBaseUnits: '50000000',
  tokenDeltas: [
    { account: 'treasury-usdy', mint: usdy, deltaBaseUnits: '100' },
    { account: 'owner-usdc', mint: usdc, deltaBaseUnits: '0' },
    { account: 'owner-usdy', mint: usdy, deltaBaseUnits: '-100000000' },
  ],
}
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: simulationBuilt, simulation: validOpenSimulation }), true,
  'an open simulation must match the approved preview and its projected leverage/LTV bounds')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: simulationBuilt, simulation: {
  ...validOpenSimulation,
  tokenDeltas: validOpenSimulation.tokenDeltas.map((item) => item.account === 'owner-usdy' ? { ...item, deltaBaseUnits: '-99999999' } : item),
} }), true, 'a verified USDY swap surplus may reduce the wallet debit without exceeding authorized funding')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: simulationBuilt, simulation: {
  ...validOpenSimulation,
  tokenDeltas: validOpenSimulation.tokenDeltas.map((item) => item.account === 'treasury-usdy'
    ? { ...item, deltaBaseUnits: '89' } : item),
} }), false, 'the exact composed fee-account delta must verify before open authorization')
const roundedSimulationBuilt = {
  ...simulationBuilt,
  simulationContext: { ...simulationBuilt.simulationContext, authorizedPosition: {
    ...simulationBuilt.simulationContext.authorizedPosition,
    collateralAmount: '150.000003', debtAmount: '50.000001',
    collateralBaseUnits: '150000003', collateralCTokenBaseUnits: '90000002', debtBaseUnits: '50000001',
  } },
}
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: roundedSimulationBuilt, simulation: {
  ...validOpenSimulation, positionCollateralAmount: '150.000003', positionDebtAmount: '50.000001',
  positionCollateralBaseUnits: '150000003', positionCollateralCTokenBaseUnits: '90000002', positionDebtBaseUnits: '50000001',
} }), true, 'simulation checks protocol-rounded token amounts instead of fractional SDK calculator values')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: roundedSimulationBuilt, simulation: {
  ...validOpenSimulation, positionCollateralAmount: '150.000003', positionDebtAmount: '50.000001',
  positionCollateralBaseUnits: '150000002', positionCollateralCTokenBaseUnits: '90000002', positionDebtBaseUnits: '50000001',
} }), false, 'raw-unit mismatch cannot pass because display token amounts round to the same value')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: roundedSimulationBuilt, simulation: {
  ...validOpenSimulation, positionCollateralAmount: '150.000003', positionDebtAmount: '50.000001',
  positionCollateralBaseUnits: '150000003', positionCollateralCTokenBaseUnits: '90000001', positionDebtBaseUnits: '50000001',
} }), false, 'cToken state must match the exchange-rate conversion approved by simulation')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: simulationBuilt, simulation: {
  ...validOpenSimulation, positionCollateralAmount: '149.999999', positionCollateralBaseUnits: '149999999',
} }), false, 'a simulated open with different collateral is outside the signed preview')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: simulationBuilt, simulation: {
  ...validOpenSimulation, positionDebtAmount: '60', positionDebtBaseUnits: '60000000',
} }), false, 'a simulated open with higher debt is outside the signed preview')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: simulationBuilt, simulation: {
  ...validOpenSimulation, tokenDeltas: validOpenSimulation.tokenDeltas.map((item) => item.account === 'owner-usdc' ? { ...item, deltaBaseUnits: '-100000001' } : item),
} }), false, 'an open may not debit the wallet USDC account')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-open', built: simulationBuilt, simulation: {
  ...validOpenSimulation,
  tokenDeltas: validOpenSimulation.tokenDeltas.map((item) => item.account === 'owner-usdy'
    ? { ...item, deltaBaseUnits: '-100000001' } : item),
} }), false, 'the transaction may not debit more USDY than the user approved')

const simulationCloseBuilt = {
  ...simulationBuilt,
  simulationContext: { kind: 'loop-close', wallet },
}
const validCloseSimulation = {
  ok: true, positionOwner: wallet, remainingDebtBaseUnits: '0', positionCollateralAmount: '0',
  obligationBalances: { deposits: [], borrows: [] },
  tokenDeltas: [
    { account: 'treasury-usdy', mint: usdy, deltaBaseUnits: '100' },
    { account: 'owner-usdc', mint: usdc, deltaBaseUnits: '30000000' },
    { account: 'owner-usdy', mint: usdy, deltaBaseUnits: '0' },
  ],
}
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-close', built: simulationCloseBuilt, simulation: validCloseSimulation }), true)
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-close', built: simulationCloseBuilt, simulation: {
  ...validCloseSimulation,
  obligationBalances: { deposits: [{ reserve: 'extra-reserve', cTokenBaseUnits: '1', amountBaseUnits: '1' }], borrows: [] },
} }), false, 'post-close simulation must prove every reserve in the Multiply PDA is empty')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-close', built: simulationCloseBuilt, simulation: {
  ...validCloseSimulation,
  obligationBalances: { deposits: [], borrows: [{ reserve: 'extra-reserve', amountScaled: '1', amountBaseUnits: '0.000000000000000001' }] },
} }), false, 'post-close simulation must prove every borrow reserve in the Multiply PDA is empty')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-close', built: simulationCloseBuilt, simulation: {
  ...validCloseSimulation, positionCollateralAmount: '0.000001',
} }), false, 'full close must release all collateral from the Multiply obligation')
assert.equal(loop.verifyLoopApplicationSimulation({ kind: 'loop-close', built: simulationCloseBuilt, simulation: {
  ...validCloseSimulation, tokenDeltas: validCloseSimulation.tokenDeltas.map((item) => item.account === 'owner-usdc' ? { ...item, deltaBaseUnits: '-1' } : item),
} }), false, 'full close cannot hide an unexpected debit to an owner token account')

let setupBuilderCalls = 0
let setupBuilderOptions
const metadataAddress = address('SysvarRent111111111111111111111111111111111')
const setupInstruction = { programAddress: address(PROGRAM_ID), accounts: [], data: Uint8Array.of(1) }
const metadataSetup = await buildLoopMetadataSetupBundle({
  kaminoMarket: { getUserMetadata: async () => [metadataAddress, null] },
  owner: createNoopSigner(address(wallet)),
  sdkBuilder: async (options) => { setupBuilderCalls++; setupBuilderOptions = options; return { ixs: [setupInstruction], luts: [] } },
})
assert.equal(metadataSetup.required, true)
assert.deepEqual(metadataSetup.ixs, [setupInstruction])
assert.deepEqual(setupBuilderOptions.initUserMetadata, { skipInitialization: false, skipLutCreation: true },
  'the isolated SDK setup initializes metadata without a lookup-table transaction')
assert.equal(setupBuilderCalls, 1)
const alreadyInitialized = await buildLoopMetadataSetupBundle({
  kaminoMarket: { getUserMetadata: async () => [metadataAddress, { owner: address(wallet) }] },
  owner: createNoopSigner(address(wallet)),
  sdkBuilder: async () => assert.fail('already initialized metadata must not produce a second setup transaction'),
})
assert.equal(alreadyInitialized.required, false)
await assert.rejects(buildLoopMetadataSetupBundle({
  kaminoMarket: { getUserMetadata: async () => [metadataAddress, null] },
  owner: createNoopSigner(address(wallet)),
  sdkBuilder: async () => ({ ixs: [setupInstruction, setupInstruction], luts: [] }),
}), /single SDK initialization/i, 'unexpected setup instructions fail closed')
const metadataState = new UserMetadata({
  referrer: address(wallet), bump: new BN(1), userLookupTable: address(wallet), owner: address(wallet),
  padding1: Array.from({ length: 51 }, () => new BN(0)), padding2: Array.from({ length: 64 }, () => new BN(0)),
})
const metadataData = Buffer.alloc(8 + UserMetadata.layout.span)
UserMetadata.discriminator.copy(metadataData)
UserMetadata.layout.encode(metadataState, metadataData, 8)
const setupBuiltFixture = { simulationContext: { kind: 'loop-setup', wallet, metadataAddress: String(metadataAddress) } }
assert.equal(verifyLoopMetadataSetupSimulation({ built: setupBuiltFixture, simulation: {
  ok: true, accountData: new Map([[String(metadataAddress), Uint8Array.from(metadataData)]]),
} }), true, 'setup is verified only when the simulated metadata account is owned by the wallet')
const foreignMetadataState = new UserMetadata({
  ...metadataState, owner: address('Vote111111111111111111111111111111111111111'),
})
const foreignMetadataData = Buffer.alloc(8 + UserMetadata.layout.span)
UserMetadata.discriminator.copy(foreignMetadataData)
UserMetadata.layout.encode(foreignMetadataState, foreignMetadataData, 8)
assert.equal(verifyLoopMetadataSetupSimulation({ built: setupBuiltFixture, simulation: {
  ok: true, accountData: new Map([[String(metadataAddress), Uint8Array.from(foreignMetadataData)]]),
} }), false)

const strategy = { enabled: false, unavailableReasons: [{ code: 'no-approval', message: 'Risk approval is not configured.' }], carry: { estimatedCarryPct: null } }
const preview = buildLoopPreview({
  fundingAmount: '1000', leverage: 1.5, strategy,
  maxBorrowLtvPct: 90, liquidationLtvPct: 95,
  leverageQuote: { fee: { mint: usdy, amountBaseUnits: '2000', bps: 10 } },
})
assert.equal(preview.exposure.grossCollateral, '1500')
assert.equal(preview.exposure.debt, '500')
assert.equal(preview.limits.projectedLtvPct, 38)
assert.equal(preview.risk.projectedLtvPct, '33.33333333333333333333333333333333333333')
assert.equal(preview.fees.length, 1)
assert.equal(preview.available, false)
assert.ok(preview.unavailableReasons.some((x) => x.code === 'no-approval'))

const adverseRoutePreview = buildLoopPreview({
  fundingAmount: '100', leverage: 1.5, strategy,
  maxBorrowLtvPct: 90, liquidationLtvPct: 95,
  riskInputs: { slippageBps: 50, priceImpactPct: 0.2, quoteAgeSeconds: 1, oracleAgeSeconds: 1, oracleHeartbeatSeconds: 60 },
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
  id: 'sol-usdy-usdc', enabled: false,
  unavailableReasons: [{ code: 'carry-acknowledgement-required', message: 'Acknowledge non-positive carry.' }],
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
const leverageRouteFixture = {
  provider: 'jupiter-v2-build', providerVersion: 'swap-v2-build', quoteAt: 1_800_000_000_000,
  inputMint: usdc, outputMint: usdy, inputAmountBaseUnits: '100000000', outputAmountBaseUnits: '89910000',
  minimumOutputBaseUnits: '89460450', slippageBps: 50, priceImpactPct: 0.2,
  fee: { bps: 10, mint: usdy, amountBaseUnits: '90000' }, routeProgramIds: ['OrcaWhirlpoolProgram1111111111111111111111'],
  routePlan: [{ percent: 100, swapInfo: { label: 'Orca Whirlpool', ammKey: 'OrcaPool11111111111111111111111111111111',
    inputMint: usdc, outputMint: usdy, inAmount: '100000000', outAmount: '90000000' } }],
}
const leverageQuote = {
  ...leverageRouteFixture, quoteAt: 1_800_000_000_100, inputAmountBaseUnits: '50000000', outputAmountBaseUnits: '44955000',
  minimumOutputBaseUnits: '44730225', fee: { bps: 10, mint: usdy, amountBaseUnits: '45000' },
  routePlan: [{ percent: 100, swapInfo: { ...leverageRouteFixture.routePlan[0].swapInfo, ammKey: 'AnotherOrcaPool111111111111111111111',
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
  leverageQuote, feePricesUsd: { [usdc]: 1, [usdy]: 1 }, sdkPosition: acknowledgementPosition,
  ...overrides,
})
const finalAcknowledgementPreview = makeAcknowledgementPreview()
assert.match(finalAcknowledgementPreview.carry.acknowledgementKey, /^[a-f0-9]{64}$/)
assert.equal(finalAcknowledgementPreview.available, true, 'a complete route preview can be available while awaiting carry acknowledgement')
assert.equal(finalAcknowledgementPreview.carry.acknowledgementPolicyVersion, 'nysa-loop-ack-v1')
const acknowledgementKeyArgs = {
  strategy: acknowledgementStrategy, fundingAmount: '100', leverage: 1.5,
  leverageQuote, preview: finalAcknowledgementPreview, sdkPosition: acknowledgementPosition,
}
assert.notEqual(createLoopAcknowledgementKey({ ...acknowledgementKeyArgs, policyVersion: 'nysa-loop-ack-v2' }), finalAcknowledgementPreview.carry.acknowledgementKey)
const changedAcknowledgementPreviews = [
  makeAcknowledgementPreview({ fundingAmount: '101' }),
  makeAcknowledgementPreview({ leverage: 1.4 }),
  makeAcknowledgementPreview({ leverageQuote: { ...leverageQuote, routePlan: [{ ...leverageQuote.routePlan[0], swapInfo: { ...leverageQuote.routePlan[0].swapInfo, ammKey: 'DifferentOrcaPool1111111111111111111111' } }] } }),
  makeAcknowledgementPreview({ leverageQuote: { ...leverageQuote, fee: { ...leverageQuote.fee, amountBaseUnits: '45001' } } }),
  makeAcknowledgementPreview({ sdkPosition: { ...acknowledgementPosition, flashFeeRatio: '0.002' } }),
  makeAcknowledgementPreview({ strategy: { ...acknowledgementStrategy, carry: { ...acknowledgementStrategy.carry, assumptions: { ...acknowledgementStrategy.carry.assumptions, collateralSupplyAprPct: 0.6 } } } }),
]
for (const changed of changedAcknowledgementPreviews) assert.notEqual(changed.carry.acknowledgementKey, finalAcknowledgementPreview.carry.acknowledgementKey)

console.log('loop preview ok')
