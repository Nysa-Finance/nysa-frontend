// GET /api/apy-history — per-token daily reserve history recorded by /api/points-snapshot:
// { tokens: { [token_id]: { inception, points: [{ ts, rate, supplyApy, borrowApy, utilization }] } } }
import { readBlob } from './_storage.js'

export const HISTORY_BLOB = 'market-history/history.json'

export default async function handler(req, res) {
  try {
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600')
    res.end((await readBlob(HISTORY_BLOB)) ?? '{"tokens":{}}')
  } catch (e) {
    console.error('[apy-history] read failed', e)
    res.statusCode = 500
    res.end('{"error":"Could not read APY history"}')
  }
}
