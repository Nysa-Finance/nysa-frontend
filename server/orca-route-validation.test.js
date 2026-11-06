import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { address, AccountRole } from '@solana/kit'
import { AccountState, getMintEncoder, getTokenEncoder } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
import {
  WHIRLPOOL_PROGRAM_ADDRESS,
  getOracleAddress,
  getOracleEncoder,
  getDynamicTickArrayEncoder,
  getTickArrayAddress,
  getTickArrayEncoder,
  getWhirlpoolEncoder,
} from '@orca-so/whirlpools-client'
import { ataOf } from './account.js'
import { validateProviderSwapInstructions } from './swap-execution.js'

const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/jupiter-v2-build-whirlpool-route.json', import.meta.url), 'utf8'))
const captured = fixture.response
const wallet = fixture.capture.request.taker
const inputMint = fixture.capture.request.inputMint
const outputMint = fixture.capture.request.outputMint
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const systemProgram = '11111111111111111111111111111111'
const associatedTokenProgram = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const memoProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const jupiterProgram = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const eventAuthority = 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf'
const pool = captured.routePlan[0].swapInfo.ammKey
const vaultA = '7jLEfNKea3UUrRUbxVMjZQc8vLohAUaZ7vo3akpnWW8V'
const vaultB = '2vKEGgEzrDa3zGAdszdwmpygEYSTJvYVhPpp6WBY55eS'
const feeAccount = fixture.capture.request.feeAccount
const whirlpoolProgram = String(WHIRLPOOL_PROGRAM_ADDRESS)

