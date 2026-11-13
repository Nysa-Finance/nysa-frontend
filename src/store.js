// Global app state. The browser never calls the Solana RPC:
// - market data is pushed by the backend over Server-Sent Events (/api/events), on load and whenever it changes
//   (polled from /api/market while the stream is unavailable);
// - the connected wallet's balances, positions and rewards come from /api/account;
// - transactions are built and simulated by /api/tx; the wallet only signs and sends them.
import { reactive, markRaw } from 'vue'
import { getWallets } from '@wallet-standard/app'
import { getBase58Decoder } from '@solana/kit'
import { confirmedSwapAmountFromTransaction, pendingSwapChainOutcome, persistSignedSwapBeforeRelay } from './swap-recovery.js'
import { assertCanStartLendingAction, canResumeSetupRecovery, cancelConfirmedSetupRecovery, classifyPendingTransaction, markSetupTransactionConfirmed, pendingTransactionMatches, recoverConfirmedSetupTransaction, resumeConfirmedSetupContinuation, startVisibleReconciliationLoop } from './pending-reconciliation.js'
import { tok, tokensOf, vaultById, WALLETCONNECT_PROJECT_ID } from './config.js'
import { parsePoints, pct, liquidationBonusRange } from './logic.js'
import { loopPositionFullyClosed } from './loop-positions.js'
import { event, skipNextPageview } from './analytics.js'
import {
  fromBase64, isIOS, DEEPLINK_WALLETS, MWA_NAME, registerMobileWalletAdapter, deeplinkSession, connectUrl, signUrl, readDeeplinkReturn, clearDeeplinkSession,
} from './wallets.js'
import { createWalletConnectWallet } from './walletconnect.js'

const TOS_KEY = 'nysaTosAccepted.v1'
const WALLET_KEY = 'connectedWallet'
const PENDING_KEY = 'nysaPendingTx'
const SETUP_RECOVERY_KEY = 'nysaSetupRecovery'
const CHAIN = 'solana:mainnet'
const ACCOUNT_REFRESH_MS = 60_000 // while the tab is visible; right after a transaction it refreshes immediately
const CONFIRM_TIMEOUT_MS = 90_000
const ACTION_BUILD_LEASE_MS = 60_000
const ACTION_BUILD_HEARTBEAT_MS = 10_000
const ACTION_RESERVATION_LOCK = 'nysa-lending-action-reservation'
const ACTION_TERMINAL_PREFIX = 'nysaActionTerminal.'
const SWAP_TERMINAL_PREFIX = 'nysaSwapTerminal.'

const safe = (fn, fallback = null) => {
  try { return fn() } catch { return fallback }
}

let activeLendingActionReservation = null
let lendingActionReservationSequence = 0
let actionBuildLeaseTimer = null
let actionBuildLeaseOwner = null
let actionBuildLeaseRenewing = false

function hasActionReservationLock() {
  return typeof safe(() => globalThis.navigator?.locks?.request) === 'function'
}

const requiresFeatureActionLock = (action) => !!(action?.loopAction || (action?.swapFlow && action?.swapFlowStage))
const requiresPendingActionLock = (pending) => requiresFeatureActionLock(pending?.params)

function withActionReservationLock(callback, required = true) {
  const locks = globalThis.navigator?.locks
  if (typeof locks?.request !== 'function') {
    if (!required) return callback()
    throw actionReservationLockUnavailable()
  }
  return locks.request(ACTION_RESERVATION_LOCK, { mode: 'exclusive' }, callback)
}

function actionReservationLockUnavailable() {
  const error = new Error('Safe cross-tab transaction locking is unavailable. Use a secure browser with Web Locks enabled.')
  error.code = 'ACTION_RESERVATION_LOCK_UNAVAILABLE'
  return error
}

function withPendingActionLock(callback, pendingHint = null) {
  const pending = pendingHint ?? persistedLendingPending()
  return withActionReservationLock(callback, requiresPendingActionLock(pending))
}

function canCancelBuildReservation(pending) {
  const idTimestamp = Number.parseInt(String(pending?.reservationId ?? '').split('-')[0], 36)
  const createdAt = Number.isSafeInteger(pending?.createdAt) ? pending.createdAt : idTimestamp
  const expiresAt = Number.isSafeInteger(pending?.leaseExpiresAt)
    ? pending.leaseExpiresAt
    : createdAt + ACTION_BUILD_LEASE_MS
  return (!requiresPendingActionLock(pending) || hasActionReservationLock()) && !activeLendingActionReservation
    && pending?.status === 'preparing' && pending.phase === 'building'
    && !pending.signature
    && Number.isSafeInteger(expiresAt) && Date.now() >= expiresAt
}

export const state = reactive({
  tosAccepted: safe(() => localStorage.getItem(TOS_KEY) === '1', false),
  loaded: false,
  loading: true,
  error: null, // market data
  walletError: null, // balances/positions
  reserves: {}, // token_id -> reserve metrics, risk parameters and rate curve (live from chain)
  rewards: {}, // token_id -> { apr, rewards: [{ symbol, apr, perDay, runwayDays }] } supply rewards
  address: null,
  balances: {}, // token_id -> units in wallet
  balancesBaseUnits: {}, // token_id -> exact confirmed SPL balance
  sol: null, // wallet SOL balance used to explain network fee requirements before building
  positions: {}, // token_id -> { supplied, borrowed, maxWithdraw } units
  positionsBaseUnits: {}, // token_id -> exact protocol-computed max withdraw amount
  loopPositions: [], // separately identified Multiply positions; never merged into vanilla token-keyed fields
  loopPositionReadStatus: {}, // owner-scoped Multiply read coverage; absence is authoritative only when every configured read succeeded
  claimable: {}, // market id -> [{ symbol, amount }] unclaimed rewards of the connected wallet
  vaults: {}, // vault id -> Earn vault metrics, allocations and exposure (live from chain, server/vault.js)
  vaultPositions: {}, // vault id -> { shares, value } of the connected wallet
  walletName: null,
  wallets: [], // detected Wallet Standard wallets
  connectOpen: false,
  connectError: null, // shown when the connect window reopens (WalletConnect failed while Reown's modal was up)
  points: { board: null, error: null }, // Farm Points leaderboard
  // Phone wallets reached by deeplink (iOS): a transaction waiting for the user to approve it in the wallet app, or its
  // outcome after they come back. { status: 'ready'|'sending'|'success'|'error', label, wallet, url?, signature?, error? }
  handoff: null,
  lendingPending: safe(() => JSON.parse(localStorage.getItem(PENDING_KEY))),
  lendingActionBusy: false,
  lendingBuildCancelable: safe(() => canCancelBuildReservation(JSON.parse(localStorage.getItem(PENDING_KEY))), false),
  lendingSetupRecovery: safe(() => JSON.parse(localStorage.getItem(SETUP_RECOVERY_KEY))),
  setupRecoveryBusy: false,
  swapPending: safe(() => JSON.parse(localStorage.getItem('nysaPendingSwap'))),
  swapOutcome: safe(() => JSON.parse(localStorage.getItem('nysaSwapFlowOutcome'))),
  blockedWallet: null, // address refused by the backend's sanctions screening (shown in a notice, then disconnected)
  swapVisible: false, // show the swap entry points: the server executes swaps for this wallet (SWAP_WALLETS beta, README)
})

