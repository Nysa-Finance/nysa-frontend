// Which markets a vault is exposed to comes from its on-chain allocation, never from config.
import { createRequire } from 'node:module'
import { KaminoVaultClient, KaminoVault, getSingleReserve, DEFAULT_RECENT_SLOT_DURATION_MS } from '@kamino-finance/klend-sdk'
import { address } from '@solana/kit'
import Decimal from 'decimal.js'
import { LIVE, OTHER_MARKETS, VAULTS, TOKENS } from '../src/config.js'
import { rpc, NONE } from './rpc.js'

const require = createRequire(import.meta.url)
const { fetchFarmState } = require('@kamino-finance/farms-sdk')

export const vaultClient = new KaminoVaultClient(rpc, DEFAULT_RECENT_SLOT_DURATION_MS)
const SECONDS_PER_YEAR = 365.242199 * 24 * 60 * 60 // as klend-sdk
const U64_MAX = '18446744073709551615' // an allocation cap of u64::MAX = uncapped
const n = (d) => (d == null ? 0 : Number(d.toString()))

export async function readVault(v, markets, now) {
  const kv = new KaminoVault(rpc, address(v.address), DEFAULT_RECENT_SLOT_DURATION_MS)
  const state = await kv.getState()
  const reserveAddrs = vaultClient.getVaultReserves(state)
  const loaded = [...markets.values()].flatMap((m) => [...m.reserves.values()])
  const reserves = new Map(await Promise.all(reserveAddrs.map(async (a) => [a, loaded.find((r) => r.address === a) ?? (await getSingleReserve(a, rpc, DEFAULT_RECENT_SLOT_DURATION_MS))])))
  const [holdings, perShare, apy, target] = await Promise.all([
    vaultClient.getVaultHoldings(state, now, reserves, now),
    vaultClient.getTokensPerShareSingleVault(state, now, reserves, now),
    vaultClient.getVaultActualAPY(state, now, reserves), // like Kamino's
    // As the on-chain invest computes it; Kamino's bot syncs the vault to it about every 15 minutes.
    vaultClient.getVaultComputedReservesAllocation(state, now, reserves, now),
  ])
  const token = Object.values(TOKENS).find((t) => t.mint === String(state.tokenMint))
  // every reserve it allocates to holds that token
  const price = reserveAddrs.length ? n(reserves.get(reserveAddrs[0]).getOracleMarketPrice()) : 1
  const dec = Number(state.tokenMintDecimals)
  // Vested rewards already belong to depositors (the program moves them in before any deposit, withdrawal or invest),
  // so they count in the vault's value and share value.
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
  const ctokens = new Map(state.vaultAllocationStrategy.map((x) => [String(x.reserve), BigInt(String(x.ctokenAllocation))]))

  const allocations = reserveAddrs.map((a) => {
    const r = reserves.get(a)
    const m = LIVE.find((x) => x.kaminoMarket === String(r.state.lendingMarket))
    const known = m ?? OTHER_MARKETS.find((x) => x.kaminoMarket === String(r.state.lendingMarket))
    const invested = n(holdings.investedInReserves.get(a))
    const supply = BigInt(String(r.state.collateral.mintTotalSupply)), mine = ctokens.get(String(a)) ?? 0n
    const part = (raw) => (supply > 0n ? Number((raw * mine) / supply) / 10 ** dec : 0)
    return {
      reserve: String(a),
      market: String(r.state.lendingMarket),
      marketId: m?.id ?? null, // only Nysa markets have a page
      marketName: known?.name ?? null,
      collateral: known?.collateral ?? [],
      weight: Number(weights.get(a)?.targetWeight ?? 0),
      cap: caps.get(String(a)) === U64_MAX ? null : Number(caps.get(String(a))) / 10 ** dec, // null = uncapped
      invested,
      share: total > 0 ? (invested / total) * 100 : 0,
      targetShare: total > 0 ? (n(target.targetReservesAllocation.get(a)) / total) * 100 : 0,
      supplyApy: r.totalSupplyAPY(now) * 100,
      // as DefiLlama's adapter reads it (debt is Q60 fixed point)
      liquid: part(BigInt(String(r.state.liquidity.totalAvailableAmount))),
      lent: part(BigInt(String(r.state.liquidity.borrowedAmountSf)) >> 60n),
    }
  })
  // As Kamino shows it: uninvested tokens count as idle.
  const borrowed = reserveAddrs.reduce((s, a) => s + n(holdings.investedInReserves.get(a)) * reserves.get(a).calculateUtilizationRatio(), 0)
  // = klend-sdk's calculateVaultRewardsAprApy (not exported): linear, since it's a fixed amount, not a rate.
  const rewardsApy = rewardsLeft > 0 && total > 0 ? ((perSecond * SECONDS_PER_YEAR) / total) * 100 : 0
  const oracles = [...new Set(reserveAddrs.map((a) => String(reserves.get(a).state.config.tokenInfo.scopeConfiguration.priceFeed)))]
  // Kamino's UI stakes deposited shares in the vault farm: positions and withdrawals count (and unstake) them.
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
      price,
      totalUsd: total * price,
      available: n(holdings.available), // vested rewards aren't in it yet: they count in `total` only
      invested: n(holdings.invested),
      bufferTarget: n(target.targetUnallocatedAmount),
      depositCap: Number(state.depositCap) ? Number(state.depositCap) / 10 ** Number(state.tokenMintDecimals) : null, // 0 = uncapped
      minDeposit: Number(state.minDepositAmount) / 10 ** Number(state.tokenMintDecimals),
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
      exposureTokens: [...new Set(allocations.flatMap((x) => x.collateral))],
    },
  }
}

// A vault that fails to read is left out (logged) so the markets still load.
export async function readVaults(markets, now) {
  const live = new Map(), views = {}
  for (const v of VAULTS) {
    try {
      const r = await readVault(v, markets, now)
      live.set(v.id, r.live)
      views[v.id] = r.view
    } catch (e) { console.error('[vault] read failed', v.id, e?.message) }
  }
  return { live, views }
}
