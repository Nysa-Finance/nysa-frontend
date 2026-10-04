// Global app state. The browser never calls the Solana RPC:
// - market data is pushed by the backend over Server-Sent Events (/api/events), on load and whenever it changes;
// - the connected wallet's balances, positions and rewards come from /api/account;
// - transactions are built and simulated by /api/tx; the wallet only signs and sends them.
import { reactive, markRaw } from 'vue'
import { getWallets } from '@wallet-standard/app'
import { getBase58Decoder } from '@solana/kit'
import { tok, tokensOf } from './config.js'
import { parsePoints, pct } from './logic.js'
import { event } from './analytics.js'
import {
  isIOS, DEEPLINK_WALLETS, registerMobileWalletAdapter, deeplinkSession, connectUrl, signUrl, readDeeplinkReturn, clearDeeplinkSession,
} from './wallets.js'

const TOS_KEY = 'nysaTosAccepted.v1'
const WALLET_KEY = 'connectedWallet'
const CHAIN = 'solana:mainnet'
const ACCOUNT_REFRESH_MS = 60_000 // while the tab is visible; right after a transaction it refreshes immediately
const CONFIRM_TIMEOUT_MS = 90_000

const safe = (fn, fallback = null) => {
  try { return fn() } catch { return fallback }
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
  positions: {}, // token_id -> { supplied, borrowed, maxWithdraw } units
  claimable: {}, // market id -> [{ symbol, amount }] unclaimed rewards of the connected wallet
  walletName: null,
  wallets: [], // detected Wallet Standard wallets
  connectOpen: false,
  points: { board: null, error: null }, // Farm Points leaderboard
  // Phone wallets reached by deeplink (iOS): a transaction waiting for the user to approve it in the wallet app, or its
  // outcome after they come back. { status: 'ready'|'sending'|'success'|'error', label, wallet, url?, signature?, error? }
  handoff: null,
})

// Wallet objects stay outside Vue reactivity (they hold private fields).
let wallet = null
let account = null
const usable = (w) => w.chains.includes(CHAIN) && 'standard:connect' in w.features && 'solana:signAndSendTransaction' in w.features
function scanWallets() {
  const ws = getWallets().get().filter(usable)
  state.wallets = [...ws.filter((w) => w.name === 'Phantom'), ...ws.filter((w) => w.name !== 'Phantom')].map(markRaw)
}

// iOS Safari has no wallet extensions: offer Phantom / Solflare through their deeplink protocol instead.
export const deeplinkWallets = () => (isIOS && !state.wallets.length ? DEEPLINK_WALLETS : [])
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

// Risk parameters of a collateral/liability pair. Governance changes them (Market Updates), so the live on-chain
// values win; config.js only fills in until the first market update arrives.
export function riskOf(pair) {
  const c = state.reserves[pair.collateral], l = state.reserves[pair.liability]
  return {
    ...pair,
    ...(c && { maxLtv: c.maxLtv, liqLtv: c.liqLtv, maxDiscount: c.maxDiscount, supplyCap: c.supplyCap }),
    ...(l && { borrowCap: l.borrowCap }),
  }
}
// Interest rate model of a borrowable token (live curve and fee); null for collateral-only tokens.
export const irmOf = (t) => (t.irm ? state.reserves[t.token_id]?.irm ?? t.irm : null)

// Everything a view needs for one token, merged.
export function rowOf(id) {
  const r = state.reserves[id]
  if (!r) return null
  return { reserve: r, walletBalance: state.balances[id] ?? 0, ...(state.positions[id] ?? { supplied: 0, borrowed: 0, maxWithdraw: 0 }) }
}

export function marketSummary(m) {
  let s = 0, b = 0
  for (const t of tokensOf(m)) {
    s += state.reserves[t.token_id]?.supplyUsd ?? 0
    b += state.reserves[t.token_id]?.borrowUsd ?? 0
  }
  return { totalSuppliedUsd: state.loaded ? s : null, totalBorrowedUsd: state.loaded ? b : null }
}

