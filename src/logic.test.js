import assert from 'node:assert/strict'
import { usd, pct, compact, borrowRateAt, supplyRateAt, borrowCapacity, weightedLtv, healthFactor, parsePoints } from './logic.js'

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

console.log('logic ok')
