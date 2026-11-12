import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { address, AccountRole, appendTransactionMessageInstructions, compileTransaction, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, partiallySignTransaction, signBytes, compressTransactionMessageUsingAddressLookupTables, createTransactionMessage, getBase64EncodedWireTransaction, getTransactionDecoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit'
import { createSwapExecutionService, createAuthorizedSwapSender, compileSwapTransaction, decodeJupiterV6RouteInstruction, assertSwapQuoteFresh, swapIntentStillAuthorized, SwapExecutionError, assertSwapSimulationEffects, validateProviderSwapInstructions } from './swap-execution.js'
import { createSwapIntentStore, messageMatchesWithLighthouse } from './tx-intent.js'
import { TOKENS } from '../src/config.js'
import { ataOf } from './account.js'
import { ROUTE_PROGRAM_IDS_BY_LABEL } from './program-policy.js'

const capturedFixture = JSON.parse(await readFile(new URL('../tests/fixtures/jupiter-v2-build-whirlpool-route.json', import.meta.url), 'utf8'))

function instructionFromCapture(instruction) {
  return {
    programAddress: address(instruction.programId),
    accounts: instruction.accounts.map((meta) => ({
      address: address(meta.pubkey),
      role: meta.isSigner
        ? meta.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
        : meta.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: Uint8Array.from(Buffer.from(instruction.data, 'base64')),
  }
}

const capturedResponse = capturedFixture.response
const capturedBuildRequest = capturedFixture.capture.request
assert.equal(capturedFixture.capture.endpoint, 'https://api.jup.ag/swap/v2/build')
assert.match(capturedFixture.capture.capturedAt, /^2026-11-05T/)
assert.equal(capturedBuildRequest.taker, '29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2')
assert.equal(capturedBuildRequest.feeAccount, '2xea9jWJ9eca3dFiefTeSPP85c6qXqunCqL2h2JNffMW')
assert.ok(capturedFixture.capture.omittedFields.includes('blockhashWithMetadata'))
const capturedRouteProgramIdsByLabel = Object.fromEntries([...new Set(capturedResponse.routePlan.map((leg) => leg.swapInfo.label))]
  .map((label) => [label, ROUTE_PROGRAM_IDS_BY_LABEL[label] ?? []]))
const capturedRequest = {
  wallet: capturedBuildRequest.taker,
  inputMint: capturedBuildRequest.inputMint,
  outputMint: capturedBuildRequest.outputMint,
  amountBaseUnits: capturedBuildRequest.amount,
  slippageBps: Number(capturedBuildRequest.slippageBps),
}
const capturedInstructions = {
  computeBudgetInstructions: capturedResponse.computeBudgetInstructions.map(instructionFromCapture),
  setupInstructions: capturedResponse.setupInstructions.map(instructionFromCapture),
  swapInstruction: instructionFromCapture(capturedResponse.swapInstruction),
}
const capturedRouteOutput = BigInt(capturedResponse.routePlan.reduce((total, leg) =>
  leg.swapInfo.outputMint === capturedRequest.outputMint ? total + BigInt(leg.swapInfo.outAmount) : total, 0n))
const capturedNetOutput = BigInt(capturedResponse.outAmount)
const capturedFeeAmount = capturedRouteOutput - capturedNetOutput
const capturedBuilt = {
  ...capturedInstructions,
  provider: 'jupiter-v2-build',
  inputMint: capturedRequest.inputMint,
  outputMint: capturedRequest.outputMint,
  inputAmountBaseUnits: capturedResponse.inAmount,
  outputAmountBaseUnits: capturedResponse.outAmount,
  minimumOutputBaseUnits: String(capturedNetOutput * BigInt(10_000 - capturedRequest.slippageBps) / 10_000n),
  slippageBps: capturedRequest.slippageBps,
  fee: { bps: Number(capturedBuildRequest.platformFeeBps), mint: capturedRequest.outputMint, amountBaseUnits: String(capturedFeeAmount) },
  feeAccount: capturedBuildRequest.feeAccount,
  feeAccountMint: capturedRequest.outputMint,
  feeAccountMintVerified: true,
  feeBalanceDeltaVerified: true,
  routePlan: capturedResponse.routePlan.map((leg) => ({
    ...leg,
    swapInfo: { ...leg.swapInfo, programId: capturedRouteProgramIdsByLabel[leg.swapInfo.label]?.[0] },
  })),
  routeProgramIds: [...new Set(Object.values(capturedRouteProgramIdsByLabel).flat())],
  routeLabels: [...new Set(capturedResponse.routePlan.map((leg) => leg.swapInfo.label))],
  routeProgramIdsByLabel: capturedRouteProgramIdsByLabel,
  swapInstructionProgramId: capturedResponse.swapInstruction.programId,
  cleanupInstruction: capturedResponse.cleanupInstruction ? instructionFromCapture(capturedResponse.cleanupInstruction) : null,
  otherInstructions: capturedResponse.otherInstructions.map(instructionFromCapture),
  tipInstruction: capturedResponse.tipInstruction ? instructionFromCapture(capturedResponse.tipInstruction) : null,
  programIds: [...new Set([
    ...capturedResponse.computeBudgetInstructions,
    ...capturedResponse.setupInstructions,
    capturedResponse.swapInstruction,
  ].map((instruction) => instruction.programId).concat(Object.values(capturedRouteProgramIdsByLabel).flat()))],
  programPolicy: { approved: true },
  instructions: [
    ...capturedInstructions.computeBudgetInstructions,
    ...capturedInstructions.setupInstructions,
    capturedInstructions.swapInstruction,
  ],
  addressesByLookupTableAddress: capturedResponse.addressesByLookupTableAddress,
}

const capturedDecoded = decodeJupiterV6RouteInstruction(capturedBuilt.swapInstruction, capturedRequest, capturedBuilt)
assert.deepEqual(capturedDecoded, {
  inputAmount: capturedResponse.inAmount,
  quotedOutput: capturedResponse.outAmount,
  slippageBps: capturedResponse.slippageBps,
  platformFeeBps: Number(capturedBuildRequest.platformFeeBps),
  routeSteps: [{ variant: 47, aToB: false, bps: 10_000, inputIndex: 0, outputIndex: 1 }],
}, 'route parser expectations come from the sanitized live Jupiter Build fixture')

function serviceForCapturedBuild(built, intentStore, counters = {}) {
  return createSwapExecutionService({
    readiness: async () => ({ executionEnabled: true, unavailableReasons: [] }),
    buildRoute: async () => built,
    compile: async () => { counters.compile = (counters.compile ?? 0) + 1; throw new Error('must reject before compile') },
    simulate: async () => { counters.simulate = (counters.simulate ?? 0) + 1; throw new Error('must reject before simulation') },
    intentStore,
    now: () => Date.now(),
  })
}

const capturedIntentStore = createSwapIntentStore({ now: () => Date.now(), idFactory: () => 'captured-route-intent' })
const capturedCounters = {}
await assert.rejects(serviceForCapturedBuild(capturedBuilt, capturedIntentStore, capturedCounters).build(capturedRequest),
  /must reject before compile/, 'the captured live Jupiter route_v2 passes route validation and reaches compilation')
assert.equal(capturedCounters.compile, 1, 'the captured live route reaches compilation')
assert.equal(capturedIntentStore.size(), 0, 'no intent is issued before compilation and simulation succeed')

const adversarialCapturedBuilds = [
  ['executable moved while still present', (instruction) => {
    const accounts = instruction.accounts.slice()
    const executable = accounts.splice(11, 1)[0]
    accounts.push(executable)
    return { ...instruction, accounts }
  }],
  ['remaining CPI account substituted', (instruction) => {
    const accounts = instruction.accounts.slice()
    const poolAddress = capturedResponse.routePlan[0].swapInfo.ammKey
    const poolIndex = accounts.findIndex((meta) => String(meta.address) === poolAddress)
    assert.ok(poolIndex >= 11, 'fixture route pool must be present in Jupiter remaining accounts')
    accounts[poolIndex] = { ...accounts[poolIndex], address: accounts[poolIndex + 1].address }
    return { ...instruction, accounts }
  }],
  ['pool identity substituted against provider routePlan', (instruction) => {
    const accounts = instruction.accounts.slice()
    const poolAddress = capturedResponse.routePlan[0].swapInfo.ammKey
    const poolIndex = accounts.findIndex((meta) => String(meta.address) === poolAddress)
    assert.ok(poolIndex >= 11, 'fixture route pool must be present in Jupiter remaining accounts')
    accounts[poolIndex] = { ...accounts[poolIndex], address: capturedBuildRequest.feeAccount }
    return { ...instruction, accounts }
  }],
]
for (const [label, alter] of adversarialCapturedBuilds) {
  const alteredSwapInstruction = alter(capturedBuilt.swapInstruction)
  const alteredBuilt = {
    ...capturedBuilt,
    swapInstruction: alteredSwapInstruction,
    instructions: [...capturedBuilt.instructions.slice(0, -1), alteredSwapInstruction],
  }
  const intentStore = createSwapIntentStore({ now: () => Date.now(), idFactory: () => `adversarial-${label}` })
  const counters = {}
  await assert.rejects(serviceForCapturedBuild(alteredBuilt, intentStore, counters).build(capturedRequest),
    /WhirlpoolSwapV2.*(account|owner|data|invalid)|Jupiter.*account/i, `${label} must fail before intent`)
  assert.equal(counters.compile ?? 0, 0, `${label} must fail before compile`)
  assert.equal(intentStore.size(), 0, `${label} must fail before authorization intent issue`)
}

const wallet = '11111111111111111111111111111111'
const usdc = TOKENS['svm-usdc'].mint
const usdy = TOKENS['svm-usdy'].mint
const body = { wallet, inputMint: usdc, outputMint: usdy, amountBaseUnits: '1000000', slippageBps: 50 }
const BLOCKHASH = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const SYSTEM = '11111111111111111111111111111111'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const LUT = 'AddressLookupTab1e1111111111111111111111111'
const inputAta = await ataOf(address(wallet), address(usdc), address(TOKEN_PROGRAM))
const outputAta = await ataOf(address(wallet), address(usdy), address(TOKEN_PROGRAM))
const feeAccount = String(outputAta)
// Captured from Jupiter's live /swap/v2/build response (2026-11-05):
// USDC -> USDY, 1,000,000 raw input, 10 bps output fee, 50 bps slippage,
// direct Whirlpool route. All 27 accounts are retained, including DEX
// remaining pool, vault, oracle, tick, token-program and memo accounts.
const jupiterRouteData = Uint8Array.from(Buffer.from(
  'u2T6zDHErxRAQg8AAAAAAFI5DQAAAAAAMgAKAAAAAQAAAC8AABAnAAE=', 'base64',
))
const routeInstruction = {
  programAddress: address(JUPITER_V6),
  accounts: [
    [wallet, AccountRole.READONLY_SIGNER],
    ['HJt8Tjdsc9ms9i4WCZEzhzr4oyf3ANcdzXrNdLPFqm3M', AccountRole.WRITABLE],
    [outputAta, AccountRole.WRITABLE],
    [usdc, AccountRole.READONLY],
    [usdy, AccountRole.READONLY],
    [TOKEN_PROGRAM, AccountRole.READONLY],
    [TOKEN_PROGRAM, AccountRole.READONLY],
    [JUPITER_V6, AccountRole.READONLY],
    ['D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf', AccountRole.READONLY],
    [JUPITER_V6, AccountRole.READONLY],
    [outputAta, AccountRole.WRITABLE],
    [WHIRLPOOL, AccountRole.READONLY],
    [TOKEN_PROGRAM, AccountRole.READONLY],
    [TOKEN_PROGRAM, AccountRole.READONLY],
    [MEMO, AccountRole.READONLY],
    [SYSTEM, AccountRole.READONLY],
    ['AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD', AccountRole.WRITABLE],
    [usdy, AccountRole.READONLY],
    [usdc, AccountRole.READONLY],
    [outputAta, AccountRole.WRITABLE],
    ['7jLEfNKea3UUrRUbxVMjZQc8vLohAUaZ7vo3akpnWW8V', AccountRole.WRITABLE],
    ['HJt8Tjdsc9ms9i4WCZEzhzr4oyf3ANcdzXrNdLPFqm3M', AccountRole.WRITABLE],
    ['2vKEGgEzrDa3zGAdszdwmpygEYSTJvYVhPpp6WBY55eS', AccountRole.WRITABLE],
    ['Cm1m2KX9ffG4B9qyWipu3S4dM3fJ4S4mKiJv453wapgH', AccountRole.WRITABLE],
    ['BgqDRCeZwRx1vLrrqCSZDiEzR1HBJ8QKGENx9C7wDqJh', AccountRole.WRITABLE],
    ['EvSutM1EWAcxY2vkvsgLbkvY4asRpR4LqEALQMF1JmCx', AccountRole.WRITABLE],
    ['4PsbTRYTjM8ZcMFwcfPs7NnbMWJg7FwcMwEq7ety292P', AccountRole.WRITABLE],
  ].map(([account, role]) => ({ address: address(account), role })),
  data: jupiterRouteData,
}
let built = 0
const store = createSwapIntentStore({ now: () => 1000, idFactory: () => 'intent-1' })
const blocked = createSwapExecutionService({
  readiness: async () => ({ executionEnabled: false, unavailableReasons: [{ code: 'fork-proof-missing', message: 'Fork proof missing.' }] }),
  buildRoute: async () => { built++; throw new Error('must not quote') },
  intentStore: store,
})
await assert.rejects(blocked.build(body), (error) => error instanceof SwapExecutionError && /fork proof missing/i.test(error.message))
assert.equal(built, 0, 'execution gate must fail before asking Jupiter to build')

const route = {
  provider: 'jupiter-v2-build', providerVersion: 'swap-v2-build', quoteAt: 1000,
  inputMint: usdc, outputMint: usdy, inputAmountBaseUnits: '1000000',
  outputAmountBaseUnits: '866642', minimumOutputBaseUnits: '862308', slippageBps: 50,
  priceImpactPct: 0.2, fee: { bps: 10, mint: usdy, amountBaseUnits: '867', basisMint: usdy, basisAmountBaseUnits: '867509' },
  feeAccount, feeAccountMint: usdy, feeAccountMintVerified: true, programPolicy: { approved: true, unreviewed: [] },
  routePlan: [{ swapInfo: { label: 'Whirlpool', programId: WHIRLPOOL, inputMint: usdc, outputMint: usdy, inAmount: '1000000', outAmount: '867509' }, percent: 100, bps: 10000 }],
  routeProgramIds: [WHIRLPOOL], routeLabels: ['Whirlpool'],
  routeProgramIdsByLabel: { Whirlpool: [WHIRLPOOL] }, swapInstructionProgramId: JUPITER_V6,
  swapInstruction: routeInstruction, computeBudgetInstructions: [], setupInstructions: [],
  cleanupInstruction: null, otherInstructions: [], tipInstruction: null,
  programIds: [JUPITER_V6, WHIRLPOOL],
  instructions: [routeInstruction],
  addressesByLookupTableAddress: {},
}

assert.equal(Buffer.from(jupiterRouteData).subarray(0, 8).toString('hex'), 'bb64facc31c4af14',
  'captured Jupiter V6 route_v2 has its Anchor instruction discriminator')
assert.equal(routeInstruction.accounts.length, 27, 'the fixture includes actual DEX remaining accounts')
await assert.rejects(validateProviderSwapInstructions(body, route), /WhirlpoolSwapV2.*(account|owner|data|invalid)/i,
  'route_v2 user accounts must be the wallet ATAs')
const routeWithoutOptionalDestination = {
  ...route,
  swapInstruction: {
    ...routeInstruction,
    accounts: routeInstruction.accounts.map((meta, index) => index === 7
      ? { address: address(JUPITER_V6), role: AccountRole.READONLY }
      : meta),
  },
}
routeWithoutOptionalDestination.instructions = [routeWithoutOptionalDestination.swapInstruction]
await assert.rejects(validateProviderSwapInstructions(body, routeWithoutOptionalDestination), /WhirlpoolSwapV2.*(account|owner|data|invalid)/i)
assert.equal(Buffer.from(jupiterRouteData).toString('hex'), 'bb64facc31c4af1440420f000000000052390d000000000032000a000000010000002f000010270001',
  'the captured Jupiter V6 route_v2 bytes bind amounts, bps, and WhirlpoolSwapV2')
const legacyStep = Buffer.from([0x11, 0x01, 100, 0, 1])
const u16 = (value) => { const out = Buffer.alloc(2); out.writeUInt16LE(value); return out }
const u32 = (value) => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out }
const u64 = (value) => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out }
const legacyRouteData = Buffer.concat([
  Buffer.from('e517cb977ae3ad2a', 'hex'), u32(1), legacyStep, u64('1000000'), u64('866642'), u16(50), Buffer.from([10]),
])
const legacyRouteInstruction = {
  programAddress: address(JUPITER_V6),
  accounts: [
    { address: address(TOKEN_PROGRAM), role: AccountRole.READONLY },
    { address: address(wallet), role: AccountRole.READONLY_SIGNER },
    { address: inputAta, role: AccountRole.WRITABLE },
    { address: outputAta, role: AccountRole.WRITABLE },
    { address: address(JUPITER_V6), role: AccountRole.READONLY },
    { address: address(usdy), role: AccountRole.READONLY },
    { address: address(feeAccount), role: AccountRole.WRITABLE },
    { address: address(WHIRLPOOL), role: AccountRole.READONLY },
  ],
  data: Uint8Array.from(legacyRouteData),
}
assert.throws(() => decodeJupiterV6RouteInstruction(legacyRouteInstruction, body, route), /only exact-input route_v2/,
  'legacy route and sharedAccountsRoute are not decoded: only route_v2 is admitted')
const executableTestRoute = { ...route, swapInstruction: legacyRouteInstruction, instructions: [legacyRouteInstruction] }
const safeSwapWire = wire({ program: JUPITER_V6, accounts: legacyRouteInstruction.accounts, data: legacyRouteInstruction.data })
const legacyIntentStore = createSwapIntentStore({ now: () => Date.now(), idFactory: () => 'legacy-route-intent' })
const legacyCounters = {}
await assert.rejects(serviceForCapturedBuild(executableTestRoute, legacyIntentStore, legacyCounters).build(body),
  /only exact-input route_v2/,
  'legacy route must fail closed even when its remaining accounts contain the Whirlpool program key')
assert.equal(legacyCounters.compile ?? 0, 0, 'legacy route must fail before compile')
assert.equal(legacyCounters.simulate ?? 0, 0, 'legacy route must fail before simulation')
assert.equal(legacyIntentStore.size(), 0, 'legacy route must fail before intent issue')
const missingLegacyPoolMetas = {
  ...executableTestRoute,
  swapInstruction: {
    ...legacyRouteInstruction,
    // A duplicate Whirlpool key is not a valid substitute for the required pool/vault/tick/oracle CPI accounts.
    accounts: [...legacyRouteInstruction.accounts, { address: address(WHIRLPOOL), role: AccountRole.READONLY }],
  },
}
missingLegacyPoolMetas.instructions = [missingLegacyPoolMetas.swapInstruction]
const missingLegacyPoolStore = createSwapIntentStore({ now: () => Date.now(), idFactory: () => 'missing-legacy-pool' })
const missingLegacyCounters = {}
await assert.rejects(serviceForCapturedBuild(missingLegacyPoolMetas, missingLegacyPoolStore, missingLegacyCounters).build(body),
  /only exact-input route_v2/,
  'legacy route with missing pool metas must fail closed before intent')
assert.equal(missingLegacyCounters.compile ?? 0, 0)
assert.equal(missingLegacyPoolStore.size(), 0)
const sharedRouteInstruction = {
  programAddress: address(JUPITER_V6),
  accounts: [
    { address: address(TOKEN_PROGRAM), role: AccountRole.READONLY },
    { address: address(JUPITER_V6), role: AccountRole.READONLY },
    { address: address(wallet), role: AccountRole.READONLY_SIGNER },
    { address: inputAta, role: AccountRole.WRITABLE },
    { address: address(inputAta), role: AccountRole.WRITABLE },
    { address: address(outputAta), role: AccountRole.WRITABLE },
    { address: outputAta, role: AccountRole.WRITABLE },
    { address: address(usdc), role: AccountRole.READONLY },
    { address: address(usdy), role: AccountRole.READONLY },
    { address: address(feeAccount), role: AccountRole.WRITABLE },
    { address: address(JUPITER_V6), role: AccountRole.READONLY },
    { address: address(WHIRLPOOL), role: AccountRole.READONLY },
  ],
  data: Uint8Array.from(Buffer.concat([
    Buffer.from('c1209b3341d69c81', 'hex'), Buffer.from([7]), u32(1), legacyStep,
    u64('1000000'), u64('866642'), u16(50), Buffer.from([10]),
  ])),
}
const sharedRoute = {
  ...route,
  swapInstruction: sharedRouteInstruction,
  swapInstructionProgramId: JUPITER_V6,
  instructions: [sharedRouteInstruction],
}
const sharedIntentStore = createSwapIntentStore({ now: () => Date.now(), idFactory: () => 'shared-route-intent' })
const sharedCounters = {}
await assert.rejects(serviceForCapturedBuild(sharedRoute, sharedIntentStore, sharedCounters).build(body),
  /only exact-input route_v2/,
  'sharedAccountsRoute must fail closed when it supplies only bare DEX program membership')
assert.equal(sharedCounters.compile ?? 0, 0)
assert.equal(sharedIntentStore.size(), 0)
await assert.rejects(validateProviderSwapInstructions(body, {
  ...route,
  swapInstruction: { ...routeInstruction, data: Uint8Array.from([1, ...jupiterRouteData.slice(1)]) },
  instructions: [{ ...routeInstruction, data: Uint8Array.from([1, ...jupiterRouteData.slice(1)]) }],
}), /discriminator|unsupported|variant/i, 'unknown Anchor instruction variants fail closed')
for (const [label, change] of [
  ['input amount', (data) => data.fill(0, 8, 16)],
  ['quoted output', (data) => data.fill(0, 16, 24)],
  ['weakened output threshold', (data) => { data[24] = 0x01; data[25] = 0x00 }],
  ['platform fee', (data) => { data[26] = 0 }],
  ['positive slippage', (data) => { data[28] = 1 }],
  ['unsupported remaining-account metadata', (data) => { data[36] = 1 }],
  ['wrong encoded DEX route', (data) => { data[34] = 17 }],
  ['unsupported V6 variant', (data) => { data[0] = 1 }],
]) {
  const alteredData = Uint8Array.from(jupiterRouteData)
  change(alteredData)
  const altered = { ...route, swapInstruction: { ...routeInstruction, data: alteredData }, instructions: [{ ...routeInstruction, data: alteredData }] }
  await assert.rejects(validateProviderSwapInstructions(body, altered), /Jupiter|route|amount|output|slippage|fee|variant/i,
    `encoded ${label} must be checked independently from quote and simulation JSON`)
}
for (const [label, index, wrongAddress] of [
  ['source token account', 1, outputAta],
  ['destination token account', 2, inputAta],
  ['fee recipient', 10, inputAta],
]) {
const legacyAccountIndex = index === 1 ? 2 : index === 2 ? 3 : 6
  const alteredAccounts = legacyRouteInstruction.accounts.map((meta, accountIndex) => accountIndex === legacyAccountIndex ? { ...meta, address: wrongAddress } : meta)
  const alteredInstruction = { ...legacyRouteInstruction, accounts: alteredAccounts }
  await assert.rejects(validateProviderSwapInstructions(body, { ...executableTestRoute, swapInstruction: alteredInstruction, instructions: [alteredInstruction] }),
    /only exact-input route_v2/, `Jupiter ${label} must remain unavailable until CPI account validation exists`)
}
const compiledLocally = await compileSwapTransaction({
  request: body,
  built: { instructions: [{ programAddress: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), accounts: [], data: Uint8Array.from([1]) }], addressesByLookupTableAddress: {} },
  rpcClient: { getLatestBlockhash: () => ({ send: async () => ({ context: { slot: 55n }, value: { blockhash: 'SysvarRecentB1ockHashes11111111111111111111', lastValidBlockHeight: 100n } }) }) },
})
assert.ok(compiledLocally.size <= 1232)
assert.equal(compiledLocally.minContextSlot, 55)
assert.ok(compiledLocally.messageBytes instanceof Uint8Array)
await assert.rejects(compileSwapTransaction({
  request: body,
  built: { instructions: [], addressesByLookupTableAddress: { [LUT]: [usdc] } },
  rpcClient: {
    getLatestBlockhash: () => ({ send: async () => ({ context: { slot: 55n }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }) }),
  },
  lookupTableResolver: async () => [{ exists: true, data: { addresses: [usdy] } }],
}), /changed|could not be resolved/i, 'lookup contents must resolve against confirmed chain state before compile')
async function compileLookup(expectedAddresses, chainAddresses, data = {}) {
  return compileSwapTransaction({
    request: body,
    built: { instructions: [], addressesByLookupTableAddress: { [LUT]: expectedAddresses } },
    rpcClient: {
      getLatestBlockhash: () => ({ send: async () => ({ context: { slot: 55n }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }) }),
      getSlot: () => ({ send: async () => 55n }),
    },
    lookupTableResolver: async () => [{ exists: true, data: { addresses: chainAddresses, ...data } }],
  })
}
await assert.rejects(compileLookup([usdc, usdy], [usdy, usdc]), /index|changed|address/i,
  'a reordered lookup array must fail even if every expected key is a member')
await assert.rejects(compileLookup([usdc], [usdc, usdy]), /exact|length|changed|address/i,
  'a provider lookup subset must not stand in for the full chain lookup array')

let enabledCompileCalls = 0
let enabledSimulationCalls = 0
const enabledIntentStore = createSwapIntentStore({ now: () => 1000, idFactory: () => 'intent-1' })
const enabled = createSwapExecutionService({
  readiness: async () => ({ executionEnabled: true, unavailableReasons: [] }),
  buildRoute: async (request) => { assert.deepEqual(request, body); return { ...executableTestRoute } },
  compile: async () => { enabledCompileCalls++; return { tx: safeSwapWire, messageBytes: new Uint8Array(), size: 400 } },
  simulate: async () => { enabledSimulationCalls++; return { inputDeltaBaseUnits: '1000000', outputDeltaBaseUnits: '866642', feeDeltaBaseUnits: '867', additionalTokenDeltas: [] } },
  intentStore: enabledIntentStore,
  now: () => 1001,
})
await assert.rejects(enabled.build(body), /only exact-input route_v2/)
assert.equal(enabledCompileCalls, 0, 'legacy route must fail before compile even when release readiness is open')
assert.equal(enabledSimulationCalls, 0, 'legacy route must fail before simulation')
assert.equal(enabledIntentStore.size(), 0, 'legacy route must fail before intent issuance')
let tamperedCompiledSimulation = false
let tamperedCompileCalled = false
const tamperedCompile = createSwapExecutionService({
  readiness: async () => ({ executionEnabled: true }),
  buildRoute: async () => ({ ...executableTestRoute, feeAccount, feeAccountMint: usdy }),
  compile: async () => {
    tamperedCompileCalled = true
    const tx = wire({ program: WHIRLPOOL, accounts: legacyRouteInstruction.accounts, data: [9] })
    return { tx, messageBytes: getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64'))).messageBytes, size: 400 }
  },
  simulate: async () => { tamperedCompiledSimulation = true; return { inputDeltaBaseUnits: '1000000', outputDeltaBaseUnits: '866642', feeDeltaBaseUnits: '867', additionalTokenDeltas: [] } },
  intentStore: createSwapIntentStore({ now: () => 1000, idFactory: () => 'compiled-tamper' }), now: () => 1001,
})
await assert.rejects(tamperedCompile.build(body), /only exact-input route_v2/)
assert.equal(tamperedCompileCalled, false, 'unsupported legacy route must not produce a transaction to tamper with')
assert.equal(tamperedCompiledSimulation, false, 'unsupported legacy route must fail before simulation and authorization')
assert.throws(() => assertSwapSimulationEffects({
  inputAmountBaseUnits: '1000000', minimumOutputBaseUnits: '862308', feeAmountBaseUnits: '867',
}, { inputDeltaBaseUnits: '1000000', outputDeltaBaseUnits: '862308', feeDeltaBaseUnits: '866' }), /fee balance delta/i)
assert.throws(() => assertSwapSimulationEffects({
  inputAmountBaseUnits: '1000000', minimumOutputBaseUnits: '862308', feeAmountBaseUnits: '867',
}, { inputDeltaBaseUnits: '999999', outputDeltaBaseUnits: '862308', feeDeltaBaseUnits: '867' }), /input balance delta/i)
assert.throws(() => assertSwapSimulationEffects({
  inputAmountBaseUnits: '1000000', minimumOutputBaseUnits: '862308', feeAmountBaseUnits: '867',
}, { inputDeltaBaseUnits: '1000000', outputDeltaBaseUnits: '862307', feeDeltaBaseUnits: '867' }), /minimum output/i)
assert.throws(() => assertSwapSimulationEffects({
  inputAmountBaseUnits: '1000000', minimumOutputBaseUnits: '862308', feeAmountBaseUnits: '867',
}, { inputDeltaBaseUnits: '1000000', outputDeltaBaseUnits: '862308', feeDeltaBaseUnits: '867', additionalTokenDeltas: [{ mint: usdc, deltaBaseUnits: '1' }] }), /unrelated wallet token/i)

const unsafeBuildCases = [
  ['System transfer', (base) => [...base, { programAddress: address('11111111111111111111111111111111'), accounts: [], data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }]],
  ['unrelated token economics', (base) => [...base, { programAddress: address(TOKEN_PROGRAM), accounts: [], data: Uint8Array.from([3, 1, 0, 0, 0]) }]],
  ['unlisted program', (base) => [...base, { programAddress: address('Vote111111111111111111111111111111111111111'), accounts: [], data: Uint8Array.from([1]) }]],
  ['extra signer', (base) => [...base, { programAddress: address(MEMO), accounts: [{ address: address('Vote111111111111111111111111111111111111111'), role: AccountRole.READONLY_SIGNER }], data: Uint8Array.from([1]) }]],
  ['missing treasury recipient', (base) => [{ programAddress: address(MEMO), accounts: [{ address: address(usdy), role: AccountRole.READONLY }], data: Uint8Array.from([1]) }]],
  ['extra approved-program economics', (base) => [...base, { ...base[0], data: Uint8Array.from([99]) }]],
  ['ATA helper with wrong payer', (base) => [...base, {
    programAddress: address(ATA_PROGRAM),
    accounts: [
      { address: address('Vote111111111111111111111111111111111111111'), role: AccountRole.WRITABLE_SIGNER },
      { address: address('SysvarRent111111111111111111111111111111111'), role: AccountRole.WRITABLE },
      { address: address(wallet), role: AccountRole.READONLY }, { address: address(usdy), role: AccountRole.READONLY },
      { address: address(SYSTEM), role: AccountRole.READONLY }, { address: address(TOKEN_PROGRAM), role: AccountRole.READONLY },
    ], data: Uint8Array.from([1]),
  }]],
]

const validOutputAtaCreate = {
  programAddress: address(ATA_PROGRAM),
  accounts: [
    { address: address(wallet), role: AccountRole.WRITABLE_SIGNER },
    { address: outputAta, role: AccountRole.WRITABLE },
    { address: address(wallet), role: AccountRole.READONLY },
    { address: address(usdy), role: AccountRole.READONLY },
    { address: address(SYSTEM), role: AccountRole.READONLY },
    { address: address(TOKEN_PROGRAM), role: AccountRole.READONLY },
  ],
  data: Uint8Array.from([1]),
}
const invalidAtaCases = [
  ['payer', { ...validOutputAtaCreate, accounts: [{ ...validOutputAtaCreate.accounts[0], address: address(feeAccount) }, ...validOutputAtaCreate.accounts.slice(1)] }],
  ['owner', { ...validOutputAtaCreate, accounts: [...validOutputAtaCreate.accounts.slice(0, 2), { ...validOutputAtaCreate.accounts[2], address: address(feeAccount) }, ...validOutputAtaCreate.accounts.slice(3)] }],
  ['mint', { ...validOutputAtaCreate, accounts: [...validOutputAtaCreate.accounts.slice(0, 3), { ...validOutputAtaCreate.accounts[3], address: address('So11111111111111111111111111111111111111112') }, ...validOutputAtaCreate.accounts.slice(4)] }],
  ['derived', { ...validOutputAtaCreate, accounts: [...validOutputAtaCreate.accounts.slice(0, 1), { ...validOutputAtaCreate.accounts[1], address: address(inputAta) }, ...validOutputAtaCreate.accounts.slice(2)] }],
  ['opcode', { ...validOutputAtaCreate, data: Uint8Array.from([2]) }],
]
for (const [label, instruction] of invalidAtaCases) {
  const invalidSetup = {
    ...executableTestRoute,
    setupInstructions: [instruction],
    instructions: [instruction, legacyRouteInstruction],
    programIds: [JUPITER_V6, WHIRLPOOL, ATA_PROGRAM],
    feeAccount, feeAccountMint: usdy,
  }
  await assert.rejects(validateProviderSwapInstructions(body, invalidSetup), /signer|associated-token|associated token|setup/i,
    `associated-token ${label} must fail before route authorization`)
}
await assert.rejects(validateProviderSwapInstructions(body, {
  ...executableTestRoute,
  setupInstructions: [validOutputAtaCreate],
  instructions: [validOutputAtaCreate, legacyRouteInstruction],
  programIds: [JUPITER_V6, WHIRLPOOL, ATA_PROGRAM],
  feeAccount, feeAccountMint: usdy,
}), /only exact-input route_v2/, 'valid ATA setup still cannot make an unverified legacy route executable')

const approvedWhirlpoolInstruction = {
  programAddress: address(WHIRLPOOL),
  accounts: [],
  data: Uint8Array.from([2, 0, 16, 0, 0]),
}
const coherentWhirlpoolRoute = {
  ...executableTestRoute,
  routePlan: [{ ...executableTestRoute.routePlan[0], swapInfo: { ...executableTestRoute.routePlan[0].swapInfo, programId: WHIRLPOOL } }],
  routeProgramIds: [WHIRLPOOL],
  routeProgramIdsByLabel: { Whirlpool: [WHIRLPOOL] },
  programIds: [JUPITER_V6, WHIRLPOOL],
  setupInstructions: [approvedWhirlpoolInstruction],
  instructions: [approvedWhirlpoolInstruction, legacyRouteInstruction],
  feeAccount, feeAccountMint: usdy,
}
await assert.rejects(validateProviderSwapInstructions(body, coherentWhirlpoolRoute), /setup|economic|router|instruction/i,
  'an approved Whirlpool swap instruction duplicated into setup must still be rejected')
await assert.rejects(validateProviderSwapInstructions(body, {
  ...coherentWhirlpoolRoute,
  setupInstructions: [],
  computeBudgetInstructions: [approvedWhirlpoolInstruction],
}), /compute|instruction|program/i,
  'DEX instructions cannot be admitted through the compute-budget group')

for (const [label, alterInstructions] of unsafeBuildCases) {
  let compileCalls = 0
  const unsafe = createSwapExecutionService({
    readiness: async () => ({ executionEnabled: true }),
    buildRoute: async () => ({ ...executableTestRoute, instructions: alterInstructions(executableTestRoute.instructions) }),
    compile: async () => { compileCalls++; return { tx: safeSwapWire, messageBytes: getTransactionDecoder().decode(Uint8Array.from(Buffer.from(safeSwapWire, 'base64'))).messageBytes, size: 400 } },
    simulate: async () => ({ inputDeltaBaseUnits: '1000000', outputDeltaBaseUnits: '866642', feeDeltaBaseUnits: '867', additionalTokenDeltas: [] }),
    intentStore: createSwapIntentStore({ now: () => 1000, idFactory: () => `unsafe-${label}` }), now: () => 1001,
  })
  await assert.rejects(unsafe.build(body), /instruction|signer|treasury|economics|program|Legacy Jupiter/i, `${label} must fail before authorization`)
  assert.equal(compileCalls, 0, `${label} must fail before compile/simulation/intent issuance`)
}

let finishSimulation
let currentTime = 1001
const delayedSimulation = new Promise((resolve) => { finishSimulation = resolve })
const delayedQuoteTimestamp = currentTime
const delayedSimulationResult = delayedSimulation.then(() => assertSwapQuoteFresh(delayedQuoteTimestamp, currentTime))
finishSimulation({ inputDeltaBaseUnits: '1000000', outputDeltaBaseUnits: '866642', feeDeltaBaseUnits: '867' })
currentTime = 16_001
await assert.rejects(delayedSimulationResult, /expired/i, 'freshness is checked after delayed simulation completes')

function wire({ payer = wallet, program = TOKEN_PROGRAM, account = usdy, accounts = null, data = [1], secondInstruction = false, lookup = false } = {}) {
  const instructions = [{ programAddress: address(program), accounts: accounts ?? [{ address: address(account), role: AccountRole.READONLY }], data: Uint8Array.from(data) }]
  if (secondInstruction) instructions.push({ programAddress: address(MEMO), accounts: [], data: Uint8Array.from([2]) })
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayer(address(payer), value),
    (value) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 1n }, value),
    (value) => appendTransactionMessageInstructions(instructions, value),
  )
  if (lookup) message = compressTransactionMessageUsingAddressLookupTables(message, { [LUT]: [account] })
  return getBase64EncodedWireTransaction(compileTransaction(message))
}
const exactWire = wire()
const exact = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(exactWire, 'base64')))
const changed = wire({ data: [9] })
const senderStore = createSwapIntentStore({ now: () => 1000, idFactory: () => 'exact-intent' })
senderStore.issue({ wallet, messageBytes: exact.messageBytes, metadata: { fee: '10bps', programIds: [MEMO] } })
let relayed = null
const send = createAuthorizedSwapSender({ intentStore: senderStore, send: async (value) => (relayed = value, { signature: 'sig' }) })
const alteredMessages = [
  ['wallet', wire({ payer: 'Vote111111111111111111111111111111111111111' })],
  ['input mint', wire({ account: usdc })],
  ['output mint', wire({ account: 'SysvarRent111111111111111111111111111111111' })],
  ['treasury', wire({ account: 'Vote111111111111111111111111111111111111111' })],
  ['fee amount', wire({ data: [2] })],
  ['minimum output/slippage bound', wire({ data: [3] })],
  ['program id', wire({ program: MEMO })],
  ['lookup table', wire({ lookup: true })],
  ['instruction set', wire({ secondInstruction: true })],
]
for (const [label, tx] of alteredMessages) {
  await assert.rejects(send({ tx, wallet, intentId: 'exact-intent' }), /transaction changed/i, `${label} changes the authorized message`)
  assert.equal(relayed, null, `${label} tampering must not reach the relay`)
}
await assert.rejects(send({ tx: changed, wallet, intentId: 'exact-intent' }), /transaction changed/i)
assert.equal(relayed, null, 'altered transaction must not reach the relay')
assert.deepEqual(await send({ tx: exactWire, wallet, intentId: 'exact-intent' }), { signature: 'sig' })
assert.equal(relayed.tx, exactWire)
assert.equal(relayed.wallet, wallet)
assert.deepEqual(relayed.intent.metadata.programIds, [MEMO])

