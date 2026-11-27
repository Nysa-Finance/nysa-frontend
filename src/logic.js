const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const DAY = 86400
// Absorbs float error before rounding to a digit: 1.15 * 100 is 114.999…, which must floor to 115.
const EPSILON = 1e-9

// Thousands get separators (an incentive APY on a tiny vault can reach 11,214.30%).
export function pct(value, decimals = 2) {
  if (!isNumber(value)) return '—'
  if (Math.abs(value) < 1000) return `${value.toFixed(decimals)}%`
  return `${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`
}

export function usd(value) {
  if (!isNumber(value)) return '—'
  const size = Math.abs(value)
  if (size >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B'
  if (size >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M'
  if (size >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K'
  return '$' + value.toFixed(2)
}

export function usdFull(value) {
  if (!isNumber(value)) return '—'
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Truncated, never rounded up: a max or balance shown is one that can be typed back and sent (9.99996 reads 9.9999,
// not 10). Like Aave, amounts below the last shown digit read "< 0.0001", not a misleading 0.
export function amt(value, decimals = 4) {
  if (!isNumber(value)) return '—'
  const smallest = 10 ** -decimals
  if (value > 0 && value < smallest) return `< ${smallest.toFixed(decimals)}`
  return value.toLocaleString('en-US', { maximumFractionDigits: decimals, roundingMode: 'trunc' })
}

export function compact(value, unit) {
  if (!isNumber(value)) return '—'
  const text = compactNumber(value)
  return unit ? `${text} ${unit}` : text
}

function compactNumber(value) {
  const size = Math.abs(value)
  if (size >= 1e6) return (value / 1e6).toFixed(1) + 'M'
  if (size >= 1e3) return (value / 1e3).toFixed(0) + 'K'
  return value.toFixed(0)
}

// "7xKX…sAsU": the first and last characters of an address.
export function short(text, head = 4, tail = 4) {
  if (!text || text.length <= head + tail + 1) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

// Applied to amount inputs as typed. The last "," or "." is the decimal point (phone keyboards type ","), shown as "."
// at once so "1,000" reads 1.000, never a silent 1; "1,000.5" and "1.000,5" read 1000.5. Digits past the token's
// decimals are dropped: the chain can't move them.
export function cleanAmount(input, decimals) {
  const text = String(input ?? '')
  const onlyDigits = (part) => part.replace(/\D/g, '')
  const decimalAt = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','))
  if (decimalAt < 0) return onlyDigits(text)
  const whole = onlyDigits(text.slice(0, decimalAt)) || '0'
  const fraction = onlyDigits(text.slice(decimalAt + 1)).slice(0, decimals)
  return `${whole}.${fraction}`
}

// "," or "." as the decimal separator; anything else is invalid → 0.
export function num(input) {
  const text = String(input ?? '')
    .trim()
    .replace(',', '.')
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function borrowRateAt(points, u) {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    if (u <= x1) return y0 + ((y1 - y0) * (u - x0)) / (x1 - x0)
  }
  return points.at(-1)[1]
}
export const supplyRateAt = (irm, u) => borrowRateAt(irm.points, u) * (u / 100) * (1 - irm.fee)

export function borrowCapacity(collateral, debtUsd, price, liquidity) {
  if (price <= 0) return 0
  const limit = collateral.reduce((s, c) => s + c.usd * (c.ltv / 100), 0)
  return Math.min(Math.max(limit - debtUsd, 0) / price, liquidity)
}

export function weightedLtv(collateral) {
  const total = collateral.reduce((s, c) => s + c.usd, 0)
  return total <= 0 ? 0 : collateral.reduce((s, c) => s + c.usd * c.ltv, 0) / total
}

export const healthFactor = (collUsd, liqLtv, debtUsd) => (debtUsd > 0 ? (collUsd * liqLtv) / 100 / debtUsd : Infinity)

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
  const seconds = Math.floor(now / 1000 - ts)
  if (seconds < 90) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
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

// Rounded down (never shown safer than it is), with 3 decimals near 1: 0.9996 reads 0.999, not a healthy-looking 1.00.
export function hfText(hf) {
  if (!Number.isFinite(hf) || hf > 999) return '∞'
  const decimals = hf < 1.1 ? 3 : 2
  return floorTo(hf, decimals).toFixed(decimals)
}

export function hfColor(hf) {
  if (!Number.isFinite(hf) || hf >= 1.8) return 'var(--n-green)'
  if (hf >= 1.3) return 'var(--n-amber)'
  return 'var(--n-red)'
}

export function dur(sec) {
  if (!Number.isFinite(sec)) return '—'
  const seconds = Math.max(Math.round(sec), 0)
  if (seconds < 90) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 2 * DAY) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / DAY)}d`
}

// Kamino re-checks borrow and withdraw limits at the transaction's block (fresh prices, accrued interest), so offered
// maxima stay this fraction under the computed limit.
export const LIMIT_MARGIN = 0.001
export const underLimit = (max, decimals) => floorTo(max * (1 - LIMIT_MARGIN), decimals)
export const floorTo = (value, decimals) =>
  value > 0 ? Math.floor(value * 10 ** decimals + EPSILON) / 10 ** decimals : 0
export const ceilTo = (value, decimals) =>
  value > 0 ? Math.ceil(value * 10 ** decimals - EPSILON) / 10 ** decimals : 0
export const coversAll = (amount, total, decimals) => total > 0 && amount >= total - 10 ** -decimals

// Kamino rejects repays leaving sub-unit dust (NetValueRemainingTooSmall): within one unit of the debt it's a full
// repay (U64_MAX, the wallet must cover it all); otherwise a partial that leaves at least 2 units.
export function repayPlan(amount, debt, wallet, decimals) {
  const all = coversAll(amount, debt, decimals)
  const maxPartial = floorTo(Math.min(wallet, debt - 2 * 10 ** -decimals), decimals)
  return { all, maxPartial, issue: repayIssue() }

  function repayIssue() {
    if (!amount) return null
    if (all) return wallet < ceilTo(debt, decimals) ? 'short' : null
    if (amount > wallet) return 'wallet'
    if (amount > maxPartial) return 'dust'
    return null
  }
}

// Linear (growth × 365 / days): compounding a short window of a rewards-boosted vault (+9% in a day) gives absurd
// figures (10^15 %); for ordinary rates the two barely differ.
export const realizedApy = (from, to, days) => (days > 0 && from > 0 ? (to / from - 1) * (365 / days) * 100 : null)

// With shorter history it uses the oldest point and says so (full=false): a 19-day-old reserve's "30D" is since launch.
export function windowApy(points, days) {
  if (points.length < 2) return null
  const end = points.at(-1)
  const target = end.ts - days * DAY
  const start = points.findLast((p) => p.ts <= target) ?? points[0]
  const spanDays = (end.ts - start.ts) / DAY
  return spanDays > 0
    ? { apy: realizedApy(start.rate, end.rate, spanDays), spanDays, full: start.ts <= target, from: start.ts }
    : null
}

// A token's own yield from its recorded prices (USDY: Ondo's rate), over the last 30 days; null under a week of them.
export function priceApy(points) {
  const w = windowApy(
    points.filter((p) => p.price > 0).map((p) => ({ ts: p.ts, rate: p.price })),
    30,
  )
  return w && w.spanDays >= 7 ? w.apy : null
}

// One APY per day, between the last points of consecutive days.
export function dailyApySeries(points) {
  const lastPointOfDay = new Map(points.map((p) => [Math.floor(p.ts / DAY), p]))
  const days = [...lastPointOfDay.values()].sort((a, b) => a.ts - b.ts)
  return days.slice(1).map((day, i) => {
    const previous = days[i]
    return { ts: day.ts, apy: realizedApy(previous.rate, day.rate, (day.ts - previous.ts) / DAY) }
  })
}

export function niceTicks(max) {
  const m = Math.max(max, EPSILON)
  const magnitude = 10 ** Math.floor(Math.log10(m / 5))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * magnitude).find((s) => m / s <= 6)
  const top = Math.ceil(m / step - EPSILON) * step
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) }
}

// APR, not APY: rewards don't compound.
export const rewardApr = (perSecond, rewardPrice, stakedUsd) =>
  stakedUsd > 0 ? ((perSecond * 31_536_000 * rewardPrice) / stakedUsd) * 100 : 0

// Kamino (liquidation_operations.rs): the LTV above the liquidation LTV, floored at the min bonus, capped at the max
// bonus and at 1 − LTV (so the loan stays solvent). Loans at ≥99% LTV use the bad-debt bonus instead.
export function liquidationBonusRange(minPct = 0, maxPct, liqLtvPct) {
  const room = 100 - liqLtvPct
  return { low: Math.min(minPct, maxPct, room), high: Math.min(maxPct, Math.max(minPct, room / 2)) }
}

// Negative values count as 0.
export function pieSlices(values) {
  const total = values.reduce((s, v) => s + Math.max(v, 0), 0)
  let at = 0
  return values.map((v) => {
    const share = total > 0 ? Math.max(v, 0) / total : 0
    const start = at
    at += share * 2 * Math.PI
    return { share: share * 100, start, end: at }
  })
}

// A whole circle (or within ~0.02% of one) is drawn as two half arcs: an SVG arc whose ends round to the same point
// isn't drawn at all.
const FULL = 2 * Math.PI - 1e-3
export function arcPath(cx, cy, r, ri, start, end) {
  if (end - start >= FULL)
    return (
      arcPath(cx, cy, r, ri, start, start + Math.PI) +
      arcPath(cx, cy, r, ri, start + Math.PI, start + 2 * Math.PI - 1e-2)
    )
  const pt = (rad, a) => `${(cx + rad * Math.sin(a)).toFixed(2)},${(cy - rad * Math.cos(a)).toFixed(2)}`
  const large = end - start > Math.PI ? 1 : 0
  return `M${pt(r, start)}A${r},${r} 0 ${large} 1 ${pt(r, end)}L${pt(ri, end)}A${ri},${ri} 0 ${large} 0 ${pt(ri, start)}Z`
}
