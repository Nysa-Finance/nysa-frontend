import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getBase58Decoder, getTransactionEncoder, partiallySignTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'

const base58 = getBase58Decoder()
const signer = await generateKeyPairSigner()
const walletAddress = String(signer.address)
const secretBytes = nacl.box.keyPair().secretKey
const sharedBytes = new Uint8Array(32).fill(7)
const nonceBytes = new Uint8Array(24).fill(9)
const values = new Map([
  ['nysaDeeplinkSession', JSON.stringify({
    wallet: 'Phantom', secret: base58.decode(secretBytes), shared: base58.decode(sharedBytes), session: 'test-session', address: walletAddress,
  })],
])
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'iPhone', maxTouchPoints: 1 } })
globalThis.location = { href: 'https://nysa.test/app', origin: 'https://nysa.test', search: '' }
globalThis.history = {
  state: null,
  replaceState(_state, _title, url) {
    const next = new URL(url)
    location.href = next.href
    location.search = next.search
  },
}
globalThis.EventSource = class {
  addEventListener() {}
}
const intervals = new Map()
let nextIntervalId = 0
globalThis.setInterval = (callback, delay) => {
  const id = ++nextIntervalId
  intervals.set(id, { callback, delay })
  return id
}
globalThis.clearInterval = (id) => intervals.delete(id)

let buildCount = 0
let relayCount = 0
const relayBodies = []
let relaySawPersistedSignature = false
let deferRelayResponse = false
let relayResponseSignature = null
let resolveRelayResponse = null
let rejectRelayResponse = null
let relayResponseJsonReads = 0
let relayResponseNetworkFailures = 0
const featureTransaction = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(signer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: address('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, tx),
  (tx) => appendTransactionMessageInstructions([{
    programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    accounts: [{ address: signer.address, role: AccountRole.READONLY }], data: Uint8Array.of(1),
  }], tx),
)
const signed = await partiallySignTransaction([signer.keyPair], compileTransaction(featureTransaction))
const signedBytes = getTransactionEncoder().encode(signed)
const signedSignatureText = base58.decode(signed.signatures[walletAddress])

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
    relayCount++
    const relayBody = JSON.parse(init.body)
    relayBodies.push(relayBody)
    const pending = JSON.parse(values.get('nysaPendingTx'))
    relaySawPersistedSignature = pending.signature === signedSignatureText && pending.status === 'signed-pending'
    if (deferRelayResponse) {
      return await new Promise((resolve, reject) => {
        resolveRelayResponse = () => resolve({ ok: true, status: 200, json: async () => {
          relayResponseJsonReads++
          return { signature: relayResponseSignature ?? signedSignatureText }
        } })
        rejectRelayResponse = () => {
          relayResponseNetworkFailures++
          reject(new Error('socket closed after transaction reached the relay'))
        }
      })
    }
    return { ok: true, status: 200, json: async () => {
      relayResponseJsonReads++
      return { signature: relayResponseSignature ?? signedSignatureText }
    } }
  }
  if (requestPath === `/api/tx/${signedSignatureText}`) {
    return { ok: true, status: 200, json: async () => ({ status: 'confirmed', slot: 12 }) }
  }
  if (requestPath.startsWith('/api/account/')) {
    return { ok: true, status: 200, json: async () => ({ balances: {}, positions: {}, claimable: {} }) }
  }
  throw new Error(`Unexpected test fetch: ${requestPath}`)
}

let storeSequence = 0
async function startStore(search = '') {
  location.search = search
  if (search) location.href = `https://nysa.test/app${search}`
  const store = await import(`./store.js?deeplink-recovery=${++storeSequence}`)
  globalThis.document = { visibilityState: 'visible', addEventListener() {} }
  store.start()
  await new Promise((resolve) => setImmediate(resolve))
  return store
}

