import assert from 'node:assert/strict'
import { getBase58Decoder } from '@solana/kit'
import { installMockWebLocks } from './test-utils/mock-web-locks.js'

const walletAddress = '11111111111111111111111111111111'
const account = { address: walletAddress, chains: ['solana:mainnet'] }
const signatureBytes = Uint8Array.from({ length: 64 }, (_, index) => index + 1)
const signature = getBase58Decoder().decode(signatureBytes)
const secondSignatureBytes = Uint8Array.from({ length: 64 }, (_, index) => index + 2)
const secondSignature = getBase58Decoder().decode(secondSignatureBytes)
const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}
installMockWebLocks()

let resolveFirstBuild
let resolveSecondSend
let resolveSecondConfirmation
let buildCount = 0
let walletPromptCount = 0
globalThis.fetch = async (path, init = {}) => {
  const requestPath = String(path)
  if (requestPath.startsWith('/api/account/')) {
    return { ok: true, status: 200, json: async () => ({ balances: {}, balancesBaseUnits: {}, positions: {}, positionsBaseUnits: {}, claimable: {} }) }
  }
  if (requestPath === '/api/tx' && init.method === 'POST') {
    buildCount++
    if (buildCount === 1) return await new Promise((resolve) => { resolveFirstBuild = resolve })
    if (buildCount === 2 || buildCount === 3) return { ok: true, status: 200, json: async () => ({ tx: 'AQ==', minContextSlot: 1, final: true }) }
    return { ok: false, status: 503, json: async () => ({ error: 'unexpected extra action build' }) }
  }
  if (requestPath === `/api/tx/${signature}`) {
    return { ok: true, status: 200, json: async () => ({ status: 'confirmed', slot: 9 }) }
  }
  if (requestPath === `/api/tx/${secondSignature}`) {
    return await new Promise((resolve) => { resolveSecondConfirmation = resolve })
  }
  throw new Error(`Unexpected test fetch: ${requestPath}`)
}

const store = await import('./store.js')
const wallet = {
  name: 'Deferred action wallet',
  chains: ['solana:mainnet'],
  features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signAndSendTransaction': {
      signAndSendTransaction: async () => {
        walletPromptCount++
        if (walletPromptCount === 1) return [{ signature: signatureBytes }]
        if (walletPromptCount === 2) return await new Promise((resolve) => { resolveSecondSend = resolve })
        if (walletPromptCount === 3) throw new Error('wallet transport dropped after possible broadcast')
        throw new Error('unexpected extra wallet prompt')
      },
    },
  },
}
await store.connectWallet(wallet)
const concurrentTab = await import('./store.js?concurrent-action-tab')
await concurrentTab.connectWallet(wallet)

const market = { id: 'sol-usdy-usdc' }
const token = { token_id: 'svm-usdc' }
const first = store.sendKaminoAction('deposit', { market, token, amount: '1' })
const acrossTab = concurrentTab.sendKaminoAction('borrow', { market, token, amount: '1' })
const sameTab = store.sendKaminoAction('repay', { market, token, amount: '1' })
const acrossTabRejected = assert.rejects(acrossTab, (error) => error.code === 'PENDING_TRANSACTION',
  'concurrent tab loses the exclusive persisted reservation before transaction build')
const sameTabRejected = assert.rejects(sameTab, (error) => error.code === 'PENDING_TRANSACTION',
  'a concurrent action is rejected while the first action is being built')
await new Promise((resolve) => setImmediate(resolve))
assert.equal(typeof resolveFirstBuild, 'function', 'first action reached its deferred build request')
await acrossTabRejected
await sameTabRejected
assert.equal(buildCount, 1, 'the second action never reaches transaction build')
assert.equal(walletPromptCount, 0, 'neither action prompts the wallet before the first build returns')
assert.ok(values.has('nysaPendingTx'), `winning action reservation remains stored; buildCount=${buildCount}`)
const reserved = JSON.parse(values.get('nysaPendingTx'))
assert.equal(reserved.status, 'preparing', 'reservation is durable before any await or build')
assert.equal(reserved.phase, 'building')

