import assert from 'node:assert/strict'
import { nextToInvest } from './vault-crank.js'

// offTarget's order: most over-allocated first
const gaps = [{ a: 'over', gap: -500, readyIn: 0 }, { a: 'soon', gap: -100, readyIn: 40 }, { a: 'under', gap: 600, readyIn: 0 }]
assert.equal(nextToInvest(gaps, new Set()).a, 'over')
assert.equal(nextToInvest(gaps, new Set(['over'])).a, 'under') // not ready: skipped
assert.equal(nextToInvest(gaps, new Set(['over', 'under'])), undefined)
assert.equal(nextToInvest([], new Set()), undefined)
console.log('vault-crank ok')
