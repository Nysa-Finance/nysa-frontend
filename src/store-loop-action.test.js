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

const requests = []
const chainReads = []
const accountLoopPositions = []
const accountLoopPositionReadStatus = { 'sol-usdy-usdc': 'verified' }
let chainStatus = 'confirmed'
globalThis.fetch = async (path, init = {}) => {
  const requestPath = String(path)
  if (requestPath === '/api/tx' && init.method === 'POST') {
    const body = JSON.parse(init.body)
    requests.push({ path: requestPath, body })
    return { ok: true, status: 200, json: async () => ({
      tx: 'AQ==', minContextSlot: 1, final: true, intentId: 'loop-intent', expiresAt: Date.now() + 10_000,
    }) }
  }
  if (requestPath === '/api/loop-send' && init.method === 'POST') {
    const body = JSON.parse(init.body)
    requests.push({ path: requestPath, body })
    return { ok: true, status: 200, json: async () => ({ signature: signatureText }) }
  }
  if (requestPath === `/api/tx/${signatureText}`) {
    chainReads.push({ status: chainStatus })
    return { ok: true, status: 200, json: async () => ({ status: chainStatus, slot: 1 }) }
  }
  if (requestPath.startsWith('/api/account/')) return {
    ok: true, status: 200,
    json: async () => ({ balances: {}, balancesBaseUnits: {}, positions: {}, positionsBaseUnits: {},
      loopPositions: accountLoopPositions, loopPositionReadStatus: accountLoopPositionReadStatus, claimable: {} }),
  }
  throw new Error(`Unexpected test fetch: ${requestPath}`)
}

const store = await import('./store.js')
let signedCount = 0
const wallet = {
  name: 'Loop intent wallet', chains: ['solana:mainnet'],
  features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signTransaction': { signTransaction: async () => { signedCount++; return [{ signedTransaction }] } },
  },
}
await store.connectWallet(wallet)
const signature = await store.sendLoopAction('loop-open', {
  market: 'sol-usdy-usdc', amount: '100', leverage: 1.5,
  previewId: 'preview-1', acknowledgementKey: 'a'.repeat(64),
})
assert.equal(signature, signatureText)
assert.equal(signedCount, 1, 'loop execution uses the wallet sign-only capability before server relay')
assert.equal(requests[0].body.previewId, 'preview-1')
assert.equal(requests[0].body.acknowledgementKey, 'a'.repeat(64))
assert.equal(requests[1].path, '/api/loop-send', 'loop signatures use the exact-intent relay endpoint')
assert.equal(requests[1].body.intentId, 'loop-intent')
assert.equal(requests[1].body.wallet, walletAddress)
assert.equal(store.state.lendingPending, null, 'confirmed loop action releases the cross-tab reservation')
await store.sendLoopSetup({ market: 'sol-usdy-usdc' })
assert.equal(requests[2].body.kind, 'loop-setup', 'Kamino initialization is a distinct non-economic build')
assert.equal(requests[3].path, '/api/loop-send', 'setup uses its own exact-message relay intent')
assert.equal(signedCount, 2, 'setup uses the connected wallet sign-only path')
assert.equal(store.state.lendingPending, null, 'confirmed setup releases its reservation independently of loop entry')

const positionId = `multiply:${'a'.repeat(64)}`
accountLoopPositionReadStatus['sol-usdy-usdc'] = 'unavailable'
await assert.rejects(store.sendLoopAction('loop-close', { market: 'sol-usdy-usdc', positionId }), (error) => {
  assert.equal(error.code, 'PENDING_TRANSACTION')
  return /not verified a full close|selected Multiply position/i.test(error.message)
}, 'a missing position after a failed fresh read remains unknown instead of confirming close')
assert.equal(store.state.lendingPending?.params?.positionId, positionId,
  'the unresolved close stays bound to the exact obligation for later reconciliation')
await assert.rejects(store.sendLoopAction('loop-open', {
  market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: 'preview-2', acknowledgementKey: 'b'.repeat(64),
}), /still pending|reconcile/i, 'a partial or unverified close blocks new economic actions')

chainStatus = 'pending'
const chainReadsBeforeReload = chainReads.length
const buildsBeforeReload = requests.length
const intervalCallbacks = []
const visibilityHandlers = []
globalThis.setInterval = (callback) => { intervalCallbacks.push(callback); return intervalCallbacks.length }
globalThis.clearInterval = () => {}
globalThis.EventSource = class {
  static CLOSED = 2
  readyState = 1
  addEventListener() {}
}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (name, callback) => { if (name === 'visibilitychange') visibilityHandlers.push(callback) },
}
globalThis.location = { href: 'https://nysa.finance/loop', search: '', origin: 'https://nysa.finance' }
globalThis.history = { state: null, replaceState() {} }
const reloadedStore = await import(`./store.js?loop-reload=${Date.now()}`)
assert.equal(reloadedStore.state.lendingPending?.signature, signatureText,
  'a submitted loop-close signature restores from localStorage after reload')
assert.equal(reloadedStore.state.lendingPending?.params?.positionId, positionId,
  'reloaded close reconciliation stays bound to the selected obligation')
await reloadedStore.connectWallet(wallet)
reloadedStore.start()
const waitFor = async (predicate, description) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail(`Timed out waiting for ${description}`)
}
await waitFor(() => chainReads.length > chainReadsBeforeReload && reloadedStore.state.address === walletAddress,
  'the reloaded wallet to reconcile the still-pending close signature')
assert.equal(chainReads.at(-1).status, 'pending', 'reload reconciliation observes the unresolved chain status')
assert.equal(reloadedStore.state.lendingPending?.signature, signatureText,
  'pending chain status never clears the durable close signature')
assert.equal(requests.length, buildsBeforeReload,
  'reload status reconciliation does not build or relay a duplicate close transaction')
assert.equal(requests.filter((request) => request.path === '/api/tx' && request.body.kind === 'loop-close').length, 1,
  'restoring a pending close does not create a second economic build')
await assert.rejects(reloadedStore.sendLoopAction('loop-open', {
  market: 'sol-usdy-usdc', amount: '100', leverage: 1.5, previewId: 'preview-3', acknowledgementKey: 'c'.repeat(64),
}), /still pending|reconcile/i, 'a reloaded pending close continues to block new loop actions')

chainStatus = 'confirmed'
accountLoopPositionReadStatus['sol-usdy-usdc'] = 'unavailable'
for (const handler of visibilityHandlers) handler()
await waitFor(() => reloadedStore.state.handoff?.signature === signatureText,
  'confirmed chain status with an unavailable position read')
assert.equal(reloadedStore.state.lendingPending?.signature, signatureText,
  'a confirmed signature remains pending while the fresh position read is unavailable')

accountLoopPositionReadStatus['sol-usdy-usdc'] = 'verified'
accountLoopPositions.splice(0, accountLoopPositions.length, {
  id: positionId,
  obligation: { balances: { deposits: [], borrows: [] }, unsupportedReserves: [] },
  liability: { amountBaseUnits: '0' },
  collateral: { amountBaseUnits: '0' },
})
await waitFor(() => {
  for (const handler of visibilityHandlers) handler()
  return reloadedStore.state.lendingPending === null
},
  'fresh verified zero debt and collateral before clearing the close')
assert.equal(reloadedStore.state.handoff?.status, 'success',
  'the reloaded close reports success only after exact zero-state verification')
console.log('loop action signs through the exact-intent relay')
