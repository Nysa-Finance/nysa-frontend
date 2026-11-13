import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getBase58Decoder, getTransactionEncoder, partiallySignTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { installMockWebLocks } from './test-utils/mock-web-locks.js'

const locks = installMockWebLocks()
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks, userAgent: 'iPhone', maxTouchPoints: 1 } })
const base58 = getBase58Decoder()
const signer = await generateKeyPairSigner()
const walletAddress = String(signer.address)
const signedMessage = await partiallySignTransaction([signer.keyPair], compileTransaction(pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(signer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: address('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, tx),
  (tx) => appendTransactionMessageInstructions([{
    programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    accounts: [{ address: signer.address, role: AccountRole.READONLY }], data: Uint8Array.of(1),
  }], tx),
)))
const signedBytes = getTransactionEncoder().encode(signedMessage)
const swapSignature = base58.decode(signedMessage.signatures[walletAddress])
const secretBytes = nacl.box.keyPair().secretKey
const sharedBytes = new Uint8Array(32).fill(7)
const nonceBytes = new Uint8Array(24).fill(9)
const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}
globalThis.location = { href: 'https://nysa.test/app', origin: 'https://nysa.test', search: '' }
globalThis.history = {
  state: null,
  replaceState(_state, _title, url) {
    const next = new URL(url)
    location.href = next.href
    location.search = next.search
  },
}
globalThis.EventSource = class { addEventListener() {} }
const intervals = new Map()
let intervalId = 0
globalThis.setInterval = (callback, delay) => {
  const id = ++intervalId
  intervals.set(id, { callback, delay })
  return id
}
globalThis.clearInterval = (id) => intervals.delete(id)

let relayMode = 'deferred-reject'
let relayResolve = null
let relayReject = null
let relayCount = 0
let relayFailureCount = 0
let overlapSettlement = false
let settlementLookupCount = 0
let settlementJsonReads = 0
const settlementResolvers = []
const reconciliationWarnings = []
const originalWarn = console.warn
console.warn = (...args) => {
  if (String(args[0]).includes('[swap] pending reconciliation unavailable')) reconciliationWarnings.push(args)
  originalWarn(...args)
}
globalThis.fetch = async (path, init = {}) => {
  const requestPath = String(path)
  if (requestPath === '/api/swap-send' && init.method === 'POST') {
    relayCount++
    if (relayMode === 'deferred-success' || relayMode === 'deferred-reject' || relayMode === 'deferred-http-reject') {
      return await new Promise((resolve, reject) => {
        relayResolve = (resultSignature = swapSignature) => {
          if (relayMode === 'deferred-http-reject') {
            resolve({ ok: false, status: 400, json: async () => ({ error: 'relay refused request' }) })
          } else {
            resolve({ ok: true, status: 200, json: async () => ({ signature: resultSignature }) })
          }
        }
        relayReject = () => {
          relayFailureCount++
          reject(new Error('relay response connection was lost'))
        }
      })
    }
    throw new Error('Unexpected relay mode')
  }
  if (requestPath === `/api/tx/${swapSignature}`) {
    const response = { ok: true, status: 200, json: async () => {
      settlementJsonReads++
      return {
        status: 'confirmed', slot: 20, transactionSlot: 20, wallet: walletAddress, outputMint: 'mint-out',
        tokenDeltas: [{ owner: walletAddress, mint: 'mint-out', deltaBaseUnits: '25' }],
      }
    } }
    if (overlapSettlement) {
      settlementLookupCount++
      if (settlementLookupCount > 1) {
        return await new Promise((resolve) => settlementResolvers.push(() => resolve(response)))
      }
    }
    return response
  }
  if (requestPath.startsWith('/api/account/')) {
    return { ok: true, status: 200, json: async () => ({ balances: {}, positions: {}, claimable: {} }) }
  }
  throw new Error(`Unexpected test fetch: ${requestPath}`)
}

let sequence = 0
async function createStore(search = '', deeplink = false) {
  if (deeplink) {
    values.set('nysaDeeplinkSession', JSON.stringify({
      wallet: 'Phantom', secret: base58.decode(secretBytes), shared: base58.decode(sharedBytes), session: 'swap-session', address: walletAddress,
    }))
  } else {
    values.delete('nysaDeeplinkSession')
    values.delete('connectedWallet')
  }
  location.search = search
  location.href = `https://nysa.test/app${search}`
  const store = await import(`./store.js?standalone-swap-race=${++sequence}`)
  globalThis.document = { visibilityState: 'visible', addEventListener() {} }
  store.start()
  await new Promise((resolve) => setImmediate(resolve))
  return store
}

