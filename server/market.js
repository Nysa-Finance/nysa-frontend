import { createRequire } from 'node:module'
import {
  KaminoMarket, LendingMarket, getSingleReserve, getCurrentLedgerInstant, DEFAULT_RECENT_SLOT_DURATION_MS,
} from '@kamino-finance/klend-sdk'
import { address } from '@solana/kit'
import { LIVE, tokensOf } from '../src/config.js'
import { rewardApr, short } from '../src/logic.js'
import { rpc, NONE, LOCAL_FORK } from './rpc.js'
import { createLatestReadPublisher, createRefresher } from './refresh.js'
import { readVaults } from './vault.js'

const require = createRequire(import.meta.url)
const { Farms, fetchFarmState } = require('@kamino-finance/farms-sdk')

export const REFRESH_MS = 60_000
const SOON_MS = 2_000
const SOON_GAP_MS = 10_000
export const num = (v) => (v == null ? 0 : typeof v === 'number' ? v : v.toNumber())
export const farms = new Farms(rpc)

// Only the reserves in config.js, by address: KaminoMarket.load() uses getProgramAccounts over the whole program,
// which many RPC plans refuse (Alchemy free: 429).
export async function loadMarket(rpcClient, m) {
  const marketAddress = address(m.kaminoMarket)
  const [state, ...reserves] = await Promise.all([
    LendingMarket.fetch(rpcClient, marketAddress),
    ...tokensOf(m).map((t) => getSingleReserve(address(m.reserves[t.token_id]), rpcClient, DEFAULT_RECENT_SLOT_DURATION_MS)),
  ])
  if (!state) throw new Error(`Kamino market ${m.kaminoMarket} not found`)
  return KaminoMarket.loadWithReserves(rpcClient, state, new Map(reserves.map((r) => [r.address, r])), marketAddress, DEFAULT_RECENT_SLOT_DURATION_MS)
}

export function reserveOf(market, t) {
  const m = LIVE.find((x) => x.kaminoMarket === String(market.getAddress()))
  const r = m?.reserves[t.token_id] && market.getReserveByAddress(address(m.reserves[t.token_id]))
  if (!r) throw new Error(`The Kamino market has no ${t.name} reserve`)
  return r
}

// Risk parameters and the rate curve come from chain too, so governance changes show up without touching config.js.
function reserveMetrics(m, t, r, now) {
  const f = num(r.getMintFactor()) || 1
  const price = num(r.getOracleMarketPrice())
  const supplied = num(r.getTotalSupply()) / f
  const borrowed = num(r.getBorrowedAmount()) / f
  const s = r.stats
  const scope = r.state.config.tokenInfo.scopeConfiguration
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
    minDiscount: s.minLiquidationBonus * 100,
    supplyCap: num(s.reserveDepositLimit) / f,
    borrowCap: num(s.reserveBorrowLimit) / f,
    irm: { points: s.borrowCurve.map(([u, rate]) => [u * 100, rate * 100]), fee: s.protocolTakeRate },
    oracleTs: Number(r.tokenOraclePrice?.timestamp ?? 0),
    priceFeed: String(scope.priceFeed),
    feedNote: `Scope · index ${scope.priceChain.filter((i) => i !== 65535).join(' → ')}`, // 65535 = unused hop
    maxAge: Number(r.state.config.tokenInfo.maxAgePriceSeconds),
  }
}

// APR, not APY: rewards don't compound. The farm stakes cTokens, converted here to liquidity and USD.
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
    reserves[m.id] = {}
    rewards[m.id] = {}
    const market = await loadMarket(rpc, m)
    const farmStates = new Map()
    const tokens = tokensOf(m)
    for (const t of tokens) {
      const r = reserveOf(market, t)
      reserves[m.id][t.token_id] = reserveMetrics(m, t, r, now)
      if (String(r.state.farmCollateral) === NONE) continue
      const { data: farm } = await fetchFarmState(rpc, r.state.farmCollateral)
      farmStates.set(String(r.state.farmCollateral), farm)
      const rw = farmRewards(tokens, t, r, farm, market)
      if (rw) rewards[m.id][t.token_id] = rw
    }
    live.set(m.id, { market, now, farms: farmStates })
  }
  const vaults = await readVaults(new Map([...live.values()].map((l) => [String(l.market.getAddress()), l.market])), now)
  return { live, vaults: vaults.live, snapshot: { updatedAt: Date.now(), slot: Number(now.slot), blockTime: Number(now.blockTime), localFork: LOCAL_FORK, reserves, rewards, vaults: vaults.views } }
}

let live = new Map()
let liveVaults = new Map()
let snapshot = null
const listeners = new Set()

export const getSnapshot = () => snapshot
export const onSnapshot = (fn) => listeners.add(fn)

function publishRead(r) {
  live = r.live
  liveVaults = r.vaults
  snapshot = r.snapshot
  for (const fn of listeners) fn(snapshot)
}

export function getLive(m) {
  const l = live.get(m.id)
  if (!l) throw new Error('Market data is still loading, try again in a few seconds')
  return l
}
export function getVault(id) {
  const v = liveVaults.get(id)
  if (!v) throw new Error('Vault data is still loading, try again in a few seconds')
  return v
}

// On failure the previous data stays served and the next tick retries.
const publishLatestRead = createLatestReadPublisher(publishRead)
const readAndPublish = () => publishLatestRead(readAll)
const refresher = createRefresher(() => readAndPublish()
  .catch((e) => console.error('[market] refresh failed', e)), { every: REFRESH_MS, soon: SOON_MS, minGap: SOON_GAP_MS })

export const refreshMarket = refresher.run
export async function refreshMarketForExecution() {
  const refreshed = await readAndPublish()
  return refreshed.snapshot
}
export const refreshSoon = refresher.soon
