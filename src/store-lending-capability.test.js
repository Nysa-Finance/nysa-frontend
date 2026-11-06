import assert from 'node:assert/strict'
import { getBase58Decoder } from '@solana/kit'
import { installMockWebLocks } from './test-utils/mock-web-locks.js'

const walletAddress = '11111111111111111111111111111111'
const account = { address: walletAddress, chains: ['solana:mainnet'] }
const setupSignature = getBase58Decoder().decode(Uint8Array.from({ length: 64 }, (_, index) => index + 1))
const actionSignature = getBase58Decoder().decode(Uint8Array.from({ length: 64 }, (_, index) => index + 2))
const localValues = new Map()
globalThis.localStorage = {
  getItem: (key) => localValues.get(key) ?? null,
  setItem: (key, value) => localValues.set(key, String(value)),
  removeItem: (key) => localValues.delete(key),
}
installMockWebLocks()

let store
let buildCount = 0
let walletSendCount = 0
let rejectActionWalletPrompt = true
let pendingObservedBeforeConfirmation = false
globalThis.fetch = async (path, init = {}) => {
  const requestPath = String(path)
  if (requestPath.startsWith('/api/account/')) {
    return { ok: true, status: 200, json: async () => ({ balances: {}, balancesBaseUnits: {}, positions: {}, positionsBaseUnits: {}, claimable: {} }) }
  }
  if (requestPath === '/api/tx' && init.method === 'POST') {
    buildCount++
    if (buildCount === 2 || buildCount === 3) return { ok: false, status: 503, json: async () => ({ error: 'temporary action build failure' }) }
    return {
      ok: true,
      status: 200,
      json: async () => ({ tx: 'AQ==', minContextSlot: 1, final: buildCount !== 1 }),
    }
  }
  if (requestPath === `/api/tx/${setupSignature}`) {
    assert.equal(store.state.lendingPending?.signature, setupSignature,
      'the signAndSend setup signature is persisted before its confirmation lookup')
    assert.equal(store.state.lendingPending.status, 'submitted')
    return { ok: true, status: 200, json: async () => ({ status: 'confirmed', slot: 5 }) }
  }
  if (requestPath === `/api/tx/${actionSignature}`) {
    pendingObservedBeforeConfirmation = true
    assert.equal(store.state.lendingPending?.signature, actionSignature,
      'the signAndSend action signature is persisted before its confirmation lookup')
    assert.equal(store.state.lendingPending.status, 'submitted')
    assert.equal(store.state.lendingPending.setupRecoverySignature, setupSignature)
    return { ok: true, status: 200, json: async () => ({ status: 'confirmed', slot: 6 }) }
  }
  throw new Error(`Unexpected test fetch: ${requestPath}`)
}

store = await import('./store.js')
const wallet = {
  name: 'SignAndSend only desktop',
  chains: ['solana:mainnet'],
  features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signAndSendTransaction': {
      signAndSendTransaction: async () => {
        walletSendCount++
        if (walletSendCount === 1) return [{ signature: Uint8Array.from({ length: 64 }, (_, index) => index + 1) }]
        if (walletSendCount === 2 && rejectActionWalletPrompt) throw new Error('User rejected the transaction')
        return [{ signature: Uint8Array.from({ length: 64 }, (_, index) => index + 2) }]
      },
    },
  },
}
await store.connectWallet(wallet)
assert.equal(store.state.address, walletAddress)
assert.equal(wallet.features['solana:signTransaction'], undefined)

const market = { id: 'sol-usdy-usdc' }
const token = { token_id: 'svm-usdc' }
await assert.rejects(store.sendKaminoAction('deposit', { market, token, amount: '1' }), /temporary action build failure/i,
  'a setup-only first step leaves an explicit recovery path when the action build fails')
assert.equal(walletSendCount, 1, 'signAndSend-only desktop wallet completes the account setup step')
assert.equal(store.state.lendingPending, null, 'confirmed setup clears its transaction marker')
assert.equal(store.state.lendingSetupRecovery.status, 'setup-confirmed')
assert.equal(store.state.lendingSetupRecovery.signature, setupSignature)
assert.notEqual(store.state.lendingSetupRecovery.signature, actionSignature)

const rejectedResume = await store.resumeLendingSetupRecovery()
assert.equal(rejectedResume, false, 'a definite wallet rejection leaves setup available for explicit retry or cancel')
assert.equal(walletSendCount, 2)
assert.equal(store.state.lendingPending, null, 'a signAndSend rejection without a returned signature creates no false unknown pending record')
assert.equal(store.state.lendingSetupRecovery.signature, setupSignature, 'rejected action keeps the confirmed setup signature')
assert.notEqual(store.state.lendingPending?.status, 'relay-unknown')

rejectActionWalletPrompt = false
const resumed = await store.resumeLendingSetupRecovery()
assert.equal(resumed, true, 'explicit Resume continues ordinary lending with signAndSend-only capability')
assert.equal(walletSendCount, 3)
assert.equal(pendingObservedBeforeConfirmation, true, 'returned action signature is durable before confirmation/reconciliation')
assert.equal(store.state.lendingPending, null, 'confirmed action clears its pending signature')
assert.equal(store.state.lendingSetupRecovery, null, 'confirmed action clears the setup recovery marker')
assert.equal(store.state.handoff.status, 'success')
assert.equal(store.state.handoff.signature, actionSignature)

console.log('ordinary lending setup resume supports signAndSend-only wallets')