function latestActiveReconciler() {
  const timer = [...intervals.values()].filter((item) => item.delay === 5_000).at(-1)
  assert.ok(timer, 'store has an active five-second reconciliation timer')
  return timer
}

function signedReturnSearch() {
  const nonce = nonceBytes
  const encrypted = nacl.box.after(new TextEncoder().encode(JSON.stringify({
    transaction: base58.decode(signedBytes),
  })), nonce, sharedBytes)
  return `?nysa_dl=sign&nonce=${encodeURIComponent(base58.decode(nonce))}&data=${encodeURIComponent(base58.decode(encrypted))}`
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

const built = () => ({ tx: 'AQ==', intentId: `swap-intent-${sequence}`, expiresAt: Date.now() + 60_000, minContextSlot: 1 })
const request = { wallet: walletAddress, inputMint: 'mint-in', outputMint: 'mint-out', amountBaseUnits: '10', slippageBps: 50 }
const desktopWallet = {
  name: 'Desktop wallet', chains: ['solana:mainnet'],
  features: {
    'standard:connect': { connect: async () => ({ accounts: [{ address: walletAddress, chains: ['solana:mainnet'] }] }) },
    'solana:signTransaction': { signTransaction: async () => [{ signedTransaction: signedBytes }] },
  },
}

const desktopStore = await createStore()
await desktopStore.connectWallet(desktopWallet)
const lostResponse = desktopStore.signAndSendSwap({ built: built(), request, outputTokenId: 'svm-usdy' })
lostResponse.catch(() => {})
await waitFor(() => typeof relayReject === 'function' && relayCount === 1,
  'desktop standalone swap should persist signature before deferred relay')
const desktopPending = JSON.parse(values.get('nysaPendingSwap'))
assert.equal(desktopPending.status, 'signed-pending')
latestActiveReconciler().callback()
await waitFor(() => !values.has('nysaPendingSwap') && desktopStore.state.swapOutcome?.status === 'confirmed',
  'active reconciliation confirms and clears the standalone desktop swap')
assert.ok(values.has(`nysaSwapTerminal.${desktopPending.reservationId}`),
  'exact confirmed swap signature is durable before active reconciliation clears it')
relayReject()
relayMode = 'deferred-success'
const lostOutcome = await lostResponse
assert.equal(lostOutcome.status, 'confirmed', 'on-chain confirmation settles a lost relay response')
assert.equal(values.has('nysaPendingSwap'), false, 'lost response must not resurrect a relay-unknown pending swap')
assert.equal(desktopStore.state.swapOutcome.status, 'confirmed')
assert.equal(relayCount, 1, 'lost response does not trigger a second relay')

const delayedSuccessStore = await createStore()
await delayedSuccessStore.connectWallet(desktopWallet)
const delayedSuccess = delayedSuccessStore.signAndSendSwap({ built: built(), request, outputTokenId: 'svm-usdy' })
delayedSuccess.catch(() => {})
await waitFor(() => typeof relayResolve === 'function' && relayCount === 2,
  'desktop success case should reach deferred relay')
const successPending = JSON.parse(values.get('nysaPendingSwap'))
latestActiveReconciler().callback()
await waitFor(() => !values.has('nysaPendingSwap') && delayedSuccessStore.state.swapOutcome?.status === 'confirmed',
  'active reconciler confirms desktop swap before relay response')
relayResolve()
const successOutcome = await delayedSuccess
assert.equal(successOutcome.status, 'confirmed')
assert.equal(values.has('nysaPendingSwap'), false, 'delayed relay success cannot recreate a completed desktop swap')
assert.ok(values.has(`nysaSwapTerminal.${successPending.reservationId}`))
assert.equal(relayCount, 2)

const newerStore = await createStore()
await newerStore.connectWallet(desktopWallet)
const oldSwap = newerStore.signAndSendSwap({ built: built(), request, outputTokenId: 'svm-usdy' })
oldSwap.catch(() => {})
await waitFor(() => typeof relayResolve === 'function' && relayCount === 3, 'old swap should reach deferred relay')
const oldPending = JSON.parse(values.get('nysaPendingSwap'))
latestActiveReconciler().callback()
await waitFor(() => !values.has('nysaPendingSwap') && newerStore.state.swapOutcome?.status === 'confirmed',
  'active reconciler settles old swap before a new reservation starts')
const newerPending = { reservationId: 'newer-reservation', wallet: walletAddress, status: 'awaiting-signature', intentId: 'newer-intent' }
values.set('nysaPendingSwap', JSON.stringify(newerPending))
relayResolve()
await assert.rejects(oldSwap, (error) => error.code === 'PENDING_TRANSACTION',
  'old delayed relay cannot claim success or overwrite a newer swap reservation')
assert.deepEqual(JSON.parse(values.get('nysaPendingSwap')), newerPending)
assert.equal(values.get(`nysaSwapTerminal.${oldPending.reservationId}`) !== undefined, true)
assert.equal(relayCount, 3, 'newer reservation conflict does not cause a duplicate relay')
values.delete('nysaPendingSwap') // end the simulated newer handoff before starting iOS cases

relayMode = 'deferred-success'
const mismatchedStore = await createStore()
await mismatchedStore.connectWallet(desktopWallet)
const mismatchedSwap = mismatchedStore.signAndSendSwap({ built: built(), request, outputTokenId: 'svm-usdy' })
mismatchedSwap.catch(() => {})
await waitFor(() => typeof relayResolve === 'function' && relayCount === 4,
  'mismatched signature case should reach deferred relay')
const mismatchedPending = JSON.parse(values.get('nysaPendingSwap'))
latestActiveReconciler().callback()
await waitFor(() => !values.has('nysaPendingSwap') && mismatchedStore.state.swapOutcome?.status === 'confirmed',
  'mismatched response case is terminal on-chain before relay response')
relayResolve(base58.decode(new Uint8Array(64).fill(3)))
await assert.rejects(mismatchedSwap, (error) => error.code === 'RELAY_SIGNATURE_MISMATCH',
  'relay response carrying a different signature remains rejected')
assert.equal(values.has('nysaPendingSwap'), false, 'mismatched response cannot recreate a pending swap')
assert.equal(values.get(`nysaSwapTerminal.${mismatchedPending.reservationId}`) !== undefined, true,
  'mismatched response cannot consume the confirmed signature record')
assert.equal(relayCount, 4)

relayMode = 'deferred-http-reject'
const httpRejectedStore = await createStore()
await httpRejectedStore.connectWallet(desktopWallet)
const httpRejectedSwap = httpRejectedStore.signAndSendSwap({ built: built(), request, outputTokenId: 'svm-usdy' })
httpRejectedSwap.catch(() => {})
await waitFor(() => typeof relayResolve === 'function' && relayCount === 5,
  'HTTP rejection case should reach deferred relay')
const httpRejectedPending = JSON.parse(values.get('nysaPendingSwap'))
latestActiveReconciler().callback()
await waitFor(() => !values.has('nysaPendingSwap') && httpRejectedStore.state.swapOutcome?.status === 'confirmed',
  'HTTP rejection case is terminal on-chain before response')
relayResolve()
const httpRejectedOutcome = await httpRejectedSwap
assert.equal(httpRejectedOutcome.status, 'confirmed', 'on-chain confirmation wins over a delayed relay HTTP rejection')
assert.equal(values.has('nysaPendingSwap'), false)
assert.equal(values.get(`nysaSwapTerminal.${httpRejectedPending.reservationId}`) !== undefined, true)
assert.equal(relayCount, 5)

relayMode = 'deferred-success'
const iosSwapStore = await createStore('', true)
const iosBuilt = built()
const iosHandoff = await iosSwapStore.signAndSendSwap({ built: iosBuilt, request, outputTokenId: 'svm-usdy' })
assert.equal(iosHandoff.status, 'pending', 'iOS swap opens a wallet handoff')
const iosReturnPending = JSON.parse(values.get('nysaPendingSwap'))
assert.equal(iosReturnPending.status, 'awaiting-signature')
const iosReturnStore = await createStore(signedReturnSearch(), true)
await waitFor(() => typeof relayResolve === 'function' && relayCount === 6, 'iOS signed return reaches deferred relay')
const iosSignedPending = JSON.parse(values.get('nysaPendingSwap'))
assert.equal(iosSignedPending.status, 'signed-pending')
latestActiveReconciler().callback()
await waitFor(() => !values.has('nysaPendingSwap') && iosReturnStore.state.swapOutcome?.status === 'confirmed',
  'active reconciliation confirms iOS swap before delayed relay response')
relayResolve()
for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(iosReturnStore.state.handoff.status, 'success', 'delayed iOS relay success preserves confirmed handoff')
assert.equal(values.has('nysaPendingSwap'), false, 'delayed iOS relay success does not resurrect pending state')
assert.ok(values.has(`nysaSwapTerminal.${iosSignedPending.reservationId}`))
assert.equal(relayCount, 6)

relayMode = 'deferred-reject'
const iosLostOrigin = await createStore('', true)
await iosLostOrigin.signAndSendSwap({ built: built(), request, outputTokenId: 'svm-usdy' })
const iosLostReturn = await createStore(signedReturnSearch(), true)
await waitFor(() => typeof relayReject === 'function' && relayCount === 7,
  'iOS lost response reaches one deferred relay request')
const iosLostPending = JSON.parse(values.get('nysaPendingSwap'))
latestActiveReconciler().callback()
await waitFor(() => !values.has('nysaPendingSwap') && iosLostReturn.state.swapOutcome?.status === 'confirmed',
  'active reconciliation confirms iOS swap before response loss')
relayReject()
await waitFor(() => relayFailureCount === 2, 'iOS relay transport response is lost')
for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(iosLostReturn.state.handoff.status, 'success', 'lost iOS relay response does not downgrade confirmed outcome')
assert.equal(values.has('nysaPendingSwap'), false, 'lost iOS relay response cannot restore relay-unknown pending state')
assert.ok(values.has(`nysaSwapTerminal.${iosLostPending.reservationId}`))
assert.equal(relayCount, 7, 'iOS lost response does not cause a duplicate relay')

relayMode = 'deferred-http-reject'
const iosRejectedOrigin = await createStore('', true)
await iosRejectedOrigin.signAndSendSwap({ built: built(), request, outputTokenId: 'svm-usdy' })
const iosRejectedReturn = await createStore(signedReturnSearch(), true)
await waitFor(() => typeof relayResolve === 'function' && relayCount === 8,
  'iOS HTTP rejection reaches one deferred relay request')
const iosRejectedPending = JSON.parse(values.get('nysaPendingSwap'))
latestActiveReconciler().callback()
await waitFor(() => !values.has('nysaPendingSwap') && iosRejectedReturn.state.swapOutcome?.status === 'confirmed',
  'active reconciliation confirms iOS swap before HTTP rejection')
relayResolve()
for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(iosRejectedReturn.state.handoff.status, 'success', 'delayed iOS HTTP rejection preserves the confirmed outcome')
assert.equal(values.has('nysaPendingSwap'), false, 'delayed iOS HTTP rejection cannot restore pending state')
assert.ok(values.has(`nysaSwapTerminal.${iosRejectedPending.reservationId}`))
assert.equal(relayCount, 8)

relayMode = 'deferred-success'
const overlapStore = await createStore()
await overlapStore.connectWallet(desktopWallet)
const overlapAction = overlapStore.signAndSendSwap({ built: built(), request, outputTokenId: 'svm-usdy' })
overlapAction.catch(() => {})
await waitFor(() => typeof relayResolve === 'function' && relayCount === 9,
  'overlap test should reach relay after persisting signed bytes')
const overlapPending = JSON.parse(values.get('nysaPendingSwap'))
overlapSettlement = true
settlementLookupCount = 0
settlementJsonReads = 0
relayResolve()
await waitFor(() => settlementLookupCount === 2 && settlementResolvers.length === 1,
  'post-relay confirmation should be held inside settlement lookup')
latestActiveReconciler().callback()
await waitFor(() => settlementResolvers.length === 2,
  'active timer enters a second settlement lookup before the first resolves')
for (const resolveSettlement of settlementResolvers.splice(0)) resolveSettlement()
const overlapOutcome = await overlapAction
overlapSettlement = false
assert.equal(overlapOutcome.status, 'confirmed',
  'second exact settlement returns the existing terminal result rather than throwing pending error')
await waitFor(() => settlementJsonReads === 3, 'confirmation and both concurrent settlement responses are consumed')
for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve))
assert.equal(overlapStore.state.swapOutcome?.status, 'confirmed', 'active reconciliation also settles idempotently')
assert.equal(reconciliationWarnings.length, 0, 'second same-signature settlement does not report pending-reservation error')
assert.equal(values.has('nysaPendingSwap'), false)
assert.equal(values.get(`nysaSwapTerminal.${overlapPending.reservationId}`) !== undefined, true)
assert.equal(relayCount, 9, 'overlapping settlement does not relay the signed transaction twice')

console.log('standalone swap reconciliation race guard')