const closedStore = createSwapIntentStore({ now: () => 1000, idFactory: () => 'closed-intent' })
closedStore.issue({ wallet, messageBytes: getTransactionDecoder().decode(getTransactionEncoder().encode(exact)).messageBytes })
let closedRelayCalled = false
const closedSender = createAuthorizedSwapSender({
  intentStore: closedStore,
  authorize: async () => false,
  send: async () => (closedRelayCalled = true),
})
await assert.rejects(closedSender({ tx: exactWire, wallet, intentId: 'closed-intent' }), /readiness changed/i)
assert.equal(closedRelayCalled, false, 'relay must recheck readiness after the wallet signature')

const evidenceStore = createSwapIntentStore({ now: () => 1000, idFactory: () => 'evidence-intent' })
evidenceStore.issue({ wallet, messageBytes: exact.messageBytes, metadata: { programIds: [MEMO] } })
let currentEvidenceApproved = true
let evidenceRelayCalled = false
const evidenceSender = createAuthorizedSwapSender({
  intentStore: evidenceStore,
  authorize: async (intent) => currentEvidenceApproved && intent.metadata.programIds.every((id) => id === MEMO),
  send: async () => (evidenceRelayCalled = true),
})
currentEvidenceApproved = false
await assert.rejects(evidenceSender({ tx: exactWire, wallet, intentId: 'evidence-intent' }), /readiness changed/i)
assert.equal(evidenceRelayCalled, false, 'relay must re-evaluate exact route program evidence at send time')

