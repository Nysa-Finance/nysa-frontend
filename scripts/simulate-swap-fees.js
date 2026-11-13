import Decimal from 'decimal.js'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { calculateSwapFeeBaseUnits, formatBaseUnits, parseBaseUnits } from '../src/swap-fees.js'

const SOURCES = new Set(['standalone', 'loop'])
const OUTCOMES = new Set(['completed', 'failed', 'rejected'])
const COST_BASES = new Set(['perCompletedSwap', 'perAttempt', 'fixed'])
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Invalid scenario ${label}`)
  return value
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid scenario ${label}`)
  return value
}

function validateScenario(scenario) {
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw new TypeError('Invalid scenario object')
  requireText(scenario.name, 'name')
  if (!Number.isSafeInteger(scenario.feeBps) || scenario.feeBps < 0 || scenario.feeBps > 10_000) throw new RangeError('Invalid scenario fee basis points')
  if (!scenario.period || typeof scenario.period !== 'object') throw new TypeError('Invalid scenario period')
  requireText(scenario.period.label, 'period label')
  requirePositiveInteger(scenario.period.periods, 'period count')
  requireText(scenario.period.unit, 'period unit')
  if (!scenario.tokens || typeof scenario.tokens !== 'object' || Array.isArray(scenario.tokens) || !Object.keys(scenario.tokens).length) throw new TypeError('Invalid scenario tokens')

  for (const [mint, token] of Object.entries(scenario.tokens)) {
    requireText(mint, 'mint')
    if (!token || !Number.isSafeInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) throw new TypeError(`Invalid token decimals for ${mint}`)
    if (token.assumedUsdPrice !== undefined) {
      if (typeof token.assumedUsdPrice !== 'string' || !CANONICAL_DECIMAL.test(token.assumedUsdPrice) || new Decimal(token.assumedUsdPrice).lte(0)) {
        throw new TypeError(`Invalid assumed USD price for ${mint}`)
      }
    }
  }

  if (!Array.isArray(scenario.events)) throw new TypeError('Invalid scenario events')
  const ids = new Set()
  const events = scenario.events.map((event) => {
    if (!event || typeof event !== 'object') throw new TypeError('Invalid scenario event')
    const id = requireText(event.id, 'event id')
    if (ids.has(id)) throw new TypeError(`Duplicate scenario event id: ${id}`)
    ids.add(id)
    if (!SOURCES.has(event.source)) throw new TypeError(`Invalid event source for ${id}`)
    if (!OUTCOMES.has(event.outcome)) throw new TypeError(`Invalid event outcome for ${id}`)
    const inputMint = requireText(event.inputMint, `input mint for ${id}`)
    const feeMint = requireText(event.feeMint, `fee mint for ${id}`)
    const feeBasisMint = requireText(event.feeBasisMint, `fee-basis mint for ${id}`)
    if (!scenario.tokens[inputMint] || !scenario.tokens[feeMint] || !scenario.tokens[feeBasisMint]) throw new TypeError(`Unknown mint in scenario event ${id}`)
    if (feeMint !== feeBasisMint) throw new TypeError(`Fee mint must match fee-basis mint for ${id}`)
    if (event.hops !== undefined && (!Number.isSafeInteger(event.hops) || event.hops < 0)) throw new TypeError(`Invalid hop count for ${id}`)
    const frequency = event.frequency
    if (!frequency || typeof frequency !== 'object') throw new TypeError(`Invalid frequency for ${id}`)
    const count = requirePositiveInteger(frequency.count, `frequency count for ${id}`)
    const periods = requirePositiveInteger(frequency.periods, `frequency periods for ${id}`)
    requireText(frequency.period, `frequency period for ${id}`)
    const repetitions = count * periods
    requirePositiveInteger(repetitions, `expanded frequency for ${id}`)
    const inputAmount = parseBaseUnits(event.inputAmount, scenario.tokens[inputMint].decimals)
    const feeBasisAmount = parseBaseUnits(event.feeBasisAmount, scenario.tokens[feeBasisMint].decimals)
    return { ...event, id, inputMint, inputAmount, feeMint, feeBasisMint, feeBasisAmount, repetitions }
  })

  if (scenario.costs !== undefined && !Array.isArray(scenario.costs)) throw new TypeError('Invalid scenario costs')
  const costs = (scenario.costs ?? []).map((cost, index) => {
    if (!cost || typeof cost !== 'object') throw new TypeError(`Invalid scenario cost ${index + 1}`)
    const id = requireText(cost.id, `cost id ${index + 1}`)
    if (!COST_BASES.has(cost.basis)) throw new TypeError(`Invalid cost basis for ${id}`)
    const mint = requireText(cost.mint, `cost mint for ${id}`)
    if (!scenario.tokens[mint]) throw new TypeError(`Unknown cost mint for ${id}`)
    if (cost.source !== undefined && !SOURCES.has(cost.source)) throw new TypeError(`Invalid cost source for ${id}`)
    if (cost.basis === 'fixed' && cost.source !== undefined) throw new TypeError(`Fixed cost cannot be scoped to a source: ${id}`)
    const amount = parseBaseUnits(cost.amount, scenario.tokens[mint].decimals)
    return { ...cost, id, mint, amount }
  })

  return { events, costs }
}

