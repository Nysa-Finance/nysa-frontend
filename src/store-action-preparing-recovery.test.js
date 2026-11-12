import assert from 'node:assert/strict'
import { getBase58Decoder } from '@solana/kit'
import { installMockWebLocks } from './test-utils/mock-web-locks.js'

// Node 25+ defines sessionStorage by default; the recovery path must work without it, so remove it.
Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true, writable: true })
assert.equal(typeof globalThis.sessionStorage, 'undefined', 'recovery test runs without sessionStorage')

const walletAddress = '11111111111111111111111111111111'
const account = { address: walletAddress, chains: ['solana:mainnet'] }
const signatureBytes = Uint8Array.from({ length: 64 }, (_, index) => index + 11)
const signature = getBase58Decoder().decode(signatureBytes)
const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}
installMockWebLocks()

const nativeSetInterval = globalThis.setInterval.bind(globalThis)
const nativeClearInterval = globalThis.clearInterval.bind(globalThis)
let heartbeatTick
globalThis.setInterval = (callback, interval, ...args) => {
  if (interval === 10_000) {
    heartbeatTick = callback
    return { actionBuildLease: true }
  }
  return nativeSetInterval(callback, interval, ...args)
}
globalThis.clearInterval = (timer) => {
  if (timer?.actionBuildLease) return
  nativeClearInterval(timer)
}

let resolveInterruptedBuild
let buildCount = 0
let walletPromptCount = 0
globalThis.fetch = async (path, init = {}) => {
  const requestPath = String(path)
  if (requestPath.startsWith('/api/account/')) {
    return { ok: true, status: 200, json: async () => ({ balances: {}, balancesBaseUnits: {}, positions: {}, positionsBaseUnits: {}, claimable: {} }) }
  }
  if (requestPath === '/api/tx' && init.method === 'POST') {
    buildCount++
    if (buildCount === 1) return await new Promise((resolve) => { resolveInterruptedBuild = resolve })
    if (buildCount === 2) return { ok: true, status: 200, json: async () => ({ tx: 'AQ==', minContextSlot: 1, final: true }) }
  }
  if (requestPath === `/api/tx/${signature}`) {
    return { ok: true, status: 200, json: async () => ({ status: 'confirmed', slot: 12 }) }
  }
  throw new Error(`Unexpected test fetch: ${requestPath}`)
}

const store = await import('./store.js')
const wallet = {
  name: 'Interrupted build wallet',
  chains: ['solana:mainnet'],
  features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signAndSendTransaction': {
      signAndSendTransaction: async () => {
        walletPromptCount++
        return [{ signature: signatureBytes }]
      },
    },
  },
}
await store.connectWallet(wallet)

const market = { id: 'sol-usdy-usdc' }
const token = { token_id: 'svm-usdc' }
const interrupted = store.sendKaminoAction('deposit', { market, token, amount: '1' })
await new Promise((resolve) => setImmediate(resolve))
assert.equal(typeof resolveInterruptedBuild, 'function', 'the first build request is deferred')
const saved = JSON.parse(values.get('nysaPendingTx'))
assert.equal(saved.status, 'preparing')
assert.equal(saved.phase, 'building')
assert.equal(saved.signature, null, 'build reservation has no transaction signature')
assert.ok(saved.leaseExpiresAt > Date.now(), 'active build owns a renewable cross-tab lease')
assert.equal(walletPromptCount, 0, 'wallet is not invoked before build completes')
assert.equal(typeof heartbeatTick, 'function', 'active build has a renewable lease heartbeat')
await heartbeatTick()
const renewed = JSON.parse(values.get('nysaPendingTx'))
assert.ok(renewed.leaseExpiresAt > saved.leaseExpiresAt,
  `heartbeat renews the same reservation under the shared lock (${saved.leaseExpiresAt} -> ${renewed.leaseExpiresAt})`)

const activeNewTab = await import('./store.js?preparing-active-new-tab')
await activeNewTab.connectWallet(wallet)
assert.equal(activeNewTab.state.lendingBuildCancelable, false, 'new tab cannot cancel a live build lease')
assert.equal(await activeNewTab.cancelLendingBuildReservation(), false, 'live build lease remains protected')
assert.equal(buildCount, 1, 'live lease prevents a second build')
assert.equal(walletPromptCount, 0)

// Model the originating tab closing: its lease stops renewing and expires.
values.set('nysaPendingTx', JSON.stringify({ ...saved, leaseExpiresAt: Date.now() - 1 }))
const otherTabStore = await import('./store.js?preparing-after-close')
await otherTabStore.connectWallet(wallet)
assert.equal(otherTabStore.state.lendingPending.status, 'preparing', 'new tab restores the interrupted build reservation')
assert.equal(otherTabStore.state.lendingActionBusy, false, 'new tab has no active in-memory action')
assert.equal(otherTabStore.state.lendingBuildCancelable, true, 'expired pre-wallet lease may be cancelled')
assert.equal(await otherTabStore.cancelLendingBuildReservation(), true, 'user may explicitly release the expired pre-wallet build reservation')
assert.equal(values.has('nysaPendingTx'), false, 'explicit release removes the no-signature reservation')
await heartbeatTick()
assert.equal(values.has('nysaPendingTx'), false, 'late heartbeat rechecks its token and cannot resurrect a cancelled reservation')

resolveInterruptedBuild({ ok: true, status: 200, json: async () => ({ tx: 'AQ==', minContextSlot: 1, final: true }) })
await assert.rejects(interrupted, (error) => error.code === 'PENDING_TRANSACTION',
  'the original in-flight builder notices its token was replaced before opening the wallet')
assert.equal(walletPromptCount, 0, 'cancelled in-flight build cannot invoke the old wallet prompt')

assert.equal(await otherTabStore.sendKaminoAction('deposit', { market, token, amount: '1' }), signature,
  'user can retry after releasing the stale pre-wallet reservation')
assert.equal(buildCount, 2)
assert.equal(walletPromptCount, 1)
assert.equal(values.has('nysaPendingTx'), false, 'confirmed retry clears its reservation')

const legacyReservationId = `${(Date.now() - 60_001).toString(36)}-1`
values.set('nysaPendingTx', JSON.stringify({
  reservationId: legacyReservationId, reservationOwner: 'old-session', wallet: walletAddress,
  kind: 'deposit', status: 'preparing', phase: 'building', signature: null,
}))
const noSessionRecovery = await import('./store.js?legacy-no-session-recovery')
assert.equal(noSessionRecovery.state.lendingBuildCancelable, true,
  'legacy reservation without a lease or sessionStorage becomes cancellable after its ID age expires')
assert.equal(await noSessionRecovery.cancelLendingBuildReservation(), true)
assert.equal(values.has('nysaPendingTx'), false)

console.log('expired build lease can be cancelled safely and retried')