function signedReturnSearch() {
  const transaction = base58.decode(signedBytes)
  const encrypted = nacl.box.after(
    new TextEncoder().encode(JSON.stringify({ transaction })), nonceBytes, sharedBytes,
  )
  return `?nysa_dl=sign&nonce=${encodeURIComponent(base58.decode(nonceBytes))}&data=${encodeURIComponent(base58.decode(encrypted))}`
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

const action = { market: { id: 'sol-usdy-usdc' }, token: { token_id: 'svm-usdc' }, amount: '1' }
const handoffStore = await startStore()
const cancelledAction = handoffStore.sendKaminoAction('deposit', action)
cancelledAction.catch(() => {})
await waitFor(() => handoffStore.state.handoff?.status === 'ready', 'iOS setup should open the wallet handoff')
assert.equal(handoffStore.state.lendingPending.status, 'awaiting-signature',
  'deeplink promotion preserves the status consumed by return and cancel recovery')
assert.match(handoffStore.state.handoff.url, /signTransaction/)
assert.equal(await handoffStore.cancelHandoff(), true, 'user can cancel the promoted iOS wallet handoff')
assert.equal(values.has('nysaPendingTx'), false, 'cancel clears the exact awaiting signature reservation')

const refusalOrigin = await startStore()
const refusedAction = refusalOrigin.sendKaminoAction('deposit', action)
refusedAction.catch(() => {})
await waitFor(() => refusalOrigin.state.handoff?.status === 'ready', 'iOS wallet refusal case should open handoff')
const refusedStore = await startStore('?nysa_dl=sign&errorCode=4001')
await waitFor(() => refusedStore.state.handoff?.status === 'error', 'wallet refusal should be reconciled after reconnect')
assert.match(refusedStore.state.handoff.error, /rejected/i)
assert.equal(values.has('nysaPendingTx'), false, 'definite wallet refusal clears its reservation')
assert.equal(relayCount, 0, 'wallet refusal never relays a transaction')
assert.equal(await refusalOrigin.cancelHandoff(), true, 'old tab can settle its cancelled handoff promise')

const retryAction = refusedStore.sendKaminoAction('deposit', action)
retryAction.catch(() => {})
await waitFor(() => refusedStore.state.handoff?.status === 'ready', 'explicit retry should open one new wallet handoff')
const retryBuildCount = buildCount
refusedStore.start()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(buildCount, retryBuildCount, 're-entry does not silently rebuild or prompt a second time')
assert.equal(await refusedStore.cancelHandoff(), true, 'retry handoff remains explicitly cancellable')
assert.equal(values.has('nysaPendingTx'), false)

const signedOrigin = await startStore()
const signedAction = signedOrigin.sendKaminoAction('deposit', action)
signedAction.catch(() => {})
await waitFor(() => signedOrigin.state.handoff?.status === 'ready', 'signed return case should open iOS handoff')
const pendingBeforeReturn = JSON.parse(values.get('nysaPendingTx'))
assert.equal(pendingBeforeReturn.status, 'awaiting-signature')
assert.match(pendingBeforeReturn.intentId, /^lending-intent-/,
  'iOS persists exact-message intent while the wallet app is open')
deferRelayResponse = true
relayResponseSignature = signedSignatureText
const signedReturnStore = await startStore(signedReturnSearch())
await waitFor(() => typeof resolveRelayResponse === 'function', 'signed return should wait for relay response after persisting the signature')
const signedPending = JSON.parse(values.get('nysaPendingTx'))
assert.equal(signedPending.status, 'signed-pending')
assert.equal(signedPending.signature, signedSignatureText)
const activeReconciler = [...intervals.values()].filter((timer) => timer.delay === 5_000).at(-1)
assert.ok(activeReconciler, 'store startup installs the active five-second reconciliation timer')
activeReconciler.callback()
await waitFor(() => !values.has('nysaPendingTx') && signedReturnStore.state.handoff?.status === 'success',
  'active reconciliation can confirm and clear while relay HTTP remains deferred')
assert.equal(values.get(`nysaActionTerminal.${signedPending.reservationId}`) !== undefined, true,
  'terminal signature is durable before its pending reservation is cleared')
resolveRelayResponse()
deferRelayResponse = false
await waitFor(() => relayResponseJsonReads === 1, 'relay response should be consumed exactly once')
assert.equal(signedReturnStore.state.handoff.status, 'success',
  `signed return resumes after wallet reconnect; got ${signedReturnStore.state.handoff.error ?? 'no error'}`)
assert.equal(relayCount, 1, 'signed return relays exactly once')
assert.equal(relayBodies[0].intentId, pendingBeforeReturn.intentId,
  'iOS signed return includes the same exact-message intent issued by /api/tx')
assert.equal(relaySawPersistedSignature, true, 'signature and signed-pending state persist before relay')
assert.equal(values.has('nysaPendingTx'), false, 'confirmed signed return clears the matching reservation')
signedReturnStore.start()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(relayCount, 1, 're-entry after successful return never repeats relay or wallet prompt')

const mismatchedOrigin = await startStore()
const mismatchedAction = mismatchedOrigin.sendKaminoAction('deposit', action)
mismatchedAction.catch(() => {})
await waitFor(() => mismatchedOrigin.state.handoff?.status === 'ready', 'mismatched response case should open handoff')
deferRelayResponse = true
relayResponseSignature = base58.decode(new Uint8Array(64).fill(3))
const mismatchedReturnStore = await startStore(signedReturnSearch())
await waitFor(() => typeof resolveRelayResponse === 'function' && relayCount === 2,
  'mismatched return should reach one deferred relay call')
const mismatchPending = JSON.parse(values.get('nysaPendingTx'))
const mismatchReconciler = [...intervals.values()].filter((timer) => timer.delay === 5_000).at(-1)
mismatchReconciler.callback()
await waitFor(() => !values.has('nysaPendingTx') && mismatchedReturnStore.state.handoff?.status === 'success',
  'confirmed on-chain transaction settles before mismatched relay response')
resolveRelayResponse()
deferRelayResponse = false
await waitFor(() => relayResponseJsonReads === 2, 'mismatched relay response should be consumed')
await waitFor(() => mismatchedReturnStore.state.handoff?.status === 'error', 'relay response with another signature remains rejected')
assert.match(mismatchedReturnStore.state.handoff.error, /outcome is unknown/i)
assert.equal(values.get(`nysaActionTerminal.${mismatchPending.reservationId}`) !== undefined, true,
  'wrong relay signature cannot consume or overwrite the exact confirmed terminal record')
assert.equal(relayCount, 2, 'mismatched response is rejected without sending a duplicate relay')

const lostResponseOrigin = await startStore()
const lostResponseAction = lostResponseOrigin.sendKaminoAction('deposit', action)
lostResponseAction.catch(() => {})
await waitFor(() => lostResponseOrigin.state.handoff?.status === 'ready', 'lost response case should open handoff')
deferRelayResponse = true
relayResponseSignature = signedSignatureText
const lostResponseStore = await startStore(signedReturnSearch())
await waitFor(() => typeof rejectRelayResponse === 'function' && relayCount === 3,
  'lost response case should reach one deferred relay request')
const lostPending = JSON.parse(values.get('nysaPendingTx'))
const lostResponseReconciler = [...intervals.values()].filter((timer) => timer.delay === 5_000).at(-1)
lostResponseReconciler.callback()
await waitFor(() => !values.has('nysaPendingTx') && lostResponseStore.state.handoff?.status === 'success',
  'active reconciliation confirms and clears before the response is lost')
rejectRelayResponse()
deferRelayResponse = false
await waitFor(() => relayResponseNetworkFailures === 1, 'relay transport should reject after reconciliation')
for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(lostResponseStore.state.handoff.status, 'success',
  `confirmed signature survives lost relay response; got ${lostResponseStore.state.handoff.error ?? 'no error'}`)
assert.equal(values.has('nysaPendingTx'), false, 'lost HTTP response does not recreate a false unknown reservation')
assert.equal(values.get(`nysaActionTerminal.${lostPending.reservationId}`) !== undefined, true,
  'confirmed signature record remains available after relay response loss')
assert.equal(relayCount, 3, 'lost response does not trigger a duplicate relay request')

console.log('iOS deeplink handoff reservation remains recoverable')
