// Live market cache: every LIVE Kamino market (reserves, oracle prices, reward farms) is read once per REFRESH_MS,
// and right after a transaction confirms, then shared by every visitor (pushed over /api/events).
// Accounts, transactions and analytics are computed against this cache instead of re-reading the market each time.
import { createRequire } from 'node:module'
import {
  KaminoMarket, LendingMarket, getSingleReserve, getCurrentLedgerInstant, DEFAULT_RECENT_SLOT_DURATION_MS,
} from '@kamino-finance/klend-sdk'
import { address } from '@solana/kit'
import { LIVE, tokensOf } from '../src/config.js'
import { rewardApr, short } from '../src/logic.js'
import { rpc } from './rpc.js'

const require = createRequire(import.meta.url)
const { Farms, fetchFarmState } = require('@kamino-finance/farms-sdk')

export const REFRESH_MS = 60_000 // how stale market data may get without activity; confirmed txs refresh sooner
export const NONE = '11111111111111111111111111111111'
export const num = (v) => (v == null ? 0 : typeof v === 'number' ? v : v.toNumber())
export const farms = new Farms(rpc)

// Load a market with only the reserves listed in config.js, fetched by address. KaminoMarket.load() discovers
// reserves with getProgramAccounts over the whole Kamino program, which many RPC plans refuse (Alchemy free: 429).
export async function loadMarket(rpcClient, m) {
  const marketAddress = address(m.kaminoMarket)
  const [state, ...reserves] = await Promise.all([
    LendingMarket.fetch(rpcClient, marketAddress),
    ...tokensOf(m).map((t) => getSingleReserve(address(t.reserve), rpcClient, DEFAULT_RECENT_SLOT_DURATION_MS)),
  ])
  if (!state) throw new Error(`Kamino market ${m.kaminoMarket} not found`)
  return KaminoMarket.loadWithReserves(rpcClient, state, new Map(reserves.map((r) => [r.address, r])), marketAddress, DEFAULT_RECENT_SLOT_DURATION_MS)
}

export function reserveOf(market, t) {
  const r = market.getReserveByAddress(address(t.reserve))
  if (!r) throw new Error(`The Kamino market has no ${t.name} reserve`)
  return r
}

// Everything the UI shows about a reserve, at the current block. Risk parameters and the rate curve come from chain
// too, so governance changes (Market Updates) show up without touching config.js.
function reserveMetrics(m, t, r, now) {
  const f = num(r.getMintFactor()) || 1
  const price = num(r.getOracleMarketPrice())
  const supplied = num(r.getTotalSupply()) / f
  const borrowed = num(r.getBorrowedAmount()) / f
  const s = r.stats
  return {
    supplyAPR: r.totalSupplyAPY(now) * 100,
    borrowAPR: m.loans.includes(t.token_id) ? r.totalBorrowAPY(now) * 100 : null,
    totalSupplied: supplied,
    totalBorrowed: borrowed,
    supplyUsd: supplied * price,
    borrowUsd: borrowed * price,
    utilization: r.calculateUtilizationRatio() * 100,
    availableLiquidity: num(r.getLiquidityAvailableAmount()) / f,
    price,
    maxLtv: s.loanToValue * 100,
    liqLtv: s.liquidationThreshold * 100,
    maxDiscount: s.maxLiquidationBonus * 100,
    supplyCap: num(s.reserveDepositLimit) / f,
    borrowCap: num(s.reserveBorrowLimit) / f,
    irm: { points: s.borrowCurve.map(([u, rate]) => [u * 100, rate * 100]), fee: s.protocolTakeRate },
    oracleTs: Number(r.tokenOraclePrice?.timestamp ?? 0),
    maxAge: Number(r.state.config.tokenInfo.maxAgePriceSeconds),
  }
}

// Supply rewards from the reserve's collateral farm, as APR (rewards don't compound): yearly emission value over the
// staked value. The farm stakes each obligation's collateral (cTokens), converted here to liquidity and USD.
function farmRewards(tokens, t, r, farm, market) {
  const stakedUsd = Number(farm.totalStakedAmount) / 10 ** t.decimals / num(r.getCollateralExchangeRate()) * num(r.getOracleMarketPrice())
  const rewards = []
  for (const info of farm.rewardInfos) {
    const mint = String(info.token.mint)
    const perSecond = mint === NONE || info.rewardsAvailable === 0n ? 0 : num(farms.getRewardPerTimeUnitSecond(info))
    if (perSecond <= 0) continue
    const rt = tokens.find((x) => x.mint === mint)
    const price = rt ? num(reserveOf(market, rt).getOracleMarketPrice()) : null
    rewards.push({
      symbol: rt?.name ?? short(mint),
      apr: price == null ? 0 : rewardApr(perSecond, price, stakedUsd),
      perDay: perSecond * 86400,
      runwayDays: Number(info.rewardsAvailable) / 10 ** Number(info.token.decimals) / perSecond / 86400,
    })
  }
  return rewards.length ? { apr: rewards.reduce((s, x) => s + x.apr, 0), rewards } : null
}

async function readAll() {
  const now = await getCurrentLedgerInstant(rpc)
  const live = new Map(), reserves = {}, rewards = {}
  for (const m of LIVE) {
    const market = await loadMarket(rpc, m)
    const farmStates = new Map() // farm address -> FarmState
    const tokens = tokensOf(m)
    for (const t of tokens) {
      const r = reserveOf(market, t)
      reserves[t.token_id] = reserveMetrics(m, t, r, now)
      if (String(r.state.farmCollateral) === NONE) continue
      const { data: farm } = await fetchFarmState(rpc, r.state.farmCollateral)
      farmStates.set(String(r.state.farmCollateral), farm)
      const rw = farmRewards(tokens, t, r, farm, market)
      if (rw) rewards[t.token_id] = rw
    }
    live.set(m.id, { market, now, farms: farmStates })
  }
  return { live, snapshot: { updatedAt: Date.now(), slot: Number(now.slot), blockTime: Number(now.blockTime), reserves, rewards } }
}

let live = new Map()
let snapshot = null // the JSON the browser gets (/api/market, /api/events)
const listeners = new Set()
let timer = null, inflight = null

export const getSnapshot = () => snapshot
export const onSnapshot = (fn) => listeners.add(fn)

// KaminoMarket + ledger instant + farm states of a market, as of the last refresh.
export function getLive(m) {
  const l = live.get(m.id)
  if (!l) throw new Error('Market data is still loading, try again in a few seconds')
  return l
}

function schedule(ms) {
  clearTimeout(timer)
  timer = setTimeout(refreshMarket, ms)
  timer.unref?.()
}

// Concurrent callers share one read. On failure the previous data stays served and the next tick retries.
export function refreshMarket() {
  inflight ??= readAll()
    .then((r) => {
      live = r.live
      snapshot = r.snapshot
      for (const fn of listeners) fn(snapshot)
    })
    .catch((e) => console.error('[market] refresh failed', e))
    .finally(() => { inflight = null; schedule(REFRESH_MS) })
  return inflight
}

// After a confirmed transaction: refresh shortly (debounced), so balances and APYs update for everyone.
export const refreshSoon = () => schedule(2_000)