// Wallet objects stay outside Vue reactivity (they hold private fields).
let wallet = null
let account = null
const usable = (w) => w.chains.includes(CHAIN) && 'standard:connect' in w.features && 'solana:signAndSendTransaction' in w.features
// WalletConnect: wallet apps on another device (QR code) or on the phone; signed there, sent by our backend.
const sendSigned = async (tx) => (await api('/api/tx/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx, wallet: account.address }) })).signature
const walletConnect = WALLETCONNECT_PROJECT_ID ? markRaw(createWalletConnectWallet(sendSigned)) : null
function scanWallets() {
  const ws = getWallets().get().filter(usable)
  state.wallets = [...ws.filter((w) => w.name === 'Phantom'), ...ws.filter((w) => w.name !== 'Phantom'), ...(walletConnect ? [walletConnect] : [])].map(markRaw)
}

// iOS Safari has no wallet extensions: offer Phantom / Solflare through their deeplink protocol instead.
export const deeplinkWallets = () => (isIOS && !state.wallets.some((w) => !w.walletconnect) ? DEEPLINK_WALLETS : [])
const deeplinkWallet = (name) => ({ name, deeplink: true })

export function acceptTos() {
  safe(() => localStorage.setItem(TOS_KEY, '1'))
  state.tosAccepted = true
}

export const priceOf = (id) => state.reserves[id]?.price ?? tok(id).price
// Supply reward APR (Kamino farm incentives) on top of the supply APY; 0 when the reserve has no active rewards.
export const rewardAprOf = (id) => state.rewards[id]?.apr ?? 0
// Tooltip for a boosted APY, e.g. "3.10% supply APY + 12.00% USDC rewards APR".
export const boostNote = (id, supplyApy) =>
  `${pct(supplyApy)} supply APY + ${pct(rewardAprOf(id))} ${state.rewards[id]?.rewards.map((x) => x.symbol).join(' + ')} rewards APR`

// Tooltip for a vault's boosted APY: "1.47% supply APY + 11,212.83% USDC rewards APY, auto-compounded".
export const vaultApyNote = (v) => `${pct(v.supplyApy)} supply APY + ${pct(v.rewardsApy)} ${v.rewards?.symbol ?? ''} rewards APY, auto-compounded`

// Risk parameters of a collateral/liability pair. Governance changes them (Market Updates), so the live on-chain
// values win; config.js only fills in until the first market update arrives.
export function riskOf(pair) {
  const c = state.reserves[pair.collateral], l = state.reserves[pair.liability]
  return {
    ...pair,
    ...(c && { maxLtv: c.maxLtv, liqLtv: c.liqLtv, supplyCap: c.supplyCap }),
    // Kamino takes the larger min and max bonus of the two reserves.
    ...(c && l && { maxDiscount: Math.max(c.maxDiscount, l.maxDiscount), minDiscount: Math.max(c.minDiscount ?? 0, l.minDiscount ?? 0) }),
    ...(l && { borrowCap: l.borrowCap }),
  }
}

// The liquidation bonus a liquidator really gets on a pair, as text ("2%–2.5%"): the configured max is often unreachable.
export function bonusText(pair) {
  const r = riskOf(pair)
  const { low, high } = liquidationBonusRange(r.minDiscount, r.maxDiscount, r.liqLtv)
  const p = (v) => `${+v.toFixed(2)}%`
  return low === high ? p(high) : `${p(low)}–${p(high)}`
}
// Interest rate model of a borrowable token (live curve and fee); null for collateral-only tokens.
export const irmOf = (t) => (t.irm ? state.reserves[t.token_id]?.irm ?? t.irm : null)

// Everything a view needs for one token, merged.
export function rowOf(id) {
  const r = state.reserves[id]
  if (!r) return null
  return { reserve: r, walletBalance: state.balances[id] ?? 0, ...(state.positions[id] ?? { supplied: 0, borrowed: 0, maxWithdraw: 0 }) }
}

// ---- market: pushed by the backend; polled from /api/market while the stream is down or refused ----
const MARKET_POLL_MS = 30_000
const STREAM_RETRY_MS = 60_000 // after the server refused the stream (too many connections), try it again this often
let marketAt = 0 // updatedAt of the snapshot shown (a slow poll mustn't overwrite a newer push)
function showMarket(s) {
  if (s.updatedAt < marketAt) return
  marketAt = s.updatedAt
  state.reserves = s.reserves
  state.vaults = s.vaults ?? {}
  state.rewards = s.rewards
  state.loaded = true
  state.loading = false
  state.error = null
}

let poll = null
async function pollMarket() {
  try {
    const res = await fetch('/api/market')
    if (!res.ok) throw new Error(`Server responded ${res.status}`)
    showMarket(await res.json())
  } catch {
    if (!state.loaded) { state.loading = false; state.error = 'the server is not reachable' }
  }
}
function startPolling() {
  if (poll) return
  pollMarket()
  poll = setInterval(pollMarket, MARKET_POLL_MS)
}
function stopPolling() {
  clearInterval(poll)
  poll = null
}

function listenMarket() {
  const es = new EventSource('/api/events')
  es.addEventListener('market', (e) => {
    stopPolling()
    showMarket(JSON.parse(e.data))
  })
  es.onerror = () => {
    startPolling() // EventSource reconnects a dropped stream by itself; meanwhile poll
    if (es.readyState === EventSource.CLOSED) setTimeout(listenMarket, STREAM_RETRY_MS) // refused: it won't retry
  }
}

// ---- connected wallet ----
// 502/503/504: the backend is not answering, e.g. restarting during a deploy (a few seconds). Asked once more, except
// for sending a signed transaction, which is never sent twice.
const UNREACHABLE = [502, 503, 504]
async function api(path, init) {
  let res = await fetch(path, init)
  if (UNREACHABLE.includes(res.status) && path !== '/api/tx/send') {
    await new Promise((r) => setTimeout(r, 2500))
    res = await fetch(path, init)
  }
  const body = await res.json().catch(() => ({}))
  if (res.status === 403 && body.blocked) refuseWallet()
  if (!res.ok) {
    const error = new Error(body.error ?? (UNREACHABLE.includes(res.status) ? 'Nysa\'s server is not reachable right now, please try again in a few seconds.' : `Server responded ${res.status}`))
    error.status = res.status
    throw error
  }
  return body
}

// The backend's sanctions screening refused this wallet: disconnect it and say why.
function refuseWallet() {
  state.blockedWallet = state.address
  disconnect()
}

// fresh: skip the server's short per-wallet cache (after a transaction).
export async function loadAccount(fresh = false) {
  const addr = state.address
  if (!addr) return
  try {
    const a = await api(`/api/account/${addr}${fresh ? '?fresh' : ''}`)
    if (state.address !== addr) return // switched wallet meanwhile
    state.balances = a.balances
    state.balancesBaseUnits = a.balancesBaseUnits ?? {}
    state.sol = a.sol ?? null
    state.positions = a.positions
    state.positionsBaseUnits = a.positionsBaseUnits ?? {}
    state.loopPositions = a.loopPositions ?? []
    state.loopPositionReadStatus = a.loopPositionReadStatus ?? {}
    state.claimable = a.claimable
    state.vaultPositions = a.vaults ?? {}
    state.walletError = null
    return a
  } catch (e) {
    console.error('[account]', e)
    state.walletError = e.message
  }
}

function setAccount(w, acc) {
  wallet = w
  account = acc
  state.address = acc?.address ?? null
  state.walletName = acc ? w.name : null
  state.balances = {}
  state.balancesBaseUnits = {}
  state.sol = null
  state.positions = {}
  state.positionsBaseUnits = {}
  state.loopPositions = []
  state.loopPositionReadStatus = {}
  state.claimable = {}
  state.vaultPositions = {}
  state.walletError = null
  if (acc) loadAccount()
  loadSwapVisibility()
}

async function loadSwapVisibility() {
  const addr = state.address
  const r = await api(`/api/swap-readiness${addr ? `?wallet=${addr}` : ''}`).catch(() => null)
  if (state.address === addr) state.swapVisible = r?.visible === true
}

async function connectWith(w, silent) {
  const { accounts } = await w.features['standard:connect'].connect(silent ? { silent: true } : undefined)
  const acc = accounts.find((a) => a.chains.includes(CHAIN)) ?? accounts[0]
  if (!acc) throw new Error(`${w.name} returned no Solana account`)
  setAccount(w, acc)
  w.features['standard:events']?.on('change', ({ accounts: next }) => {
    if (next && wallet === w) setAccount(w, next[0] ?? null)
  })
  safe(() => localStorage.setItem(WALLET_KEY, w.name))
}

export async function connectWallet(w) {
  await connectWith(w, false)
  // via: how the wallet was reached — browser extension, Android app (Mobile Wallet Adapter) or iOS app (deeplink)
  event('Wallet connected', w.name === MWA_NAME ? { wallet: 'Wallet app', via: 'android-app' } : w.walletconnect ? { wallet: 'WalletConnect', via: 'walletconnect' } : { wallet: w.name, via: 'extension' })
  state.connectOpen = false
}

// Leaves for the wallet app; it sends the user back here connected (see start()). Call it straight from a tap.
export const connectDeeplink = (name) => location.assign(connectUrl(name))

export async function disconnect() {
  if (wallet?.deeplink) clearDeeplinkSession()
  try { await wallet?.features?.['standard:disconnect']?.disconnect() } catch { /* wallet already gone */ }
  setAccount(null, null)
  safe(() => localStorage.removeItem(WALLET_KEY))
}

// Silent reconnect to the wallet used last time.
async function eagerConnect() {
  if (state.address) return
  const dl = deeplinkSession()
  if (dl) return setAccount(deeplinkWallet(dl.wallet), { address: dl.address })
  const name = safe(() => localStorage.getItem(WALLET_KEY))
  const w = name && state.wallets.find((x) => x.name === name)
  if (!w) return
  try { await connectWith(w, true) } catch { /* no longer authorised */ }
}

// ---- transactions: built by the backend, signed and sent by the wallet ----

async function confirmed(signature) {
  const until = Date.now() + CONFIRM_TIMEOUT_MS
  while (Date.now() < until) {
    const s = await api(`/api/tx/${signature}`)
    if (s.status === 'confirmed') return s.slot
    if (s.status === 'failed') throw new Error(`Transaction failed on-chain: ${s.error}`)
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`Transaction ${signature} was not confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s`)
}

const buildTx = (params) => api('/api/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...params, wallet: params.wallet ?? account.address }) })

const ACTION_LABELS = { deposit: 'Supply', withdraw: 'Withdraw', borrow: 'Borrow', repay: 'Repay', claim: 'Claim rewards', liquidate: 'Liquidate', 'vault-deposit': 'Deposit', 'vault-withdraw': 'Withdraw', 'loop-open': 'Open loop', 'loop-close': 'Full close', 'loop-setup': 'Initialize Kamino metadata' }
const labelOf = (p) => `${ACTION_LABELS[p.kind]}${p.vault ? ` ${vaultById(p.vault)?.name ?? ''}` : p.token ? ` ${tok(p.token).name}` : ''}`
function trackSuccess(p) {
  if (p.kind === 'claim') event('Rewards claimed', { market: p.market })
  else if (p.kind.startsWith('vault-')) event(p.kind === 'vault-deposit' ? 'Vault deposit' : 'Vault withdraw', { vault: p.vault })
  else if (p.kind === 'liquidate') event('Liquidation', { market: p.market })
  else if (p.token) event(p.kind[0].toUpperCase() + p.kind.slice(1), { token: tok(p.token).name })
}

// ---- deeplink wallets (iOS): every signature is a round trip to the wallet app, and the page reloads on return ----
const SWAP_PENDING_KEY = 'nysaPendingSwap'
let cancelPending = null
let reconcilingSwap = false
let reconcilingFlowAmount = false
let reconcilingLending = false
let stopActiveReconciliation = null
const base64 = (bytes) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function persistedSwapPending() {
  return safe(() => JSON.parse(localStorage.getItem(SWAP_PENDING_KEY)))
}

function swapTerminalFor(pending) {
  if (typeof pending?.reservationId !== 'string' || !pending.signature) return null
  const terminal = safe(() => JSON.parse(localStorage.getItem(`${SWAP_TERMINAL_PREFIX}${pending.reservationId}`)))
  if (terminal?.reservationId !== pending.reservationId || terminal.signature !== pending.signature
    || terminal.wallet !== pending.wallet) return null
  return terminal
}

function rememberSwapTerminal(pending, outcome) {
  if (typeof pending?.reservationId !== 'string' || !pending.signature || !pending.wallet
    || typeof pending.signedTransactionBase64 !== 'string') return
  localStorage.setItem(`${SWAP_TERMINAL_PREFIX}${pending.reservationId}`, JSON.stringify({
    reservationId: pending.reservationId, signature: pending.signature, wallet: pending.wallet,
    status: outcome.status, error: outcome.error ?? null, amountBaseUnits: outcome.amountBaseUnits ?? null,
    completedAt: Date.now(),
  }))
}

function writeSwapPending(pending, allowInitial = false) {
  const current = persistedSwapPending()
  if (current && (current.reservationId !== pending?.reservationId || current.wallet !== pending?.wallet)) {
    throw pendingActionError('A different swap reservation is pending. Reconcile it before continuing.')
  }
  if (!current) {
    const relayStatusCanUseTerminal = pending?.status === 'submitted' || pending?.status === 'rejected'
      || (pending?.status === 'relay-unknown' && pending.relayErrorCode === 'RELAY_TRANSPORT_UNKNOWN')
    const terminal = relayStatusCanUseTerminal ? swapTerminalFor(pending) : null
    if (terminal) return { ...pending, terminalOutcome: terminal }
    if (!allowInitial || !['wallet-prompt', 'awaiting-signature'].includes(pending?.status)) {
      throw pendingActionError('The swap reservation was cleared before its relay outcome was stored.')
    }
  }
  if (current?.signature && pending?.signature && current.signature !== pending.signature) {
    throw pendingActionError('The swap signature changed after signing.')
  }
  localStorage.setItem(SWAP_PENDING_KEY, JSON.stringify(pending))
  state.swapPending = pending
  return pending
}

function persistSwapPending(pending) {
  return withActionReservationLock(() => writeSwapPending(pending), true)
}

function clearSwapPending(reservationId, signature = null, terminalOutcome = null) {
  return withActionReservationLock(() => {
    const current = persistedSwapPending()
    if (!current || (reservationId && current.reservationId !== reservationId)
      || (signature && current.signature !== signature)) return false
    if (terminalOutcome) rememberSwapTerminal(current, terminalOutcome)
    safe(() => localStorage.removeItem(SWAP_PENDING_KEY))
    state.swapPending = null
    return true
  }, true)
}

function settleSwapPending(pending, terminalOutcome) {
  return withActionReservationLock(() => {
    const current = persistedSwapPending()
    if (!current) {
      const terminal = swapTerminalFor(pending)
      if (terminal) return terminal
      throw pendingActionError('The swap reservation was cleared without a matching terminal signature.')
    }
    if (current.reservationId !== pending.reservationId || current.wallet !== pending.wallet
      || current.signature !== pending.signature) {
      throw pendingActionError('A different swap reservation or signature is now pending.')
    }
    rememberSwapTerminal(current, terminalOutcome)
    safe(() => localStorage.removeItem(SWAP_PENDING_KEY))
    state.swapPending = null
    return {
      reservationId: current.reservationId, wallet: current.wallet, ...terminalOutcome,
    }
  }, true)
}

function assertNoPendingSwapAction() {
  if (persistedSwapPending()) {
    throw pendingActionError('A swap may still be pending. Reconcile it before starting another action.')
  }
}

function persistedLendingPending() {
  return safe(() => JSON.parse(localStorage.getItem(PENDING_KEY)))
}

function persistLendingPending(pending) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  state.lendingPending = pending
  state.lendingBuildCancelable = canCancelBuildReservation(pending)
}

function stopActionBuildLease(id) {
  if (id && actionBuildLeaseOwner !== id) return
  if (actionBuildLeaseTimer) clearInterval(actionBuildLeaseTimer)
  actionBuildLeaseTimer = null
  actionBuildLeaseOwner = null
}

function startActionBuildLease(id) {
  stopActionBuildLease()
  actionBuildLeaseOwner = id
  actionBuildLeaseTimer = setInterval(async () => {
    if (actionBuildLeaseRenewing) return
    actionBuildLeaseRenewing = true
    try {
      const renewed = await withPendingActionLock(() => {
        const pending = persistedLendingPending()
        if (pending?.reservationId !== id || pending.status !== 'preparing' || pending.phase !== 'building'
          || !Number.isSafeInteger(pending.leaseExpiresAt) || pending.leaseExpiresAt <= Date.now()) return false
        persistLendingPending({ ...pending, leaseExpiresAt: Math.max(Date.now() + ACTION_BUILD_LEASE_MS, pending.leaseExpiresAt + 1) })
        return true
      })
      if (!renewed) {
        stopActionBuildLease(id)
        state.lendingBuildCancelable = canCancelBuildReservation(persistedLendingPending())
      }
    } catch {
      stopActionBuildLease(id)
      state.lendingBuildCancelable = canCancelBuildReservation(persistedLendingPending())
    } finally {
      actionBuildLeaseRenewing = false
    }
  }, ACTION_BUILD_HEARTBEAT_MS)
}

function persistedSetupRecovery() {
  return safe(() => JSON.parse(localStorage.getItem(SETUP_RECOVERY_KEY)))
}

function persistSetupRecovery(recovery) {
  localStorage.setItem(SETUP_RECOVERY_KEY, JSON.stringify(recovery))
  state.lendingSetupRecovery = recovery
}

function clearSetupRecovery(signature) {
  const recovery = persistedSetupRecovery()
  if (!recovery || (signature && recovery.signature !== signature)) return false
  safe(() => localStorage.removeItem(SETUP_RECOVERY_KEY))
  state.lendingSetupRecovery = null
  return true
}

function clearLendingPending(signature = null, id = null, expected = null) {
  return withPendingActionLock(() => clearPendingUnderLock(id, signature, expected))
}

function pendingActionError(message = 'Another action may still be pending. Reconcile it before starting another action.') {
  const error = new Error(message)
  error.code = 'PENDING_TRANSACTION'
  return error
}

function actionTerminalFor(pending) {
  if (typeof pending?.reservationId !== 'string' || !pending.signature) return null
  const terminal = safe(() => JSON.parse(localStorage.getItem(`${ACTION_TERMINAL_PREFIX}${pending.reservationId}`)))
  if (terminal?.reservationId !== pending.reservationId || terminal.signature !== pending.signature
    || terminal.wallet !== pending.wallet) return null
  return terminal
}

function rememberActionTerminal(pending, status, error = null) {
  if (typeof pending?.reservationId !== 'string' || !pending.signature || !pending.wallet
    || typeof pending.signedTransactionBase64 !== 'string') return
  localStorage.setItem(`${ACTION_TERMINAL_PREFIX}${pending.reservationId}`, JSON.stringify({
    reservationId: pending.reservationId, signature: pending.signature, wallet: pending.wallet,
    status, error: error ?? null, completedAt: Date.now(),
  }))
}

function applyActionTerminalToHandoff(pending, terminal) {
  const label = labelOf(pending.params)
  if (terminal.status === 'confirmed') state.handoff = { status: 'success', label, signature: terminal.signature }
  else if (terminal.status === 'failed') state.handoff = { status: 'error', label, error: `Transaction failed on-chain: ${terminal.error ?? 'Unknown chain error.'}` }
  else if (terminal.status === 'setup-confirmed') {
    state.handoff = { status: 'error', label, error: 'Account setup confirmed. Choose Resume to sign the requested action, or Cancel to stop.' }
  }
}

function settleLendingPending(pending, status, error = null) {
  return withPendingActionLock(() => {
    const current = persistedLendingPending()
    if (!pendingTransactionMatches(pending, current, pending.wallet)) return false
    rememberActionTerminal(pending, status, error)
    return clearPendingUnderLock(pending.reservationId, pending.signature, pending)
  }, pending)
}

function reservationId() {
  lendingActionReservationSequence++
  const nonce = safe(() => crypto.randomUUID(), `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`)
  return `${Date.now().toString(36)}-${lendingActionReservationSequence.toString(36)}-${nonce}`
}

function writeActionReservationUnderLock(id, values = {}) {
  const pending = persistedLendingPending()
  if (pending?.reservationId !== id) throw pendingActionError('The action reservation changed. Reconcile the current transaction before continuing.')
  if (values.status === 'wallet-prompt'
    && (pending.status !== 'preparing' || pending.phase !== 'building')) {
    throw pendingActionError('The build reservation is no longer eligible for wallet signing.')
  }
  if (values.status === 'preparing'
    && !(pending.status === 'preparing' && pending.phase === 'building'
      || pending.status === 'submitted' && pending.final === false)) {
    throw pendingActionError('The action reservation cannot return to build state.')
  }
  if (values.status === 'submitted' && pending.status !== 'wallet-prompt') {
    throw pendingActionError('The wallet prompt reservation changed before its signature was stored.')
  }
  if (values.status === 'relay-unknown' && pending.status !== 'wallet-prompt') {
    throw pendingActionError('The wallet prompt reservation changed before its unknown outcome was stored.')
  }
  const next = { ...pending, ...values }
  if (next.status === 'preparing' && next.phase === 'building') {
    next.leaseExpiresAt = Math.max(Date.now() + ACTION_BUILD_LEASE_MS, (pending.leaseExpiresAt ?? 0) + 1)
  } else {
    next.leaseExpiresAt = null
  }
  persistLendingPending(next)
  if (next.status === 'preparing' && next.phase === 'building') startActionBuildLease(id)
  else stopActionBuildLease(id)
  return next
}

function updateActionReservation(id, values = {}) {
  return withPendingActionLock(() => writeActionReservationUnderLock(id, values))
}

function persistActionPending(id, pending) {
  return withPendingActionLock(() => {
    const current = persistedLendingPending()
    if (current?.reservationId !== id || pending?.reservationId !== id) {
      const relayStatusCanUseTerminal = pending?.status === 'submitted' || pending?.status === 'rejected'
        || (pending?.status === 'relay-unknown' && pending.relayErrorCode === 'RELAY_TRANSPORT_UNKNOWN')
      const terminal = relayStatusCanUseTerminal ? actionTerminalFor(pending) : null
      if (current?.reservationId !== id && pending?.reservationId === id && terminal) {
        applyActionTerminalToHandoff(pending, terminal)
        return { ...pending, terminalOutcome: terminal }
      }
      throw pendingActionError('The transaction reservation changed before its signed state was saved.')
    }
    const allowedFrom = {
      'signed-pending': ['wallet-prompt', 'awaiting-signature'],
      submitted: ['signed-pending'],
      'relay-unknown': ['signed-pending'],
      rejected: ['signed-pending'],
    }
    if (!allowedFrom[pending.status]?.includes(current.status)) {
      throw pendingActionError('The transaction reservation changed before its signature state was saved.')
    }
    persistLendingPending(pending)
    stopActionBuildLease(id)
    return pending
  })
}

function refreshLendingBuildCancelable() {
  state.lendingBuildCancelable = canCancelBuildReservation(persistedLendingPending())
}

async function promoteActionReservationToWalletPrompt(id, values = {}) {
  return withPendingActionLock(() => {
    const pending = persistedLendingPending()
    if (pending?.reservationId !== id || pending.status !== 'preparing' || pending.phase !== 'building') {
      throw pendingActionError('The build reservation was cancelled or replaced before wallet signing.')
    }
    if (!Number.isSafeInteger(pending.leaseExpiresAt) || pending.leaseExpiresAt <= Date.now()) {
      throw pendingActionError('The build reservation lease expired before wallet signing.')
    }
    const status = values.status === 'awaiting-signature' ? 'awaiting-signature' : 'wallet-prompt'
    return writeActionReservationUnderLock(id, { ...values, status, leaseExpiresAt: null })
  })
}

function clearPendingUnderLock(id = null, signature = null, expected = null) {
  const pending = persistedLendingPending()
  if (!pending || (id && pending.reservationId !== id) || (signature && pending.signature !== signature)
    || (!id && !signature && !expected)) return false
  if (expected && (pending.status !== expected.status || pending.wallet !== expected.wallet
    || pending.final !== expected.final || JSON.stringify(pending.params) !== JSON.stringify(expected.params)
    || pending.reservationId !== expected.reservationId)) return false
  safe(() => localStorage.removeItem(PENDING_KEY))
  state.lendingPending = null
  state.lendingBuildCancelable = false
  stopActionBuildLease(id ?? pending.reservationId)
  return true
}

function clearActionReservation(id) {
  return withPendingActionLock(() => clearPendingUnderLock(id))
}

export async function cancelLendingBuildReservation() {
  return withPendingActionLock(() => {
    const pending = persistedLendingPending()
    if (!canCancelBuildReservation(pending) || typeof pending.reservationId !== 'string') return false
    if (!clearPendingUnderLock(pending.reservationId)) return false
    state.handoff = {
      status: 'error',
      label: labelOf(pending.params ?? { kind: pending.kind }),
      error: 'The transaction build was interrupted before wallet signing. No transaction was sent. You can retry the action.',
    }
    return true
  })
}

// 4100: the wallet refused before signing because the site's permission lapsed (Phantom after a lock or account switch).
const walletUnauthorized = (error) => error?.code === 4100 || /not been authorized/i.test(error?.message ?? '')

/** Run a wallet request; on 4100 ask the wallet to authorize Nysa again, then retry once. */
async function reauthorized(request) {
  try { return await request() } catch (error) {
    if (!walletUnauthorized(error) || wallet?.deeplink) throw error
    await connectWith(wallet, false)
    return request()
  }
}

function definiteWalletRejection(error) {
  return error?.code === 4001 || error?.code === 'ACTION_REJECTED' || walletUnauthorized(error)
    || /user rejected|user denied|rejected by (?:the )?user|transaction rejected|cancelled|canceled/i.test(error?.message ?? '')
}

function preserveUnknownWalletSend(id, error) {
  const pending = persistedLendingPending()
  if (pending?.reservationId !== id) return
  return updateActionReservation(id, {
    status: 'relay-unknown',
    phase: 'send-outcome-unknown',
    signature: null,
    sendError: String(error?.message ?? 'Wallet send outcome is unknown.').slice(0, 240),
  })
}

function saveSwapOutcome(outcome) {
  const { tx, signedTransactionBase64, intentId, ...safeOutcome } = outcome
  state.swapOutcome = safeOutcome
  safe(() => localStorage.setItem('nysaSwapFlowOutcome', JSON.stringify(safeOutcome)))
}

// Age of a swap reservation: its id starts with the creation time in base 36.
const swapAge = (pending) => Date.now() - Number.parseInt(String(pending?.reservationId).split('-')[0], 36)

async function settleSwapChainOutcome(signature, pending) {
  const chain = await api(`/api/tx/${signature}`)
  let classified = pendingSwapChainOutcome({ ...pending, signature }, {
    ...chain, wallet: pending.wallet, outputMint: pending.outputMint,
  })
  // The swap's blockhash expires about 90 s after the build, so a signature the chain still doesn't know can never land.
  if (classified.status === 'pending' && swapAge(pending) > 3 * 60_000) {
    classified = { status: 'failed', signature, error: 'The transaction expired before landing. No funds moved.' }
  }
  if (classified.status === 'pending') return classified
  const terminal = await settleSwapPending(pending, classified)
  const outcome = { ...pending, ...terminal }
  state.swapPending = null
  saveSwapOutcome(outcome)
  if (classified.status === 'confirmed') await loadAccount(true)
  return outcome
}

function applySwapTerminalToHandoff(pending, terminal) {
  const outcome = { ...pending, ...terminal }
  state.swapPending = null
  saveSwapOutcome(outcome)
  state.handoff = terminal.status === 'confirmed'
    ? { status: 'success', label: 'Swap', signature: terminal.signature }
    : { status: 'error', label: 'Swap', error: `Swap failed on-chain: ${terminal.error ?? 'Unknown chain error.'}` }
  return outcome
}

async function confirmedSwapOutcome(signature, pending) {
  try { await confirmed(signature) }
  catch (error) {
    if (!/failed on-chain/i.test(error.message)) throw error
  }
  const outcome = await settleSwapChainOutcome(signature, pending)
  if (outcome.status === 'pending') throw new Error('Swap signature is still pending. Do not rebuild until its outcome is reconciled.')
  if (outcome.status === 'failed') throw new Error(`Swap failed on-chain: ${outcome.error}`)
  return outcome
}

/** Sign only a server-built route, then relay it against its one-time exact-message intent. */
export async function signAndSendSwap({ built, request, outputTokenId, flow, flowAmountBaseUnits } = {}) {
  if (!hasActionReservationLock()) throw actionReservationLockUnavailable()
  if (!wallet || !account || !state.address) throw new Error('Connect a Solana wallet to continue.')
  const signerAddress = account.address
  if (!built?.tx || !built.intentId || built.expiresAt <= Date.now()) throw new Error('The swap build expired. Build it again before signing.')
  if (state.address !== request.wallet || signerAddress !== request.wallet) throw new Error('The connected wallet changed after the quote. Build the swap again.')
  const id = reservationId()
  const pending = {
    reservationId: id,
    wallet: state.address,
    outputTokenId,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amountBaseUnits: request.amountBaseUnits,
    flow,
    primaryAmountBaseUnits: flowAmountBaseUnits ?? null,
    stage: flow === 'withdraw-sell' ? 'sell' : 'swap',
  }
  await withActionReservationLock(() => {
    if (persistedLendingPending()) throw pendingActionError('A lending action may still be pending. Reconcile it before starting a swap.')
    if (persistedSwapPending()) throw pendingActionError('A previous swap may still be pending. Reconcile it before starting another swap.')
    writeSwapPending({ ...pending, intentId: built.intentId, tx: built.tx, status: wallet.deeplink ? 'awaiting-signature' : 'wallet-prompt' }, true)
  }, true)
  if (wallet.deeplink) {
    state.handoff = { status: 'ready', label: 'Swap', wallet: wallet.name, url: signUrl(built.tx) }
    return { status: 'pending' }
  }
  const sign = wallet.features['solana:signTransaction']?.signTransaction
  if (typeof sign !== 'function') {
    await clearSwapPending(id)
    throw new Error('This wallet has no validated sign-only route for the Nysa swap relay.')
  }
  let signed
  try {
    signed = await reauthorized(() => sign({ account, chain: CHAIN, transaction: fromBase64(built.tx), options: { preflightCommitment: 'confirmed', minContextSlot: built.minContextSlot ?? undefined } }))
  } catch (error) {
    await clearSwapPending(id) // signTransaction cannot broadcast the transaction
    throw error
  }
  const signedTransaction = signed?.[0]?.signedTransaction
  if (!(signedTransaction instanceof Uint8Array)) {
    await clearSwapPending(id)
    throw new Error('The wallet did not return a signed swap transaction.')
  }
  if (state.address !== signerAddress || account?.address !== signerAddress) {
    await clearSwapPending(id)
    throw new Error('The connected wallet changed while the swap was being signed.')
  }
  const relayed = await persistSignedSwapBeforeRelay({
    pending: { ...pending, intentId: built.intentId },
    signedTransaction,
    persist: persistSwapPending,
    relay: async ({ signedTransaction: bytes }) => api('/api/swap-send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tx: base64(bytes), wallet: signerAddress, intentId: built.intentId }),
    }),
  })
  if (relayed.terminalOutcome) {
    const outcome = applySwapTerminalToHandoff(pending, relayed.terminalOutcome)
    if (outcome.status === 'failed') throw new Error(`Swap failed on-chain: ${outcome.error}`)
    return outcome
  }
  if (relayed.pending.status === 'rejected') {
    await clearSwapPending(id, relayed.pending.signature)
    saveSwapOutcome({ ...pending, status: 'rejected', signature: relayed.pending.signature })
    throw relayed.error
  }
  if (relayed.error) throw relayed.error
  return confirmedSwapOutcome(relayed.pending.signature, relayed.pending)
}
async function deeplinkStep(params, { resumeFromSetupSignature = null, reservationId: actionReservationId = null } = {}) {
  const built = await buildTx(params)
  const intentExpiresAt = params.loopAction ? built?.expiresAt : built?.intentExpiresAt
  if (!built?.intentId || !Number.isFinite(intentExpiresAt) || intentExpiresAt <= Date.now()) {
    throw new Error('The transaction authorization expired before wallet signing. Build it again.')
  }
  if (state.address !== params.wallet || account?.address !== params.wallet) throw new Error('The connected wallet changed while the transaction was being prepared.')
  if (resumeFromSetupSignature && !canResumeSetupRecovery(persistedSetupRecovery(), persistedLendingPending(), resumeFromSetupSignature, actionReservationId)) {
    throw new Error('Confirmed account setup changed while the action was being prepared.')
  }
  assertCanStartLendingAction(persistedLendingPending(), params, resumeFromSetupSignature, actionReservationId)
  await promoteActionReservationToWalletPrompt(actionReservationId, {
    final: built.final, status: 'awaiting-signature', phase: 'wallet-prompt',
    setupRecoverySignature: resumeFromSetupSignature,
    intentId: built.intentId,
  })
  if (state.address !== params.wallet || account?.address !== params.wallet) {
    await clearActionReservation(actionReservationId)
    throw new Error('The connected wallet changed before the wallet handoff opened.')
  }
  state.handoff = { status: 'ready', label: labelOf(params) + (built.final ? '' : ' · account setup (1 of 2)'), wallet: wallet.name, url: signUrl(built.tx) }
}
export async function cancelHandoff() {
  const lendingPending = persistedLendingPending()
  if (lendingPending?.status === 'awaiting-signature') {
    try {
      const cleared = await clearLendingPending(lendingPending.signature, lendingPending.reservationId, lendingPending)
      if (!cleared) throw pendingActionError('The wallet handoff changed before it could be cancelled.')
    } catch (error) {
      state.handoff = { status: 'error', label: labelOf(lendingPending.params), error: error.message }
      return false
    }
    if (lendingPending.params?.swapFlow) saveLendingFlowOutcome(lendingPending.params, 'rejected').catch(() => {})
  }
  const pendingSwap = safe(() => JSON.parse(localStorage.getItem(SWAP_PENDING_KEY)))
  if (pendingSwap?.status === 'awaiting-signature') {
    try {
      if (!await clearSwapPending(pendingSwap.reservationId)) throw pendingActionError('The swap handoff changed before it could be cancelled.')
    } catch (error) {
      state.handoff = { status: 'error', label: 'Swap', error: error.message }
      return false
    }
    saveSwapOutcome({ ...pendingSwap, status: 'rejected' })
  }
  state.handoff = null
  cancelPending?.(new Error('Transaction cancelled'))
  cancelPending = null
  return true
}
export const dismissHandoff = () => { state.handoff = null }

export async function resumeLendingSetupRecovery() {
  const recovery = persistedSetupRecovery()
  const activePending = persistedLendingPending()
  if (!canResumeSetupRecovery(recovery, activePending, recovery?.signature)) {
    state.handoff = { status: 'error', label: 'Account setup', error: 'Resolve the current transaction before resuming account setup.' }
    return false
  }
  if (!wallet || !account || state.address !== recovery.wallet || account.address !== recovery.wallet) {
    state.handoff = { status: 'error', label: labelOf(recovery.params), error: 'Reconnect the wallet that confirmed account setup to continue.' }
    return false
  }
  if (state.setupRecoveryBusy) return false
  state.setupRecoveryBusy = true
  try {
    const continuation = await resumeConfirmedSetupContinuation({
      pending: recovery,
      chain: { status: 'confirmed' },
      wallet,
      accountAddress: account.address,
      userInitiated: true,
      continueDeeplink: async (params, setupSignature) => {
        await runAction(params, { resumeFromSetupSignature: setupSignature, handoffOnly: true })
      },
      continueDesktop: async (params, setupSignature) => {
        state.handoff = { status: 'sending', label: labelOf(params) }
        return await runAction(params, { resumeFromSetupSignature: setupSignature })
      },
    })
    if (continuation.mode === null) {
      state.handoff = { status: 'error', label: labelOf(recovery.params), error: 'Reconnect a wallet with transaction signing to resume account setup.' }
      return false
    }
    if (continuation.mode === 'deeplink') return true
    if (!continuation.result || state.address !== recovery.wallet || account?.address !== recovery.wallet) return false
    trackSuccess(recovery.params)
    if (recovery.params?.swapFlow) await saveLendingFlowOutcome(recovery.params, 'confirmed', continuation.result)
    state.handoff = { status: 'success', label: labelOf(recovery.params), signature: continuation.result }
    await loadAccount(true)
    return true
  } catch (error) {
    if (recovery.params?.swapFlow && !persistedLendingPending()) {
      const rejected = /reject|cancel/i.test(error?.message)
      await saveLendingFlowOutcome(recovery.params, rejected ? 'rejected' : 'failed').catch(() => {})
    }
    state.handoff = { status: 'error', label: labelOf(recovery.params), error: error?.message ?? 'The wallet did not complete the action. You can resume or cancel account setup.' }
    return false
  } finally {
    state.setupRecoveryBusy = false
  }
}

export function cancelLendingSetupRecovery() {
  const recovery = persistedSetupRecovery()
  const activePending = persistedLendingPending()
  const cancellation = cancelConfirmedSetupRecovery(recovery, activePending)
  if (!cancellation) {
    state.handoff = { status: 'error', label: 'Account setup', error: 'A transaction is still unresolved. Reconcile it before cancelling setup recovery.' }
    return false
  }
  const currentOutcome = state.swapOutcome
  const sameFlowOutcome = currentOutcome?.wallet === cancellation.outcome?.wallet
    && currentOutcome?.flow === cancellation.outcome?.flow
    && currentOutcome?.stage === cancellation.outcome?.stage
    && currentOutcome?.market === cancellation.outcome?.market
  if (cancellation.outcome && (!currentOutcome || sameFlowOutcome || state.address === cancellation.outcome.wallet)) {
    saveSwapOutcome(cancellation.outcome)
  }
  clearSetupRecovery(cancellation.signature)
  return true
}

async function saveLendingFlowOutcome(params, status, signature = null) {
  const walletAddress = params?.wallet ?? account?.address
  if (!params?.swapFlow || !params?.swapFlowStage || !walletAddress) return
  if (state.address !== walletAddress || account?.address !== walletAddress) return
  const market = params.market
  const token = params.token
  let amountBaseUnits = params.flowAmountBaseUnits ?? null
  let finalStatus = status
  if (status === 'confirmed' && params.swapFlowStage === 'withdraw') {
    try {
      const transaction = signature ? await api(`/api/tx/${signature}`) : null
      if (state.address !== walletAddress || account?.address !== walletAddress
        || params.market !== market || params.token !== token) return
      amountBaseUnits = confirmedSwapAmountFromTransaction(transaction, walletAddress, tok(params.token).mint)
    } catch {
      finalStatus = 'confirmed-amount-unknown'
      amountBaseUnits = null
    }
  }
  saveSwapOutcome({
    wallet: walletAddress,
    market,
    flow: params.swapFlow,
    stage: params.swapFlowStage,
    status: finalStatus,
    amountBaseUnits,
    signature,
    token,
  })
  return true
}

// Back from the wallet app with a signed transaction (or a refusal): send it, confirm it, then the next step if any.
async function resumeDeeplink(ret) {
  const swapPending = safe(() => JSON.parse(localStorage.getItem(SWAP_PENDING_KEY)))
  if (swapPending?.status === 'awaiting-signature') {
    if (ret.error) {
      if (!await clearSwapPending(swapPending.reservationId)) return
      saveSwapOutcome({ ...swapPending, status: 'rejected' })
      state.handoff = { status: 'error', label: 'Swap', error: ret.error }
      return
    }
    if (state.address !== swapPending.wallet) {
      state.handoff = { status: 'error', label: 'Swap', error: 'The connected wallet changed while the swap was open.' }
      return
    }
    state.handoff = { status: 'sending', label: 'Swap' }
    try {
      const relayed = await persistSignedSwapBeforeRelay({
        pending: swapPending,
        signedTransaction: fromBase64(ret.signed),
        persist: persistSwapPending,
        relay: async ({ signedTransaction }) => api('/api/swap-send', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tx: base64(signedTransaction), wallet: state.address, intentId: swapPending.intentId }),
        }),
      })
      if (relayed.terminalOutcome) {
        applySwapTerminalToHandoff(swapPending, relayed.terminalOutcome)
        return
      }
      if (relayed.pending.status === 'rejected') {
        await clearSwapPending(swapPending.reservationId, relayed.pending.signature)
        saveSwapOutcome({ ...swapPending, status: 'rejected', signature: relayed.pending.signature })
        throw relayed.error
      }
      if (relayed.error) {
        state.handoff = { status: 'error', label: 'Swap', error: 'Relay outcome is unknown. Keep this page open while Nysa checks the signed transaction before allowing another swap.' }
        return
      }
      const outcome = await confirmedSwapOutcome(relayed.pending.signature, relayed.pending)
      state.handoff = outcome.status === 'confirmed'
        ? { status: 'success', label: 'Swap', signature: relayed.pending.signature }
        : { status: 'error', label: 'Swap', error: outcome.error }
      saveSwapOutcome(outcome)
    } catch (error) {
      state.handoff = { status: 'error', label: 'Swap', error: error.message }
    }
    return
  }
  const pending = persistedLendingPending()
  if (!pending) return
  const params = pending.params
  const label = labelOf(params)
  if (pending.status !== 'awaiting-signature' && pending.signature) {
    await reconcilePendingLendingFlow()
    return
  }
  if (pending.status !== 'awaiting-signature') return
  if (ret.error) {
    try {
      const cleared = await clearLendingPending(pending.signature, pending.reservationId, pending)
      if (!cleared) throw pendingActionError('The wallet handoff changed before its rejection was saved.')
    } catch (error) {
      state.handoff = { status: 'error', label, error: error.message }
      return
    }
    state.handoff = { status: 'error', label, error: ret.error }
    if (params?.swapFlow) await saveLendingFlowOutcome(params, 'rejected').catch(() => {})
    event('Transaction failed', { action: params.kind, reason: 'rejected' })
    return
  }
  if (state.address !== pending.wallet || account?.address !== pending.wallet) {
    state.handoff = { status: 'error', label, error: 'Reconnect the wallet that signed this transaction before Nysa can relay it.' }
    return
  }
  state.handoff = { status: 'sending', label }
  try {
    const relayed = await persistSignedSwapBeforeRelay({
      pending,
      signedTransaction: fromBase64(ret.signed),
      persist: (next) => persistActionPending(pending.reservationId, next),
      relay: async ({ signedTransaction }) => api(params.loopAction ? '/api/loop-send' : '/api/tx/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tx: base64(signedTransaction), wallet: pending.wallet, intentId: pending.intentId }),
      }),
    })
    if (state.address !== pending.wallet || account?.address !== pending.wallet) return
    if (relayed.terminalOutcome) {
      applyActionTerminalToHandoff(relayed.pending, relayed.terminalOutcome)
      return
    }
    if (relayed.pending.status === 'rejected') {
      const cleared = await clearLendingPending(relayed.pending.signature, relayed.pending.reservationId)
      if (!cleared) return
      if (params?.swapFlow) await saveLendingFlowOutcome(params, 'rejected', relayed.pending.signature).catch(() => {})
      state.handoff = { status: 'error', label, error: relayed.error?.message ?? 'The transaction was refused before relay.' }
      return
    }
    if (relayed.error) {
      state.handoff = { status: 'error', label, error: 'Relay outcome is unknown. Keep this page open while Nysa checks the signed transaction before allowing another action.' }
      return
    }
    await reconcilePendingLendingFlow()
  } catch (error) {
    state.handoff = { status: 'error', label, error: error.message }
  }
  loadAccount(true)
}

