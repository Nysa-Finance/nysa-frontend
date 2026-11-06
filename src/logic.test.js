import assert from 'node:assert/strict'
import { usd, pct, compact, borrowRateAt, supplyRateAt, borrowCapacity, weightedLtv, healthFactor, parsePoints, snapshotPoints, pointsCsv, hfText, dur, floorTo, ceilTo, coversAll, realizedApy, windowApy, dailyApySeries, niceTicks, repayPlan, amtDust, rewardApr, liquidationBonusRange, pieSlices, arcPath, num, underLimit } from './logic.js'

assert.equal(usd(0.81), '$0.81')
assert.equal(usd(6600), '$6.6K')
assert.equal(usd(NaN), '—')
assert.equal(pct(3.0712), '3.07%')
assert.equal(pct(11214.304957), '11,214.30%')
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

// Farm Points accrue on the lower balance of the interval: A held $1000 for 1.5 days → 1500 points; B went from 1000 to
// 200 (only 200 stayed the whole time) → 300; the sniper S was in at the last snapshot and is out now → 0; D added
// $500 since (it counts from the next snapshot) → 1500; newcomer C starts at 0.
const day = 86400
const prev = [['A', 1000], ['B', 1000], ['S', 10_000], ['D', 1000]].map(([address, supplied]) => ({ address, points: 10, supplied, ts: 0 }))
const snap = snapshotPoints(prev, new Map([['A', 1000], ['B', 200], ['D', 1500], ['C', 50]]), 1.5 * day)
const ptsOf = (a) => snap.find((r) => r.address === a).points
assert.deepEqual([ptsOf('A'), ptsOf('B'), ptsOf('S'), ptsOf('D')], [1510, 310, 10, 1510])
assert.deepEqual(snap.find((r) => r.address === 'S'), { address: 'S', points: 10, supplied: 0, ts: 1.5 * day })
assert.deepEqual(snap.find((r) => r.address === 'C'), { address: 'C', points: 0, supplied: 50, ts: 1.5 * day })
// Round-trips through the CSV the leaderboard reads.
assert.deepEqual(parsePoints(pointsCsv(snap)).rows.map((r) => [r.address, r.points]), [['A', 1510], ['D', 1510], ['B', 310], ['S', 10], ['C', 0]])

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
assert.ok(Math.abs(w30.apy - (1.0001 ** 30 - 1) * (365 / 30) * 100) < 1e-6)
// A rewards-boosted day (+9.53%) annualizes to ~3,480%, not 10^15 %.
assert.ok(Math.abs(realizedApy(1, 1.0953, 1) - 3478.45) < 1e-6)
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
// Liquidation bonus with the live USDY settings (min 2%, max 5%, liquidation LTV 95%): 2% to 2.5%, never 5%.
assert.deepEqual(liquidationBonusRange(2, 5, 95), { low: 2, high: 2.5 })
assert.deepEqual(liquidationBonusRange(2, 5, 80), { low: 2, high: 5 }) // wide band: the max is reachable
assert.deepEqual(liquidationBonusRange(4, 5, 95), { low: 4, high: 4 })
// Vault allocation pie: shares and arcs; a single allocation fills the circle.
const slices = pieSlices([75, 25, -5])
assert.deepEqual(slices.map((x) => x.share), [75, 25, 0])
assert.equal(slices[0].start, 0)
assert.ok(Math.abs(slices[0].end - 1.5 * Math.PI) < 1e-9 && Math.abs(slices[1].end - 2 * Math.PI) < 1e-9)
assert.deepEqual(pieSlices([0, 0]).map((x) => x.share), [0, 0]) // nothing allocated yet
assert.equal(arcPath(50, 50, 40, 25, 0, Math.PI / 2), 'M50.00,10.00A40,40 0 0 1 90.00,50.00L75.00,50.00A25,25 0 0 0 50.00,25.00Z')
assert.equal((arcPath(50, 50, 40, 25, 0, 2 * Math.PI).match(/M/g) ?? []).length, 2) // full circle: two halves
// 99.99998% (all invested but a few micro-USDC): drawn as a full circle, not as an arc whose ends coincide.
const nearFull = pieSlices([4.5546, 0.000001])[0]
assert.equal((arcPath(50, 50, 40, 25, nearFull.start, nearFull.end).match(/M/g) ?? []).length, 2)
// Typed amounts: comma or dot as the decimal separator; anything ambiguous or invalid is 0 (no amount).
assert.equal(num('586,985732'), 586.985732)
assert.equal(num(' 0.5 '), 0.5)
for (const bad of ['1.000,5', '1,000.5', 'abc', '-3', '', null]) assert.equal(num(bad), 0, String(bad))
// Offered maxima stay LIMIT_MARGIN (0.1%) under Kamino's limit, floored to the token's decimals.
assert.equal(underLimit(0.836779, 6), 0.835942)
assert.equal(underLimit(1000, 6), 999)
assert.equal(underLimit(0, 6), 0)
console.log('logic ok')
