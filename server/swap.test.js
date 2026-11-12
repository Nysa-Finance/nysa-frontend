import assert from 'node:assert/strict'
import { TOKENS } from '../src/config.js'
import { buildSwap, createKeylessRateLimiter, inspectFeeTokenAccount } from './swap.js'
import { getAddressEncoder, address } from '@solana/kit'

const inputMint = TOKENS['svm-usdc'].mint
const outputMint = TOKENS['svm-usdy'].mint
const wallet = '11111111111111111111111111111111'
const feeAccount = 'SysvarRent111111111111111111111111111111111'
const routerProgram = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const venueProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const tokenProgram = venueProgram
let fakeTime = 0
const waits = []
const limiter = createKeylessRateLimiter({
  now: () => fakeTime,
  sleep: async (milliseconds) => { waits.push(milliseconds); fakeTime += milliseconds },
})
await limiter()
await limiter()
await limiter()
assert.deepEqual(waits, [2100, 2100]) // keyless Jupiter has a documented 0.5 RPS cap

const heldSleeps = []
const boundedLimiter = createKeylessRateLimiter({
  intervalMs: 100,
  maxPending: 2,
  maxWaitMs: 1_000,
  now: () => 0,
  sleep: (milliseconds, signal) => new Promise((resolve, reject) => {
    const item = { milliseconds, resolve, reject }
    heldSleeps.push(item)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  }),
})
await boundedLimiter()
const pendingController = new AbortController()
const pendingFirst = boundedLimiter(pendingController.signal)
const pendingSecond = boundedLimiter()
assert.deepEqual(heldSleeps.map((item) => item.milliseconds), [100, 200])
const saturation = await Promise.race([
  assert.rejects(boundedLimiter(), (error) => error.code === 'KEYLESS_PROVIDER_BUSY').then(() => true, () => false),
  new Promise((resolve) => setTimeout(() => resolve(false), 50)),
])
assert.equal(saturation, true)
pendingController.abort(new DOMException('cancelled', 'AbortError'))
await assert.rejects(pendingFirst, (error) => error.name === 'AbortError')
heldSleeps[1].resolve()
await pendingSecond

const deadlineLimiter = createKeylessRateLimiter({
  intervalMs: 100,
  maxPending: 4,
  maxWaitMs: 50,
  now: () => 0,
  sleep: async () => {},
})
await deadlineLimiter()
await assert.rejects(deadlineLimiter(), (error) => error.code === 'KEYLESS_PROVIDER_BUSY')
const encoder = getAddressEncoder()
const feeAccountData = new Uint8Array(165)
feeAccountData.set(encoder.encode(address(inputMint)), 0)
feeAccountData.set(encoder.encode(address(wallet)), 32)
feeAccountData[108] = 1
assert.deepEqual(inspectFeeTokenAccount({ exists: true, programAddress: tokenProgram, data: feeAccountData }), {
  mint: inputMint, authority: wallet, tokenProgram, initialized: true,
})
assert.equal(inspectFeeTokenAccount({ exists: false }), null)
assert.equal(inspectFeeTokenAccount({ exists: true, programAddress: tokenProgram, data: new Uint8Array(10) }), null)
assert.equal(inspectFeeTokenAccount({ exists: true, programAddress: tokenProgram, data: new Uint8Array(165) }), null)
const feeAccountVerifierFor = (mint) => async () => ({ mint, authority: wallet, tokenProgram, initialized: true })
const buildResponse = ({ overrides = {} } = {}) => ({
  inputMint,
  outputMint,
  inAmount: '100000000',
  outAmount: '90000000',
  otherAmountThreshold: '89550000',
  slippageBps: 50,
  priceImpactPct: '0.004',
  platformFee: { amount: '100000', feeBps: 10, feeMint: inputMint },
  routePlan: [{ swapInfo: { label: 'Reviewed Test Venue', ammKey: wallet, inputMint, outputMint, inAmount: '99900000', outAmount: '90000000' } }],
  computeBudgetInstructions: [],
  setupInstructions: [],
  swapInstruction: { programId: routerProgram, accounts: [{ pubkey: wallet, isSigner: false, isWritable: true }], data: 'AQ==' },
  cleanupInstruction: null,
  otherInstructions: [],
  tipInstruction: null,
  addressesByLookupTableAddress: {},
  ...overrides,
})
const approvedPrograms = new Set([routerProgram, venueProgram])