async function reconcilePendingSwap() {
  if (reconcilingSwap) return
  const pending = safe(() => JSON.parse(localStorage.getItem(SWAP_PENDING_KEY)))
  // Never signed (the page reloaded while the wallet prompt was open): the server refuses its 15 s intent, so it can't land.
  if (pending && !pending.signature && ['wallet-prompt', 'awaiting-signature'].includes(pending.status) && swapAge(pending) > 60_000) {
    await clearSwapPending(pending.reservationId)
    return
  }
  if (!['submitted', 'signed-pending', 'relay-unknown'].includes(pending?.status) || !pending.signature || state.address !== pending.wallet) return
  state.swapPending = pending
  reconcilingSwap = true
  try {
    const outcome = await settleSwapChainOutcome(pending.signature, pending)
    if (outcome.status === 'failed') state.handoff = { status: 'error', label: 'Swap', error: `Swap failed on-chain: ${outcome.error}` }
    else if (outcome.status === 'confirmed') state.handoff = { status: 'success', label: 'Swap', signature: pending.signature }
  } catch (error) { console.warn('[swap] pending reconciliation unavailable', error?.message) }
  finally { reconcilingSwap = false }
}

async function reconcilePendingLendingFlow() {
  if (reconcilingLending) return
  const pending = persistedLendingPending()
  if (!['signed-pending', 'submitted', 'relay-unknown', 'setup-confirmed'].includes(pending?.status)
    || !pending.signature || state.address !== pending.wallet || account?.address !== pending.wallet) return
  reconcilingLending = true
  try {
    const chain = pending.status === 'setup-confirmed' ? { status: 'confirmed' } : await api(`/api/tx/${pending.signature}`)
    const current = persistedLendingPending()
    if (!pendingTransactionMatches(pending, current, state.address)
      || account?.address !== pending.wallet || current?.market !== pending.market || current?.kind !== pending.kind) return
    const outcome = classifyPendingTransaction(pending, chain)
    if (outcome.status === 'pending') return
    if (outcome.status === 'failed') {
      const cleared = await settleLendingPending(pending, 'failed', outcome.error)
      if (!cleared) return
      if (pending.params?.swapFlow) await saveLendingFlowOutcome(pending.params, 'failed', pending.signature)
      state.handoff = { status: 'error', label: labelOf(pending.params), error: `Transaction failed on-chain: ${outcome.error}` }
      return
    }
    if (outcome.status === 'setup-confirmed') {
      const recovery = recoverConfirmedSetupTransaction(pending, { status: 'confirmed' })
      const cleared = await settleLendingPending(pending, 'setup-confirmed')
      if (!cleared) return
      persistSetupRecovery(recovery)
      state.handoff = { status: 'error', label: labelOf(pending.params), error: 'Account setup confirmed. Choose Resume to sign the requested action, or Cancel to stop.' }
      return
    }
    if (pending.params?.loopAction && pending.kind === 'loop-close') {
      const accountSnapshot = await loadAccount(true)
      if (!accountSnapshot || !loopPositionFullyClosed(accountSnapshot.loopPositions, pending.params.positionId, accountSnapshot.loopPositionReadStatus)) {
        state.handoff = {
          status: 'error', label: labelOf(pending.params), signature: pending.signature,
          error: 'The close signature is confirmed, but the selected position still has debt or collateral. Nysa will keep reconciling it before allowing another action.',
        }
        return
      }
    }
    const cleared = await settleLendingPending(pending, 'confirmed')
    if (!cleared) return
    if (pending.setupRecoverySignature) clearSetupRecovery(pending.setupRecoverySignature)
    if (state.address !== pending.wallet || account?.address !== pending.wallet) return
    trackSuccess(pending.params)
    if (pending.params?.swapFlow) await saveLendingFlowOutcome(pending.params, 'confirmed', pending.signature)
    state.handoff = { status: 'success', label: labelOf(pending.params), signature: pending.signature }
    await loadAccount(true)
  } catch (error) {
    const stillRecorded = persistedLendingPending()
    if (stillRecorded) {
      state.handoff = { status: 'error', label: labelOf(pending.params), error: 'The transaction may still be pending. Nysa will keep checking its signature before another action is allowed.' }
    }
    console.warn('[lending flow] pending reconciliation unavailable', error?.message)
  }
  finally { reconcilingLending = false }
}

