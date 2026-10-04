// Positions for the Analytics page: every obligation in each LIVE market (addresses from the market index, read in one
// batch against the market cache), riskiest first. Cached for a minute and shared.
import { address } from '@solana/kit'
import { LIVE } from '../src/config.js'
import { getLive, num } from './market.js'
import { freshIndex } from './updates.js'

async function readPositions() {
  const index = await freshIndex()
  const out = []
  for (const m of LIVE) {
    const { market, now } = getLive(m)
    const addrs = index.obligations[m.kaminoMarket] ?? []
    for (const ob of addrs.length ? await market.getMultipleObligationsByAddress(addrs.map(address), now) : []) {
      if (!ob) continue
      const s = ob.refreshedStats
      const debt = num(s.userTotalBorrow)
      const deposits = num(s.userTotalDeposit)
      if (deposits <= 0 && debt <= 0) continue
      out.push({
        owner: String(ob.state.owner),
        deposits,
        debt,
        ltv: debt > 0 ? num(s.loanToValue) * 100 : 0,
        liqLtv: num(s.liquidationLtv) * 100 || 0,
        hf: debt > 0 ? num(s.borrowLiquidationLimit) / debt : null, // null = no debt (infinite health)
      })
    }
  }
  return out.sort((a, b) => (a.hf ?? Infinity) - (b.hf ?? Infinity) || b.deposits - a.deposits)
}

let cached = null, cachedAt = 0
export function getPositions() {
  if (!cached || Date.now() - cachedAt > 60_000) {
    cachedAt = Date.now()
    cached = readPositions().catch((e) => { cached = null; throw e })
  }
  return cached
}
