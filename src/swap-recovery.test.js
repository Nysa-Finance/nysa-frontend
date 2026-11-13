import assert from 'node:assert/strict'
import {
  address, AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getBase58Decoder, getTransactionEncoder, partiallySignTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { confirmedSwapAmountFromDeltas, confirmedSwapAmountFromTransaction, pendingSwapChainOutcome, persistSignedSwapBeforeRelay, signatureFromSignedTransaction } from './swap-recovery.js'
import { TOKENS } from './config.js'

const signer = await generateKeyPairSigner()
const mint = TOKENS['svm-usdy'].mint
const memo = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(signer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: address('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, tx),
  (tx) => appendTransactionMessageInstructions([{ programAddress: memo, accounts: [{ address: signer.address, role: AccountRole.READONLY }], data: Uint8Array.from([1]) }], tx),
)
const signed = await partiallySignTransaction([signer.keyPair], compileTransaction(message))
const signedBytes = getTransactionEncoder().encode(signed)
const expectedSignature = getBase58Decoder().decode(signed.signatures[String(signer.address)])
assert.equal(signatureFromSignedTransaction(signedBytes, String(signer.address)), expectedSignature)
assert.throws(() => signatureFromSignedTransaction(signedBytes, 'Vote111111111111111111111111111111111111111'), /payer|signature/i)

const order = []
const ambiguous = await persistSignedSwapBeforeRelay({
  pending: { wallet: String(signer.address), outputMint: mint },
  signedTransaction: signedBytes,
  persist: async (pending) => { order.push(`persist:${pending.status}`) },
  relay: async () => { order.push('relay'); throw new Error('connection closed after request') },
})
assert.deepEqual(order, ['persist:signed-pending', 'relay', 'persist:relay-unknown'], 'signature and exact signed bytes must persist before relay')
assert.equal(ambiguous.pending.signature, expectedSignature)
assert.ok(ambiguous.pending.signedTransactionBase64)
assert.equal(ambiguous.pending.status, 'relay-unknown', 'ambiguous transport remains recoverable and blocks rebuild')
const refused = await persistSignedSwapBeforeRelay({
  pending: { wallet: String(signer.address), outputMint: mint }, signedTransaction: signedBytes,
  persist: async () => {}, relay: async () => { const error = new Error('readiness changed'); error.status = 400; throw error },
})
assert.equal(refused.pending.status, 'rejected', 'definite pre-relay refusal is settled rather than left ambiguous')
await assert.rejects(persistSignedSwapBeforeRelay({
  pending: { wallet: String(signer.address), outputMint: mint }, signedTransaction: signedBytes,
  persist: async () => { throw new Error('storage full') }, relay: async () => assert.fail('must not relay without persistence'),
}), /storage full/i)

const deltas = [
  { owner: signer.address, mint, deltaBaseUnits: '500' },
  { owner: 'Vote111111111111111111111111111111111111111', mint, deltaBaseUnits: '9000' },
  { owner: signer.address, mint: TOKENS['svm-usdc'].mint, deltaBaseUnits: '-1' },
]
assert.equal(confirmedSwapAmountFromDeltas(deltas, String(signer.address), mint), '500', 'only the confirmed transaction wallet/mint delta is attributed')
assert.throws(() => confirmedSwapAmountFromDeltas(deltas, String(signer.address), TOKENS['svm-usdc'].mint), /positive/i)
const confirmedTransaction = { status: 'confirmed', slot: 10, transactionSlot: 10, tokenDeltas: deltas }
assert.equal(confirmedSwapAmountFromTransaction(confirmedTransaction, String(signer.address), mint), '500')
assert.throws(() => confirmedSwapAmountFromTransaction({ ...confirmedTransaction, transactionSlot: 9 }, String(signer.address), mint), /slot/i)
assert.throws(() => confirmedSwapAmountFromTransaction({ ...confirmedTransaction, transactionSlot: null }, String(signer.address), mint), /slot/i)

assert.deepEqual(pendingSwapChainOutcome({ signature: 'sig' }, { status: 'confirmed', slot: 10, transactionSlot: 10, tokenDeltas: deltas, wallet: String(signer.address), outputMint: mint }), {
  status: 'confirmed', signature: 'sig', amountBaseUnits: '500',
})
assert.deepEqual(pendingSwapChainOutcome({ signature: 'sig' }, { status: 'failed', error: 'on-chain error' }), {
  status: 'failed', signature: 'sig', error: 'on-chain error',
})
assert.deepEqual(pendingSwapChainOutcome({ signature: 'sig' }, { status: 'pending' }), { status: 'pending', signature: 'sig' })

console.log('swap recovery attribution ok')