/** Resolve an ambiguous local-wallet relay only after Surfpool proves the signature absent and its blockhash expired. */
export async function reconcileLocalPendingAction() {
  const pending = persistedLendingPending()
  if (!pending || !['signed-pending', 'submitted', 'relay-unknown'].includes(pending.status)
    || typeof pending.signedTransactionBase64 !== 'string' || !pending.signature || !pending.wallet) return false
  const result = await api('/api/tx/reconcile-local', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: pending.wallet, signature: pending.signature, tx: pending.signedTransactionBase64 }),
  })
  if (result.status === 'pending') {
    state.handoff = { status: 'error', label: labelOf(pending.params), signature: pending.signature,
      error: 'Surfpool still considers this signed transaction valid. Nysa will keep reconciling it.' }
    return false
  }
  if (result.status === 'confirmed') {
    await reconcilePendingLendingFlow()
    return true
  }
  if (result.status !== 'failed' || !await settleLendingPending(pending, 'failed', result.error)) return false
  state.handoff = { status: 'error', label: labelOf(pending.params), signature: pending.signature,
    error: `Local transaction dropped safely: ${result.error}` }
  await loadAccount(true)
  return true
}

async function reconcileConfirmedFlowAmount() {
  if (reconcilingFlowAmount) return
  const pending = state.swapOutcome
  if (pending?.status !== 'confirmed-amount-unknown' || pending.stage !== 'withdraw'
    || !pending.signature || state.address !== pending.wallet) return
  reconcilingFlowAmount = true
  try {
    const transaction = await api(`/api/tx/${pending.signature}`)
    const amountBaseUnits = confirmedSwapAmountFromTransaction(transaction, pending.wallet, tok(pending.token ?? 'svm-usdy').mint)
    if (state.address !== pending.wallet || state.swapOutcome?.signature !== pending.signature) return
    saveSwapOutcome({ ...pending, status: 'confirmed', amountBaseUnits })
  } catch (error) { console.warn('[swap flow] confirmed amount reconciliation unavailable', error?.message) }
  finally { reconcilingFlowAmount = false }
}

