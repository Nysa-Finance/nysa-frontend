// OFAC sanctions screening against a stubbed SDN XML download. Run by `npm test`.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nysa-screening-'))
const entry = (coin, addr) => `<id>\n<uid>1</uid>\n<idType>Digital Currency Address - ${coin}</idType>\n<idNumber>${addr}</idNumber>\n</id>`
const SOL = '42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi'
const filler = Array.from({ length: 150 }, (_, i) => entry('XBT', `1Filler${i}`)).join('\n')
let next
globalThis.fetch = async () => (next === 'down' ? Promise.reject(new Error('network down')) : { ok: true, status: 200, text: async () => next })

const { parseSdn, refreshSanctions, isSanctioned, screeningReady, screeningStatus } = await import('./screening.js')

// Parsing: every Digital Currency Address id, whatever the coin; other ids ignored.
const parsed = parseSdn(`<sdnList>${entry('SOL', SOL)}${entry('USDC', 'UsdcAddr111')}<id><idType>Passport</idType><idNumber>X123</idNumber></id></sdnList>`)
assert.deepEqual([...parsed].sort(), [SOL, 'UsdcAddr111'].sort())

// Nothing loaded yet: not ready (transactions fail closed), nobody flagged.
assert.equal(screeningReady(), false)
next = `<sdnList>${entry('SOL', SOL)}\n${filler}</sdnList>`
await refreshSanctions()
assert.equal(screeningReady(), true)
assert.equal(isSanctioned(SOL), true)
assert.equal(isSanctioned('66pW72Fchnr34FGgXrxheGs3BbUsDSwJmGcK7m8Bz1Yv'), false)
assert.equal(screeningStatus().addresses, 151)
assert.equal(JSON.parse(readFileSync(join(process.env.DATA_DIR, 'sanctions/ofac-addresses.json'), 'utf8')).addresses.length, 151) // saved for restarts

// A broken or truncated download never replaces a good list.
next = `<sdnList>${entry('SOL', 'Other111')}</sdnList>`
await assert.rejects(refreshSanctions())
next = 'down'
await assert.rejects(refreshSanctions())
assert.equal(isSanctioned(SOL), true)
assert.equal(screeningStatus().addresses, 151)

console.log('screening ok')
