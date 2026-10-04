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
})

// Wallet objects stay outside Vue reactivity (they hold private fields).
let wallet = null
let account = null
const usable = (w) => w.chains.includes(CHAIN) && 'standard:connect' in w.features && 'solana:signAndSendTransaction' in w.features
function scanWallets() {
  const ws = getWallets().get().filter(usable)
  state.wallets = [...ws.filter((w) => w.name === 'Phantom'), ...ws.filter((w) => w.name !== 'Phantom')].map(markRaw)
}

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

export async function disconnect() {
  try { await wallet?.features['standard:disconnect']?.disconnect() } catch { /* wallet already gone */ }
  setAccount(null, null)
  safe(() => localStorage.removeItem(WALLET_KEY))
}

// Silent reconnect to the wallet used last time.
async function eagerConnect() {
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

// First-time setup comes back as a separate transaction (final: false): send it, wait, then ask for the action.
async function runAction(params) {
  if (!wallet || !account) throw new Error('Connect a Solana wallet to continue.')
  let minSlot = 0
  for (let step = 0; step < 3; step++) {
    const built = await api('/api/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...params, wallet: account.address }) })
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
    const sig = await runAction({ kind, market: market.id, token: token.token_id, amount, all })
    event(kind[0].toUpperCase() + kind.slice(1), { token: token.name }) // Deposit | Withdraw | Borrow | Repay
    return sig
  } catch (e) {
    event('Transaction failed', { action: kind, reason: /reject/i.test(e?.message) ? 'rejected' : 'error' })
    throw e
  }
}

export async function claimRewards(market) {
  const sig = await runAction({ kind: 'claim', market: market.id })
  event('Rewards claimed', { market: market.id })
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
  scanWallets()
  getWallets().on('register', scanWallets)
  listenMarket()
  eagerConnect()
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
