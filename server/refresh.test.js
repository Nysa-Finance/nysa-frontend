// Market cache refresh timer (server/refresh.js), on mocked timers. Run by `npm test`.
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { createRefresher } from './refresh.js'

mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
const EVERY = 60_000, SOON = 2_000, GAP = 10_000
const flush = () => new Promise((r) => setImmediate(r))
// Advance mocked time in 100 ms steps, calling each(t) (t = ms since start) before every step.
async function advance(ms, each = () => {}) {
  for (let t = 0; t < ms; t += 100) { each(t); mock.timers.tick(100); await flush() }
}
// A refresher whose reads take readMs and are logged as start times relative to t0.
function make(readMs = 500) {
  const t0 = Date.now(), reads = []
  const r = createRefresher(() => { reads.push(Date.now() - t0); return new Promise((ok) => setTimeout(ok, readMs)) }, { every: EVERY, soon: SOON, minGap: GAP })
  return { r, reads }
}
const gaps = (xs) => xs.slice(1).map((x, i) => x - xs[i])

// Regular cadence: a read every EVERY ms after the previous one ends; concurrent callers share a read.
{
  const { r, reads } = make()
  assert.equal(r.run(), r.run())
  await advance(125_000)
  assert.deepEqual(reads, [0, 60_500, 121_000])
}

// F-1: polling confirmations every 1.5 s (each one asking for a refresh) used to push the timer back forever.
// Now reads keep coming, at most one per GAP.
{
  const { r, reads } = make()
  r.run()
  await advance(120_000, (t) => t % 1_500 === 0 && r.soon())
  assert.ok(reads.length >= 11, `reads: ${reads}`)
  for (const g of gaps(reads)) assert.ok(g >= GAP && g <= GAP + 200, `gap ${g}`)
}

// A request brings the next read forward (SOON after it, once GAP has passed) and repeats don't postpone it.
{
  const { r, reads } = make()
  r.run()
  await advance(30_000)
  r.soon()
  await advance(1_000)
  r.soon()
  await advance(1_500)
  assert.deepEqual(reads, [0, 32_000])
  // GAP not passed since the last read: the next one waits for it, coalescing every request in between.
  await advance(10_000, (t) => t < 9_000 && r.soon()) // requests from 32.5 s to 41.4 s
  assert.deepEqual(reads, [0, 32_000, 42_000])
  await advance(60_000) // then the regular cadence again
  assert.deepEqual(reads, [0, 32_000, 42_000, 102_500])
}

// A request made while a slow read is running (it may predate the transaction) gets a read after it ends.
{
  const { r, reads } = make(15_000)
  r.run()
  await advance(1_000)
  r.soon() // due at GAP, while the first read is still running
  await advance(20_000)
  assert.deepEqual(reads, [0, 17_000])
}

mock.timers.reset()
console.log('refresh ok')