function instructionFromCapture(capturedInstruction) {
  return {
    programAddress: address(capturedInstruction.programId),
    accounts: capturedInstruction.accounts.map((meta) => ({
      address: address(meta.pubkey),
      role: meta.isSigner
        ? meta.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
        : meta.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: Uint8Array.from(Buffer.from(capturedInstruction.data, 'base64')),
  }
}

function account(key, owner, data) {
  return { exists: true, address: address(key), programAddress: address(owner), data }
}

function ataCreateInstruction({ ownerAta, mint }) {
  return {
    programAddress: address(associatedTokenProgram),
    accounts: [
      { address: address(wallet), role: AccountRole.WRITABLE_SIGNER },
      { address: address(ownerAta), role: AccountRole.WRITABLE },
      { address: address(wallet), role: AccountRole.READONLY },
      { address: address(mint), role: AccountRole.READONLY },
      { address: address(systemProgram), role: AccountRole.READONLY },
      { address: address(tokenProgram), role: AccountRole.READONLY },
    ],
    data: Uint8Array.of(1),
  }
}

function addAtaSetup(ctx, instruction) {
  ctx.built.setupInstructions = [instruction]
  ctx.built.instructions = [instruction, ctx.instruction]
  ctx.built.programIds = [jupiterProgram, whirlpoolProgram, associatedTokenProgram]
}

function tokenAccountData(mint, owner) {
  return getTokenEncoder().encode({
    mint: address(mint), owner: address(owner), amount: 1_000_000n,
    delegate: null, state: AccountState.Initialized, isNative: null,
    delegatedAmount: 0n, closeAuthority: null,
  })
}

function mintData() {
  return getMintEncoder().encode({
    mintAuthority: null, supply: 1_000_000_000n, decimals: 6,
    isInitialized: true, freezeAuthority: null,
  })
}

function tickArrayData(startTickIndex) {
  return getTickArrayEncoder().encode({
    startTickIndex,
    whirlpool: address(pool),
    ticks: Array.from({ length: 88 }, () => ({
      initialized: false,
      liquidityNet: 0n,
      liquidityGross: 0n,
      feeGrowthOutsideA: 0n,
      feeGrowthOutsideB: 0n,
      rewardGrowthsOutside: [0n, 0n, 0n],
    })),
  })
}

function whirlpoolData({ tokenMintA = outputMint, tokenMintB = inputMint, tokenVaultAAddress = vaultA,
  tokenVaultBAddress = vaultB, tickSpacing = 64, tickCurrentIndex = 0 } = {}) {
  const zeroAddress = address(systemProgram)
  return getWhirlpoolEncoder().encode({
    whirlpoolsConfig: zeroAddress,
    whirlpoolBump: Uint8Array.of(1),
    tickSpacing,
    feeTierIndexSeed: Uint8Array.of(0, 0),
    feeRate: 3_000,
    protocolFeeRate: 0,
    liquidity: 1_000_000n,
    sqrtPrice: 1n << 64n,
    tickCurrentIndex,
    protocolFeeOwedA: 0n,
    protocolFeeOwedB: 0n,
    tokenMintA: address(tokenMintA),
    tokenVaultA: address(tokenVaultAAddress),
    feeGrowthGlobalA: 0n,
    tokenMintB: address(tokenMintB),
    tokenVaultB: address(tokenVaultBAddress),
    feeGrowthGlobalB: 0n,
    rewardLastUpdatedTimestamp: 0n,
    rewardInfos: Array.from({ length: 3 }, () => ({
      mint: zeroAddress, vault: zeroAddress, authority: zeroAddress,
      extension: new Uint8Array(32),
      emissionsPerSecondX64: 0n, growthGlobalX64: 0n,
    })),
  })
}

function oracleData(whirlpool = pool) {
  return getOracleEncoder().encode({
    whirlpool: address(whirlpool),
    tradeEnableTimestamp: 0n,
    adaptiveFeeConstants: {
      filterPeriod: 1, decayPeriod: 2, reductionFactor: 5_000,
      adaptiveFeeControlFactor: 1, maxVolatilityAccumulator: 1_000,
      tickGroupSize: 1, majorSwapThresholdTicks: 1, reserved: new Uint8Array(16),
    },
    adaptiveFeeVariables: {
      lastReferenceUpdateTimestamp: 0n, lastMajorSwapTimestamp: 0n,
      volatilityReference: 0, tickGroupIndexReference: 0,
      volatilityAccumulator: 0, reserved: new Uint8Array(16),
    },
    reserved: new Uint8Array(128),
  })
}

function dynamicTickArrayData(startTickIndex, { whirlpoolAddress = pool, initializedOffset = 5, tickBitmap = 1n << 5n } = {}) {
  const ticks = Array.from({ length: 88 }, () => ({ __kind: 'Uninitialized' }))
  ticks[initializedOffset] = {
    __kind: 'Initialized',
    fields: [{ liquidityNet: 0n, liquidityGross: 1n, feeGrowthOutsideA: 0n, feeGrowthOutsideB: 0n, rewardGrowthsOutside: [0n, 0n, 0n] }],
  }
  return getDynamicTickArrayEncoder().encode({ startTickIndex, whirlpool: address(whirlpoolAddress), tickBitmap, ticks })
}

async function makeFixture({ poolState, oracle = null, aToB = false, emptyTickArrays = false, systemEmptyTickArrays = false, dynamicTickArrayIndex = -1, tickArrayStarts } = {}) {
  const inputAta = String(await ataOf(address(wallet), address(inputMint), address(tokenProgram)))
  const outputAta = String(await ataOf(address(wallet), address(outputMint), address(tokenProgram)))
  const poolMintA = aToB ? inputMint : outputMint
  const poolMintB = aToB ? outputMint : inputMint
  const starts = tickArrayStarts ?? (aToB ? [0, -5_632, -11_264] : [0, 5_632, 11_264])
  const tickArrays = await Promise.all(starts.map((start) => getTickArrayAddress(address(pool), start)))
  const [oracleAddress] = await getOracleAddress(address(pool))
  const instruction = instructionFromCapture(captured.swapInstruction)
  instruction.accounts[1].address = address(inputAta)
  instruction.accounts[2].address = address(outputAta)
  instruction.accounts[16].address = address(pool)
  instruction.accounts[17].address = address(poolMintA)
  instruction.accounts[18].address = address(poolMintB)
  instruction.accounts[19].address = address(aToB ? inputAta : outputAta)
  instruction.accounts[20].address = address(vaultA)
  instruction.accounts[21].address = address(aToB ? outputAta : inputAta)
  instruction.accounts[22].address = address(vaultB)
  instruction.accounts[23].address = address(tickArrays[0][0])
  instruction.accounts[24].address = address(tickArrays[1][0])
  instruction.accounts[25].address = address(tickArrays[2][0])
  instruction.accounts[26].address = address(oracleAddress)
  instruction.data[35] = aToB ? 1 : 0

  const accountMap = new Map()
  accountMap.set(pool, account(pool, whirlpoolProgram, poolState ?? whirlpoolData({ tokenMintA: poolMintA, tokenMintB: poolMintB })))
  accountMap.set(inputMint, account(inputMint, tokenProgram, mintData()))
  accountMap.set(outputMint, account(outputMint, tokenProgram, mintData()))
  accountMap.set(inputAta, account(inputAta, tokenProgram, tokenAccountData(inputMint, wallet)))
  accountMap.set(outputAta, account(outputAta, tokenProgram, tokenAccountData(outputMint, wallet)))
  accountMap.set(vaultA, account(vaultA, tokenProgram, tokenAccountData(poolMintA, pool)))
  accountMap.set(vaultB, account(vaultB, tokenProgram, tokenAccountData(poolMintB, pool)))
  for (const [index, start] of starts.entries()) {
    const tickArrayAddress = String(tickArrays[index][0])
    accountMap.set(tickArrayAddress, emptyTickArrays
      ? systemEmptyTickArrays
        ? { exists: true, address: address(tickArrayAddress), programAddress: address(systemProgram), data: new Uint8Array() }
        : { exists: false, address: address(tickArrayAddress) }
      : account(tickArrayAddress, whirlpoolProgram, index === dynamicTickArrayIndex
        ? dynamicTickArrayData(start)
        : tickArrayData(start)))
  }
  if (oracle) accountMap.set(String(oracleAddress), account(String(oracleAddress), whirlpoolProgram, oracle))
  else accountMap.set(String(oracleAddress), { exists: false, address: address(oracleAddress) })

  const routePlan = [{
    ...captured.routePlan[0],
    swapInfo: { ...captured.routePlan[0].swapInfo, programId: whirlpoolProgram, ammKey: pool },
  }]
  const built = {
    provider: 'jupiter-v2-build',
    inputMint,
    outputMint,
    inputAmountBaseUnits: captured.inAmount,
    outputAmountBaseUnits: captured.outAmount,
    minimumOutputBaseUnits: String(BigInt(captured.outAmount) * BigInt(10_000 - Number(captured.slippageBps)) / 10_000n),
    slippageBps: Number(captured.slippageBps),
    fee: { bps: 10, mint: outputMint, amountBaseUnits: '867' },
    feeAccount,
    feeAccountMint: outputMint,
    feeAccountMintVerified: true,
    programPolicy: { approved: true },
    routePlan,
    routeProgramIds: [whirlpoolProgram],
    routeProgramIdsByLabel: { Whirlpool: [whirlpoolProgram] },
    swapInstructionProgramId: jupiterProgram,
    swapInstruction: instruction,
    computeBudgetInstructions: [],
    setupInstructions: [],
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    programIds: [jupiterProgram, whirlpoolProgram],
    instructions: [instruction],
  }
  const request = {
    wallet, inputMint, outputMint,
    amountBaseUnits: captured.inAmount,
    slippageBps: Number(captured.slippageBps),
  }
  return {
    request,
    built,
    instruction,
    accountMap,
    readContext: { inputAta, outputAta, tickArrayAddresses: tickArrays.map(([key]) => String(key)), oracleAddress: String(oracleAddress) },
    readAccounts: async (addresses) => addresses.map((key) => accountMap.get(String(key))
      ?? { exists: false, address: key }),
  }
}

const positive = await makeFixture()
await assert.doesNotReject(
  validateProviderSwapInstructions(positive.request, positive.built, { deriveAta: ataOf, readAccounts: positive.readAccounts }),
  'single-hop route_v2 WhirlpoolSwapV2 must pass with realistic official-client-encoded account state and allowed empty arrays/oracle',
)

const dynamicTickArray = await makeFixture({
  poolState: whirlpoolData({ tickSpacing: 16, tickCurrentIndex: 1_405 }),
  tickArrayStarts: [1_408, 2_816, 4_224],
  dynamicTickArrayIndex: 0,
})
assert.deepEqual(
  dynamicTickArray.readContext.tickArrayAddresses,
  captured.swapInstruction.accounts.slice(23, 26).map((meta) => meta.pubkey),
  'dynamic fixture derives the captured Whirlpool tick-array PDAs for its observed start sequence',
)
assert.equal(dynamicTickArray.accountMap.get(dynamicTickArray.readContext.tickArrayAddresses[0]).data.length, 260,
  'dynamic fixture must encode official discriminator, 88 entries and one initialized tick')
await assert.doesNotReject(
  validateProviderSwapInstructions(dynamicTickArray.request, dynamicTickArray.built, { deriveAta: ataOf, readAccounts: dynamicTickArray.readAccounts }),
  'official generated DynamicTickArray layout must pass when owner, discriminator, bitmap, start and pool match',
)

const missingTickArrays = await makeFixture({ emptyTickArrays: true })
await assert.doesNotReject(
  validateProviderSwapInstructions(missingTickArrays.request, missingTickArrays.built, { deriveAta: ataOf, readAccounts: missingTickArrays.readAccounts }),
  'official Orca sparse tick-sequence semantics allow an uninitialized PDA with no account data',
)

const systemEmptyTickArrays = await makeFixture({ emptyTickArrays: true, systemEmptyTickArrays: true })
await assert.doesNotReject(
  validateProviderSwapInstructions(systemEmptyTickArrays.request, systemEmptyTickArrays.built, { deriveAta: ataOf, readAccounts: systemEmptyTickArrays.readAccounts }),
  'official Orca sparse tick-sequence semantics allow System-owned empty tick-array accounts',
)

const aToBRoute = await makeFixture({ aToB: true })
await assert.doesNotReject(
  validateProviderSwapInstructions(aToBRoute.request, aToBRoute.built, { deriveAta: ataOf, readAccounts: aToBRoute.readAccounts }),
  'pool A-to-B direction must bind the requested input/output pair and descending PDA sequence',
)

const firstSwapWithoutOutputAta = await makeFixture()
firstSwapWithoutOutputAta.accountMap.set(firstSwapWithoutOutputAta.readContext.outputAta, {
  exists: false, address: address(firstSwapWithoutOutputAta.readContext.outputAta),
})
addAtaSetup(firstSwapWithoutOutputAta, ataCreateInstruction({
  ownerAta: firstSwapWithoutOutputAta.readContext.outputAta, mint: outputMint,
}))
await assert.doesNotReject(
  validateProviderSwapInstructions(firstSwapWithoutOutputAta.request, firstSwapWithoutOutputAta.built, {
    deriveAta: ataOf, readAccounts: firstSwapWithoutOutputAta.readAccounts,
  }),
  'first-time output ATA may be absent only when exact validated setup creates that output ATA',
)

const firstSwapWithPrefundedOutputAta = await makeFixture()
firstSwapWithPrefundedOutputAta.accountMap.set(firstSwapWithPrefundedOutputAta.readContext.outputAta, {
  exists: true,
  address: address(firstSwapWithPrefundedOutputAta.readContext.outputAta),
  programAddress: address(systemProgram),
  data: new Uint8Array(),
})
addAtaSetup(firstSwapWithPrefundedOutputAta, ataCreateInstruction({
  ownerAta: firstSwapWithPrefundedOutputAta.readContext.outputAta, mint: outputMint,
}))
await assert.doesNotReject(
  validateProviderSwapInstructions(firstSwapWithPrefundedOutputAta.request, firstSwapWithPrefundedOutputAta.built, {
    deriveAta: ataOf, readAccounts: firstSwapWithPrefundedOutputAta.readAccounts,
  }),
  'a System-owned empty prefunded output ATA may be initialized by its exact validated setup instruction',
)

const missingOutputWithoutSetup = await makeFixture()
missingOutputWithoutSetup.accountMap.set(missingOutputWithoutSetup.readContext.outputAta, {
  exists: false, address: address(missingOutputWithoutSetup.readContext.outputAta),
})
await assert.rejects(
  validateProviderSwapInstructions(missingOutputWithoutSetup.request, missingOutputWithoutSetup.built, {
    deriveAta: ataOf, readAccounts: missingOutputWithoutSetup.readAccounts,
  }),
  /WhirlpoolSwapV2.*user token account A.*(owner|data)|WhirlpoolSwapV2.*token account/i,
  'absent output ATA without a matching ATA create must reject',
)

const missingInputWithSetup = await makeFixture()
missingInputWithSetup.accountMap.set(missingInputWithSetup.readContext.inputAta, {
  exists: false, address: address(missingInputWithSetup.readContext.inputAta),
})
addAtaSetup(missingInputWithSetup, ataCreateInstruction({
  ownerAta: missingInputWithSetup.readContext.inputAta, mint: inputMint,
}))
await assert.rejects(
  validateProviderSwapInstructions(missingInputWithSetup.request, missingInputWithSetup.built, {
    deriveAta: ataOf, readAccounts: missingInputWithSetup.readAccounts,
  }),
  /user token account|token-account/i,
  'input ATA must already exist even when setup creates it',
)

const initializedOracle = await makeFixture({ oracle: oracleData() })
await assert.doesNotReject(
  validateProviderSwapInstructions(initializedOracle.request, initializedOracle.built, { deriveAta: ataOf, readAccounts: initializedOracle.readAccounts }),
  'initialized Whirlpool oracle must pass when owner, discriminator and pool relationship match',
)

const invalidCases = [
  ['wrong pool owner', (ctx) => { ctx.accountMap.set(pool, account(pool, tokenProgram, whirlpoolData())) }],
  ['wrong pool discriminator', (ctx) => { const data = whirlpoolData(); data[0] ^= 1; ctx.accountMap.set(pool, account(pool, whirlpoolProgram, data)) }],
  ['wrong pool mint', (ctx) => ctx.accountMap.set(pool, account(pool, whirlpoolProgram, whirlpoolData({ tokenMintA: inputMint, tokenMintB: inputMint })))],
  ['wrong pool vault', (ctx) => ctx.accountMap.set(pool, account(pool, whirlpoolProgram, whirlpoolData({ tokenVaultAAddress: vaultB })))],
  ['wrong user account mint', (ctx) => ctx.accountMap.set(ctx.readContext.inputAta, account(ctx.readContext.inputAta, tokenProgram, tokenAccountData(outputMint, wallet)))],
  ['wrong user account owner', (ctx) => ctx.accountMap.set(ctx.readContext.inputAta, account(ctx.readContext.inputAta, tokenProgram, tokenAccountData(inputMint, pool)))],
  ['wrong mint owner', (ctx) => ctx.accountMap.set(inputMint, account(inputMint, systemProgram, mintData()))],
  ['wrong vault mint', (ctx) => ctx.accountMap.set(vaultA, account(vaultA, tokenProgram, tokenAccountData(inputMint, pool)))],
  ['wrong vault authority', (ctx) => ctx.accountMap.set(vaultA, account(vaultA, tokenProgram, tokenAccountData(outputMint, wallet)))],
  ['wrong tick-array PDA', (ctx) => { ctx.instruction.accounts[23].address = address(pool) }],
  ['wrong tick-array order', (ctx) => { [ctx.instruction.accounts[23].address, ctx.instruction.accounts[24].address] = [ctx.instruction.accounts[24].address, ctx.instruction.accounts[23].address] }],
  ['wrong tick-array owner', (ctx) => ctx.accountMap.set(ctx.readContext.tickArrayAddresses[0], account(ctx.readContext.tickArrayAddresses[0], tokenProgram, tickArrayData(0)))],
  ['wrong tick-array start', (ctx) => ctx.accountMap.set(ctx.readContext.tickArrayAddresses[0], account(ctx.readContext.tickArrayAddresses[0], whirlpoolProgram, tickArrayData(5_632)))],
  ['wrong tick-array pool', (ctx) => ctx.accountMap.set(ctx.readContext.tickArrayAddresses[0], account(ctx.readContext.tickArrayAddresses[0], whirlpoolProgram, getTickArrayEncoder().encode({
    startTickIndex: 0, whirlpool: address(vaultA), ticks: Array.from({ length: 88 }, () => ({
      initialized: false, liquidityNet: 0n, liquidityGross: 0n, feeGrowthOutsideA: 0n, feeGrowthOutsideB: 0n,
      rewardGrowthsOutside: [0n, 0n, 0n],
    })),
  })))],
  ['dynamic tick-array owner', (ctx) => { const data = dynamicTickArrayData(0); ctx.accountMap.set(ctx.readContext.tickArrayAddresses[0], account(ctx.readContext.tickArrayAddresses[0], tokenProgram, data)) }],
  ['dynamic tick-array discriminator', (ctx) => { const data = dynamicTickArrayData(0); data[0] ^= 1; ctx.accountMap.set(ctx.readContext.tickArrayAddresses[0], account(ctx.readContext.tickArrayAddresses[0], whirlpoolProgram, data)) }],
  ['dynamic tick-array start', (ctx) => ctx.accountMap.set(ctx.readContext.tickArrayAddresses[0], account(ctx.readContext.tickArrayAddresses[0], whirlpoolProgram, dynamicTickArrayData(5_632)))],
  ['dynamic tick-array pool', (ctx) => ctx.accountMap.set(ctx.readContext.tickArrayAddresses[0], account(ctx.readContext.tickArrayAddresses[0], whirlpoolProgram, dynamicTickArrayData(0, { whirlpoolAddress: vaultA })))],
  ['dynamic tick-array trailing bytes', (ctx) => { const data = dynamicTickArrayData(0); ctx.accountMap.set(ctx.readContext.tickArrayAddresses[0], account(ctx.readContext.tickArrayAddresses[0], whirlpoolProgram, Uint8Array.from([...data, 0]))) }],
  ['dynamic tick-array bitmap mismatch', (ctx) => ctx.accountMap.set(ctx.readContext.tickArrayAddresses[0], account(ctx.readContext.tickArrayAddresses[0], whirlpoolProgram, dynamicTickArrayData(0, { tickBitmap: 0n })))],
  ['wrong oracle PDA', (ctx) => { ctx.instruction.accounts[26].address = address(vaultA) }],
  ['wrong oracle owner', (ctx) => ctx.accountMap.set(ctx.readContext.oracleAddress, account(ctx.readContext.oracleAddress, tokenProgram, oracleData()))],
  ['wrong oracle discriminator', (ctx) => { const data = oracleData(); data[0] ^= 1; ctx.accountMap.set(ctx.readContext.oracleAddress, account(ctx.readContext.oracleAddress, whirlpoolProgram, data)) }],
  ['wrong oracle pool', (ctx) => ctx.accountMap.set(ctx.readContext.oracleAddress, account(ctx.readContext.oracleAddress, whirlpoolProgram, oracleData(vaultA)))],
  ['wrong direction', (ctx) => { ctx.instruction.data[35] = 1 }],
  ['wrong common account role', (ctx) => { ctx.instruction.accounts[1].role = AccountRole.READONLY }],
  ['wrong Orca account role', (ctx) => { ctx.instruction.accounts[20].role = AccountRole.READONLY }],
  ['Token-2022 token program with unverified hooks', (ctx) => { ctx.instruction.accounts[5].address = TOKEN_2022_PROGRAM_ADDRESS }],
  ['trailing route account metadata', (ctx) => ctx.instruction.accounts.push({ address: address(vaultA), role: AccountRole.READONLY })],
  ['trailing route instruction data', (ctx) => { ctx.instruction.data = Uint8Array.from([...ctx.instruction.data, 0]) }],
  ['remaining-account instruction metadata', (ctx) => { ctx.instruction.data[36] = 1 }],
]

for (const [label, alter] of invalidCases) {
  const ctx = await makeFixture()
  alter(ctx)
  await assert.rejects(
    validateProviderSwapInstructions(ctx.request, ctx.built, { deriveAta: ataOf, readAccounts: ctx.readAccounts }),
    /Jupiter|Whirlpool|account|tick|oracle|direction|route|remaining|metadata/i,
    `${label} must reject before transaction compilation`,
  )
}

const multihop = await makeFixture()
multihop.built.routePlan.push({ ...multihop.built.routePlan[0], bps: 0 })
await assert.rejects(
  validateProviderSwapInstructions(multihop.request, multihop.built, { deriveAta: ataOf, readAccounts: multihop.readAccounts }),
  /route|allocation|Whirlpool/i,
  'multi-hop route_v2 must fail closed',
)

const legacy = await makeFixture()
legacy.instruction.data = Uint8Array.from(Buffer.concat([
  Buffer.from('e517cb977ae3ad2a', 'hex'),
  Buffer.from([1, 0, 0, 0, 17, 1, 100, 0, 1]),
  Buffer.from('40420f000000000052390d000000000032000a', 'hex'),
]))
await assert.rejects(
  validateProviderSwapInstructions(legacy.request, legacy.built, { deriveAta: ataOf, readAccounts: legacy.readAccounts }),
  /legacy|route|variant|Jupiter/i,
  'legacy route must remain unadmitted',
)

assert.equal(pool, captured.routePlan[0].swapInfo.ammKey)
assert.equal(eventAuthority, 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf')
assert.equal(memoProgram, 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
console.log('orca route validator tests passed')