let request
const fetcher = async (url, init) => {
  request = { url: new URL(url), init }
  return { ok: true, status: 200, json: async () => buildResponse() }
}

const result = await buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
  providerApiKey: 'test-key', fetcher, approvedPrograms,
  routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] }, feeAccountAuthority: wallet,
  feeAccountVerifier: feeAccountVerifierFor(inputMint), feeBalanceDeltaVerified: true,
  now: () => 1_800_000_000_000,
})
assert.equal(request.url.pathname, '/swap/v2/build')
assert.equal(request.url.searchParams.get('amount'), '100000000')
assert.equal(request.url.searchParams.get('platformFeeBps'), '10')
assert.equal(request.url.searchParams.get('feeAccount'), feeAccount)
assert.equal(request.url.searchParams.get('taker'), wallet)
assert.equal(request.init.headers['x-api-key'], 'test-key')
assert.equal(result.inputAmountBaseUnits, '100000000')
assert.deepEqual(result.fee, { bps: 10, mint: inputMint, basisMint: inputMint, basisAmountBaseUnits: '100000000', amountBaseUnits: '100000', providerReported: true, routeDeltaVerified: true })
assert.equal(result.outputAmountBaseUnits, '90000000')
assert.equal(result.minimumOutputBaseUnits, '89550000')
assert.equal(result.priceImpactPct, 0.4)
assert.equal(result.programPolicy.approved, true)
assert.equal(result.executable, true)
assert.equal(result.instructions.length, 1)
assert.equal(result.instructions[0].programAddress, routerProgram)
assert.deepEqual([...result.instructions[0].data], [1])
assert.deepEqual(result.routeProgramIds, [venueProgram])

const roundedThreshold = await buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
  providerApiKey: 'test-key', approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] },
  now: () => 1_800_000_000_000,
  fetcher: async () => ({ ok: true, status: 200, json: async () => buildResponse({ overrides: {
    outAmount: '90000001', otherAmountThreshold: '89550001',
    routePlan: [{ swapInfo: { label: 'Reviewed Test Venue', ammKey: wallet, inputMint, outputMint, inAmount: '99900000', outAmount: '90000001' } }],
  } }) }),
})
assert.equal(roundedThreshold.minimumOutputBaseUnits, '89550000',
  'authorized minimum uses the exact floor guaranteed by the encoded Jupiter slippage, not a rounded-up API display threshold')

const noFeeMetadata = await buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
  providerApiKey: 'test-key', fetcher: async () => ({ ok: true, status: 200, json: async () => buildResponse({ overrides: { platformFee: undefined } }) }),
  approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] }, now: () => 1_800_000_000_000,
})
assert.equal(noFeeMetadata.fee.amountBaseUnits, '100000')
assert.equal(noFeeMetadata.fee.providerReported, false)
assert.equal(noFeeMetadata.fee.routeDeltaVerified, true) // derived from provider input amount and routePlan leg amounts
assert.equal(noFeeMetadata.executable, false) // requires actual account-mint and simulated fee-balance verification

const outputFee = await buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount: 'SysvarC1ock11111111111111111111111111111111', feeAccountMint: outputMint,
  providerApiKey: 'test-key', approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] },
  feeAccountAuthority: wallet, feeAccountVerifier: feeAccountVerifierFor(outputMint), feeBalanceDeltaVerified: true,
  now: () => 1_800_000_000_000,
  fetcher: async () => ({ ok: true, status: 200, json: async () => buildResponse({ overrides: {
    outAmount: '90000000', otherAmountThreshold: '89550000',
    platformFee: { amount: '90090', feeBps: 10, feeMint: outputMint },
    routePlan: [{ swapInfo: { label: 'Reviewed Test Venue', ammKey: wallet, inputMint, outputMint, inAmount: '100000000', outAmount: '90090090' } }],
  } }) }),
})
assert.deepEqual(outputFee.fee, { bps: 10, mint: outputMint, basisMint: outputMint, basisAmountBaseUnits: '90090090', amountBaseUnits: '90090', providerReported: true, routeDeltaVerified: true })
assert.equal(outputFee.outputAmountBaseUnits, '90000000')
assert.equal(outputFee.executable, true)

