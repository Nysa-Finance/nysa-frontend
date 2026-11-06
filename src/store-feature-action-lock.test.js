import assert from 'node:assert/strict'
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getBase58Decoder, getTransactionEncoder, partiallySignTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { installMockWebLocks } from './test-utils/mock-web-locks.js'

const signer = await generateKeyPairSigner()
const walletAddress = String(signer.address)
const account = { address: walletAddress, chains: ['solana:mainnet'] }
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(signer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: address('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, tx),
  (tx) => appendTransactionMessageInstructions([{
    programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    accounts: [{ address: signer.address, role: AccountRole.READONLY }], data: Uint8Array.of(1),
  }], tx),
)
const signed = await partiallySignTransaction([signer.keyPair], compileTransaction(message))
const signedTransaction = getTransactionEncoder().encode(signed)
const signatureText = getBase58Decoder().decode(signed.signatures[walletAddress])
const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}
installMockWebLocks()

let buildCount = 0
let walletSignCount = 0
globalThis.fetch = async (path, init = {}) => {
  const requestPath = String(path)
  if (requestPath === '/api/tx' && init.method === 'POST') {
    buildCount++
    return { ok: true, status: 200, json: async () => ({
      tx: 'AQ==', minContextSlot: 1, final: true,
      intentId: `lending-intent-${buildCount}`, intentExpiresAt: Date.now() + 60_000,
    }) }
  }
  if (requestPath === '/api/tx/send' && init.method === 'POST') {
    return { ok: true, status: 200, json: async () => ({ signature: signatureText }) }
  }
  if (requestPath === `/api/tx/${signatureText}`) {
    return { ok: true, status: 200, json: async () => ({
      status: 'confirmed', slot: 1, transactionSlot: 1, wallet: walletAddress, outputMint: 'mint-output',
      tokenDeltas: [{ owner: walletAddress, mint: 'mint-output', deltaBaseUnits: '25' }],
    }) }
  }
  if (requestPath === '/api/swap-send' && init.method === 'POST') {
    return { ok: true, status: 200, json: async () => ({ signature: signatureText }) }
  }
  if (requestPath.startsWith('/api/account/')) {
    return { ok: true, status: 200, json: async () => ({ balances: {}, balancesBaseUnits: {}, positions: {}, positionsBaseUnits: {}, claimable: {} }) }
  }
  throw new Error(`Unexpected test fetch: ${requestPath}`)
}

const store = await import('./store.js')
const wallet = {
  name: 'Web Locks wallet', chains: ['solana:mainnet'],
  features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signTransaction': { signTransaction: async () => { walletSignCount++; return [{ signedTransaction }] } },
  },
}
await store.connectWallet(wallet)
const result = await store.sendKaminoAction('deposit', {
  market: { id: 'sol-usdy-usdc' }, token: { token_id: 'svm-usdy' }, amount: '1',
  swapFlow: 'acquire-supply', swapFlowStage: 'supply',
})
assert.equal(result, signatureText, 'feature borrower action remains executable when Web Locks are available')
assert.equal(store.state.lendingPending, null, 'confirmed feature action releases its shared reservation')
assert.equal(store.state.swapOutcome.status, 'confirmed', 'confirmed borrower outcome is persisted')

values.set('nysaPendingSwap', JSON.stringify({ status: 'relay-unknown', reservationId: 'swap-pending' }))
await assert.rejects(store.sendVaultAction('vault-deposit', { id: 'rwa-prime' }, { amount: '1' }),
  (error) => error.code === 'PENDING_TRANSACTION',
  'ordinary actions cannot replace or race an unresolved router reservation')
assert.equal(buildCount, 1, 'ordinary action is stopped before building over a router reservation')
values.delete('nysaPendingSwap')

values.set('nysaPendingTx', JSON.stringify({ status: 'submitted', signature: 'ordinary-pending' }))
await assert.rejects(store.signAndSendSwap({
  built: { tx: 'AQ==', intentId: 'intent', expiresAt: Date.now() + 10_000 },
  request: { wallet: walletAddress, inputMint: 'input', outputMint: 'output', amountBaseUnits: '1' },
  outputTokenId: 'svm-usdy',
}), (error) => error.code === 'PENDING_TRANSACTION',
'router actions cannot replace an unresolved ordinary action reservation')
assert.equal(walletSignCount, 1, 'conflicting router action never prompts the wallet')
assert.equal(buildCount, 1, 'conflicting router action never uses a built transaction')
values.delete('nysaPendingTx')

const swapOutcome = await store.signAndSendSwap({
  built: { tx: 'AQ==', intentId: 'swap-intent', expiresAt: Date.now() + 10_000 },
  request: { wallet: walletAddress, inputMint: 'mint-input', outputMint: 'mint-output', amountBaseUnits: '10' },
  outputTokenId: 'svm-usdy',
})
assert.equal(swapOutcome.status, 'confirmed', 'router action remains executable when Web Locks are available')
assert.equal(swapOutcome.amountBaseUnits, '25', 'router reservation reconciles its transaction-specific output amount')
assert.equal(store.state.swapPending, null, 'confirmed router action releases its shared reservation')
assert.equal(values.has('nysaPendingSwap'), false, 'confirmed router signature no longer blocks ordinary actions')
assert.equal(walletSignCount, 2, 'one borrower action and one router action signed only after locking')

console.log('borrower feature action remains available with Web Locks')
