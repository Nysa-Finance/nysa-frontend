// The backend's single Solana RPC client. The browser never talks to the RPC: every on-chain read and every
// transaction build goes through here, so the RPC key stays private and usage doesn't grow with each visitor.
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit'

export const RPC_URL = process.env.SOLANA_RPC || process.env.VITE_SOLANA_RPC // VITE_ name kept for old .env files

const calls = [] // request timestamps of the last hour, for /api/health
export function rpcCallsLastHour() {
  const hourAgo = Date.now() - 3_600_000
  while (calls.length && calls[0] < hourAgo) calls.shift()
  return calls.length
}

// Retries HTTP 429 with exponential backoff: rate-limited plans throttle the bursts klend-sdk makes.
export function createRpc(url = RPC_URL) {
  const transport = createDefaultRpcTransport({ url })
  return createSolanaRpcFromTransport(async (req) => {
    for (let i = 0; ; i++) {
      calls.push(Date.now())
      try { return await transport(req) } catch (e) {
        if (i >= 5 || e?.context?.statusCode !== 429) throw e
        await new Promise((r) => setTimeout(r, 500 * 2 ** i))
      }
    }
  })
}

export const rpc = RPC_URL ? createRpc() : null
