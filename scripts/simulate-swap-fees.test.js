import assert from 'node:assert/strict'
import { renderScenarioReport, simulateScenario } from './simulate-swap-fees.js'

const scenario = {
  name: 'synthetic USDY/USDC cases',
  feeBps: 10,
  period: { label: '30 synthetic days', periods: 30, unit: 'day' },
  tokens: {
    USDC: { decimals: 6, assumedUsdPrice: '1' },
    USDY: { decimals: 6, assumedUsdPrice: '1.10' },
  },
  events: [
    { id: 'small-standalone', source: 'standalone', outcome: 'completed', inputMint: 'USDC', inputAmount: '100', feeMint: 'USDC', feeBasisMint: 'USDC', feeBasisAmount: '100', hops: 4, frequency: { count: 1, period: 'scenario', periods: 1 } },
    { id: 'large-loop', source: 'loop', outcome: 'completed', inputMint: 'USDY', inputAmount: '10000', feeMint: 'USDY', feeBasisMint: 'USDY', feeBasisAmount: '10000', hops: 3, frequency: { count: 1, period: 'scenario', periods: 1 } },
    { id: 'daily', source: 'standalone', outcome: 'completed', inputMint: 'USDC', inputAmount: '100', feeMint: 'USDC', feeBasisMint: 'USDC', feeBasisAmount: '100', frequency: { count: 10, period: 'day', periods: 30 } },
    { id: 'failed', source: 'loop', outcome: 'failed', inputMint: 'USDC', inputAmount: '500', feeMint: 'USDC', feeBasisMint: 'USDC', feeBasisAmount: '500', frequency: { count: 2, period: 'scenario', periods: 1 } },
    { id: 'rejected', source: 'standalone', outcome: 'rejected', inputMint: 'USDC', inputAmount: '1000', feeMint: 'USDC', feeBasisMint: 'USDC', feeBasisAmount: '1000', frequency: { count: 1, period: 'scenario', periods: 1 } },
  ],
  costs: [
    { id: 'per-completion', basis: 'perCompletedSwap', mint: 'USDC', amount: '0.02' },
    { id: 'per-attempt', basis: 'perAttempt', mint: 'USDC', amount: '0.01' },
    { id: 'fixed', basis: 'fixed', mint: 'USDY', amount: '1' },
  ],
}

const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('simulator must not use network') }
try {
  const result = simulateScenario(scenario)
  assert.ok(result && typeof result === 'object', 'scenario returns a report')
  assert.equal(result.hypothetical, true)
  assert.equal(result.attemptedSwapCount, 305)
  assert.equal(result.completedSwapCount, 302)
  assert.deepEqual(result.excludedSwapCounts, { failed: 2, rejected: 1 })
  assert.equal(result.completedInputNotional.USDC.amount, '30100')
  assert.equal(result.completedInputNotional.USDC.usd, '30100')
  assert.equal(result.completedInputNotional.USDY.amount, '10000')
  assert.equal(result.completedInputNotional.USDY.usd, '11000')
  assert.equal(result.grossFees.byMint.USDC.amount, '30.1') // 301 completed events × 0.10 USDC
  assert.equal(result.grossFees.byMint.USDY.amount, '10')
  assert.equal(result.grossFees.totalUsd, '41.1')
  assert.equal(result.directCosts.byMint.USDC.amount, '9.09') // 302 × .02 + 305 × .01
  assert.equal(result.directCosts.byMint.USDY.amount, '1')
  assert.equal(result.netFees.totalUsd, '30.91') // 41.1 - 9.09 - (1 USDY × $1.10)

  const repeated = simulateScenario({
    ...scenario,
    events: [{ ...scenario.events[0], frequency: { count: 1000, period: 'scenario', periods: 1 } }],
    costs: [],
  })
  assert.equal(repeated.grossFees.byMint.USDC.amount, '100')

  const rounding = simulateScenario({
    ...scenario,
    events: [{ ...scenario.events[0], inputAmount: '0.0009', feeBasisAmount: '0.0009', frequency: { count: 10, period: 'scenario', periods: 1 } }],
    costs: [],
  })
  assert.equal(rounding.grossFees.byMint.USDC.baseUnits, '0') // floor fee per event before multiplying count

  const unpriced = simulateScenario({
    ...scenario,
    tokens: { USDC: { decimals: 6 } },
    events: [{ ...scenario.events[0] }],
    costs: [],
  })
  assert.equal(unpriced.grossFees.byMint.USDC.usd, null)
  assert.equal(unpriced.grossFees.totalUsd, null)

  const report = renderScenarioReport(result)
  assert.match(report, /Hypothetical scenario — not a forecast/)
  assert.match(report, /Completed swaps: 302/)
  assert.match(report, /Gross fees: 41\.1 USD equivalent/)
  assert.match(report, /Net after declared direct costs: 30\.91 USD equivalent/)
  assert.equal(report, renderScenarioReport(simulateScenario(scenario)))

  for (const invalid of [
    { ...scenario, feeBps: -1 },
    { ...scenario, events: [{ ...scenario.events[0], frequency: undefined }] },
    { ...scenario, events: [{ ...scenario.events[0], inputAmount: '1e3' }] },
    { ...scenario, events: [{ ...scenario.events[0], inputMint: 'UNKNOWN' }] },
    { ...scenario, events: [{ ...scenario.events[0], frequency: { count: 1.5, period: 'day', periods: 2 } }] },
    { ...scenario, events: [{ ...scenario.events[0], outcome: 'pending' }] },
    { ...scenario, events: [{ ...scenario.events[0], source: 'dex-hop' }] },
    { ...scenario, costs: [{ basis: 'perHour', mint: 'USDC', amount: '1' }] },
  ]) assert.throws(() => simulateScenario(invalid), /scenario|event|frequency|amount|mint|outcome|source|cost/i)
} finally {
  globalThis.fetch = originalFetch
}

console.log('swap-fee-simulator ok')
