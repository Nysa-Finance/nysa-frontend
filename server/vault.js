// Kamino Earn vaults (kVaults) curated by Nysa, e.g. "RWA Prime": a vault takes one token (USDC) and allocates it to
// reserves of one or more Kamino markets, its exposure. Read with the market cache (market.js), every refresh.
// Which markets a vault is exposed to comes from its on-chain allocation, never from config.
import { KaminoVaultClient, KaminoVault, getSingleReserve, DEFAULT_RECENT_SLOT_DURATION_MS } from '@kamino-finance/klend-sdk'
import { address } from '@solana/kit'
import { LIVE, VAULTS, TOKENS, tokensOf } from '../src/config.js'
import { rpc } from './rpc.js'

export const vaultClient = new KaminoVaultClient(rpc, DEFAULT_RECENT_SLOT_DURATION_MS)
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
  const [holdings, perShare, apy] = await Promise.all([
    vaultClient.getVaultHoldings(state, now, reserves, now),
    vaultClient.getTokensPerShareSingleVault(state, now, reserves, now),
    vaultClient.getVaultTheoreticalAPY(state, now, reserves),
  ])
  const token = Object.values(TOKENS).find((t) => t.mint === String(state.tokenMint))
  const price = token ? reserveMetrics[token.token_id]?.price ?? 1 : 1
  const total = n(holdings.totalAUMIncludingFees) - n(holdings.pendingFees)
  const weights = new Map(vaultClient.getVaultAllocations(state))

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
      invested,
      share: total > 0 ? (invested / total) * 100 : 0,
      supplyApy: (tokenByReserve.get(String(a)) && reserveMetrics[tokenByReserve.get(String(a)).token_id]?.supplyAPR) ?? r.totalSupplyAPY(now) * 100,
    }
  })
  const exposure = LIVE.filter((m) => allocations.some((x) => x.market === m.kaminoMarket))
  const live = { kv: KaminoVault.loadWithClientAndState(vaultClient, address(v.address), state), state, reserves, perShare, now }
  return {
    live,
    view: {
      id: v.id,
      address: v.address,
      name: Buffer.from(state.name).toString('utf8').replace(/\0+$/, '') || v.name,
      tokenId: token?.token_id ?? null,
      apy: n(apy.netAPY) * 100,
      tokensPerShare: n(perShare),
      total,
      totalUsd: total * price,
      available: n(holdings.available),
      invested: n(holdings.invested),
      depositCap: Number(state.depositCap) / 10 ** Number(state.tokenMintDecimals),
      minDeposit: Number(state.minDepositAmount) / 10 ** Number(state.tokenMintDecimals),
      // Charged on withdrawals and left in the vault (set on-chain by the curator).
      withdrawPenaltyPct: Number(state.withdrawalPenaltyBps) / 100,
      withdrawPenaltyFixed: Number(state.withdrawalPenaltyLamports) / 10 ** Number(state.tokenMintDecimals),
      performanceFee: Number(state.performanceFeeBps) / 100,
      managementFee: Number(state.managementFeeBps) / 100,
      sharesMint: String(state.sharesMint),
      sharesDecimals: Number(state.sharesMintDecimals),
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
