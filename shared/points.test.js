import assert from 'node:assert/strict'
import { parsePoints, snapshotPoints, pointsCsv } from './points.js'
import { DAY } from './finance.js'

const b = parsePoints('address,cumulative_points,last_supplied_usd,last_snapshot_ts\nB,1,2,100\nA,5,9,200\n')
assert.deepEqual(
  b.rows.map((r) => [r.address, r.rank]),
  [
    ['A', 1],
    ['B', 2],
  ],
)
assert.equal(b.updatedTs, 200)

// Farm Points accrue on the lower balance of the interval: A held $1000 for 1.5 days → 1500 points; B went from 1000 to
// 200 (only 200 stayed the whole time) → 300; the sniper S was in at the last snapshot and is out now → 0; D added
// $500 since (it counts from the next snapshot) → 1500; newcomer C starts at 0.
const prev = [
  ['A', 1000],
  ['B', 1000],
  ['S', 10_000],
  ['D', 1000],
].map(([address, supplied]) => ({ address, points: 10, supplied, ts: 0 }))
const snap = snapshotPoints(
  prev,
  new Map([
    ['A', 1000],
    ['B', 200],
    ['D', 1500],
    ['C', 50],
  ]),
  1.5 * DAY,
)
const ptsOf = (a) => snap.find((r) => r.address === a).points
assert.deepEqual([ptsOf('A'), ptsOf('B'), ptsOf('S'), ptsOf('D')], [1510, 310, 10, 1510])
assert.deepEqual(
  snap.find((r) => r.address === 'S'),
  { address: 'S', points: 10, supplied: 0, ts: 1.5 * DAY },
)
assert.deepEqual(
  snap.find((r) => r.address === 'C'),
  { address: 'C', points: 0, supplied: 50, ts: 1.5 * DAY },
)
// Round-trips through the CSV the leaderboard reads.
assert.deepEqual(
  parsePoints(pointsCsv(snap)).rows.map((r) => [r.address, r.points]),
  [
    ['A', 1510],
    ['D', 1510],
    ['B', 310],
    ['S', 10],
    ['C', 0],
  ],
)

console.log('points ok')
