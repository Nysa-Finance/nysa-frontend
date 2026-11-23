import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { address, AccountRole } from '@solana/kit'
import { ataOf } from './account.js'
import { validateProviderSwapInstructions } from './swap-execution.js'
import { leverageImpactPct } from './loop.js'

// A live Jupiter build of USDC -> oTFY through its Raydium CLMM pool (the oTFY loop's only route).
const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/jupiter-v2-build-raydium-clmm-route.json', import.meta.url), 'utf8'))
const captured = fixture.response
const { taker: wallet, inputMint, outputMint, feeAccount } = fixture.capture.request
const jupiterProgram = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const raydiumProgram = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const pool = captured.routePlan[0].swapInfo.ammKey

function makeFixture() {
  const instruction = {
    programAddress: address(captured.swapInstruction.programId),
    accounts: captured.swapInstruction.accounts.map((meta) => ({
      address: address(meta.pubkey),
      role: meta.isSigner ? (meta.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : (meta.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY),
    })),
    data: Uint8Array.from(Buffer.from(captured.swapInstruction.data, 'base64')),
  }
  const built = {
    inputMint, outputMint,
    inputAmountBaseUnits: captured.inAmount,
    outputAmountBaseUnits: captured.outAmount,
    minimumOutputBaseUnits: String(BigInt(captured.outAmount) * BigInt(10_000 - Number(captured.slippageBps)) / 10_000n),
    slippageBps: Number(captured.slippageBps),
    fee: { bps: 10, mint: outputMint, amountBaseUnits: String(BigInt(captured.routePlan[0].swapInfo.outAmount) - BigInt(captured.outAmount)) },
    feeAccount, feeAccountMint: outputMint,
    programPolicy: { approved: true },
    routePlan: [{ ...captured.routePlan[0], swapInfo: { ...captured.routePlan[0].swapInfo, programId: raydiumProgram } }],
    routeProgramIds: [raydiumProgram],
    routeProgramIdsByLabel: { 'Raydium CLMM': [raydiumProgram] },
    swapInstructionProgramId: jupiterProgram,
    swapInstruction: instruction,
    computeBudgetInstructions: [], setupInstructions: [], cleanupInstruction: null, otherInstructions: [], tipInstruction: null,
    programIds: [jupiterProgram, raydiumProgram],
    instructions: [instruction],
  }
  const request = { wallet, inputMint, outputMint, amountBaseUnits: captured.inAmount, slippageBps: Number(captured.slippageBps) }
  return { request, built, instruction }
}
const validate = (ctx) => validateProviderSwapInstructions(ctx.request, ctx.built, { deriveAta: ataOf })

await assert.doesNotReject(validate(makeFixture()), 'the captured Raydium CLMM route_v2 passes')
for (const [label, alter] of [
  ['user source not the wallet ATA', (ctx) => { ctx.instruction.accounts[1].address = address(feeAccount) }],
  ['Raydium input account not the wallet ATA', (ctx) => { ctx.instruction.accounts[15].address = address(feeAccount) }],
  ['Raydium output account not the wallet ATA', (ctx) => { ctx.instruction.accounts[16].address = address(feeAccount) }],
  ['wrong pool', (ctx) => { ctx.instruction.accounts[14].address = address(feeAccount) }],
  ['wrong Raydium program', (ctx) => { ctx.instruction.accounts[11].address = address(tokenProgram) }],
  ['payer not the wallet', (ctx) => { ctx.instruction.accounts[12].address = address(pool) }],
  ['wrong fee account', (ctx) => { ctx.instruction.accounts[10].address = address(pool) }],
  ['read-only vault', (ctx) => { ctx.instruction.accounts[17].role = AccountRole.READONLY }],
  ['read-only tick array', (ctx) => { ctx.instruction.accounts[21].role = AccountRole.READONLY }],
  ['missing trailing placeholder', (ctx) => { ctx.instruction.accounts.pop() }],
  ['Whirlpool variant under a Raydium label', (ctx) => { ctx.instruction.data[ctx.instruction.data.length - 5] = 47 }],
  ['trailing route data', (ctx) => { ctx.instruction.data = Uint8Array.from([...ctx.instruction.data, 0]) }],
]) {
  const ctx = makeFixture()
  alter(ctx)
  await assert.rejects(validate(ctx), /Jupiter|Raydium|route|account/i, `${label} must reject`)
}

// Jupiter's 100% impact for a token it can't price falls back to the loss against Kamino's oracle prices.
const usdc = { decimals: 6 }, otfy = { decimals: 9 }
const prices = { liabilityPriceUsd: '1', collateralPriceUsd: '1.03' }
assert.equal(leverageImpactPct({ priceImpactPct: 0.2 }, usdc, otfy, prices), 0.2, 'a real provider impact is kept')
assert.ok(Math.abs(leverageImpactPct({ priceImpactPct: 100, inputAmountBaseUnits: '100000000', outputAmountBaseUnits: '96116504854' }, usdc, otfy, prices) - 1) < 1e-6, '1% below oracle reads as 1%')
assert.equal(leverageImpactPct({ priceImpactPct: 100, inputAmountBaseUnits: '100000000', outputAmountBaseUnits: '98000000000' }, usdc, otfy, prices), 0, 'better than oracle reads as 0')
assert.equal(leverageImpactPct(null, usdc, otfy, prices), Infinity)
console.log('raydium route validator tests passed')