async function reconcileActivePendingTransactions() {
  refreshLendingBuildCancelable()
  await reconcilePendingSwap()
  await reconcilePendingLendingFlow()
  await reconcileConfirmedFlowAmount()
}

// First-time setup comes back as a separate transaction (final: false): send it, wait, then ask for the action.
async function runAction(params, { resumeFromSetupSignature = null, handoffOnly = false, verifyConfirmed = null } = {}) {
  if (activeLendingActionReservation) throw pendingActionError()
  const id = reservationId()
  activeLendingActionReservation = { reservationId: id, params }
  state.lendingActionBusy = true
  state.lendingBuildCancelable = false
  let owner
  try {
    if (!wallet || !account) throw new Error('Connect a Solana wallet to continue.')
    // No SOL at all: every transaction would fail (fees are paid in SOL).
    if (state.sol === 0) throw new Error('This wallet needs a little SOL for Solana network fees and new account rent: add about 0.01 SOL (0.05 before a first supply or borrow) and try again.')
    if (state.setupRecoveryBusy && !resumeFromSetupSignature) {
      throw pendingActionError('An account setup action is being resumed. Finish or cancel that action first.')
    }
    owner = account.address
    params = { ...params, wallet: owner }
    let resumeSignature = resumeFromSetupSignature
    const reservation = {
      reservationId: id, createdAt: Date.now(), leaseExpiresAt: Date.now() + ACTION_BUILD_LEASE_MS,
      wallet: owner, params, final: null, market: params.market, kind: params.kind,
      flow: params.swapFlow ?? null, stage: params.swapFlowStage ?? null,
      signature: null, status: 'preparing', phase: 'building', setupRecoverySignature: resumeSignature,
    }
    await withActionReservationLock(() => {
      assertNoPendingSwapAction()
      const existingPending = persistedLendingPending()
      if (resumeSignature && !canResumeSetupRecovery(persistedSetupRecovery(), existingPending, resumeSignature)) {
        throw pendingActionError('Confirmed account setup no longer matches the requested resume action.')
      }
      assertCanStartLendingAction(existingPending, params, resumeSignature)
      const setupRecovery = persistedSetupRecovery()
      if (setupRecovery && setupRecovery.signature !== resumeSignature) {
        throw pendingActionError('Confirmed account setup must be resumed or cancelled before another action.')
      }
      persistLendingPending(reservation)
    }, requiresFeatureActionLock(params))
    startActionBuildLease(id)

    if (wallet.deeplink) {
      // The page leaves for the wallet app from the handoff card; this promise only settles if the user cancels.
      await deeplinkStep(params, { resumeFromSetupSignature: resumeSignature, reservationId: id })
      if (handoffOnly) return null
      return await new Promise((_, reject) => { cancelPending = reject })
    }

    let minSlot = 0
    for (let step = 0; step < 3; step++) {
      await updateActionReservation(id, { status: 'preparing', phase: 'building', setupRecoverySignature: resumeSignature })
      const built = await buildTx(params)
      const intentExpiresAt = params.loopAction ? built?.expiresAt : built?.intentExpiresAt
      if ((params.loopAction || (params.swapFlow && params.swapFlowStage))
        && (!built?.intentId || !Number.isFinite(intentExpiresAt) || intentExpiresAt <= Date.now())) {
        throw new Error('The transaction authorization expired before wallet signing. Build it again.')
      }
      if (state.address !== owner || account?.address !== owner) throw new Error('The connected wallet changed while the transaction was being prepared.')
      if (resumeSignature && !canResumeSetupRecovery(persistedSetupRecovery(), persistedLendingPending(), resumeSignature, id)) {
        throw pendingActionError('Confirmed account setup changed while the action was being prepared.')
      }
      assertCanStartLendingAction(persistedLendingPending(), params, resumeSignature, id)
      if (params.loopAction || (params.swapFlow && params.swapFlowStage)) {
        const sign = wallet.features['solana:signTransaction']?.signTransaction
        if (typeof sign !== 'function') throw new Error('This wallet cannot safely sign a recoverable Nysa flow transaction.')
        await promoteActionReservationToWalletPrompt(id, {
          phase: 'wallet-sign', final: built.final,
          intentId: built.intentId,
        })
        if (state.address !== owner || account?.address !== owner) {
          await clearActionReservation(id)
          throw new Error('The connected wallet changed before signing.')
        }
        let signed
        try {
          signed = await sign({ account, chain: CHAIN, transaction: fromBase64(built.tx), options: { preflightCommitment: 'confirmed', minContextSlot: Math.max(built.minContextSlot ?? 0, minSlot) } })
        } catch (error) {
          await clearActionReservation(id) // signTransaction cannot broadcast the transaction
          throw error
        }
        const signedTransaction = signed?.[0]?.signedTransaction
        if (!(signedTransaction instanceof Uint8Array)) {
          await clearActionReservation(id)
          throw new Error('The wallet did not return a signed transaction.')
        }
        if (state.address !== owner || account?.address !== owner) {
          await clearActionReservation(id)
          throw new Error('The connected wallet changed while the transaction was being signed.')
        }
        if (resumeSignature && !canResumeSetupRecovery(persistedSetupRecovery(), persistedLendingPending(), resumeSignature, id)) {
          await clearActionReservation(id)
          throw pendingActionError('Confirmed account setup changed while the action was being signed.')
        }
        assertCanStartLendingAction(persistedLendingPending(), params, resumeSignature, id)
        const pending = {
          ...reservation, wallet: owner, params, final: built.final, market: params.market, kind: params.kind,
          flow: params.swapFlow, stage: params.swapFlowStage, setupRecoverySignature: resumeSignature,
          intentId: built.intentId,
        }
        const relayed = await persistSignedSwapBeforeRelay({
          pending,
          signedTransaction,
          persist: (next) => persistActionPending(id, next),
          relay: async ({ signedTransaction: bytes }) => api(params.loopAction ? '/api/loop-send' : '/api/tx/send', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tx: base64(bytes), wallet: owner, intentId: built.intentId }),
          }),
        })
        if (state.address !== owner || account?.address !== owner) throw new Error('The connected wallet changed while the transaction was being relayed.')
        if (relayed.pending.status === 'rejected') {
          await clearActionReservation(id)
          const error = new Error(relayed.error?.message ?? 'The transaction was refused before relay.')
          error.code = 'TRANSACTION_REJECTED'
          error.status = relayed.error?.status ?? 400
          throw error
        }
        if (relayed.error) throw pendingActionError('Relay outcome is unknown. Reconcile the signed transaction before retrying.')
        try { minSlot = await confirmed(relayed.pending.signature) }
        catch (error) {
          if (/failed on-chain/i.test(error.message)) await clearActionReservation(id)
          throw error
        }
        if (state.address !== owner || account?.address !== owner) throw new Error('The connected wallet changed while the transaction was confirming.')
        if (built.final) {
          if (typeof verifyConfirmed === 'function' && await verifyConfirmed({ signature: relayed.pending.signature }) !== true) {
            state.handoff = {
              status: 'error', label: labelOf(params), signature: relayed.pending.signature,
              error: 'The transaction is confirmed, but its final position state is not verified. Nysa will keep reconciling before allowing another action.',
            }
            throw pendingActionError('The transaction is confirmed, but the selected Multiply position has not verified a full close. Reconcile it before retrying.')
          }
          await clearActionReservation(id)
          if (resumeSignature) clearSetupRecovery(resumeSignature)
          return relayed.pending.signature
        }
        resumeSignature = relayed.pending.signature
        persistSetupRecovery(markSetupTransactionConfirmed(relayed.pending))
        await updateActionReservation(id, { signature: null, final: null, status: 'preparing', phase: 'building', setupRecoverySignature: resumeSignature })
        continue
      }

      const send = wallet.features['solana:signAndSendTransaction']?.signAndSendTransaction
      if (typeof send !== 'function') throw new Error('This wallet cannot send Solana transactions.')
      assertCanStartLendingAction(persistedLendingPending(), params, resumeSignature, id)
      await promoteActionReservationToWalletPrompt(id, { phase: 'wallet-prompt', final: built.final })
      if (state.address !== owner || account?.address !== owner) {
        await clearActionReservation(id)
        throw new Error('The connected wallet changed before sending.')
      }
      let sent
      try {
        sent = await reauthorized(() => send({
          account, chain: CHAIN, transaction: fromBase64(built.tx),
          options: { preflightCommitment: 'confirmed', minContextSlot: Math.max(built.minContextSlot, minSlot) },
        }))
      } catch (error) {
        if (definiteWalletRejection(error)) await clearActionReservation(id)
        else {
          await preserveUnknownWalletSend(id, error)
          throw pendingActionError('Wallet send outcome is unknown. Reconcile it before starting another action.')
        }
        throw error
      }
      let sig
      try { sig = getBase58Decoder().decode(sent?.[0]?.signature) }
      catch (error) {
        await preserveUnknownWalletSend(id, error)
        throw pendingActionError('Wallet returned no usable signature. Send outcome is unknown; reconcile before retrying.')
      }
      const pending = await updateActionReservation(id, {
        wallet: owner, params, final: built.final, market: params.market, kind: params.kind,
        flow: params.swapFlow ?? null, stage: params.swapFlowStage ?? null,
        signature: sig, status: 'submitted', phase: 'submitted', setupRecoverySignature: resumeSignature,
      })
      if (state.address !== owner || account?.address !== owner) throw new Error('The connected wallet changed after sending; the signature is saved for reconciliation.')
      try { minSlot = await confirmed(sig) }
      catch (error) {
        if (/failed on-chain/i.test(error.message)) await clearActionReservation(id)
        throw error
      }
      if (state.address !== owner || account?.address !== owner) throw new Error('The connected wallet changed while the transaction was confirming.')
      if (built.final) {
        await clearActionReservation(id)
        if (resumeSignature) clearSetupRecovery(resumeSignature)
        return sig
      }
      resumeSignature = sig
      persistSetupRecovery(markSetupTransactionConfirmed(pending))
      await updateActionReservation(id, { signature: null, final: null, status: 'preparing', phase: 'building', setupRecoverySignature: resumeSignature })
    }
    throw new Error('Account setup did not complete, please try again')
  } catch (error) {
    const pending = persistedLendingPending()
    if (pending?.reservationId === id
      && ((pending.status === 'preparing' && pending.phase === 'building')
        || (pending.status === 'wallet-prompt' && pending.phase === 'wallet-sign'))) {
      await clearActionReservation(id) // no economic transaction was sent on this path
    }
    throw error
  } finally {
    if (activeLendingActionReservation?.reservationId === id) activeLendingActionReservation = null
    stopActionBuildLease(id)
    state.lendingActionBusy = false
    state.lendingBuildCancelable = canCancelBuildReservation(persistedLendingPending())
  }
}