const exactEvidenceIntent = { metadata: {
  programIds: [MEMO], routeLabels: ['TestDex'], routeProgramIdsByLabel: { TestDex: [MEMO] },
} }
const approvedPrograms = new Set([MEMO])
assert.equal(swapIntentStillAuthorized(exactEvidenceIntent, { executionEnabled: true, approvedPrograms }), true)
assert.equal(swapIntentStillAuthorized(exactEvidenceIntent, { executionEnabled: true }), false,
  'a program off the approved list blocks relay even after a route was signed')
assert.equal(swapIntentStillAuthorized(exactEvidenceIntent, { executionEnabled: false, approvedPrograms }), false)

// Phantom appends Lighthouse guard instructions when it signs: the swap relay accepts those and nothing else, and a
// changed message is a definite refusal (SwapExecutionError, HTTP 400), not an unknown outcome.
const guardPayer = await generateKeyPairSigner()
const guardWallet = String(guardPayer.address)
const swapMessage = (data, extra = []) => compileTransaction(pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayer(guardPayer.address, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 2n }, m),
  (m) => appendTransactionMessageInstructions([
    { programAddress: address(JUPITER_V6), accounts: [{ address: guardPayer.address, role: AccountRole.WRITABLE_SIGNER }], data: Uint8Array.of(data) },
    ...extra,
  ], m),
))
const lighthouseGuard = {
  programAddress: address('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
  accounts: [{ address: guardPayer.address, role: AccountRole.READONLY }], // asserts on an account already in the swap
  data: Uint8Array.from([5, 0, 6, 0, 0]),
}
const signedWire = async (compiled) => getBase64EncodedWireTransaction(await partiallySignTransaction([guardPayer.keyPair], compiled))
let guardIntent = 0
const guardStore = createSwapIntentStore({ messageMatcher: messageMatchesWithLighthouse, idFactory: () => `guard-${++guardIntent}` })
let guardRelayed = 0
const guardSender = createAuthorizedSwapSender({ intentStore: guardStore, send: async () => ++guardRelayed })
guardStore.issue({ wallet: guardWallet, messageBytes: swapMessage(1).messageBytes, metadata: {} })
await guardSender({ tx: await signedWire(swapMessage(1, [lighthouseGuard])), wallet: guardWallet, intentId: 'guard-1' })
assert.equal(guardRelayed, 1, 'a swap signed with an appended Lighthouse guard is relayed')
guardStore.issue({ wallet: guardWallet, messageBytes: swapMessage(1).messageBytes, metadata: {} })
await assert.rejects(guardSender({ tx: await signedWire(swapMessage(2, [lighthouseGuard])), wallet: guardWallet, intentId: 'guard-2' }),
  (error) => error instanceof SwapExecutionError && /changed after authorization/i.test(error.message),
  'a changed swap message is refused as a SwapExecutionError')
assert.equal(guardRelayed, 1)

// What Phantom actually sends (captured on mainnet): the same instructions, its readonly static keys recompiled into a
// different order with the Lighthouse program among them, and assertions using log level 4.
const phantomBuilt = swapMessage(1, [
  { programAddress: address(ATA_PROGRAM), accounts: [{ address: guardPayer.address, role: AccountRole.WRITABLE_SIGNER }], data: Uint8Array.of(1) },
  { programAddress: address(MEMO), accounts: [], data: Uint8Array.of(9) },
])
const builtMessage = getCompiledTransactionMessageDecoder().decode(phantomBuilt.messageBytes)
const builtKeys = builtMessage.staticAccounts.map(String)
const readonlyStart = builtKeys.length - builtMessage.header.numReadonlyNonSignerAccounts
const reorderedKeys = [...builtKeys.slice(0, readonlyStart), ...builtKeys.slice(readonlyStart).reverse(), 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95']
const remap = (index) => reorderedKeys.indexOf(builtKeys[index])
const phantomMessageBytes = getCompiledTransactionMessageEncoder().encode({
  ...builtMessage,
  header: { ...builtMessage.header, numReadonlyNonSignerAccounts: builtMessage.header.numReadonlyNonSignerAccounts + 1 },
  staticAccounts: reorderedKeys.map(address),
  instructions: [
    ...builtMessage.instructions.map((ix) => ({ ...ix, programAddressIndex: remap(ix.programAddressIndex), accountIndices: (ix.accountIndices ?? []).map(remap) })),
    { programAddressIndex: reorderedKeys.length - 1, accountIndices: [0], data: Uint8Array.from(Buffer.from('06040300808a5e07000000000403000001000000000000000000', 'hex')) },
  ],
})
assert.notDeepEqual(reorderedKeys.slice(0, builtKeys.length), builtKeys, 'the fixture reorders the readonly static keys')
const phantomWire = Buffer.concat([ // wire format: one signature (shortvec 1), the signature, then the message
  Uint8Array.of(1), await signBytes(guardPayer.keyPair.privateKey, phantomMessageBytes), phantomMessageBytes,
]).toString('base64')
guardStore.issue({ wallet: guardWallet, messageBytes: phantomBuilt.messageBytes, metadata: {} })
await guardSender({ tx: phantomWire, wallet: guardWallet, intentId: 'guard-3' })
assert.equal(guardRelayed, 2, 'Phantom\'s reordered static keys and log-level-4 Lighthouse assertions are relayed')

console.log('swap execution guard ok')
