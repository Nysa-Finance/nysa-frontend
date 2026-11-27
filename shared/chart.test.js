import assert from 'node:assert/strict'
import { niceTicks, pieSlices, arcPath } from './chart.js'

assert.deepEqual(niceTicks(11.33), { top: 12, ticks: [0, 2, 4, 6, 8, 10, 12] })
// Vault allocation pie: shares and arcs; a single allocation fills the circle.
const slices = pieSlices([75, 25, -5])
assert.deepEqual(
  slices.map((x) => x.share),
  [75, 25, 0],
)
assert.equal(slices[0].start, 0)
assert.ok(Math.abs(slices[0].end - 1.5 * Math.PI) < 1e-9 && Math.abs(slices[1].end - 2 * Math.PI) < 1e-9)
assert.deepEqual(
  pieSlices([0, 0]).map((x) => x.share),
  [0, 0],
) // nothing allocated yet
assert.equal(
  arcPath(50, 50, 40, 25, 0, Math.PI / 2),
  'M50.00,10.00A40,40 0 0 1 90.00,50.00L75.00,50.00A25,25 0 0 0 50.00,25.00Z',
)
assert.equal((arcPath(50, 50, 40, 25, 0, 2 * Math.PI).match(/M/g) ?? []).length, 2) // full circle: two halves
// 99.99998% (all invested but a few micro-USDC): drawn as a full circle, not as an arc whose ends coincide.
const nearFull = pieSlices([4.5546, 0.000001])[0]
assert.equal((arcPath(50, 50, 40, 25, nearFull.start, nearFull.end).match(/M/g) ?? []).length, 2)
console.log('chart ok')
