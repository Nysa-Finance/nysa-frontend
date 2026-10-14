// Unique-wallet counting (server/wallets.js) in a temporary DATA_DIR. Run by `npm test`.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nysa-wallets-'))
const { recordWallet, walletStats } = await import('./wallets.js')

const A = '42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi', B = 'GJxKuaeyH4NtibQHpRkVRn2NKahbP8jUp2QQrmhgda2o'
const day = (d) => Date.parse(`2026-10-${String(d).padStart(2, '0')}T12:00:00Z`)

await recordWallet(A, day(1))
await recordWallet(A, day(1)) // same wallet, same day: one user
await recordWallet(B, day(1))
await recordWallet(A, day(5)) // A comes back
assert.equal((await walletStats(1, day(5))).unique, 1)
const s = await walletStats(7, day(5))
assert.deepEqual([s.unique, s.new, s.returning, s.allTime], [2, 2, 0, 2])
assert.deepEqual(s.series.find((d) => d.t === '2026-10-01'), { t: '2026-10-01', wallets: 2, new: 2 })
assert.deepEqual(s.series.find((d) => d.t === '2026-10-05'), { t: '2026-10-05', wallets: 1, new: 0 }) // came back
// A window that starts after A's first visit: A counts as returning, not new.
const late = await walletStats(2, day(5))
assert.deepEqual([late.unique, late.new, late.returning], [1, 0, 1])
// Longer windows group by month.
const year = await walletStats(365, day(5))
assert.equal(year.unit, 'month')
assert.deepEqual(year.series.at(-1), { t: '2026-10', wallets: 2, new: 2 })

// Only hashes on disk, never the addresses.
const saved = readFileSync(join(process.env.DATA_DIR, 'wallet-stats/wallets.json'), 'utf8')
assert.ok(!saved.includes(A) && !saved.includes(B))

console.log('wallets ok')
