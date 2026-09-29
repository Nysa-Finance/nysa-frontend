// Load a Kamino market with only the reserves we list in config.js, fetched by address.
// KaminoMarket.load() discovers reserves with getProgramAccounts over the whole Kamino program, which many RPC plans
// reject or bill heavily (Alchemy free: 429 on the first call). This is also how the original Nysa app loads it.
import { KaminoMarket, LendingMarket, getSingleReserve, DEFAULT_RECENT_SLOT_DURATION_MS } from '@kamino-finance/klend-sdk'
import { address } from '@solana/kit'
import { tokensOf } from './config.js'

export async function loadMarket(rpc, m) {
  const marketAddress = address(m.kaminoMarket)
  const [state, ...reserves] = await Promise.all([
    LendingMarket.fetch(rpc, marketAddress),
    ...tokensOf(m).map((t) => getSingleReserve(address(t.reserve), rpc, DEFAULT_RECENT_SLOT_DURATION_MS)),
  ])
  if (!state) throw new Error(`Kamino market ${m.kaminoMarket} not found`)
  return KaminoMarket.loadWithReserves(rpc, state, new Map(reserves.map((r) => [r.address, r])), marketAddress, DEFAULT_RECENT_SLOT_DURATION_MS)
}
