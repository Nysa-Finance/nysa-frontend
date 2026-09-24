import assert from 'node:assert/strict'
import { usd, pct, compact, borrowRateAt, supplyRateAt, borrowCapacity, weightedLtv, healthFactor, parsePoints, snapshotPoints, pointsCsv, hfText, dur, floorTo, ceilTo, coversAll } from './logic.js'

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
assert.deepEqual([dur(45), dur(180), dur(7200), dur(3 * 86400)], ['45s', '3m', '2h', '3d'])

// Repay/withdraw dust: debt 0.7831105 USDC (interest in sub-units) → MAX sends 0.783111, and 0.78311 already counts as "all".
assert.equal(floorTo(0.7831105, 6), 0.78311)
assert.equal(ceilTo(0.7831105, 6), 0.783111)
assert.equal(ceilTo(0.78311, 6), 0.78311) // exact values stay put despite float noise
assert.equal(coversAll(0.78311, 0.7831105, 6), true)
assert.equal(coversAll(0.78, 0.7831105, 6), false)
assert.equal(coversAll(1, 0, 6), false)

console.log('logic ok')
