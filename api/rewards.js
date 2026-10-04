// GET /api/rewards — supply rewards from each reserve's Kamino collateral farm, per token:
// { [token_id]: { apr, rewards: [{ symbol, apr, perDay, runwayDays }] } }. apr is in % and is an APR: rewards don't compound.
// Read on-chain (reserve + farm), at most once a minute and shared by concurrent requests (no CDN in front of the VPS).
import { createRequire } from 'node:module'
import { createRpc, loadMarket } from '../src/loadMarket.js'
import { LIVE, tokensOf } from '../src/config.js'
import { rewardApr, short } from '../src/logic.js'

const require = createRequire(import.meta.url)
const NONE = '11111111111111111111111111111111'

async function readRewards(rpc) {
  const { Farms, fetchFarmState } = require('@kamino-finance/farms-sdk')
  const farms = new Farms(rpc)
  const out = {}
  for (const m of LIVE) {
    const market = await loadMarket(rpc, m)
    const tokens = tokensOf(m)
    const reserveOf = (t) => market.getReserveByAddress(t.reserve)
    const priceOfMint = (mint) => { const t = tokens.find((x) => x.mint === mint); return t ? reserveOf(t).getOracleMarketPrice().toNumber() : null }
    for (const t of tokens) {
      const r = reserveOf(t)
      if (!r || String(r.state.farmCollateral) === NONE) continue
      const { data: farm } = await fetchFarmState(rpc, r.state.farmCollateral)
      // The farm stakes each obligation's collateral (cTokens): convert to liquidity, then to USD.
      const stakedUsd = Number(farm.totalStakedAmount) / 10 ** t.decimals / r.getCollateralExchangeRate().toNumber() * r.getOracleMarketPrice().toNumber()
      const rewards = []
      for (const info of farm.rewardInfos) {
        const mint = String(info.token.mint)
        const perSecond = mint === NONE || info.rewardsAvailable === 0n ? 0 : farms.getRewardPerTimeUnitSecond(info).toNumber()
        if (perSecond <= 0) continue
        const price = priceOfMint(mint)
        const left = Number(info.rewardsAvailable) / 10 ** Number(info.token.decimals)
        rewards.push({
          symbol: tokens.find((x) => x.mint === mint)?.name ?? short(mint),
          apr: price == null ? 0 : rewardApr(perSecond, price, stakedUsd),
          perDay: perSecond * 86400,
          runwayDays: left / perSecond / 86400,
        })
      }
      if (rewards.length) out[t.token_id] = { apr: rewards.reduce((s, x) => s + x.apr, 0), rewards }
    }
  }
  return out
}

let cached = null, cachedAt = 0
function freshRewards(rpcUrl) {
  if (!cached || Date.now() - cachedAt > 60_000) {
    cachedAt = Date.now()
    cached = readRewards(createRpc(rpcUrl)).catch((e) => { cached = null; throw e })
  }
  return cached
}

export default async function handler(req, res) {
  try {
    const rpcUrl = process.env.SOLANA_RPC || process.env.VITE_SOLANA_RPC
    if (!rpcUrl) throw new Error('SOLANA_RPC (or VITE_SOLANA_RPC) is not set')
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'public, max-age=60')
    res.end(JSON.stringify(await freshRewards(rpcUrl)))
  } catch (e) {
    console.error('[rewards] failed', e)
    res.statusCode = 500
    res.end('{"error":"Could not read rewards"}')
  }
}
