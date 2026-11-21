// Runs with NYSA_FEE_BPS=0: swaps and loops with no Nysa fee (the other suites run with 10 bps).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { address, AccountRole } from '@solana/kit'
import { ataOf } from './account.js'
import { buildSwap, configuredFeeAccountForMint, FEE_BPS, feeBpsFromEnv, swapFeeAccountsConfigured } from './swap.js'
import { assertSwapSimulationEffects, validateProviderSwapInstructions } from './swap-execution.js'
import { verifyAtomicLoopFeeDeltas } from './loop.js'

assert.equal(FEE_BPS, 0, 'run with NYSA_FEE_BPS=0')
assert.equal(feeBpsFromEnv(''), 0)
assert.equal(feeBpsFromEnv('10'), 10)
assert.throws(() => feeBpsFromEnv('101'), /0 to 100/)
assert.throws(() => feeBpsFromEnv('2.5'), /0 to 100/)

const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/jupiter-v2-build-whirlpool-route.json', import.meta.url), 'utf8'))
const captured = fixture.response
const wallet = fixture.capture.request.taker
const { inputMint, outputMint } = fixture.capture.request
const jupiterProgram = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const whirlpoolProgram = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const pool = captured.routePlan[0].swapInfo.ammKey

// No fee account to configure, and swap is not gated on one.
assert.deepEqual(configuredFeeAccountForMint(outputMint), { account: null, mint: outputMint })
assert.equal(swapFeeAccountsConfigured(), true)

// The captured route as Jupiter returns it without a platform fee: no fee account slot, fee bps 0, route out = out.
const inputAta = String(await ataOf(address(wallet), address(inputMint), address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')))
const outputAta = String(await ataOf(address(wallet), address(outputMint), address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')))
const accounts = captured.swapInstruction.accounts.filter((_, index) => index !== 10)
accounts[1] = { ...accounts[1], pubkey: inputAta }
accounts[2] = { ...accounts[2], pubkey: outputAta }
accounts[15] = { ...accounts[15], pubkey: pool }
accounts[16] = { ...accounts[16], pubkey: outputMint }
accounts[17] = { ...accounts[17], pubkey: inputMint }
accounts[18] = { ...accounts[18], pubkey: outputAta }
accounts[20] = { ...accounts[20], pubkey: inputAta }
const data = Buffer.from(captured.swapInstruction.data, 'base64')
data.writeUInt16LE(0, 26) // platform fee bps
data[35] = 0
const noFeeResponse = {
  ...captured,
  platformFee: undefined,
  routePlan: [{ ...captured.routePlan[0], swapInfo: { ...captured.routePlan[0].swapInfo, outAmount: captured.outAmount, programId: whirlpoolProgram, ammKey: pool } }],
  swapInstruction: { ...captured.swapInstruction, accounts, data: data.toString('base64') },
  computeBudgetInstructions: [], setupInstructions: [], otherInstructions: [], cleanupInstruction: null, tipInstruction: null,
}
const requests = []
const build = (response) => buildSwap({
  inputMint, outputMint, inputAmountBaseUnits: captured.inAmount, wallet, slippageBps: Number(captured.slippageBps),
  providerApiKey: 'test', fetcher: async (url) => { requests.push(new URL(url)); return { ok: true, json: async () => response } },
  routeProgramIdsByLabel: { Whirlpool: [whirlpoolProgram] }, feeBalanceDeltaVerified: true,
})
const built = await build(noFeeResponse)
assert.equal(requests[0].searchParams.has('platformFeeBps'), false, 'no fee is requested from Jupiter')
assert.equal(requests[0].searchParams.has('feeAccount'), false)
assert.equal(built.fee.bps, 0)
assert.equal(built.fee.amountBaseUnits, '0')
assert.equal(built.feeAccount, null)
assert.equal(built.feeAccountMintVerified, true)

// A route that still skims output (route out above the reported out) is a fee Nysa did not ask for.
const skimmed = structuredClone(noFeeResponse)
skimmed.routePlan[0].swapInfo.outAmount = String(BigInt(captured.outAmount) + 867n)
await assert.rejects(build(skimmed), /fee Nysa did not request/)

const request = { wallet, inputMint, outputMint, amountBaseUnits: captured.inAmount, slippageBps: Number(captured.slippageBps) }
await assert.doesNotReject(validateProviderSwapInstructions(request, built, { deriveAta: ataOf }), 'the 26-account no-fee route passes')
const withFeeBps = { ...built, swapInstruction: { ...built.swapInstruction, data: Uint8Array.from(built.swapInstruction.data) } }
withFeeBps.swapInstruction.data[26] = 10
withFeeBps.instructions = [withFeeBps.swapInstruction]
await assert.rejects(validateProviderSwapInstructions(request, withFeeBps, { deriveAta: ataOf }), /platform fee/, 'an encoded platform fee is refused')
assert.equal(String(built.swapInstruction.programAddress), jupiterProgram)
assert.equal(built.swapInstruction.accounts[10].role, AccountRole.READONLY, 'index 10 is the Orca program, not a fee account')

const effects = { inputAmountBaseUnits: captured.inAmount, minimumOutputBaseUnits: built.minimumOutputBaseUnits, feeAmountBaseUnits: '0' }
const simulation = { inputDeltaBaseUnits: captured.inAmount, outputDeltaBaseUnits: captured.outAmount, feeDeltaBaseUnits: '0', additionalTokenDeltas: [] }
assert.doesNotThrow(() => assertSwapSimulationEffects(effects, simulation))
assert.throws(() => assertSwapSimulationEffects({ ...effects, feeAmountBaseUnits: '867' }, simulation), /no fee/)

// Loops: no fee events and no fee deltas is the expected state; a stray fee delta is not.
assert.doesNotThrow(() => verifyAtomicLoopFeeDeltas([], []))
assert.throws(() => verifyAtomicLoopFeeDeltas([], [{ account: 'x', mint: outputMint, deltaBaseUnits: '1' }]))

console.log('no-fee ok')
