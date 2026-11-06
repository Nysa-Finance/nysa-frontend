import assert from 'node:assert/strict'
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getBase58Decoder, getBase64EncodedWireTransaction, getTransactionEncoder,
  partiallySignTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { installMockWebLocks } from './test-utils/mock-web-locks.js'

const signer = await generateKeyPairSigner()
const walletAddress = String(signer.address)
const account = { address: walletAddress, chains: ['solana:mainnet'] }
const localValues = new Map()
globalThis.localStorage = {
  getItem: (key) => localValues.get(key) ?? null,
  setItem: (key, value) => localValues.set(key, String(value)),
  removeItem: (key) => localValues.delete(key),
}
installMockWebLocks()

const message = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(signer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: address('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, tx),
  (tx) => appendTransactionMessageInstructions([{
    programAddress: address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'),
    accounts: [{ address: signer.address, role: AccountRole.WRITABLE_SIGNER }], data: Uint8Array.of(1),
  }], tx),
)
const unsignedTransaction = getBase64EncodedWireTransaction(compileTransaction(message))
const signed = await partiallySignTransaction([signer.keyPair], compileTransaction(message))
const signedTransaction = getTransactionEncoder().encode(signed)
const signatureText = getBase58Decoder().decode(signed.signatures[walletAddress])
const requests = []
globalThis.fetch = async (path, init = {}) => {
  const requestPath = String(path)
  if (requestPath.startsWith('/api/account/')) {
    return { ok: true, status: 200, json: async () => ({ balances: {}, balancesBaseUnits: {}, positions: {}, positionsBaseUnits: {}, claimable: {} }) }
  }
  if (requestPath === '/api/tx' && init.method === 'POST') {
    requests.push({ path: requestPath, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({
      tx: unsignedTransaction, minContextSlot: 1, final: true,
      intentId: 'borrower-flow-intent', intentExpiresAt: Date.now() + 60_000,
    }) }
  }
  if (requestPath === '/api/tx/send' && init.method === 'POST') {
    const body = JSON.parse(init.body)
    requests.push({ path: requestPath, body })
    assert.equal(body.intentId, 'borrower-flow-intent', 'sign-only desktop relays the exact build intent')
    return { ok: true, status: 200, json: async () => ({ signature: signatureText }) }
  }
  if (requestPath === `/api/tx/${signatureText}`) return { ok: true, status: 200, json: async () => ({ status: 'confirmed', slot: 3 }) }
  throw new Error(`Unexpected test fetch: ${requestPath}`)
}

const store = await import('./store.js')
let signedCount = 0
const wallet = {
  name: 'Sign only desktop', chains: ['solana:mainnet'],
  features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signAndSendTransaction': { signAndSendTransaction: async () => { throw new Error('feature action must use signTransaction relay') } },
    'solana:signTransaction': { signTransaction: async () => { signedCount++; return [{ signedTransaction }] } },
  },
}
await store.connectWallet(wallet)
const result = await store.sendKaminoAction('deposit', {
  market: { id: 'sol-usdy-usdc' }, token: { token_id: 'svm-usdy' }, amount: '25',
  swapFlow: 'acquire-supply', swapFlowStage: 'supply', flowAmountBaseUnits: '25000000',
})
assert.equal(result, signatureText)
assert.equal(signedCount, 1)
assert.equal(requests[0].body.swapFlow, 'acquire-supply', 'the route receives the flow build metadata')
assert.equal(requests[0].body.swapFlowStage, 'supply')
assert.equal(requests[1].path, '/api/tx/send')
assert.equal(requests[1].body.wallet, walletAddress)
assert.equal(requests[1].body.intentId, 'borrower-flow-intent')
assert.equal(store.state.lendingPending, null)

console.log('desktop borrower flow relays with its exact build intent')
