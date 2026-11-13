import assert from 'node:assert/strict'
import {
  address, AccountRole, appendTransactionMessageInstructions, compileTransaction, generateKeyPairSigner,
  getBase58Decoder, getBase64EncodedWireTransaction, partiallySignTransaction, pipe,
  createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { SolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE } from '@solana/kit'
import { relaySignedTransaction, DefiniteSendRefusal, SendOutcomeUnknownError } from './send-safety.js'
import { persistSignedSwapBeforeRelay } from '../src/swap-recovery.js'

const signer = await generateKeyPairSigner()
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(signer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: address('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, tx),
  (tx) => appendTransactionMessageInstructions([{ programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), accounts: [{ address: signer.address, role: AccountRole.READONLY }], data: Uint8Array.from([1]) }], tx),
)
const signed = await partiallySignTransaction([signer.keyPair], compileTransaction(message))
const tx = getBase64EncodedWireTransaction(signed)
const signature = getBase58Decoder().decode(signed.signatures[String(signer.address)])

let sendCalls = 0
await assert.rejects(relaySignedTransaction({
  tx, wallet: String(signer.address), refuse: async () => 'invalid signed transaction',
  send: async () => { sendCalls++; return signature },
}), (error) => error instanceof DefiniteSendRefusal && error.status === 400)
assert.equal(sendCalls, 0, 'known pre-send refusal never calls RPC')

let requestReachedRpc = false
await assert.rejects(relaySignedTransaction({
  tx, wallet: String(signer.address), refuse: async () => null,
  send: async () => { requestReachedRpc = true; throw new Error('response socket closed after broadcast') },
}), (error) => error instanceof SendOutcomeUnknownError && error.signature === signature && error.status === 502)
assert.equal(requestReachedRpc, true, 'lost RPC response is classified only after invoking send')

await assert.rejects(relaySignedTransaction({
  tx, wallet: String(signer.address), refuse: async () => null,
  send: async () => { throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, { logs: ['Program log: Error: SlippageToleranceExceeded'] }) },
}), (error) => error instanceof DefiniteSendRefusal && /simulation.*SlippageToleranceExceeded/.test(error.message),
'a failed preflight simulation is a definite refusal: the RPC never forwarded the transaction')

for (const stage of ['withdraw', 'supply']) {
  const persisted = []
  const pending = await persistSignedSwapBeforeRelay({
    pending: { wallet: String(signer.address), flow: stage === 'withdraw' ? 'withdraw-sell' : 'acquire-supply', stage, amountBaseUnits: '42' },
    signedTransaction: Uint8Array.from(Buffer.from(tx, 'base64')),
    persist: async (record) => persisted.push(record),
    relay: () => relaySignedTransaction({
      tx, wallet: String(signer.address), refuse: async () => null,
      send: async () => { throw new Error('lost response after broadcast') },
    }),
  })
  assert.deepEqual(persisted.map(({ status }) => status), ['signed-pending', 'relay-unknown'], `${stage} signature persists before relay and remains after lost response`)
  assert.equal(pending.pending.signature, signature, `${stage} unknown relay retains durable signature for reconciliation`)
  assert.equal(pending.pending.status, 'relay-unknown')
}

console.log('send outcome safety ok')
