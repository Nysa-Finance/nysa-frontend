import assert from 'node:assert/strict'
import { LIVE, TOKENS } from '../src/config.js'
import { createPublicSwapQuote, parseSwapQuoteRequest, publicSwapQuote, marketForPair, swapPairAvailability, swapReadiness } from './swap-routes.js'
import { feeAccountEnv, swapFeeAccountsConfigured } from './swap.js'
import { getFeeReceiverMetadata } from './analytics.js'

const wallet = '11111111111111111111111111111111'
const usdc = TOKENS['svm-usdc']
const usdy = TOKENS['svm-usdy']
const request = { wallet, inputMint: usdc.mint, outputMint: usdy.mint, amountBaseUnits: '1000000', slippageBps: 50 }

const market = { id: 'sol-usdy-usdc', visible: true, kaminoMarket: 'market', reserves: LIVE[0].reserves, pairs: [{ collateral: 'svm-usdy', liability: 'svm-usdc' }] }
const allocatedVaults = { prime: { allocations: [{ market: 'market', reserve: LIVE[0].reserves['svm-usdc'], collateral: ['svm-usdy'], invested: 1 }] } }
const allocatedPair = swapPairAvailability({
  market, vaults: allocatedVaults, snapshotUpdatedAt: 1000, inputMint: usdc.mint, outputMint: usdy.mint, now: 1500,
})
assert.deepEqual(allocatedPair, { available: true, reasons: [] })
assert.ok(swapPairAvailability({ market, vaults: {}, snapshotUpdatedAt: 1000, inputMint: usdc.mint, outputMint: usdy.mint, now: 1500 }).reasons.some((r) => r.code === 'no-actual-allocation'))
assert.ok(swapPairAvailability({ market, vaults: allocatedVaults, snapshotUpdatedAt: 1000, inputMint: usdc.mint, outputMint: usdy.mint, now: 61_001 }).reasons.some((r) => r.code === 'market-data-stale'))
assert.ok(swapPairAvailability({ market: { ...market, visible: false }, vaults: allocatedVaults, snapshotUpdatedAt: 1000, inputMint: usdc.mint, outputMint: usdy.mint, now: 1500 }).reasons.some((r) => r.code === 'market-inactive'))

assert.deepEqual(parseSwapQuoteRequest(request), request)
assert.throws(() => parseSwapQuoteRequest({ ...request, inputMint: 'unknown' }), /unsupported swap pair/i)
assert.throws(() => parseSwapQuoteRequest({ ...request, amountBaseUnits: '0' }), /positive integer/i)
assert.throws(() => parseSwapQuoteRequest({ ...request, amountBaseUnits: '1.5' }), /positive integer/i)
assert.throws(() => parseSwapQuoteRequest({ ...request, slippageBps: 51 }), /slippage/i)
assert.throws(() => parseSwapQuoteRequest({ ...request, wallet: 'bad' }), /wallet/i)
assert.throws(() => parseSwapQuoteRequest({ ...request, outputMint: request.inputMint }), /unsupported swap pair/i)

const publicQuote = publicSwapQuote({
  provider: 'jupiter-v2-build', quoteAt: 1000, inputMint: request.inputMint, outputMint: request.outputMint,
  inputAmountBaseUnits: request.amountBaseUnits, outputAmountBaseUnits: '1080000', minimumOutputBaseUnits: '1074600',
  slippageBps: 50, priceImpactPct: 0.2, fee: { bps: 10, mint: usdy.mint, amountBaseUnits: '1080' },
  routePlan: [{ swapInfo: { label: 'Whirlpool', inputMint: usdc.mint, outputMint: usdy.mint, inAmount: '1000000', outAmount: '1081080' }, percent: 100 }],
  programIds: ['program'], programPolicy: { approved: false, unreviewed: [{ programId: 'program', reason: 'No evidence record exists.' }] },
  executable: false, instructions: [{ secretLike: 'never expose' }], addressesByLookupTableAddress: { hidden: [] },
}, { now: () => 1500 })
assert.equal(publicQuote.expiresAt, 16_000)
assert.equal(publicQuote.executable, false)
assert.equal(publicQuote.routePlan[0].label, 'Whirlpool')
assert.equal('instructions' in publicQuote, false)
assert.equal('addressesByLookupTableAddress' in publicQuote, false)
assert.equal(JSON.stringify(publicQuote).includes('never expose'), false)
const expiredQuote = publicSwapQuote({
  provider: 'jupiter-v2-build', quoteAt: 1000, inputMint: request.inputMint, outputMint: request.outputMint,
  inputAmountBaseUnits: request.amountBaseUnits, outputAmountBaseUnits: '1', minimumOutputBaseUnits: '1',
  slippageBps: 50, priceImpactPct: 0, executable: true, programPolicy: { approved: true, unreviewed: [] },
}, { now: () => 16_000 })
assert.equal(expiredQuote.quoteFresh, false)
assert.equal(expiredQuote.executable, false, 'expired quote cannot be executable')
assert.ok(expiredQuote.executionUnavailableReasons.some((reason) => reason.code === 'quote-expired'))

