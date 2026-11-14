// The backend's single Solana RPC client. The browser never talks to the RPC: every on-chain read and every
// transaction build goes through here, so the RPC key stays private and usage doesn't grow with each visitor.
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit'

export const RPC_URL = process.env.SOLANA_RPC || process.env.VITE_SOLANA_RPC // VITE_ name kept for old .env files
export const isLoopbackRpc = (value) => {
  if (typeof value !== 'string') return false
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname.toLowerCase()) }
  catch { return false }
}
// A local fork (surfpool on localhost) for testing: the browser then has wallets only sign, and the server sends the
// transaction to the fork (a wallet would send it to mainnet). Never true in production, whose RPC isn't local.
export const LOCAL_FORK = isLoopbackRpc(RPC_URL)
// Used when RPC_URL fails (down, bad key, out of credits): rate-limited, but keeps the site live.
export const FALLBACK_RPC_URL = process.env.SOLANA_RPC_FALLBACK || 'https://api.mainnet-beta.solana.com'

const calls = [] // request timestamps of the last hour, for /api/health
export function rpcCallsLastHour() {
  const hourAgo = Date.now() - 3_600_000
  while (calls.length && calls[0] < hourAgo) calls.shift()
  return calls.length
}

export const NONE = '11111111111111111111111111111111' // the default (empty) Solana address: an unset field

// Retries HTTP 429 with exponential backoff: rate-limited plans throttle the bursts klend-sdk makes.
function withRetry(transport) {
  return async (req) => {
    for (let i = 0; ; i++) {
      calls.push(Date.now())
      try { return await transport(req) } catch (e) {
        if (i >= 5 || e?.context?.statusCode !== 429) throw e
        await new Promise((r) => setTimeout(r, 500 * 2 ** i))
      }
    }
  }
}

// Any request the main RPC fails (HTTP error, network, timeout; JSON-RPC errors are answers, not failures) goes to the
// fallback; the main one is tried again on the next request, so it takes over as soon as it is back.
export function createRpc(url) {
  const targetUrl = url ?? RPC_URL
  if (!targetUrl) throw new Error('SOLANA_RPC is not configured.')
  // A main RPC that hangs instead of failing would hold every read: give up on it after 20 s.
  const mainTransport = createDefaultRpcTransport({ url: targetUrl })
  const main = withRetry((req) => mainTransport({ ...req, signal: AbortSignal.any([req.signal, AbortSignal.timeout(20_000)].filter(Boolean)) }))
  // Explicit endpoints are used by the guarded local-fork verifier and must never fall back to Mainnet.
  if (url != null) return createSolanaRpcFromTransport(main)
  const fallback = withRetry(createDefaultRpcTransport({ url: FALLBACK_RPC_URL }))
  let warned = 0
  return createSolanaRpcFromTransport(async (req) => {
    try { return await main(req) } catch (e) {
      // Status or error name only, not the message: it can carry the URL, and the URL carries the key.
      if (Date.now() - warned > 600_000) { warned = Date.now(); console.warn('[rpc] main RPC failed, using fallback:', e?.context?.statusCode ?? e?.name) }
      return fallback(req)
    }
  })
}

export const rpc = RPC_URL ? createRpc() : null