// kind: deposit | withdraw | borrow | repay. Returns the confirmed signature.
export async function sendKaminoAction(kind, { market, token, amount, amountBaseUnits, all, swapFlow, swapFlowStage, flowAmountBaseUnits, beforeBalanceBaseUnits }) {
  const walletAddress = account?.address
  const params = { wallet: walletAddress, kind, market: market.id, token: token.token_id, amount, amountBaseUnits, all, swapFlow, swapFlowStage, flowAmountBaseUnits, beforeBalanceBaseUnits }
  try {
    const sig = await runAction(params)
    trackSuccess(params) // Deposit | Withdraw | Borrow | Repay
    if (params.swapFlow) await saveLendingFlowOutcome(params, 'confirmed', sig)
    return sig
  } catch (e) {
    if (e?.code === 'PENDING_TRANSACTION' || e?.code === 'ACTION_RESERVATION_LOCK_UNAVAILABLE') throw e
    const pending = persistedLendingPending()
    const stillPending = pending?.wallet === walletAddress && pending?.params?.swapFlow === swapFlow
      && pending?.params?.swapFlowStage === swapFlowStage
      && ['preparing', 'wallet-prompt', 'awaiting-signature', 'signed-pending', 'submitted', 'relay-unknown'].includes(pending.status)
    if (params.swapFlow && !stillPending) {
      const rejected = e?.code === 'TRANSACTION_REJECTED' || /reject|cancel/i.test(e?.message)
      await saveLendingFlowOutcome(params, rejected ? 'rejected' : 'failed').catch(() => {})
    }
    event('Transaction failed', { action: kind, reason: /reject|cancel/i.test(e?.message) ? 'rejected' : 'error' })
    throw e
  }
}

