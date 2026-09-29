// Load a Kamino market with only the reserves we list in config.js, fetched by address.
// KaminoMarket.load() discovers reserves with getProgramAccounts over the whole Kamino program, which many RPC plans
// reject or bill heavily (Alchemy free: 429 on the first call). This is also how the original Nysa app loads it.
import { KaminoMarket, LendingMarket, getSingleReserve, DEFAULT_RECENT_SLOT_DURATION_MS } from '@kamino-finance/klend-sdk'
import { address, createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit'
import { tokensOf } from './config.js'

// Solana RPC client that retries HTTP 429 with exponential backoff: rate-limited plans (Alchemy free, QuickNode free)
// throttle the request bursts klend-sdk makes. Shared by the browser and the server functions.
export function createRpc(url) {
  const transport = createDefaultRpcTransport({ url })
  return createSolanaRpcFromTransport(async (req) => {
    for (let i = 0; ; i++) {
      try { return await transport(req) } catch (e) {
        if (i >= 5 || e?.context?.statusCode !== 429) throw e
        await new Promise((r) => setTimeout(r, 500 * 2 ** i))
      }
    }
  })
}

export async function loadMarket(rpc, m) {
  const marketAddress = address(m.kaminoMarket)
  const [state, ...reserves] = await Promise.all([
    LendingMarket.fetch(rpc, marketAddress),
    ...tokensOf(m).map((t) => getSingleReserve(address(t.reserve), rpc, DEFAULT_RECENT_SLOT_DURATION_MS)),
  ])
  if (!state) throw new Error(`Kamino market ${m.kaminoMarket} not found`)
  return KaminoMarket.loadWithReserves(rpc, state, new Map(reserves.map((r) => [r.address, r])), marketAddress, DEFAULT_RECENT_SLOT_DURATION_MS)
}