// ---- market: pushed by the backend (EventSource reconnects by itself) ----
function listenMarket() {
  const es = new EventSource('/api/events')
  es.addEventListener('market', (e) => {
    const s = JSON.parse(e.data)
    state.reserves = s.reserves
    state.rewards = s.rewards
    state.loaded = true
    state.loading = false
    state.error = null
  })
  es.onerror = () => {
    if (!state.loaded) { state.loading = false; state.error = 'the server is not reachable' }
  }
}

// ---- connected wallet ----
async function api(path, init) {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Server responded ${res.status}`)
  return body
}

// fresh: skip the server's short per-wallet cache (after a transaction).
export async function loadAccount(fresh = false) {
  const addr = state.address
  if (!addr) return
  try {
    const a = await api(`/api/account/${addr}${fresh ? '?fresh' : ''}`)
    if (state.address !== addr) return // switched wallet meanwhile
    state.balances = a.balances
    state.positions = a.positions
    state.claimable = a.claimable
    state.walletError = null
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
  state.positions = {}
  state.claimable = {}
  state.walletError = null
  if (acc) loadAccount()
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
  event('Wallet connected', { wallet: w.name })
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
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

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

const buildTx = (params) => api('/api/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...params, wallet: account.address }) })

const ACTION_LABELS = { deposit: 'Supply', withdraw: 'Withdraw', borrow: 'Borrow', repay: 'Repay', claim: 'Claim rewards', test: 'Test transfer' }
const labelOf = (p) => `${ACTION_LABELS[p.kind]}${p.token ? ` ${tok(p.token).name}` : ''}`
function trackSuccess(p) {
  if (p.kind === 'claim') event('Rewards claimed', { market: p.market })
  else if (p.token) event(p.kind[0].toUpperCase() + p.kind.slice(1), { token: tok(p.token).name })
}

// ---- deeplink wallets (iOS): every signature is a round trip to the wallet app, and the page reloads on return ----
const PENDING_KEY = 'nysaPendingTx' // the action being signed, kept across the page reload
let cancelPending = null
async function deeplinkStep(params) {
  const built = await buildTx(params)
  safe(() => localStorage.setItem(PENDING_KEY, JSON.stringify({ params, final: built.final })))
  state.handoff = { status: 'ready', label: labelOf(params) + (built.final ? '' : ' · account setup (1 of 2)'), wallet: wallet.name, url: signUrl(built.tx) }
}
export function cancelHandoff() {
  safe(() => localStorage.removeItem(PENDING_KEY))
  state.handoff = null
  cancelPending?.(new Error('Transaction cancelled'))
  cancelPending = null
}
export const dismissHandoff = () => { state.handoff = null }

// Back from the wallet app with a signed transaction (or a refusal): send it, confirm it, then the next step if any.
async function resumeDeeplink(ret) {
  const pending = safe(() => JSON.parse(localStorage.getItem(PENDING_KEY)))
  safe(() => localStorage.removeItem(PENDING_KEY))
  if (!pending) return
  const label = labelOf(pending.params)
  if (ret.error) {
    state.handoff = { status: 'error', label, error: ret.error }
    event('Transaction failed', { action: pending.params.kind, reason: 'rejected' })
    return
  }
  state.handoff = { status: 'sending', label }
  try {
    const { signature } = await api('/api/tx/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: ret.signed, wallet: account.address }) })
    await confirmed(signature)
    if (pending.final) {
      state.handoff = { status: 'success', label, signature }
      trackSuccess(pending.params)
    } else {
      await deeplinkStep(pending.params) // account created: now the action itself
    }
  } catch (e) {
    state.handoff = { status: 'error', label, error: e.message }
    event('Transaction failed', { action: pending.params.kind, reason: 'error' })
  }
  loadAccount(true)
}

// First-time setup comes back as a separate transaction (final: false): send it, wait, then ask for the action.
async function runAction(params) {
  if (!wallet || !account) throw new Error('Connect a Solana wallet to continue.')
  if (wallet.deeplink) {
    // The page leaves for the wallet app from the handoff card; this promise only settles if the user cancels.
    await deeplinkStep(params)
    return new Promise((_, reject) => { cancelPending = reject })
  }
  let minSlot = 0
  for (let step = 0; step < 3; step++) {
    const built = await buildTx(params)
    const [{ signature }] = await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({
      account, chain: CHAIN, transaction: fromBase64(built.tx),
      options: { preflightCommitment: 'confirmed', minContextSlot: Math.max(built.minContextSlot, minSlot) },
    })
    const sig = getBase58Decoder().decode(signature)
    minSlot = await confirmed(sig)
    if (built.final) return sig
  }
  throw new Error('Account setup did not complete, please try again')
}

// kind: deposit | withdraw | borrow | repay. Returns the confirmed signature.
export async function sendKaminoAction(kind, { market, token, amount, all }) {
  try {
    const params = { kind, market: market.id, token: token.token_id, amount, all }
    const sig = await runAction(params)
    trackSuccess(params) // Deposit | Withdraw | Borrow | Repay
    return sig
  } catch (e) {
    event('Transaction failed', { action: kind, reason: /reject/i.test(e?.message) ? 'rejected' : 'error' })
    throw e
  }
}

export async function claimRewards(market) {
  const params = { kind: 'claim', market: market.id }
  const sig = await runAction(params)
  trackSuccess(params)
  return sig
}

// TEMPORARY (/debug-transfer page): 1000 lamports to yourself, see server/tx.js.
export const sendTestTransfer = () => runAction({ kind: 'test' })

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

// Daily reserve history for Realized APY (recorded by the daily snapshot). Loaded once per page view.
let historyReq = null
export function loadApyHistory() {
  historyReq ??= api('/api/apy-history').catch((e) => { historyReq = null; throw e })
  return historyReq
}

// Admin changes to the market and its reserves (decoded on-chain by the backend). Loaded once per page view.
let updatesReq = null
export function loadMarketUpdates() {
  updatesReq ??= api('/api/market-updates').catch((e) => { updatesReq = null; throw e })
  return updatesReq
}

// Every open position, riskiest first (hf null = no debt).
export const loadPositions = () => api('/api/analytics').then((a) => a.positions)

let started = false
export function start() {
  if (started) return
  started = true
  registerMobileWalletAdapter()
  scanWallets()
  getWallets().on('register', scanWallets)
  listenMarket()
  const ret = readDeeplinkReturn() // back from Phantom/Solflare on iOS?
  if (ret?.action === 'connect' && ret.error) state.handoff = { status: 'error', label: 'Connect wallet', error: ret.error }
  else if (ret?.action === 'connect') {
    setAccount(deeplinkWallet(ret.wallet), { address: ret.address })
    event('Wallet connected', { wallet: ret.wallet })
  }
  eagerConnect()
  if (ret?.action === 'sign') resumeDeeplink(ret)
  setInterval(() => document.visibilityState === 'visible' && loadAccount(), ACCOUNT_REFRESH_MS)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && loadAccount())
}

// Sequential multi-step transaction runner shared by the Lend/Borrow panels.
export function useTx() {
  const tx = reactive({ status: 'idle', steps: [], i: 0, error: null, signature: null })
  return {
    tx,
    reset: () => Object.assign(tx, { status: 'idle', steps: [], i: 0, error: null, signature: null }),
    async run(steps) {
      if (tx.status === 'running') return false
      Object.assign(tx, { status: 'running', steps: steps.map((s) => s.label), i: 0, error: null, signature: null })
      for (const [i, s] of steps.entries()) {
        tx.i = i
        try {
          const sig = await s.run()
          if (typeof sig === 'string') tx.signature = sig
        } catch (e) {
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