function addTo(map, mint, amount) {
  map.set(mint, (map.get(mint) ?? 0n) + amount)
}

function human(raw, decimals) {
  if (raw < 0n) return `-${formatBaseUnits(-raw, decimals)}`
  return formatBaseUnits(raw, decimals)
}

function usdValue(raw, mint, tokens) {
  const price = tokens[mint].assumedUsdPrice
  return price === undefined ? null : new Decimal(human(raw, tokens[mint].decimals)).mul(price)
}

function usdTotal(amounts, tokens) {
  let total = new Decimal(0)
  for (const [mint, raw] of amounts) {
    if (raw === 0n) continue
    const value = usdValue(raw, mint, tokens)
    if (value === null) return null
    total = total.plus(value)
  }
  return total.toFixed()
}

function summarizeMints(totals, tokens) {
  return Object.fromEntries([...totals.keys()].sort().map((mint) => {
    const baseUnits = totals.get(mint)
    const token = tokens[mint]
    return [mint, {
      baseUnits: String(baseUnits),
      decimals: token.decimals,
      amount: human(baseUnits, token.decimals),
      usd: usdValue(baseUnits, mint, tokens)?.toFixed() ?? null,
      assumedUsdPrice: token.assumedUsdPrice ?? null,
    }]
  }))
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

export function simulateScenario(scenario) {
  const { events, costs } = validateScenario(scenario)
  const inputTotals = new Map(), feeTotals = new Map(), directCostTotals = new Map()
  const sourceInputTotals = { standalone: new Map(), loop: new Map() }
  const counts = { attempted: 0, completed: 0, failed: 0, rejected: 0, standalone: 0, loop: 0 }
  const eventResults = []

  for (const event of events) {
    const count = event.repetitions
    counts.attempted += count
    counts[event.source] += count
    if (event.outcome !== 'completed') {
      counts[event.outcome] += count
      eventResults.push({ id: event.id, source: event.source, outcome: event.outcome, swapCount: count, feePerSwapBaseUnits: '0', totalFeeBaseUnits: '0' })
      continue
    }
    counts.completed += count
    addTo(inputTotals, event.inputMint, event.inputAmount * BigInt(count))
    addTo(sourceInputTotals[event.source], event.inputMint, event.inputAmount * BigInt(count))
    const feePerSwap = calculateSwapFeeBaseUnits(event.feeBasisAmount, scenario.feeBps)
    addTo(feeTotals, event.feeMint, feePerSwap * BigInt(count))
    eventResults.push({ id: event.id, source: event.source, outcome: event.outcome, swapCount: count, feeMint: event.feeMint, feeBasisMint: event.feeBasisMint, feeBasisPerSwap: human(event.feeBasisAmount, scenario.tokens[event.feeBasisMint].decimals), feePerSwapBaseUnits: String(feePerSwap), totalFeeBaseUnits: String(feePerSwap * BigInt(count)) })
  }

  for (const cost of costs) {
    let count = 1
    if (cost.basis !== 'fixed') {
      count = events.filter((event) => cost.source === undefined || event.source === cost.source)
        .reduce((sum, event) => sum + (cost.basis === 'perAttempt' || event.outcome === 'completed' ? event.repetitions : 0), 0)
    }
    addTo(directCostTotals, cost.mint, cost.amount * BigInt(count))
  }

  const tokenNetFees = new Map([...new Set([...feeTotals.keys(), ...directCostTotals.keys()])].map((mint) => [mint, (feeTotals.get(mint) ?? 0n) - (directCostTotals.get(mint) ?? 0n)]))
  const inputNotional = summarizeMints(inputTotals, scenario.tokens)
  const inputNotionalBySource = Object.fromEntries(Object.entries(sourceInputTotals).map(([source, totals]) => [source, summarizeMints(totals, scenario.tokens)]))
  const grossFees = summarizeMints(feeTotals, scenario.tokens)
  const directCosts = summarizeMints(directCostTotals, scenario.tokens)
  const netFees = summarizeMints(tokenNetFees, scenario.tokens)
  const excludedSwapCounts = { failed: counts.failed, rejected: counts.rejected }

  return {
    hypothetical: true,
    label: 'Hypothetical scenario — not a forecast',
    name: scenario.name,
    feeBps: scenario.feeBps,
    period: scenario.period,
    attemptedSwapCount: counts.attempted,
    completedSwapCount: counts.completed,
    completedSwapCountsBySource: { standalone: counts.standalone - events.filter((event) => event.source === 'standalone' && event.outcome !== 'completed').reduce((sum, event) => sum + event.repetitions, 0), loop: counts.loop - events.filter((event) => event.source === 'loop' && event.outcome !== 'completed').reduce((sum, event) => sum + event.repetitions, 0) },
    excludedSwapCounts,
    completedInputNotional: Object.fromEntries(Object.entries(inputNotional).map(([mint, total]) => [mint, { amount: total.amount, baseUnits: total.baseUnits, decimals: total.decimals, usd: total.usd, assumedUsdPrice: total.assumedUsdPrice }])),
    completedInputNotionalBySource: inputNotionalBySource,
    completedInputNotionalTotalUsd: usdTotal(inputTotals, scenario.tokens),
    grossFees: { byMint: grossFees, totalUsd: usdTotal(feeTotals, scenario.tokens) },
    directCosts: { byMint: directCosts, totalUsd: usdTotal(directCostTotals, scenario.tokens) },
    netFees: { byMint: netFees, totalUsd: usdTotal(tokenNetFees, scenario.tokens) },
    eventResults,
    assumptions: stableValue(scenario),
  }
}

function listTotals(label, totals) {
  const rows = Object.entries(totals)
  if (!rows.length) return `${label}: none`
  return `${label}:\n${rows.map(([mint, amount]) => `- ${mint}: ${amount.amount}${amount.usd === null ? '' : ` (USD equivalent ${amount.usd} at assumed $${amount.assumedUsdPrice})`}`).join('\n')}`
}

export function renderScenarioReport(result) {
  if (!result?.hypothetical || !result.assumptions) throw new TypeError('Invalid scenario result')
  return [
    result.label,
    `Scenario: ${result.name}`,
    `Fee rate: ${result.feeBps} bps`,
    `Period: ${result.period.label}`,
    `Attempted swaps: ${result.attemptedSwapCount}`,
    `Completed swaps: ${result.completedSwapCount} (standalone ${result.completedSwapCountsBySource.standalone}, loop ${result.completedSwapCountsBySource.loop})`,
    `Excluded swaps: ${result.excludedSwapCounts.failed} failed, ${result.excludedSwapCounts.rejected} rejected`,
    listTotals('Completed input notional', result.completedInputNotional),
    `Completed input notional by source:\n${Object.entries(result.completedInputNotionalBySource).map(([source, totals]) => `${source}:\n${listTotals('  input mint', totals)}`).join('\n')}`,
    listTotals('Gross fees by mint', result.grossFees.byMint),
    `Gross fees: ${result.grossFees.totalUsd === null ? 'USD equivalent unavailable without explicit prices' : `${result.grossFees.totalUsd} USD equivalent`}`,
    listTotals('Declared direct costs by mint', result.directCosts.byMint),
    `Net after declared direct costs: ${result.netFees.totalUsd === null ? 'USD equivalent unavailable without explicit prices' : `${result.netFees.totalUsd} USD equivalent`}`,
    'Assumptions:',
    JSON.stringify(result.assumptions, null, 2),
  ].join('\n')
}

function usage() {
  return 'Usage: npm run simulate:swap-fees -- --scenario <file> [--json]'
}

export async function main(args = process.argv.slice(2)) {
  let scenarioPath, json = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--scenario' && args[index + 1]) scenarioPath = resolve(args[++index])
    else if (args[index] === '--json') json = true
    else throw new TypeError(usage())
  }
  if (!scenarioPath) throw new TypeError(usage())
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'))
  const result = simulateScenario(scenario)
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${renderScenarioReport(result)}\n`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error?.message ?? 'Could not simulate swap fees'}\n`)
    process.exitCode = 1
  })
}
