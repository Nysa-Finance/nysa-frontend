import { DAY } from './finance.js'

export function parsePoints(csv) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return { rows: [], updatedTs: 0 }
  const head = lines[0].split(',').map((h) => h.trim())
  const col = (cells, k) => cells[head.indexOf(k)]?.trim()
  const rows = lines
    .slice(1)
    .map((l) => {
      const c = l.split(',')
      return {
        address: col(c, 'address'),
        points: Number(col(c, 'cumulative_points')),
        supplied: Number(col(c, 'last_supplied_usd')),
        ts: Number(col(c, 'last_snapshot_ts')),
      }
    })
    .filter((r) => r.address && Number.isFinite(r.points))
    .sort((a, b) => b.points - a.points || a.address.localeCompare(b.address))
    .map((r, i) => ({ ...r, rank: i + 1 }))
  return { rows, updatedTs: Math.max(0, ...rows.map((r) => r.ts || 0)) }
}

// Points accrue on the lower of the balances at the previous snapshot and now: depositing just before a snapshot and
// withdrawing right after earns nothing.
export function snapshotPoints(prev, balances, nowSec) {
  const rows = new Map(
    prev.map((r) => {
      const days = Number.isFinite(r.ts) ? Math.max(nowSec - r.ts, 0) / DAY : 0
      const now = balances.get(r.address) ?? 0
      return [
        r.address,
        { address: r.address, points: r.points + Math.min(r.supplied || 0, now) * days, supplied: now, ts: nowSec },
      ]
    }),
  )
  for (const [address, usd] of balances)
    if (!rows.has(address)) rows.set(address, { address, points: 0, supplied: usd, ts: nowSec })
  return [...rows.values()]
}

export const pointsCsv = (rows) =>
  [
    'address,cumulative_points,last_supplied_usd,last_snapshot_ts',
    ...rows.map((r) => `${r.address},${r.points},${r.supplied},${r.ts}`),
  ].join('\n') + '\n'
