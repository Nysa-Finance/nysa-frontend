export const DAY = 86400

// Absorbs float error before rounding to a digit: 1.15 * 100 is 114.999…, which must floor to 115.
export const EPSILON = 1e-9

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

// APR, not APY: rewards don't compound.
export const rewardApr = (perSecond, rewardPrice, stakedUsd) =>
  stakedUsd > 0 ? ((perSecond * 31_536_000 * rewardPrice) / stakedUsd) * 100 : 0

// Kamino (liquidation_operations.rs): the LTV above the liquidation LTV, floored at the min bonus, capped at the max
// bonus and at 1 − LTV (so the loan stays solvent). Loans at ≥99% LTV use the bad-debt bonus instead.
export function liquidationBonusRange(minPct = 0, maxPct, liqLtvPct) {
  const room = 100 - liqLtvPct
  return { low: Math.min(minPct, maxPct, room), high: Math.min(maxPct, Math.max(minPct, room / 2)) }
}
