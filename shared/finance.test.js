import assert from 'node:assert/strict'
import {
  DAY,
  borrowRateAt,
  supplyRateAt,
  borrowCapacity,
  weightedLtv,
  healthFactor,
  floorTo,
  ceilTo,
  coversAll,
  realizedApy,
  windowApy,
  dailyApySeries,
  repayPlan,
  priceApy,
  rewardApr,
  liquidationBonusRange,
  underLimit,
} from './finance.js'

const pts = [
  [0, 0],
  [90, 3.07],
  [100, 11.3],
] // simplified curve
assert.equal(borrowRateAt(pts, 0), 0)
assert.ok(Math.abs(borrowRateAt(pts, 90) - 3.07) < 1e-9)
assert.ok(Math.abs(borrowRateAt(pts, 95) - 7.185) < 1e-9)
assert.equal(borrowRateAt(pts, 100), 11.3)
assert.ok(Math.abs(supplyRateAt({ points: pts, fee: 0.1 }, 90) - 3.07 * 0.9 * 0.9) < 1e-9)

// $1000 USDY @92% LTV, $200 debt, USDC @ $1, 10k liquidity → 720 USDC
assert.equal(borrowCapacity([{ usd: 1000, ltv: 92 }], 200, 1, 10000), 720)
assert.equal(borrowCapacity([{ usd: 1000, ltv: 92 }], 200, 1, 50), 50) // capped by liquidity
assert.equal(borrowCapacity([{ usd: 100, ltv: 92 }], 500, 1, 1e6), 0) // underwater
assert.equal(
  weightedLtv([
    { usd: 100, ltv: 90 },
    { usd: 300, ltv: 50 },
  ]),
  60,
)
assert.equal(healthFactor(1000, 95, 500), 1.9)
assert.equal(healthFactor(1000, 95, 0), Infinity)

// Repay/withdraw dust: debt 0.7831105 USDC (interest in sub-units) → MAX sends 0.783111, and 0.78311 already counts as "all".
assert.equal(floorTo(0.7831105, 6), 0.78311)
assert.equal(ceilTo(0.7831105, 6), 0.783111)
assert.equal(ceilTo(0.78311, 6), 0.78311) // exact values stay put despite float noise
assert.equal(coversAll(0.78311, 0.7831105, 6), true)
assert.equal(coversAll(0.78, 0.7831105, 6), false)
assert.equal(coversAll(1, 0, 6), false)

// Realized APY: a share worth 1.05 after 365 days → 5%.
assert.ok(Math.abs(realizedApy(1, 1.05, 365) - 5) < 1e-9)
assert.equal(realizedApy(1, 1.05, 0), null)
// 40 days of history growing 0.01%/day: the 30D and 7D windows are full.
const hist = Array.from({ length: 41 }, (_, i) => ({ ts: i * DAY, rate: 1.0001 ** i }))
const w30 = windowApy(hist, 30),
  w7 = windowApy(hist, 7)
assert.ok(w30.full && w7.full && Math.abs(w30.spanDays - 30) < 1e-9)
assert.ok(Math.abs(w30.apy - (1.0001 ** 30 - 1) * (365 / 30) * 100) < 1e-6)
// A rewards-boosted day (+9.53%) annualizes to ~3,480%, not 10^15 %.
assert.ok(Math.abs(realizedApy(1, 1.0953, 1) - 3478.45) < 1e-6)
// 19-day-old reserve: "30D" falls back to since-launch and says so.
const young = [
  { ts: 0, rate: 1 },
  { ts: 19 * DAY, rate: 1.001 },
]
assert.deepEqual([windowApy(young, 30).full, windowApy(young, 30).spanDays], [false, 19])
assert.equal(windowApy([{ ts: 0, rate: 1 }], 7), null)
// Daily series keeps the last point per day.
const series = dailyApySeries([
  { ts: 0, rate: 1 },
  { ts: DAY + 10, rate: 1.0001 },
  { ts: DAY + 20, rate: 1.0001 },
  { ts: 2 * DAY + 20, rate: 1.0002 },
])
assert.equal(series.length, 2)

// Repay decisions (6-decimal token).
// Full repay with enough in the wallet goes through: this is the case that used to be wrongly blocked.
assert.deepEqual(repayPlan(1.044222, 1.044221238, 3.5, 6), { all: true, maxPartial: 1.044219, issue: null })
// Tiny leftover debt (2.742 micro-units): MAX sends 0.000003 as a full repay.
assert.deepEqual(repayPlan(0.000003, 0.000002742, 3.5, 6), { all: true, maxPartial: 0, issue: null })
// Wallet short of the full debt by a fraction of a unit → 'short'; the largest safe partial is offered instead.
assert.deepEqual(repayPlan(1.044221, 1.044221238, 1.044221, 6), { all: true, maxPartial: 1.044219, issue: 'short' })
assert.equal(repayPlan(1.044219, 1.044221238, 1.044221, 6).issue, null)
// Partial leaving 1 unit of dust → 'dust'; more than the wallet → 'wallet'; ordinary partial → ok.
assert.equal(repayPlan(1.04422, 1.044221238, 3.5, 6).issue, 'dust')
assert.equal(repayPlan(0.5, 1.044221238, 0.4, 6).issue, 'wallet')
assert.equal(repayPlan(0.5, 1.044221238, 3.5, 6).issue, null)
assert.equal(repayPlan(0, 1, 1, 6).issue, null)

assert.equal(Math.round(rewardApr(1000 / 31_536_000, 1, 10_000)), 10) // 1000 USDC/year on 10k staked = 10%
assert.equal(rewardApr(1, 1, 0), 0) // nothing staked
// Liquidation bonus with the live USDY settings (min 2%, max 5%, liquidation LTV 95%): 2% to 2.5%, never 5%.
assert.deepEqual(liquidationBonusRange(2, 5, 95), { low: 2, high: 2.5 })
assert.deepEqual(liquidationBonusRange(2, 5, 80), { low: 2, high: 5 }) // wide band: the max is reachable
assert.deepEqual(liquidationBonusRange(4, 5, 95), { low: 4, high: 4 })
// Offered maxima stay LIMIT_MARGIN (0.1%) under Kamino's limit, floored to the token's decimals.
assert.equal(underLimit(0.836779, 6), 0.835942)
assert.equal(underLimit(1000, 6), 999)
assert.equal(underLimit(0, 6), 0)

// USDY's own yield from recorded prices: 1.00 → 1.003 in 30 days ≈ 3.65%; under a week of prices, none.
assert.ok(Math.abs(priceApy([{ ts: 0, price: 1 }, { ts: 15 * DAY }, { ts: 30 * DAY, price: 1.003 }]) - 3.65) < 0.01)
assert.equal(
  priceApy([
    { ts: 0, price: 1 },
    { ts: 6 * DAY, price: 1.001 },
  ]),
  null,
)
console.log('finance ok')
