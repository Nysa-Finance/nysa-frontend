import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { address, AccountRole } from '@solana/kit'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
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
const jupiterProgram = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const whirlpoolProgram = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const pool = captured.routePlan[0].swapInfo.ammKey
const feeAccount = fixture.capture.request.feeAccount

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

// The captured live route, with its user accounts bound to the fixture wallet's ATAs.
async function makeFixture({ aToB = false } = {}) {
  const inputAta = String(await ataOf(address(wallet), address(inputMint), address(tokenProgram)))
  const outputAta = String(await ataOf(address(wallet), address(outputMint), address(tokenProgram)))
  const instruction = instructionFromCapture(captured.swapInstruction)
  instruction.accounts[1].address = address(inputAta)
  instruction.accounts[2].address = address(outputAta)
  instruction.accounts[16].address = address(pool)
  instruction.accounts[17].address = address(aToB ? inputMint : outputMint)
  instruction.accounts[18].address = address(aToB ? outputMint : inputMint)
  instruction.accounts[19].address = address(aToB ? inputAta : outputAta)
  instruction.accounts[21].address = address(aToB ? outputAta : inputAta)
  instruction.data[35] = aToB ? 1 : 0
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
    routePlan: [{ ...captured.routePlan[0], swapInfo: { ...captured.routePlan[0].swapInfo, programId: whirlpoolProgram, ammKey: pool } }],
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
  const request = { wallet, inputMint, outputMint, amountBaseUnits: captured.inAmount, slippageBps: Number(captured.slippageBps) }
  return { request, built, instruction, outputAta }
}

const validate = (ctx) => validateProviderSwapInstructions(ctx.request, ctx.built, { deriveAta: ataOf })

await assert.doesNotReject(validate(await makeFixture()), 'the captured single-hop route_v2 WhirlpoolSwapV2 passes')
await assert.doesNotReject(validate(await makeFixture({ aToB: true })), 'pool A-to-B direction passes when mint A is the input')

const firstSwap = await makeFixture()
const outputAtaCreate = ataCreateInstruction({ ownerAta: firstSwap.outputAta, mint: outputMint })
firstSwap.built.setupInstructions = [outputAtaCreate]
firstSwap.built.instructions = [outputAtaCreate, firstSwap.instruction]
firstSwap.built.programIds = [jupiterProgram, whirlpoolProgram, associatedTokenProgram]
await assert.doesNotReject(validate(firstSwap), 'a first swap may create the output ATA with an exact setup instruction')

const invalidCases = [
  ['wrong direction', (ctx) => { ctx.instruction.data[35] = 1 }],
  ['wrong pool', (ctx) => { ctx.instruction.accounts[16].address = address(feeAccount) }],
  ['wrong Orca program', (ctx) => { ctx.instruction.accounts[11].address = address(tokenProgram) }],
  ['wrong pool mint', (ctx) => { ctx.instruction.accounts[18].address = address(outputMint) }],
  ['user account A not the wallet ATA', (ctx) => { ctx.instruction.accounts[19].address = address(feeAccount) }],
  ['user account B not the wallet ATA', (ctx) => { ctx.instruction.accounts[21].address = address(feeAccount) }],
  ['wrong fee account', (ctx) => { ctx.instruction.accounts[10].address = address(pool) }],
  ['wrong common account role', (ctx) => { ctx.instruction.accounts[1].role = AccountRole.READONLY }],
  ['wrong Orca account role', (ctx) => { ctx.instruction.accounts[20].role = AccountRole.READONLY }],
  ['read-only tick array', (ctx) => { ctx.instruction.accounts[23].role = AccountRole.READONLY }],
  ['Token-2022 token program with unverified hooks', (ctx) => { ctx.instruction.accounts[5].address = TOKEN_2022_PROGRAM_ADDRESS }],
  ['trailing route account metadata', (ctx) => ctx.instruction.accounts.push({ address: address(pool), role: AccountRole.READONLY })],
  ['trailing route instruction data', (ctx) => { ctx.instruction.data = Uint8Array.from([...ctx.instruction.data, 0]) }],
  ['remaining-account instruction metadata', (ctx) => { ctx.instruction.data[36] = 1 }],
]
for (const [label, alter] of invalidCases) {
  const ctx = await makeFixture()
  alter(ctx)
  await assert.rejects(validate(ctx), /Jupiter|Whirlpool|account|direction|route|remaining|metadata/i, `${label} must reject before transaction compilation`)
}

const multihop = await makeFixture()
multihop.built.routePlan.push({ ...multihop.built.routePlan[0], bps: 0 })
await assert.rejects(validate(multihop), /route|allocation|Whirlpool/i, 'multi-hop route_v2 must fail closed')

const legacy = await makeFixture()
legacy.instruction.data = Uint8Array.from(Buffer.concat([
  Buffer.from('e517cb977ae3ad2a', 'hex'),
  Buffer.from([1, 0, 0, 0, 17, 1, 100, 0, 1]),
  Buffer.from('40420f000000000052390d000000000032000a', 'hex'),
]))
await assert.rejects(validate(legacy), /only exact-input route_v2/, 'legacy route must remain unadmitted')

console.log('orca route validator tests passed')