let providerRequest
const requestSignal = new AbortController().signal
const quoteResult = await createPublicSwapQuote(request, {
  now: () => 1500,
  signal: requestSignal,
  feeAccountResolver: (mint) => ({ account: 'fee-account', mint }),
  buildSwapFn: async (params) => {
    providerRequest = params
    return {
      provider: 'jupiter-v2-build', quoteAt: 1000, inputMint: params.inputMint, outputMint: params.outputMint,
      inputAmountBaseUnits: params.inputAmountBaseUnits, outputAmountBaseUnits: '1080000', minimumOutputBaseUnits: '1074600',
      slippageBps: params.slippageBps, priceImpactPct: 0.2, fee: { bps: 10, mint: params.feeAccountMint, amountBaseUnits: '1080' },
      routePlan: [], programPolicy: { approved: false, unreviewed: [] }, executable: false,
      feeAccountMintVerified: true, feeBalanceDeltaVerified: false,
    }
  },
})
assert.equal(providerRequest.inputAmountBaseUnits, request.amountBaseUnits)
assert.equal(providerRequest.feeAccountMint, usdy.mint)
assert.equal(providerRequest.feeBalanceDeltaVerified, false)
assert.equal(providerRequest.signal, requestSignal)
assert.equal(quoteResult.executable, false)
await assert.rejects(createPublicSwapQuote(request, { feeAccountResolver: () => null }), /fee account is configured/i)

assert.equal(swapReadiness({ providerConfigured: false, feeAccountsConfigured: true, marketDataAvailable: true }).executionEnabled, false)
assert.equal(swapReadiness({ providerConfigured: true, feeAccountsConfigured: false, marketDataAvailable: true }).executionEnabled, false)
assert.equal(swapReadiness({ providerConfigured: true, feeAccountsConfigured: true, marketDataAvailable: false }).executionEnabled, false)
assert.equal(swapReadiness({ providerConfigured: true, feeAccountsConfigured: true, marketDataAvailable: true }).executionEnabled, true)
assert.deepEqual(swapReadiness({ providerConfigured: true, feeAccountsConfigured: true, walletEnabled: false, marketDataAvailable: true }).unavailableReasons
  .map((r) => r.code), ['swap-wallet-not-enabled'], 'a wallet outside the SWAP_WALLETS beta cannot execute')

// A pair finds its market either way round; mints outside every pair find none.
assert.equal(marketForPair(usdc.mint, usdy.mint), LIVE[0])
assert.equal(marketForPair(usdy.mint, usdc.mint), LIVE[0])
assert.equal(marketForPair(usdc.mint, usdc.mint), null)
assert.equal(marketForPair(), LIVE[0], 'no pair asked: the first market')
// Fee account env var from the token name; swap stays off until every swap token has one.
assert.equal(feeAccountEnv({ name: 'USDC' }), 'SWAP_FEE_ACCOUNT_USDC')
assert.equal(feeAccountEnv({ name: 'oTFY' }), 'SWAP_FEE_ACCOUNT_OTFY')
assert.equal(feeAccountEnv({ name: 'USD₮0' }), 'SWAP_FEE_ACCOUNT_USD_0')
const savedEnv = { ...process.env }
Object.assign(process.env, { SWAP_FEE_ACCOUNT_USDC: wallet, SWAP_FEE_TREASURY_AUTHORITY: wallet })
delete process.env.SWAP_FEE_ACCOUNT_USDY
assert.equal(swapFeeAccountsConfigured(), false, 'a swap token without a fee account keeps swap off')
process.env.SWAP_FEE_ACCOUNT_USDY = wallet
assert.equal(swapFeeAccountsConfigured(), true)
process.env = savedEnv
// Analytics lists a fee receiver for every swap token, read from its env var.
assert.deepEqual(getFeeReceiverMetadata({ env: { SWAP_FEE_ACCOUNT_USDC: wallet }, rpcUrl: 'https://rpc.example' }).accounts.map((a) => [a.tokenId, a.address]),
  [['svm-usdc', wallet], ['svm-usdy', null]])

console.log('swap routes ok')
