// Kamino Earn vaults (kVaults) curated by Nysa, e.g. "RWA Prime": a vault takes one token (USDC) and allocates it to
// reserves of one or more Kamino markets, its exposure. Read with the market cache (market.js), every refresh.
// Which markets a vault is exposed to comes from its on-chain allocation, never from config.
import { createRequire } from 'node:module'
import { KaminoVaultClient, KaminoVault, getSingleReserve, DEFAULT_RECENT_SLOT_DURATION_MS } from '@kamino-finance/klend-sdk'
import { address } from '@solana/kit'
import Decimal from 'decimal.js'
import { LIVE, VAULTS, TOKENS, tokensOf } from '../src/config.js'
import { rpc } from './rpc.js'

const require = createRequire(import.meta.url)
const { fetchFarmState } = require('@kamino-finance/farms-sdk')

export const vaultClient = new KaminoVaultClient(rpc, DEFAULT_RECENT_SLOT_DURATION_MS)
const NONE = '11111111111111111111111111111111'
const SECONDS_PER_YEAR = 365.242199 * 24 * 60 * 60 // as klend-sdk
const U64_MAX = '18446744073709551615' // an allocation cap of u64::MAX = uncapped
const n = (d) => (d == null ? 0 : Number(d.toString()))
const tokenByReserve = new Map(Object.values(TOKENS).map((t) => [t.reserve, t]))

