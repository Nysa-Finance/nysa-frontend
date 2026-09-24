// Global app state: live reserve data (Kamino API), Solana wallet (Wallet Standard), balances, positions.
import { reactive, markRaw } from 'vue'
import { getWallets } from '@wallet-standard/app'
import { KAMINO_API, SOLANA_RPC, LIVE, TOKENS, tok, tokensOf } from './config.js'
import { parsePoints } from './logic.js'

const TOS_KEY = 'nysaTosAccepted.v1'
const WALLET_KEY = 'connectedWallet'
const CHAIN = 'solana:mainnet'
const kamino = () => import('./kamino.js') // klend-sdk is big; load it only once a wallet is involved

const safe = (fn, fallback = null) => {
  try { return fn() } catch { return fallback }
}

export const state = reactive({
  tosAccepted: safe(() => localStorage.getItem(TOS_KEY) === '1', false),
  loaded: false,
  loading: false,
  error: null, // market data
  walletError: null, // balances/positions
  reserves: {}, // token_id -> reserve metrics
  address: null,
  balances: {}, // token_id -> units in wallet
  positions: {}, // token_id -> { supplied, borrowed, maxWithdraw } units
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

async function loadReserves() {
  for (const m of LIVE) {
    const res = await fetch(`${KAMINO_API}/kamino-market/${m.kaminoMarket}/reserves/metrics?env=mainnet-beta`)
    if (!res.ok) throw new Error(`Kamino API responded ${res.status}`)
    const list = await res.json()
    for (const t of tokensOf(m)) {
      const x = list.find((r) => r.reserve === t.reserve)
      if (!x) continue
      const supplied = +x.totalSupply, borrowed = +x.totalBorrow
      state.reserves[t.token_id] = {
        supplyAPR: +x.supplyApy * 100,
        borrowAPR: m.loans.includes(t.token_id) ? +x.borrowApy * 100 : null,
        totalSupplied: supplied,
        totalBorrowed: borrowed,
        supplyUsd: +x.totalSupplyUsd,
        borrowUsd: +x.totalBorrowUsd,
        utilization: supplied > 0 ? (borrowed / supplied) * 100 : 0,
        availableLiquidity: Math.max(supplied - borrowed, 0),
        price: supplied > 0 ? +x.totalSupplyUsd / supplied : t.price,
        maxLtv: +x.maxLtv * 100,
      }
    }
  }
}

async function rpc(method, params) {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

async function loadBalances(owner) {
  const out = {}
  for (const t of Object.values(TOKENS)) {
    const r = await rpc('getTokenAccountsByOwner', [owner, { mint: t.mint }, { encoding: 'jsonParsed' }])
    out[t.token_id] = r.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0)
  }
  state.balances = out
}

// Positions via klend-sdk. The same read also yields reserve metrics at the current block, which replace the
// REST ones (Kamino's API lags a few minutes after activity, e.g. showing 0% APY right after a borrow).
async function loadPositions(owner) {
  const { loadPositions: read } = await kamino()
  const out = {}
  for (const m of LIVE) {
    const { positions, reserves } = await read(m, tokensOf(m), owner)
    Object.assign(out, positions)
    Object.assign(state.reserves, reserves)
  }
  state.positions = out
}

export async function refresh() {
  state.loading = true
  try {
    await loadReserves()
    state.error = null
  } catch (e) {
    console.error('[refresh] market data', e)
    state.error = e.message
  }
  try {
    if (state.address) await Promise.all([loadBalances(state.address), loadPositions(state.address)])
    state.walletError = null
  } catch (e) {
    console.error('[refresh] wallet', e)
    state.walletError = e.message
  } finally {
    state.loaded = true
    state.loading = false
  }
}

function setAccount(w, acc) {
  wallet = w
  account = acc
  state.address = acc?.address ?? null
  state.walletName = acc ? w.name : null
  if (!acc) {
    state.balances = {}
    state.positions = {}
    state.walletError = null
  }
}

async function connectWith(w, silent) {
  const { accounts } = await w.features['standard:connect'].connect(silent ? { silent: true } : undefined)
  const acc = accounts.find((a) => a.chains.includes(CHAIN)) ?? accounts[0]
  if (!acc) throw new Error(`${w.name} returned no Solana account`)
  setAccount(w, acc)
  w.features['standard:events']?.on('change', ({ accounts: next }) => {
    if (!next || wallet !== w) return
    setAccount(w, next[0] ?? null)
    refresh()
  })
  safe(() => localStorage.setItem(WALLET_KEY, w.name))
}

export async function connectWallet(w) {
  await connectWith(w, false)
  state.connectOpen = false
  refresh()
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

// kind: deposit | withdraw | borrow | repay. Returns the confirmed signature.
export async function sendKaminoAction(kind, { market, token, amount, all }) {
  if (!wallet || !account) throw new Error('Connect a Solana wallet to continue.')
  const { execute } = await kamino()
  return execute(kind, { wallet, account, market, token, amount, all })
}

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

// Lazy Analytics data (klend-sdk).
export const loadAnalytics = async (m, tokens) => (await kamino()).loadAnalytics(m, tokens)

let started = false
export function start() {
  if (started) return
  started = true
  scanWallets()
  getWallets().on('register', scanWallets)
  eagerConnect().finally(refresh)
  setInterval(refresh, 60_000)
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
          return false
        }
      }
      tx.status = 'success'
      refresh()
      return true
    },
  }
}
