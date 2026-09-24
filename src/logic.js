// Pure helpers (formatters + lending math), no Vue — covered by logic.test.js.

const ok = (v) => typeof v === 'number' && Number.isFinite(v)

export const pct = (v, d = 2) => (ok(v) ? `${v.toFixed(d)}%` : '—')
export const usd = (v) => {
  if (!ok(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K'
  return '$' + v.toFixed(2)
}
export const usdFull = (v) =>
  ok(v) ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'
export const amt = (v, d = 4) => (ok(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d }) : '—')
export const compact = (v, unit) => {
  if (!ok(v)) return '—'
  const a = Math.abs(v)
  const n = a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v.toFixed(0)
  return unit ? `${n} ${unit}` : n
}
export const short = (s, a = 4, b = 4) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s)
export const num = (s) => {
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Piecewise-linear borrow APR (%) at utilization u (%), from Kamino curve points.
export function borrowRateAt(points, u) {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    if (u <= x1) return y0 + ((y1 - y0) * (u - x0)) / (x1 - x0)
  }
  return points.at(-1)[1]
}
export const supplyRateAt = (irm, u) => borrowRateAt(irm.points, u) * (u / 100) * (1 - irm.fee)

// Borrow capacity in loan-token units.
// collateral: [{usd, ltv}] (ltv in %), debtUsd: existing debt, price: loan token price, liquidity: vault cash.
export function borrowCapacity(collateral, debtUsd, price, liquidity) {
  if (price <= 0) return 0
  const limit = collateral.reduce((s, c) => s + c.usd * (c.ltv / 100), 0)
  return Math.min(Math.max(limit - debtUsd, 0) / price, liquidity)
}

// Weighted max LTV (%) across collateral.
export function weightedLtv(collateral) {
  const total = collateral.reduce((s, c) => s + c.usd, 0)
  return total <= 0 ? 0 : collateral.reduce((s, c) => s + c.usd * c.ltv, 0) / total
}

// Health factor = liquidation-weighted collateral / debt.
export const healthFactor = (collUsd, liqLtv, debtUsd) => (debtUsd > 0 ? (collUsd * liqLtv) / 100 / debtUsd : Infinity)

// Parse the Farm Points CSV (address,cumulative_points,last_supplied_usd,last_snapshot_ts).
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

export function ago(ts, now = Date.now()) {
  if (!ts) return 'unknown'
  const s = Math.floor(now / 1000 - ts)
  if (s < 90) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}
