// GET /api/points — Farm Points leaderboard as CSV (address,cumulative_points,last_supplied_usd,last_snapshot_ts).
// State is written by /api/points-snapshot (storage: see _storage.js).
import { readBlob } from './_storage.js'

export const POINTS_BLOB = 'farm-points/points_state.csv'
const EMPTY = 'address,cumulative_points,last_supplied_usd,last_snapshot_ts\n'

export const readPoints = () => readBlob(POINTS_BLOB)

export default async function handler(req, res) {
  try {
    const csv = (await readPoints()) ?? EMPTY
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600')
    res.end(csv)
  } catch (e) {
    console.error('[points] read failed', e)
    res.statusCode = 500
    res.end('Could not read Farm Points')
  }
}