// One vault: its state and the reserves it allocates to (taken from the markets already loaded, or fetched when the
// vault uses a reserve outside them), plus the numbers the UI shows. `markets`: market address -> KaminoMarket.
export async function readVault(v, markets, now, reserveMetrics) {
  const kv = new KaminoVault(rpc, address(v.address), DEFAULT_RECENT_SLOT_DURATION_MS)
  const state = await kv.getState()
  const reserveAddrs = vaultClient.getVaultReserves(state)
  const loaded = [...markets.values()].flatMap((m) => [...m.reserves.values()])
  const reserves = new Map(await Promise.all(reserveAddrs.map(async (a) => [a, loaded.find((r) => r.address === a) ?? (await getSingleReserve(a, rpc, DEFAULT_RECENT_SLOT_DURATION_MS))])))
  const [holdings, perShare, apy, target] = await Promise.all([
    vaultClient.getVaultHoldings(state, now, reserves, now),
    vaultClient.getTokensPerShareSingleVault(state, now, reserves, now),
    vaultClient.getVaultActualAPY(state, now, reserves), // invested share × each reserve's supply APY, like Kamino's
    // Where the vault should be: weights (plus the unallocated weight, a liquidity buffer) and caps, as the on-chain
    // invest computes them. Kamino's bot syncs the vault to it about every 15 minutes.
    vaultClient.getVaultComputedReservesAllocation(state, now, reserves, now),
  ])
  const token = Object.values(TOKENS).find((t) => t.mint === String(state.tokenMint))
  const price = token ? reserveMetrics[token.token_id]?.price ?? 1 : 1
  const dec = Number(state.tokenMintDecimals)
  // Auto-compounding rewards: a fixed amount of the vault's token per second, paid into the vault (so into its share
  // value) while the reward balance lasts. The program moves what has vested into the vault before any deposit,
  // withdrawal or invest, so it already belongs to depositors: counted in the vault's value and share value here.
  const ri = state.rewardInfo
  const perSecond = Number(ri.rewardPerSecond) / 10 ** dec
  const vested = Number(ri.lastIssuanceTs) > 0
    ? Math.min(Math.max(Number(now.blockTime) - Number(ri.lastIssuanceTs), 0) * perSecond, Number(ri.rewardsAvailable) / 10 ** dec) : 0
  const rewardsLeft = Number(ri.rewardsAvailable) / 10 ** dec - vested
  const total = n(holdings.totalAUMIncludingFees) - n(holdings.pendingFees) + vested
  const shares = Number(state.sharesIssued) / 10 ** Number(state.sharesMintDecimals)
  const perShareNow = shares > 0 ? new Decimal(total).div(shares) : perShare
  const weights = new Map(vaultClient.getVaultAllocations(state))
  const caps = new Map(state.vaultAllocationStrategy.map((x) => [String(x.reserve), String(x.tokenAllocationCap)]))

  // Exposure: each allocated reserve, its market (a LIVE market when it is one of ours) and that market's collateral.
  const allocations = reserveAddrs.map((a) => {
    const r = reserves.get(a)
    const m = LIVE.find((x) => x.kaminoMarket === String(r.state.lendingMarket))
    const invested = n(holdings.investedInReserves.get(a))
    return {
      reserve: String(a),
      market: String(r.state.lendingMarket),
      marketId: m?.id ?? null,
      marketName: m?.name ?? null,
      collateral: m?.collateral ?? [],
      weight: Number(weights.get(a)?.targetWeight ?? 0),
      cap: caps.get(String(a)) === U64_MAX ? null : Number(caps.get(String(a))) / 10 ** dec, // tokens; null = uncapped
      invested,
      share: total > 0 ? (invested / total) * 100 : 0,
      targetShare: total > 0 ? (n(target.targetReservesAllocation.get(a)) / total) * 100 : 0,
      supplyApy: (tokenByReserve.get(String(a)) && reserveMetrics[tokenByReserve.get(String(a)).token_id]?.supplyAPR) ?? r.totalSupplyAPY(now) * 100,
    }
  })
  const exposure = LIVE.filter((m) => allocations.some((x) => x.market === m.kaminoMarket))
  // Utilization as Kamino shows it: the part of the vault's tokens that borrowers hold (uninvested tokens count as idle).
  const borrowed = reserveAddrs.reduce((s, a) => s + n(holdings.investedInReserves.get(a)) * reserves.get(a).calculateUtilizationRatio(), 0)
  // Rewards shown as APY on top of the supply APY, as Kamino does.
  // = klend-sdk's calculateVaultRewardsAprApy (not exported): yearly rewards / vault value, linear (a fixed amount, not a rate).
  const rewardsApy = rewardsLeft > 0 && total > 0 ? ((perSecond * SECONDS_PER_YEAR) / total) * 100 : 0
  // Oracles behind the vault's token price in its reserves (Scope feeds).
  const oracles = [...new Set(reserveAddrs.map((a) => String(reserves.get(a).state.config.tokenInfo.scopeConfiguration.priceFeed)))]
  // The vault farm, where Kamino's UI stakes deposited shares: positions and withdrawals count (and unstake) them.
  const farmAddr = String(state.vaultFarm)
  const farm = farmAddr === NONE ? null : { address: farmAddr, state: (await fetchFarmState(rpc, address(farmAddr))).data }
  const live = { kv: KaminoVault.loadWithClientAndState(vaultClient, address(v.address), state), state, reserves, perShare: perShareNow, now, farm }
  return {
    live,
    view: {
      id: v.id,
      address: v.address,
      name: Buffer.from(state.name).toString('utf8').replace(/\0+$/, '') || v.name,
      tokenId: token?.token_id ?? null,
      supplyApy: n(apy.netAPY) * 100,
      rewardsApy,
      apy: n(apy.netAPY) * 100 + rewardsApy,
      rewards: rewardsApy > 0 ? { symbol: token?.name ?? '', perWeek: perSecond * 604_800, left: rewardsLeft, daysLeft: rewardsLeft / perSecond / 86_400 } : null,
      borrowed,
      utilization: total > 0 ? (borrowed / total) * 100 : 0,
      tokensPerShare: n(perShareNow),
      total,
      totalUsd: total * price,
      available: n(holdings.available), // in the vault, uninvested (vested rewards not in it yet: they count in `total` only)
      invested: n(holdings.invested),
      bufferTarget: n(target.targetUnallocatedAmount), // tokens kept uninvested to serve withdrawals at once
      depositCap: Number(state.depositCap) / 10 ** Number(state.tokenMintDecimals),
      minDeposit: Number(state.minDepositAmount) / 10 ** Number(state.tokenMintDecimals),
      // Charged on withdrawals and left in the vault (set on-chain by the curator).
      withdrawPenaltyPct: Number(state.withdrawalPenaltyBps) / 100,
      withdrawPenaltyFixed: Number(state.withdrawalPenaltyLamports) / 10 ** Number(state.tokenMintDecimals),
      performanceFee: Number(state.performanceFeeBps) / 100,
      managementFee: Number(state.managementFeeBps) / 100,
      sharesMint: String(state.sharesMint),
      sharesDecimals: Number(state.sharesMintDecimals),
      admin: String(state.vaultAdminAuthority),
      allocationAdmin: String(state.allocationAdmin),
      oracles,
      allocations,
      // Markets the vault is exposed to: their ids, collateral tokens, and everything supplied in them (collateral +
      // loan asset), which the Earn table shows as Total Supply.
      exposureMarkets: exposure.map((m) => m.id),
      exposureTokens: [...new Set(exposure.flatMap((m) => m.collateral))],
      exposureSupplyUsd: exposure.flatMap(tokensOf).reduce((s, t) => s + (reserveMetrics[t.token_id]?.supplyUsd ?? 0), 0),
    },
  }
}

// Every vault in config; a vault that fails to read is left out (logged) so the markets still load.
export async function readVaults(markets, now, reserveMetrics) {
  const live = new Map(), views = {}
  for (const v of VAULTS) {
    try {
      const r = await readVault(v, markets, now, reserveMetrics)
      live.set(v.id, r.live)
      views[v.id] = r.view
    } catch (e) { console.error('[vault] read failed', v.id, e?.message) }
  }
  return { live, views }
}