resolveFirstBuild({ ok: true, status: 200, json: async () => ({ tx: 'AQ==', minContextSlot: 1, final: true }) })
assert.equal(await first, signature)
assert.equal(walletPromptCount, 1, 'only the reserved action prompts and broadcasts')
assert.equal(values.has('nysaPendingTx'), false, 'confirmed action releases the reservation')

const secondAction = store.sendKaminoAction('deposit', { market, token, amount: '2' })
await new Promise((resolve) => setImmediate(resolve))
assert.equal(typeof resolveSecondSend, 'function', 'the next action reached its deferred wallet prompt')
const walletPromptReservation = JSON.parse(values.get('nysaPendingTx'))
assert.equal(walletPromptReservation.status, 'wallet-prompt')
assert.equal(walletPromptReservation.phase, 'wallet-prompt')

const promptReload = await import('./store.js?action-prompt-reload')
await promptReload.connectWallet(wallet)
assert.equal(await promptReload.cancelLendingBuildReservation(), false, 'a wallet-prompt reservation cannot be cancelled as an interrupted build')
await assert.rejects(promptReload.sendKaminoAction('borrow', { market, token, amount: '3' }),
  (error) => error.code === 'PENDING_TRANSACTION',
  'a reloaded store cannot overwrite a durable wallet-prompt reservation')
assert.equal(buildCount, 2, 'reload does not build over an unresolved wallet prompt')
assert.equal(walletPromptCount, 2, 'reload does not open a second wallet prompt')

resolveSecondSend([{ signature: secondSignatureBytes }])
await new Promise((resolve) => setImmediate(resolve))
const submitted = JSON.parse(values.get('nysaPendingTx'))
assert.equal(submitted.status, 'submitted')
assert.equal(submitted.signature, secondSignature, 'returned signature is persisted before confirmation')
assert.equal(typeof resolveSecondConfirmation, 'function', 'confirmation lookup is deferred after persistence')

const signatureReload = await import('./store.js?action-signature-reload')
await signatureReload.connectWallet(wallet)
assert.equal(signatureReload.state.lendingPending.signature, secondSignature,
  'a reloaded store hydrates the exact unresolved signature')
await assert.rejects(signatureReload.sendKaminoAction('borrow', { market, token, amount: '4' }),
  (error) => error.code === 'PENDING_TRANSACTION',
  'a reloaded store cannot overwrite a returned unresolved signature')
assert.equal(buildCount, 2)
assert.equal(walletPromptCount, 2)
resolveSecondConfirmation({ ok: true, status: 200, json: async () => ({ status: 'confirmed', slot: 10 }) })
assert.equal(await secondAction, secondSignature)
assert.equal(values.has('nysaPendingTx'), false, 'confirmed completion clears the persistent signature')

await assert.rejects(store.sendKaminoAction('deposit', { market, token, amount: '5' }),
  (error) => error.code === 'PENDING_TRANSACTION',
  'an ambiguous wallet send is surfaced as an unresolved action')
const unknown = JSON.parse(values.get('nysaPendingTx'))
assert.equal(unknown.status, 'relay-unknown')
assert.equal(unknown.phase, 'send-outcome-unknown')
assert.equal(unknown.signature, null)

const unknownReload = await import('./store.js?action-unknown-reload')
await unknownReload.connectWallet(wallet)
assert.equal(await unknownReload.cancelLendingBuildReservation(), false, 'an ambiguous send cannot be cancelled as an interrupted build')
await assert.rejects(unknownReload.sendKaminoAction('borrow', { market, token, amount: '6' }),
  (error) => error.code === 'PENDING_TRANSACTION',
  'ambiguous send remains blocked after reload even without a returned signature')
assert.equal(buildCount, 3, 'reload does not rebuild an ambiguous send')
assert.equal(walletPromptCount, 3, 'reload does not prompt again after an ambiguous send')

console.log('lending action reservation serializes concurrent actions')