const unreviewed = await buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
  providerApiKey: 'test-key', fetcher, approvedPrograms: new Set(), routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] }, now: () => 1_800_000_000_000,
})
assert.equal(unreviewed.executable, false)
assert.ok(unreviewed.programPolicy.unreviewed.length > 0)

for (const invalid of [
  { feeAccountMint: 'So11111111111111111111111111111111111111112' },
  { inputAmountBaseUnits: '-1' },
  { inputAmountBaseUnits: '0' },
  { slippageBps: 51 },
  { feeAccount: undefined },
]) {
  await assert.rejects(buildSwap({
    inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
    providerApiKey: 'test-key', fetcher, approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] }, now: () => 1_800_000_000_000, ...invalid,
  }), /swap|fee|amount|slippage/i)
}

await assert.rejects(buildSwap({ inputMint: wallet, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint, providerApiKey: 'test-key', fetcher, approvedPrograms }), /mint/i)
await assert.rejects(buildSwap({ inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, providerApiKey: 'test-key', fetcher, approvedPrograms }), /fee account/i)

await assert.rejects(buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
    providerApiKey: 'test-key', approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] }, fetcher: async () => ({ ok: false, status: 429, json: async () => ({ error: 'secret response details' }) }),
}), (error) => error.message === 'Swap provider is temporarily unavailable.' && !error.message.includes('secret'))

for (const response of [
  buildResponse({ overrides: { outputMint: inputMint } }),
  buildResponse({ overrides: { inAmount: '99999999' } }),
  buildResponse({ overrides: { otherAmountThreshold: '90000001' } }),
  buildResponse({ overrides: { platformFee: { amount: '99999', feeBps: 10, feeMint: inputMint } } }),
  buildResponse({ overrides: { platformFee: { amount: '100000', feeBps: 10, feeMint: outputMint } } }),
  buildResponse({ overrides: { routePlan: [] } }),
]) {
  await assert.rejects(buildSwap({
    inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
    providerApiKey: 'test-key', approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] }, fetcher: async () => ({ ok: true, status: 200, json: async () => response }),
    now: () => 1_800_000_000_000,
  }), /swap|fee|route|amount/i)
}

const noProgramMapping = await buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
  providerApiKey: 'test-key', fetcher, approvedPrograms, now: () => 1_800_000_000_000,
})
assert.equal(noProgramMapping.executable, false)
assert.ok(noProgramMapping.programPolicy.unreviewed.some((x) => x.routeLabel === 'Reviewed Test Venue'))

const unverifiedFeeAccount = await buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
  providerApiKey: 'test-key', fetcher, approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] },
  feeBalanceDeltaVerified: true, now: () => 1_800_000_000_000,
})
assert.equal(unverifiedFeeAccount.executable, false)

await assert.rejects(buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
  providerApiKey: 'test-key', fetcher, approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] },
  feeAccountAuthority: wallet, feeAccountVerifier: feeAccountVerifierFor(outputMint), now: () => 1_800_000_000_000,
}), /fee account/i)

const keylessRequest = await buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
  fetcher: async (url, init) => {
    assert.equal(init.headers['x-api-key'], undefined)
    return { ok: true, status: 200, json: async () => buildResponse() }
  },
  approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] }, now: () => 1_800_000_000_000,
  keylessRateLimiter: async () => {},
})
assert.equal(keylessRequest.provider, 'jupiter-v2-build')

let saturationFetcherCalled = false
await assert.rejects(buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: '100000000', wallet, feeAccount, feeAccountMint: inputMint,
  fetcher: async () => { saturationFetcherCalled = true; return { ok: true, status: 200, json: async () => buildResponse() } },
  approvedPrograms, routeProgramIdsByLabel: { 'Reviewed Test Venue': [venueProgram] }, now: () => 1_800_000_000_000,
  keylessRateLimiter: async () => { const error = new Error('private limiter details'); error.code = 'KEYLESS_PROVIDER_BUSY'; throw error },
}), (error) => error.message === 'Swap provider is busy; try again shortly.' && error.code === undefined)
assert.equal(saturationFetcherCalled, false)

console.log('swap adapter ok')