/** Open or fully close an identified Multiply position through the exact-message loop intent relay. */
export async function sendLoopAction(kind, { market, amount, leverage, previewId, acknowledgementKey, positionId } = {}) {
  if (!['loop-open', 'loop-close'].includes(kind)) throw new Error('Unsupported loop action.')
  const walletAddress = account?.address
  const params = { wallet: walletAddress, kind, market, amount, leverage, previewId, acknowledgementKey, positionId, loopAction: true }
  try {
    const signature = await runAction(params, {
      verifyConfirmed: kind === 'loop-close' ? async () => {
        const accountSnapshot = await loadAccount(true)
        return !!accountSnapshot && loopPositionFullyClosed(accountSnapshot.loopPositions, positionId, accountSnapshot.loopPositionReadStatus)
      } : null,
    })
    event(kind === 'loop-open' ? 'Multiply loop opened' : 'Multiply loop fully closed', { market })
    await loadAccount(true)
    return signature
  } catch (error) {
    if (error?.code === 'PENDING_TRANSACTION' || error?.code === 'ACTION_RESERVATION_LOCK_UNAVAILABLE') throw error
    event('Transaction failed', { action: kind, reason: /reject|cancel/i.test(error?.message ?? '') ? 'rejected' : 'error' })
    throw error
  }
}

