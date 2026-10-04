import assert from 'node:assert/strict'
import { usd, pct, compact, borrowRateAt, supplyRateAt, borrowCapacity, weightedLtv, healthFactor, parsePoints, snapshotPoints, pointsCsv, hfText, dur, floorTo, ceilTo, coversAll, realizedApy, windowApy, dailyApySeries, niceTicks, repayPlan, amtDust, rewardApr } from './logic.js'

assert.equal(usd(0.81), '$0.81')
assert.equal(usd(6600), '$6.6K')
assert.equal(usd(NaN), '—')
assert.equal(pct(3.0712), '3.07%')
assert.equal(compact(250000, 'USDY'), '250K USDY')

const pts = [[0, 0], [90, 3.07], [100, 11.3]] // simplified curve
assert.equal(borrowRateAt(pts, 0), 0)
assert.ok(Math.abs(borrowRateAt(pts, 90) - 3.07) < 1e-9)
assert.ok(Math.abs(borrowRateAt(pts, 95) - 7.185) < 1e-9)
assert.equal(borrowRateAt(pts, 100), 11.3)
assert.ok(Math.abs(supplyRateAt({ points: pts, fee: 0.1 }, 90) - 3.07 * 0.9 * 0.9) < 1e-9)

// $1000 USDY @92% LTV, $200 debt, USDC @ $1, 10k liquidity → 720 USDC
assert.equal(borrowCapacity([{ usd: 1000, ltv: 92 }], 200, 1, 10000), 720)
assert.equal(borrowCapacity([{ usd: 1000, ltv: 92 }], 200, 1, 50), 50) // capped by liquidity
assert.equal(borrowCapacity([{ usd: 100, ltv: 92 }], 500, 1, 1e6), 0) // underwater
assert.equal(weightedLtv([{ usd: 100, ltv: 90 }, { usd: 300, ltv: 50 }]), 60)
assert.equal(healthFactor(1000, 95, 500), 1.9)
assert.equal(healthFactor(1000, 95, 0), Infinity)

const b = parsePoints('address,cumulative_points,last_supplied_usd,last_snapshot_ts\nB,1,2,100\nA,5,9,200\n')
assert.deepEqual(b.rows.map((r) => [r.address, r.rank]), [['A', 1], ['B', 2]])
assert.equal(b.updatedTs, 200)

// Farm Points: $1000 held for 1.5 days → 1500 points; balance now 200; newcomer C starts at 0.
const day = 86400
const snap = snapshotPoints([{ address: 'A', points: 10, supplied: 1000, ts: 0 }], new Map([['A', 200], ['C', 50]]), 1.5 * day)
assert.deepEqual(snap.find((r) => r.address === 'A'), { address: 'A', points: 1510, supplied: 200, ts: 1.5 * day })
assert.deepEqual(snap.find((r) => r.address === 'C'), { address: 'C', points: 0, supplied: 50, ts: 1.5 * day })
// Round-trips through the CSV the leaderboard reads.
assert.deepEqual(parsePoints(pointsCsv(snap)).rows.map((r) => [r.address, r.points]), [['A', 1510], ['C', 0]])

assert.equal(hfText(Infinity), '∞')
assert.equal(hfText(1.234), '1.23')
assert.deepEqual([dur(45), dur(180), dur(3600), dur(7200), dur(3 * 86400)], ['45s', '3m', '1h', '2h', '3d'])

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
const D = 86400
// 40 days of history growing 0.01%/day: the 30D and 7D windows are full.
const hist = Array.from({ length: 41 }, (_, i) => ({ ts: i * D, rate: 1.0001 ** i }))
const w30 = windowApy(hist, 30), w7 = windowApy(hist, 7)
assert.ok(w30.full && w7.full && Math.abs(w30.spanDays - 30) < 1e-9)
assert.ok(Math.abs(w30.apy - (1.0001 ** 365 - 1) * 100) < 1e-6)
// 19-day-old reserve: "30D" falls back to since-launch and says so.
const young = [{ ts: 0, rate: 1 }, { ts: 19 * D, rate: 1.001 }]
assert.deepEqual([windowApy(young, 30).full, windowApy(young, 30).spanDays], [false, 19])
assert.equal(windowApy([{ ts: 0, rate: 1 }], 7), null)
// Daily series keeps the last point per day.
const series = dailyApySeries([{ ts: 0, rate: 1 }, { ts: D + 10, rate: 1.0001 }, { ts: D + 20, rate: 1.0001 }, { ts: 2 * D + 20, rate: 1.0002 }])
assert.equal(series.length, 2)
assert.deepEqual(niceTicks(11.33), { top: 12, ticks: [0, 2, 4, 6, 8, 10, 12] })

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
// Dust display.
assert.equal(amtDust(0.000002742), '< 0.0001')
assert.equal(amtDust(0), '0')
assert.equal(amtDust(1.04422), '1.0442')

assert.equal(Math.round(rewardApr(1000 / 31_536_000, 1, 10_000)), 10) // 1000 USDC/year on 10k staked = 10%
assert.equal(rewardApr(1, 1, 0), 0) // nothing staked
console.log('logic ok')
