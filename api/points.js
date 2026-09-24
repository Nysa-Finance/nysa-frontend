// GET /api/points — Farm Points leaderboard as CSV (address,cumulative_points,last_supplied_usd,last_snapshot_ts).
// State lives in a private Vercel Blob written by /api/points-snapshot.
import { get } from '@vercel/blob'

export const POINTS_BLOB = 'farm-points/points_state.csv'
// Previous leaderboard: seeds the first snapshot, and is served until our own state exists.
export const SEED_URL = process.env.POINTS_SEED_URL ?? 'https://app.nysa.finance/api/points'
const EMPTY = 'address,cumulative_points,last_supplied_usd,last_snapshot_ts\n'

export async function readPoints() {
  const blob = await get(POINTS_BLOB, { access: 'private', useCache: false })
  return blob ? new Response(blob.stream).text() : null
}

export default async function handler(req, res) {
  try {
    let why = 'blob empty'
    const own = await readPoints().catch((e) => ((why = e.message), console.warn('[points] no blob state:', e.message), null))
    // Never proxy to ourselves (if this app is the one deployed at the seed URL).
    const seed = !own && new URL(SEED_URL).host !== req.headers.host
      ? await fetch(SEED_URL).then((r) => (r.ok ? r.text() : null)).catch(() => null)
      : null
    const csv = own ?? seed ?? EMPTY
    res.setHeader('x-points-source', own ? 'blob' : `${seed ? 'seed' : 'empty'} (${why})`.slice(0, 200).replace(/[^\x20-\x7e]/g, ''))
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600')
    res.end(csv)
  } catch (e) {
    console.error('[points] read failed', e)
    res.statusCode = 500
    res.end('Could not read Farm Points')
  }
}