/** Run the one-time non-economic Kamino UserMetadata setup through the same sign-only intent relay. */
export async function sendLoopSetup({ market = 'sol-usdy-usdc' } = {}) {
  const walletAddress = account?.address
  if (!walletAddress) throw new Error('Connect a Solana wallet before initializing Kamino metadata.')
  const params = { wallet: walletAddress, kind: 'loop-setup', market, loopAction: true }
  try {
    const signature = await runAction(params)
    await loadAccount(true)
    return signature
  } catch (error) {
    if (error?.code === 'PENDING_TRANSACTION' || error?.code === 'ACTION_RESERVATION_LOCK_UNAVAILABLE') throw error
    event('Kamino metadata setup failed', { reason: /reject|cancel/i.test(error?.message ?? '') ? 'rejected' : 'error' })
    throw error
  }
}

// Runs an action and records the outcome (analytics). Returns the confirmed signature.
async function act(params) {
  try {
    const sig = await runAction(params)
    trackSuccess(params)
    return sig
  } catch (e) {
    event('Transaction failed', { action: params.kind, reason: /reject|cancel/i.test(e?.message) ? 'rejected' : 'error' })
    throw e
  }
}
// Earn vault: deposit the vault's token for shares, or withdraw `amount` of it (all: every share).
export const sendVaultAction = (kind, vault, { amount, all }) => act({ kind, vault: vault.id, amount, all })
export const claimRewards = (market) => act({ kind: 'claim', market: market.id })

// Liquidation of someone else's unhealthy loan: how much can be repaid, a quote (simulated on-chain), then the action.
export const loadLiquidationInfo = (market, borrower) => api(`/api/liquidation/${market.id}/${borrower}`)
export async function previewLiquidation(market, borrower, amount) {
  if (!account) throw new Error('Connect a Solana wallet to continue.')
  return (await buildTx({ kind: 'liquidate', market: market.id, borrower, amount, preview: true })).quote
}
export const liquidate = (market, borrower, amount) => act({ kind: 'liquidate', market: market.id, borrower, amount })

// ---- read-only data from the backend ----
// Farm Points leaderboard (shared by the modal, Portfolio and Analytics). Loaded once per page view.
let pointsReq = null
export function loadPoints() {
  pointsReq ??= fetch('/api/points', { headers: { accept: 'text/csv' } })
    .then((res) => { if (!res.ok) throw new Error(`Points source responded ${res.status}`); return res.text() })
    .then((csv) => { state.points.board = parsePoints(csv); state.points.error = null })
    .catch((e) => { state.points.error = e.message || 'Could not load Farm Points.'; pointsReq = null })
  return pointsReq
}
export const myPoints = () => state.points.board?.rows.find((r) => r.address === state.address) ?? null

// One request per page view, shared by every caller; asked again after a failure.
const once = (path) => { let req = null; return () => (req ??= api(path).catch((e) => { req = null; throw e })) }
// Reserve history for Realized APY (recorded by the snapshot twice a day).
export const loadApyHistory = once('/api/apy-history')
// Admin changes to the market and its reserves (decoded on-chain by the backend).
export const loadMarketUpdates = once('/api/market-updates')

// Every open position, riskiest first (hf null = no debt).
// Market positions (obligations) and each vault's holders ({ [vaultId]: [{ owner, wallet, staked }] } or null).
export const loadAnalytics = () => api('/api/analytics')
// Every liquidation in the live markets, newest first (decoded on-chain by the backend).
export const loadLiquidations = () => api('/api/liquidations').then((a) => a.liquidations)

let started = false
export function start() {
  if (started) return
  started = true
  registerMobileWalletAdapter()
  scanWallets()
  getWallets().on('register', scanWallets)
  listenMarket()
  loadSwapVisibility()
  const ret = readDeeplinkReturn() // back from Phantom/Solflare on iOS?
  if (ret) skipNextPageview()
  if (ret?.action === 'connect' && ret.error) state.handoff = { status: 'error', label: 'Connect wallet', error: ret.error }
  else if (ret?.action === 'connect') {
    setAccount(deeplinkWallet(ret.wallet), { address: ret.address })
    event('Wallet connected', { wallet: ret.wallet, via: 'ios-app' })
  }
  eagerConnect().then(async () => {
    if (ret?.action === 'sign') await resumeDeeplink(ret)
    await reconcileActivePendingTransactions()
  }).catch((error) => console.warn('[wallet] reconnect failed', error?.message))
  setInterval(() => document.visibilityState === 'visible' && loadAccount(), ACCOUNT_REFRESH_MS)
  stopActiveReconciliation = startVisibleReconciliationLoop({
    reconcile: reconcileActivePendingTransactions,
    isVisible: () => document.visibilityState === 'visible',
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadAccount()
      reconcileActivePendingTransactions()
    }
  })
}

// Sequential multi-step transaction runner shared by the Lend/Borrow panels.
export function useTx() {
  const tx = reactive({ status: 'idle', steps: [], i: 0, error: null, signature: null, note: null })
  return {
    tx,
    reset: () => Object.assign(tx, { status: 'idle', steps: [], i: 0, error: null, signature: null, note: null }),
    async run(steps) {
      if (tx.status === 'running') return false
      Object.assign(tx, { status: 'running', steps: steps.map((s) => s.label), i: 0, error: null, signature: null, note: null })
      for (const [i, s] of steps.entries()) {
        tx.i = i
        try {
          const sig = await s.run()
          if (typeof sig === 'string') tx.signature = sig
        } catch (e) {
          if (e?.message === 'Transaction cancelled') return (tx.status = 'idle', false) // the user's own Cancel on the wallet sheet
          tx.error = `${s.label} — ${/reject/i.test(e?.message) ? 'Transaction rejected in your wallet.' : e?.message ?? 'Transaction failed'}`
          tx.status = 'error'
          loadAccount(true)
          return false
        }
      }
      tx.status = 'success'
      loadAccount(true)
      return true
    },
  }
}
