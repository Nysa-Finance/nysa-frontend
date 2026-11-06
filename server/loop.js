import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'
import { address, createNoopSigner, none, some } from '@solana/kit'
import { fetchAddressLookupTable } from '@solana-program/address-lookup-table'
import {
  getDepositWithLeverageIxs, getDepositWithLeverageSwapInputs,
  getWithdrawWithLeverageIxs, getWithdrawWithLeverageSwapInputs,
  getObligationType, KaminoAction, KaminoObligation, PROGRAM_ID, UserMetadata,
  ObligationTypeTag,
} from '@kamino-finance/klend-sdk'
import { DEFAULT_LOOP_LIMITS, loopExposure, projectedLtvLimitPct } from '../src/loop-policy.js'
import { LIVE, TOKENS } from '../src/config.js'
import { parseBaseUnits } from '../src/swap-fees.js'
import { buildSwap, configuredFeeAccountForMint } from './swap.js'
import { rpc } from './rpc.js'
import { getLive, reserveOf, refreshMarketForExecution } from './market.js'
import { ataOf } from './account.js'
import { simulateAtomicTransaction } from './tx.js'
import { validateProviderSwapInstructions } from './swap-execution.js'
import { composeAtomicOpenInstructions } from './loop-composition.js'
import { LOOP_ACK_POLICY_VERSION } from './strategy.js'
import { loopMarketRiskStillCurrent } from './loop-preview-validation.js'

export class LoopPreviewError extends Error {}
const PreciseDecimal = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP })
const DEFAULT_RESERVE_ADDRESS = '11111111111111111111111111111111'
const MAX_ROUTER_FEE_ROUNDING_BASE_UNITS = 10n

function loopSdkMarketRisk(collateralReserve, liabilityReserve) {
  return {
    collateralPriceUsd: String(collateralReserve.getOracleMarketPrice()),
    liabilityPriceUsd: String(liabilityReserve.getOracleMarketPrice()),
    maxBorrowLtvPct: Number(collateralReserve.stats.loanToValue) * 100,
    liquidationLtvPct: Number(collateralReserve.stats.liquidationThreshold) * 100,
    collateralOracleTimestamp: Number(collateralReserve.tokenOraclePrice?.timestamp ?? 0),
    liabilityOracleTimestamp: Number(liabilityReserve.tokenOraclePrice?.timestamp ?? 0),
    collateralOracleHeartbeatSeconds: Number(collateralReserve.state.config.tokenInfo.maxAgePriceSeconds),
    liabilityOracleHeartbeatSeconds: Number(liabilityReserve.state.config.tokenInfo.maxAgePriceSeconds),
  }
}

function assertCurrentLoopMarketRisk(previewRisk, fresh) {
  const risk = loopSdkMarketRisk(fresh.collateralReserve, fresh.liabilityReserve)
  const nowSeconds = Number(fresh.currentLedgerInstant?.blockTime)
  if (!loopMarketRiskStillCurrent(previewRisk, risk, nowSeconds)) {
    throw new LoopPreviewError('Fresh oracle or market risk assumptions changed or are outside their reserve heartbeat; build a fresh preview.')
  }
  return risk
}

/** Kamino SDK `slippagePct` uses percentage points (0.5 means 50 bps), unlike the router's basis-point field. */
export function sdkSlippagePctFromBps(slippageBps) {
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new LoopPreviewError('Invalid Kamino slippage basis points.')
  return new Decimal(slippageBps).div(100)
}

function rawAmount(value) {
  let amount
  try { amount = new Decimal(value).floor() } catch { throw new LoopPreviewError('Invalid swap amount.') }
  if (!amount.isFinite() || amount.lte(0) || !amount.isInteger()) throw new LoopPreviewError('Invalid swap amount.')
  return amount.toFixed(0)
}

function tokenDecimals(mint, configured) {
  const decimals = configured?.[mint] ?? Object.values(TOKENS).find((token) => token.mint === mint)?.decimals
  if (!Number.isSafeInteger(decimals) || decimals < 0) throw new LoopPreviewError('Unsupported loop token mint.')
  return decimals
}

function positiveDecimal(value, label, allowZero = false) {
  let parsed
  try { parsed = new PreciseDecimal(String(value)) } catch { throw new LoopPreviewError(`Invalid ${label}.`) }
  if (!parsed.isFinite() || (allowZero ? parsed.isNegative() : !parsed.gt(0))) throw new LoopPreviewError(`Invalid ${label}.`)
  return parsed
}

function decimalText(value) {
  return value.toDecimalPlaces(38, Decimal.ROUND_HALF_UP).toFixed()
}

/** Kamino getDepositByReserve/getBorrowByReserve amounts are raw mint base units. */
export function obligationRawAmountBaseUnits(value) {
  let amount
  try { amount = new PreciseDecimal(String(value)) } catch { throw new LoopPreviewError('Invalid raw obligation amount.') }
  if (!amount.isFinite() || amount.isNegative()) throw new LoopPreviewError('Invalid raw obligation amount.')
  return BigInt(amount.ceil().toFixed(0)).toString()
}

/** Mirror Kamino's posted obligation amounts: deposit is floored and debt borrow is ceiled to mint base units. */
export function sdkAmountBaseUnitsWithProtocolRounding(value, decimals, direction) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18 || !['floor', 'ceil'].includes(direction)) {
    throw new LoopPreviewError('Invalid protocol amount rounding inputs.')
  }
  const scale = new PreciseDecimal(10).pow(decimals)
  const raw = positiveDecimal(value, 'SDK protocol amount').mul(scale)
  const rounded = direction === 'floor' ? raw.floor() : raw.ceil()
  return rounded.toFixed(0)
}

export function sdkAmountWithProtocolRounding(value, decimals, direction) {
  return decimalText(new PreciseDecimal(sdkAmountBaseUnitsWithProtocolRounding(value, decimals, direction))
    .div(new PreciseDecimal(10).pow(decimals)))
}

/** Mirror the installed SDK's raw borrow, exclusive protocol fee, and half-up origination-fee rounding. */
export function sdkBorrowDebtBaseUnitsWithProtocolFee(value, decimals, market, reserve, hasReferrer = false) {
  if (!market?.state || typeof reserve?.calculateFees !== 'function' || typeof reserve?.getBorrowFee !== 'function') {
    throw new LoopPreviewError('Kamino borrow-fee inputs are unavailable for loop simulation.')
  }
  const receivedBaseUnits = sdkAmountBaseUnitsWithProtocolRounding(value, decimals, 'ceil')
  const debtWithFees = KaminoObligation.getDebtWithFeesForBorrowAmount(
    new PreciseDecimal(receivedBaseUnits), market, reserve, hasReferrer,
  )
  return obligationRawAmountBaseUnits(debtWithFees)
}

/** Mirror Kamino on-chain liquidity_to_collateral + try_to_floor, then hydrate the cToken amount through exchange rate. */
export function sdkDepositPositionBaseUnitsWithExchangeRate(value, decimals, exchangeRate) {
  const rate = positiveDecimal(exchangeRate, 'collateral exchange rate')
  const liquidityBaseUnits = sdkAmountBaseUnitsWithProtocolRounding(value, decimals, 'floor')
  const cTokenBaseUnits = new PreciseDecimal(liquidityBaseUnits).mul(rate).floor().toFixed(0)
  // KaminoObligation.calculateObligationDeposits uses the SDK's default Decimal precision for cTokens / exchangeRate.
  const positionRawAmount = new Decimal(cTokenBaseUnits).div(new Decimal(rate.toString())).toString()
  const positionBaseUnits = obligationRawAmountBaseUnits(positionRawAmount)
  return { liquidityBaseUnits, cTokenBaseUnits, positionRawAmount, positionBaseUnits }
}

function obligationDepositCTokenBaseUnits(obligation, reserveAddress) {
  const deposit = obligation?.state?.deposits?.find((item) => String(item.depositReserve) === String(reserveAddress))
  if (!deposit) return '0'
  const amount = String(deposit.depositedAmount)
  if (!/^\d+$/.test(amount)) throw new LoopPreviewError('Simulated Multiply cToken amount is invalid.')
  return BigInt(amount).toString()
}

function assertSupportedLoopObligationReserves(obligation, collateralReserveAddress, liabilityReserveAddress) {
  if (!Array.isArray(obligation?.state?.deposits) || !Array.isArray(obligation?.state?.borrows)) {
    throw new LoopPreviewError('The selected Multiply obligation’s full reserve state is unavailable.')
  }
  for (const deposit of obligation.state.deposits) {
    const reserve = String(deposit.depositReserve)
    if (reserve === DEFAULT_RESERVE_ADDRESS) continue
    let amount
    try { amount = BigInt(String(deposit.depositedAmount)) } catch { throw new LoopPreviewError('Multiply collateral reserve state is invalid.') }
    if (amount > 0n && reserve !== String(collateralReserveAddress)) {
      throw new LoopPreviewError('Full close does not support extra active collateral reserves in this Multiply obligation.')
    }
  }
  for (const borrow of obligation.state.borrows) {
    const reserve = String(borrow.borrowReserve)
    if (reserve === DEFAULT_RESERVE_ADDRESS) continue
    let amount
    try { amount = BigInt(String(borrow.borrowedAmountSf)) } catch { throw new LoopPreviewError('Multiply debt reserve state is invalid.') }
    if (amount > 0n && reserve !== String(liabilityReserveAddress)) {
      throw new LoopPreviewError('Full close does not support extra active borrow reserves in this Multiply obligation.')
    }
  }
}

export function obligationSimulationBalances(obligation) {
  if (!Array.isArray(obligation?.state?.deposits) || !Array.isArray(obligation?.state?.borrows)) {
    throw new LoopPreviewError('Simulation omitted whole-obligation reserve state.')
  }
  const deposits = obligation.state.deposits.flatMap((deposit) => {
    const reserve = String(deposit.depositReserve)
    if (reserve === DEFAULT_RESERVE_ADDRESS) return []
    const cTokenBaseUnits = String(deposit.depositedAmount)
    if (!/^\d+$/.test(cTokenBaseUnits)) throw new LoopPreviewError('Simulated obligation cToken amount is invalid.')
    const hydrated = obligation.getDepositByReserve(address(reserve))?.amount
    return [{
      reserve, cTokenBaseUnits: BigInt(cTokenBaseUnits).toString(),
      amountBaseUnits: hydrated == null ? null : new PreciseDecimal(String(hydrated)).toString(),
    }]
  })
  const borrows = obligation.state.borrows.flatMap((borrow) => {
    const reserve = String(borrow.borrowReserve)
    if (reserve === DEFAULT_RESERVE_ADDRESS) return []
    const amountScaled = String(borrow.borrowedAmountSf)
    if (!/^\d+$/.test(amountScaled)) throw new LoopPreviewError('Simulated obligation debt amount is invalid.')
    const hydrated = obligation.getBorrowByReserve(address(reserve))?.amount
    return [{
      reserve, amountScaled: BigInt(amountScaled).toString(),
      amountBaseUnits: hydrated == null ? null : new PreciseDecimal(String(hydrated)).toString(),
    }]
  })
  return { deposits, borrows }
}

function canonicalize(value) {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().flatMap((key) =>
    value[key] === undefined ? [] : [[key, canonicalize(value[key])]]))
  return value
}

export function createLoopAcknowledgementKey({ strategy, fundingAmount, leverage, acquisitionQuote, leverageQuote, preview, sdkPosition, policyVersion = LOOP_ACK_POLICY_VERSION }) {
  if (!strategy?.carry?.requiresAcknowledgement || !sdkPosition || !acquisitionQuote || !leverageQuote) return null
  const fundingBaseUnits = parseBaseUnits(String(fundingAmount), TOKENS['svm-usdc'].decimals).toString()
  const signedPreview = {
    policyVersion,
    marketId: strategy.id ?? 'sol-usdy-usdc',
    fundingAmountBaseUnits: fundingBaseUnits,
    selectedLeverage: String(leverage),
    rateAssumptions: strategy.carry.assumptions ?? null,
    carry: {
      estimatedCarryPct: strategy.carry.estimatedCarryPct ?? null,
      asOf: strategy.carry.asOf ?? null,
    },
    routes: { acquisition: acquisitionQuote, leverage: leverageQuote },
    sdkPosition,
    economics: {
      exposure: preview.exposure,
      limits: preview.limits,
      risk: preview.risk,
      fees: preview.fees,
      costs: preview.costs,
      knownCostsTotalUsd: preview.knownCostsTotalUsd,
      feeTotalUsd: preview.feeTotalUsd,
    },
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(signedPreview))).digest('hex')
}

function sdkPositionExposure(position) {
  const collateralAmount = positiveDecimal(position.collateralAmount, 'SDK collateral amount')
  const collateralPriceUsd = positiveDecimal(position.collateralPriceUsd, 'collateral USD price')
  const debtBorrowAmount = positiveDecimal(position.debtBorrowAmount, 'SDK debt amount', true)
  const liabilityPriceUsd = positiveDecimal(position.liabilityPriceUsd, 'liability USD price')
  const borrowFeeRatio = positiveDecimal(position.borrowFeeRatio ?? 0, 'borrow fee ratio', true)
  const collateralValue = collateralAmount.mul(collateralPriceUsd)
  const debt = debtBorrowAmount.mul(new PreciseDecimal(1).add(borrowFeeRatio)).mul(liabilityPriceUsd)
  if (!collateralValue.gt(0) || !debt.lt(collateralValue)) throw new LoopPreviewError('SDK position has no positive collateral equity.')
  const equity = collateralValue.minus(debt)
  const projectedLtvPct = debt.div(collateralValue).mul(100)
  return {
    equity: decimalText(equity),
    grossCollateral: decimalText(collateralValue),
    debt: decimalText(debt),
    leverage: decimalText(collateralValue.div(equity)),
    projectedLtvPct: decimalText(projectedLtvPct),
    source: 'kamino-sdk-net-route',
    collateralAmount: decimalText(collateralAmount),
    collateralMint: position.collateralMint,
    collateralPriceUsd: decimalText(collateralPriceUsd),
    liabilityMint: position.liabilityMint,
    liabilityPriceUsd: decimalText(liabilityPriceUsd),
  }
}

function estimateSdkCosts(position, feePricesUsd) {
  const costs = []
  const debtBorrowAmount = positiveDecimal(position.debtBorrowAmount, 'SDK debt amount', true)
  const borrowFeeRatio = positiveDecimal(position.borrowFeeRatio ?? 0, 'borrow fee ratio', true)
  const debtPrice = positiveDecimal(position.liabilityPriceUsd, 'liability USD price')
  const borrowFee = debtBorrowAmount.mul(borrowFeeRatio)
  costs.push({ action: 'borrow-origination-fee', mint: position.liabilityMint, amount: decimalText(borrowFee), usd: Number(borrowFee.mul(debtPrice).toString()) })

  const flashBorrowAmount = positiveDecimal(position.flashBorrowAmount ?? 0, 'SDK flash borrow amount', true)
  const flashFeeRatio = positiveDecimal(position.flashFeeRatio ?? 0, 'flash fee ratio', true)
  const flashFee = flashBorrowAmount.mul(flashFeeRatio)
  const collateralPrice = positiveDecimal(position.collateralPriceUsd, 'collateral USD price')
  costs.push({ action: 'flash-loan-fee', mint: position.collateralMint, amount: decimalText(flashFee), usd: Number(flashFee.mul(collateralPrice).toString()) })

  for (const fee of position.swapFees ?? []) {
    const amountBaseUnits = positiveDecimal(fee.amountBaseUnits, 'provider swap fee', true)
    const decimals = tokenDecimals(fee.mint)
    const price = feePricesUsd[fee.mint]
    costs.push({
      action: fee.action,
      mint: fee.mint,
      amountBaseUnits: amountBaseUnits.toFixed(0),
      usd: Number.isFinite(price) ? Number(amountBaseUnits.div(new PreciseDecimal(10).pow(decimals)).mul(price).toString()) : null,
    })
  }
  const known = costs.every((cost) => Number.isFinite(cost.usd))
  return { costs, knownCostsTotalUsd: known ? costs.reduce((sum, cost) => sum + cost.usd, 0) : null }
}

async function resolveLookupTables(built, resolver) {
  const tables = Object.keys(built.addressesByLookupTableAddress ?? {})
  if (!tables.length) return []
  if (typeof resolver === 'function') return resolver(tables, built.addressesByLookupTableAddress)
  if (!rpc) throw new LoopPreviewError('Lookup table accounts require a configured backend RPC.')
  const accounts = await Promise.all(tables.map(async (table) => {
    const account = await fetchAddressLookupTable(rpc, address(table), { commitment: 'confirmed' })
    const expected = built.addressesByLookupTableAddress[table]
    if (expected.some((item) => !account.data.addresses.includes(item))) throw new LoopPreviewError('Swap provider lookup table changed after quote.')
    return account
  }))
  return accounts
}

/** The same callbacks are used by Kamino's quote-only preview and its instruction builder. */
export function createKaminoSwapCallbacks({
  wallet,
  buildSwapFn = buildSwap,
  getFeeAccount = configuredFeeAccountForMint,
  tokenDecimals: decimals = {},
  lookupTableResolver,
  providerApiKey = process.env.JUPITER_API_KEY,
  signal,
  // The installed SDK budgets 50 bps when sizing flash repayment; quote the route at 49 bps so its provider min-out
  // remains above that repayment amount after 10-bps fee arithmetic and integer-base-unit rounding.
  slippageBps = 49,
  localForkSimulation = false,
  localForkRpcUrl,
  localRouteProgramVerifier,
  onSwapComposed,
  routeQuotes = [],
  validateRoute = validateProviderSwapInstructions,
} = {}) {
  if (typeof wallet !== 'string' || !wallet) throw new LoopPreviewError('Wallet address is required for the loop quote.')
  if (localForkSimulation) {
    let hostname
    try { hostname = new URL(localForkRpcUrl).hostname.toLowerCase() } catch { throw new LoopPreviewError('Local simulation requires a loopback validator URL.') }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) || typeof localRouteProgramVerifier !== 'function') {
      throw new LoopPreviewError('Unapproved route composition requires a loopback RPC and verified deployed programs on the local validator.')
    }
  }
  const routeCache = new Map()
  const composedRoutes = []
  let pricingQuoteOverride = null
  const routeKey = (inputMint, outputMint, inputAmountBaseUnits) => `${wallet}:${inputMint}:${outputMint}:${inputAmountBaseUnits}`
  for (const quote of routeQuotes) {
    if (quote?.inputMint && quote?.outputMint && quote?.inputAmountBaseUnits) {
      routeCache.set(routeKey(quote.inputMint, quote.outputMint, quote.inputAmountBaseUnits), quote)
    }
  }
  let quotesSealed = false
  const prepare = async (inputs) => {
    const inputMint = String(inputs?.inputMint ?? '')
    const outputMint = String(inputs?.outputMint ?? '')
    const inputAmountBaseUnits = rawAmount(inputs?.inputAmountLamports)
    const feeDestination = await getFeeAccount(outputMint)
    if (!feeDestination || feeDestination.mint !== outputMint || typeof feeDestination.account !== 'string') {
      throw new LoopPreviewError('A validated output-mint Nysa fee account is not configured for this swap.')
    }
    const key = routeKey(inputMint, outputMint, inputAmountBaseUnits)
    let built = routeCache.get(key)
    if (!built) {
      if (quotesSealed) throw new LoopPreviewError('Swap amount changed after the loop preview; build a fresh preview.')
      built = await buildSwapFn({
        inputMint,
        outputMint,
        inputAmountBaseUnits,
        wallet,
        feeAccount: feeDestination.account,
        feeAccountMint: outputMint,
        feeBps: 10,
        platformFeeBps: 10,
        providerApiKey,
        slippageBps,
        signal,
      })
      routeCache.set(key, built)
    } else if (built.feeAccount !== feeDestination.account || built.feeAccountMint !== outputMint) {
      throw new LoopPreviewError('The fee destination changed after the loop preview; build a fresh preview.')
    }
    if (!built || !built.fee?.routeDeltaVerified || !built.programPolicy
      || built.feeAccountMintVerified !== true || !Array.isArray(built.instructions) || built.instructions.length === 0
      || typeof validateRoute !== 'function') {
      throw new LoopPreviewError('Swap route did not verify its 10-bps fee and provider route.')
    }
    if (!localForkSimulation && !built.programPolicy.approved) {
      throw new LoopPreviewError('Swap route programs and fee-account mint are not approved for composition.')
    }
    try {
      await validateRoute({
        wallet,
        inputMint,
        outputMint,
        amountBaseUnits: inputAmountBaseUnits,
        slippageBps: built.slippageBps,
      }, built)
    } catch (error) {
      throw new LoopPreviewError(`Swap route failed the shared router validator: ${error?.message ?? 'unsupported route.'}`)
    }
    if (built.compositionValidated !== true) built = { ...built, compositionValidated: true }
    routeCache.set(key, built)
    return { built, inputMint, outputMint, inputAmountBaseUnits }
  }

  const quoter = async (inputs) => {
    const inputMint = String(inputs?.inputMint ?? '')
    const outputMint = String(inputs?.outputMint ?? '')
    if (pricingQuoteOverride && (pricingQuoteOverride.inputMint !== inputMint || pricingQuoteOverride.outputMint !== outputMint)) {
      throw new LoopPreviewError('Pinned leverage quote does not match the SDK swap token pair.')
    }
    const quoteInputs = pricingQuoteOverride
      ? { ...inputs, inputAmountLamports: new Decimal(pricingQuoteOverride.inputAmountBaseUnits) }
      : inputs
    const { built, inputAmountBaseUnits } = await prepare(quoteInputs)
    const inDecimals = tokenDecimals(inputMint, decimals)
    const outDecimals = tokenDecimals(outputMint, decimals)
    const inputTokens = new Decimal(inputAmountBaseUnits).div(new Decimal(10).pow(inDecimals))
    const outputTokens = new Decimal(built.outputAmountBaseUnits).div(new Decimal(10).pow(outDecimals))
    if (inputTokens.lte(0) || outputTokens.lte(0)) throw new LoopPreviewError('Swap quote returned no usable output.')
    return { priceAInB: outputTokens.div(inputTokens), quoteResponse: built }
  }

  const swapper = async (inputs, _klendAccounts, quote) => {
    const inputMint = String(inputs?.inputMint ?? '')
    const outputMint = String(inputs?.outputMint ?? '')
    const inputAmountBaseUnits = rawAmount(inputs?.inputAmountLamports)
    let built = quote?.quoteResponse
    if (!built || built.inputMint !== inputMint || built.outputMint !== outputMint || built.inputAmountBaseUnits !== inputAmountBaseUnits) {
      ({ built } = await prepare(inputs))
    }
    if (built.fee?.bps !== 10 || built.fee?.mint !== outputMint) throw new LoopPreviewError('Kamino swapper requires the same fee-aware output-mint policy as its route quote.')
    if (!Number.isFinite(built.quoteAt) || Date.now() - built.quoteAt < 0 || Date.now() - built.quoteAt > 15_000) {
      throw new LoopPreviewError('Kamino swap quote expired before instruction composition.')
    }
    if (built.compositionValidated !== true) throw new LoopPreviewError('Swap route was not validated for atomic composition.')
    if (localForkSimulation) {
      if (!built.fee.routeDeltaVerified || !built.feeAccountMintVerified || !await localRouteProgramVerifier(built)) {
        throw new LoopPreviewError('Local route must have a verified fee account and deployed local route programs before simulation.')
      }
    } else if (!built.programPolicy.approved || !built.feeAccountMintVerified || !built.fee?.routeDeltaVerified) {
      throw new LoopPreviewError('Swap route or fee account is not approved for atomic composition.')
    }
    if (inputs.minOutAmountLamports != null && BigInt(built.minimumOutputBaseUnits) < BigInt(rawAmount(new Decimal(inputs.minOutAmountLamports).ceil()))) {
      throw new LoopPreviewError(`Swap provider minimum output ${built.minimumOutputBaseUnits} is below Kamino’s required flash-repayment amount ${rawAmount(new Decimal(inputs.minOutAmountLamports).ceil())}.`)
    }
    composedRoutes.push(built)
    if (typeof onSwapComposed === 'function') await onSwapComposed(built)
    const lookupTables = await resolveLookupTables(built, lookupTableResolver)
    return [{ preActionIxs: [], swapIxs: built.instructions, lookupTables, quote }]
  }

  return {
    quoter,
    swapper,
    sealQuotes() { quotesSealed = true },
    beginComposition() { quotesSealed = false },
    setPricingQuote(route) { pricingQuoteOverride = route ?? null },
    composedQuotes() { return composedRoutes.slice() },
    async authorizeComposedRoute(route) {
      if (!localForkSimulation) return route?.programPolicy?.approved === true
      return route?.fee?.routeDeltaVerified === true
        && route?.feeAccountMintVerified === true
        && typeof localRouteProgramVerifier === 'function'
        && await localRouteProgramVerifier(route)
    },
  }
}

export function buildLoopPreview({
  fundingAmount,
  leverage,
  strategy = null,
  maxBorrowLtvPct,
  liquidationLtvPct,
  tighterProjectedLtvPct = null,
  riskInputs = null,
  acquisitionQuote = null,
  leverageQuote = null,
  feePricesUsd = {},
  sdkPosition = null,
} = {}) {
  const exposure = sdkPosition ? sdkPositionExposure(sdkPosition) : { ...loopExposure(fundingAmount, leverage), source: 'target-estimate' }
  const ltvLimitPct = projectedLtvLimitPct(maxBorrowLtvPct, liquidationLtvPct, tighterProjectedLtvPct)
  const violations = []
  if (Number(exposure.projectedLtvPct) > ltvLimitPct) violations.push('projected-ltv-cap')
  if (Number(exposure.leverage) > DEFAULT_LOOP_LIMITS.maxLeverage) violations.push('leverage-cap')
  if (!riskInputs) violations.push('risk-data-unavailable')
  else {
    if (!Number.isFinite(riskInputs.slippageBps) || riskInputs.slippageBps > DEFAULT_LOOP_LIMITS.maxSlippageBps) violations.push('slippage-cap')
    if (!Number.isFinite(riskInputs.priceImpactPct) || riskInputs.priceImpactPct > DEFAULT_LOOP_LIMITS.maxPriceImpactPct) violations.push('price-impact-cap')
    if (!Number.isFinite(riskInputs.quoteAgeSeconds) || riskInputs.quoteAgeSeconds > DEFAULT_LOOP_LIMITS.maxQuoteAgeSeconds) violations.push('stale-quote')
    if (!Number.isFinite(riskInputs.oracleAgeSeconds) || !Number.isFinite(riskInputs.oracleHeartbeatSeconds)
      || riskInputs.oracleHeartbeatSeconds <= 0 || riskInputs.oracleAgeSeconds > riskInputs.oracleHeartbeatSeconds) violations.push('stale-oracle')
  }
  const quotes = [
    acquisitionQuote && { action: 'initial-acquisition', ...acquisitionQuote },
    leverageQuote && { action: 'leverage-swap', ...leverageQuote },
  ].filter(Boolean)
  const fees = quotes.map(({ action, fee }) => ({
    action,
    mint: fee?.mint ?? null,
    amountBaseUnits: fee?.amountBaseUnits ?? null,
    bps: fee?.bps ?? null,
    usd: fee?.mint && fee?.amountBaseUnits && Number.isFinite(feePricesUsd[fee.mint])
      ? Number(fee.amountBaseUnits) / 10 ** tokenDecimals(fee.mint) * feePricesUsd[fee.mint]
      : null,
  }))
  const estimatedCosts = sdkPosition
    ? estimateSdkCosts({ ...sdkPosition, swapFees: fees }, feePricesUsd)
    : { costs: fees, knownCostsTotalUsd: fees.every((fee) => fee.usd != null) ? fees.reduce((sum, fee) => sum + fee.usd, 0) : null }
  const projectedLtv = new PreciseDecimal(exposure.projectedLtvPct)
  const liquidationLimit = positiveDecimal(liquidationLtvPct, 'liquidation LTV')
  const collateralAmount = sdkPosition ? positiveDecimal(sdkPosition.collateralAmount, 'SDK collateral amount') : null
  const collateralPrice = sdkPosition ? positiveDecimal(sdkPosition.collateralPriceUsd, 'collateral USD price') : null
  const debtAmountUsd = new Decimal(exposure.debt)
  const liquidationPriceUsd = sdkPosition && collateralAmount && collateralPrice
    ? debtAmountUsd.div(collateralAmount.mul(liquidationLimit.div(100)))
    : null
  const liquidationPriceDeclinePct = liquidationPriceUsd && collateralPrice
    ? new PreciseDecimal(1).minus(liquidationPriceUsd.div(collateralPrice)).mul(100)
    : null
  const unavailableReasons = [...(strategy?.unavailableReasons ?? [])]
  const strategyExecutionEligible = strategy?.enabled === true
    || (strategy?.carry?.requiresAcknowledgement === true
      && unavailableReasons.length > 0
      && unavailableReasons.every((item) => item?.code === 'carry-acknowledgement-required'))
  for (const violation of violations) unavailableReasons.push({ code: violation, message: 'The preview cannot confirm that this request is within the current loop risk limits.' })
  if (fees.length !== 2) unavailableReasons.push({ code: 'swap-quotes-unavailable', message: 'Both the initial USDY acquisition and leverage swap need fee-aware provider quotes.' })
  const preview = {
    available: strategyExecutionEligible && violations.length === 0 && fees.length === 2,
    executionEnabled: false,
    exposure,
    limits: { maxLeverage: DEFAULT_LOOP_LIMITS.maxLeverage, projectedLtvPct: ltvLimitPct },
    risk: {
      projectedLtvPct: exposure.projectedLtvPct,
      liquidationLtvPct: Number(liquidationLimit.toString()),
      healthFactor: projectedLtv.gt(0) ? decimalText(liquidationLimit.div(projectedLtv)) : null,
      liquidationPriceUsd: liquidationPriceUsd ? decimalText(liquidationPriceUsd) : null,
      liquidationPriceDeclinePct: liquidationPriceDeclinePct ? decimalText(liquidationPriceDeclinePct) : null,
      violations,
    },
    carry: { ...(strategy?.carry ?? { estimatedCarryPct: null }), acknowledgementKey: null,
      ...(strategy?.carry?.requiresAcknowledgement ? { acknowledgementPolicyVersion: LOOP_ACK_POLICY_VERSION } : {}) },
    fees,
    costs: estimatedCosts.costs,
    knownCostsTotalUsd: estimatedCosts.knownCostsTotalUsd,
    feeTotalUsd: fees.every((fee) => fee.usd != null) ? fees.reduce((sum, fee) => sum + fee.usd, 0) : null,
    unavailableReasons,
  }
  preview.carry.acknowledgementKey = createLoopAcknowledgementKey({
    strategy, fundingAmount, leverage, acquisitionQuote, leverageQuote, preview, sdkPosition,
  })
  return preview
}

/** Use the installed Kamino SDK quote path while preserving the provider-native fee in the quoter callback. */
export function quoteMultiplyOpen(inputs, callbacks) {
  return getDepositWithLeverageSwapInputs({ ...inputs, quoter: callbacks.quoter })
}

/** Pin an exact route for the SDK's final integer-base-unit swap amount, including its price-based recalculation. */
export async function quoteMultiplyOpenAtFinalAmount(inputs, callbacks, quoteSdk = quoteMultiplyOpen, { maxIterations = 6 } = {}) {
  if (typeof quoteSdk !== 'function' || typeof callbacks?.quoter !== 'function' || typeof callbacks?.setPricingQuote !== 'function'
    || !Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 12) {
    throw new LoopPreviewError('Cannot converge the final SDK swap quote.')
  }
  let sdkPreview
  const attempts = []
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    sdkPreview = await quoteSdk(inputs, callbacks)
    const route = sdkPreview?.initialInputs?.swapQuote?.quoteResponse
    const swapInputs = sdkPreview?.swapInputs
    const finalAmount = rawAmount(swapInputs?.inputAmountLamports)
    attempts.push({ quotedAmountBaseUnits: route?.inputAmountBaseUnits ?? null, sdkAmountBaseUnits: finalAmount })
    const inputMint = String(swapInputs?.inputMint ?? route?.inputMint ?? '')
    const outputMint = String(swapInputs?.outputMint ?? route?.outputMint ?? '')
    if (!route || !inputMint || !outputMint || route.inputMint !== inputMint || route.outputMint !== outputMint) {
      throw new LoopPreviewError('Kamino SDK returned an invalid final swap quote.')
    }
    if (route.inputAmountBaseUnits === finalAmount) {
      callbacks.setPricingQuote(route)
      return { sdkPreview, leverageQuote: route }
    }
    if (iteration === maxIterations - 1) break
    callbacks.setPricingQuote(null)
    const finalQuote = await callbacks.quoter({
      inputMint,
      outputMint,
      inputAmountLamports: new Decimal(finalAmount),
    })
    const exactRoute = finalQuote?.quoteResponse
    if (!exactRoute || exactRoute.inputMint !== inputMint || exactRoute.outputMint !== outputMint
      || exactRoute.inputAmountBaseUnits !== finalAmount) {
      throw new LoopPreviewError('Router could not quote the SDK final swap amount exactly.')
    }
    callbacks.setPricingQuote(exactRoute)
  }
  // Jupiter's integer output rounding can make the SDK's derived input alternate between adjacent base units.
  // Resolve that narrow case with a fresh quote for the SDK's final input. The economic builder still re-quotes
  // that exact amount and its transaction simulation remains the execution authority.
  const adjacentRoundingOnly = attempts.length === maxIterations && attempts.every(({ quotedAmountBaseUnits, sdkAmountBaseUnits }) =>
    quotedAmountBaseUnits != null && /^\d+$/.test(quotedAmountBaseUnits) && /^\d+$/.test(sdkAmountBaseUnits)
      && (BigInt(quotedAmountBaseUnits) - BigInt(sdkAmountBaseUnits) <= 1n)
      && (BigInt(sdkAmountBaseUnits) - BigInt(quotedAmountBaseUnits) <= 1n))
  if (adjacentRoundingOnly && sdkPreview) {
    const swapInputs = sdkPreview.swapInputs
    const finalAmount = rawAmount(swapInputs?.inputAmountLamports)
    const inputMint = String(swapInputs?.inputMint ?? '')
    const outputMint = String(swapInputs?.outputMint ?? '')
    const finalQuote = await callbacks.quoter({ inputMint, outputMint, inputAmountLamports: new Decimal(finalAmount) })
    const route = finalQuote?.quoteResponse
    if (route?.inputMint === inputMint && route?.outputMint === outputMint && route?.inputAmountBaseUnits === finalAmount) {
      callbacks.setPricingQuote(route)
      const priorSwapQuote = sdkPreview.initialInputs?.swapQuote
      const normalizedPreview = priorSwapQuote ? {
        ...sdkPreview,
        initialInputs: { ...sdkPreview.initialInputs, swapQuote: { ...priorSwapQuote, quoteResponse: route } },
      } : sdkPreview
      return { sdkPreview: normalizedPreview, leverageQuote: route }
    }
  }
  throw new LoopPreviewError(`Kamino SDK final swap quote did not converge within ${maxIterations} iterations: ${JSON.stringify(attempts)}.`)
}

export function quoteMultiplyFullClose(inputs, callbacks) {
  return getWithdrawWithLeverageSwapInputs({ ...inputs, quoter: callbacks.quoter })
}

/** Compose Kamino's real leveraged-deposit instructions with the fee-aware Jupiter quote and swap callbacks. */
export function buildMultiplyOpenIxs(inputs, callbacks, builder = getDepositWithLeverageIxs) {
  if (typeof callbacks?.quoter !== 'function' || typeof callbacks?.swapper !== 'function') throw new LoopPreviewError('Open requires fee-aware quote and swap callbacks.')
  if (inputs?.obligation) {
    const deposits = inputs.obligation.refreshedStats?.userTotalDeposit
    const borrows = inputs.obligation.refreshedStats?.userTotalBorrow
    if (deposits == null || borrows == null) throw new LoopPreviewError('Cannot verify that the target Multiply obligation is empty; opening cannot top up an existing position.')
    if (positiveDecimal(deposits, 'existing obligation deposits', true).gt(0)
      || positiveDecimal(borrows, 'existing obligation debt', true).gt(0)) {
      throw new LoopPreviewError('A Multiply position already exists for this pair; opening cannot top it up.')
    }
  }
  const leverage = positiveDecimal(inputs?.targetLeverage, 'target leverage')
  if (leverage.lte(1) || leverage.gt(DEFAULT_LOOP_LIMITS.maxLeverage)) throw new LoopPreviewError('Target leverage must be above 1 and at most 1.5.')
  return builder({ ...inputs, obligationTypeTagOverride: ObligationTypeTag.Multiply, quoter: callbacks.quoter, swapper: callbacks.swapper })
}

/** Force the installed Kamino SDK close-position branch to withdraw the full collateral amount. */
export function buildMultiplyFullCloseIxs(inputs, callbacks, builder = getWithdrawWithLeverageIxs) {
  if (inputs?.isClosingPosition !== true) throw new LoopPreviewError('Full close requires the SDK full close branch.')
  if (!inputs.obligation || typeof callbacks?.quoter !== 'function' || typeof callbacks?.swapper !== 'function') {
    throw new LoopPreviewError('Full close requires the live obligation and fee-aware quote and swap callbacks.')
  }
  const deposited = positiveDecimal(inputs.deposited, 'obligation collateral amount')
  positiveDecimal(inputs.borrowed, 'obligation debt amount')
  return builder({ ...inputs, withdrawAmount: deposited, isClosingPosition: true, quoter: callbacks.quoter, swapper: callbacks.swapper })
}

async function assertComposableFeeRoute(route, inputMint, outputMint, {
  wallet,
  validateRoute = validateProviderSwapInstructions,
  authorizeRoute = async (candidate) => candidate?.programPolicy?.approved === true,
  now = Date.now(),
} = {}) {
  if (!route || route.inputMint !== inputMint || route.outputMint !== outputMint
    || route.fee?.bps !== 10 || route.fee?.mint !== outputMint || route.fee?.routeDeltaVerified !== true
    || route.feeAccountMint !== outputMint || route.feeAccountMintVerified !== true
    || typeof route.feeAccount !== 'string'
    || !Array.isArray(route.instructions) || route.instructions.length === 0) {
    throw new LoopPreviewError('Loop swap does not satisfy the shared router composition fee and route policy.')
  }
  if (typeof authorizeRoute !== 'function' || await authorizeRoute(route) !== true) {
    throw new LoopPreviewError('Loop swap route programs are not approved for this execution environment.')
  }
  if (!Number.isFinite(route.quoteAt) || now < route.quoteAt || now - route.quoteAt > 15_000) {
    throw new LoopPreviewError('Loop swap quote expired before atomic composition.')
  }
  if (typeof validateRoute !== 'function') throw new LoopPreviewError('Shared router route validation is unavailable.')
  try {
    await validateRoute({
      wallet,
      inputMint,
      outputMint,
      amountBaseUnits: route.inputAmountBaseUnits,
      slippageBps: route.slippageBps,
    }, route)
  } catch (error) {
    throw new LoopPreviewError(`Loop swap failed the shared router validator: ${error?.message ?? 'unsupported route.'}`)
  }
  return route.compositionValidated === true ? route : { ...route, compositionValidated: true }
}

function mergeApplicationParts({ routes, instructionGroups, lookupTables = [], simulationAccounts = [] }) {
  const feeEvents = routes.map((route) => ({
    account: route.feeAccount,
    mint: route.fee.mint,
    amountBaseUnits: String(route.fee.amountBaseUnits),
    bps: route.fee.bps,
  }))
  const routePrograms = routes.flatMap((route) => route.programIds ?? [])
  const routeLabels = [...new Set(routes.flatMap((route) => route.routeLabels ?? []))]
  const routeProgramIdsByLabel = {}
  const addressesByLookupTableAddress = {}
  for (const route of routes) for (const [label, programs] of Object.entries(route.routeProgramIdsByLabel ?? {})) {
    routeProgramIdsByLabel[label] = [...new Set([...(routeProgramIdsByLabel[label] ?? []), ...programs.map(String)])]
  }
  for (const route of routes) for (const [table, addresses] of Object.entries(route.addressesByLookupTableAddress ?? {})) {
    addressesByLookupTableAddress[table] = [...new Set([...(addressesByLookupTableAddress[table] ?? []), ...addresses.map(String)])]
  }
  const instructionPrograms = instructionGroups.flat().map((instruction) => String(instruction.programAddress))
  const routeTables = routes.flatMap((route) => Object.keys(route.addressesByLookupTableAddress ?? {}))
  const sdkTables = lookupTables.map((table) => typeof table === 'string' ? table : String(table?.address ?? ''))
  const instructions = instructionGroups.flat()
  if (instructions.length === 0 || instructions.length > 160) throw new LoopPreviewError('Atomic loop transaction has an invalid instruction count.')
  return {
    atomic: true,
    instructions,
    lookupTables: [...new Set([...routeTables, ...sdkTables].filter(Boolean))],
    feeEvents,
    programIds: [...new Set([...routePrograms, ...instructionPrograms].filter(Boolean))],
    routeLabels,
    routeProgramIdsByLabel,
    addressesByLookupTableAddress,
    simulationAccounts: [...new Set([...feeEvents.map((fee) => fee.account), ...simulationAccounts].filter(Boolean))],
    expiresAt: Math.min(...routes.map((route) => route.quoteAt + 15_000)),
  }
}

/** Compose the acquisition route and SDK Multiply-open instructions into exactly one economic transaction. */
export async function buildAtomicMultiplyOpenApplication({
  wallet,
  acquisitionQuote,
  sdkInputs,
  callbacks,
  validateRoute = validateProviderSwapInstructions,
  builder = getDepositWithLeverageIxs,
  now = Date.now(),
} = {}) {
  const initial = await assertComposableFeeRoute(acquisitionQuote, TOKENS['svm-usdc'].mint, TOKENS['svm-usdy'].mint, {
    wallet, validateRoute, authorizeRoute: callbacks.authorizeComposedRoute, now,
  })
  if (typeof wallet !== 'string' || !wallet || !sdkInputs || !callbacks) throw new LoopPreviewError('Open application builder inputs are incomplete.')
  const leverageTransactions = await buildMultiplyOpenIxs(sdkInputs, callbacks, builder)
  if (!Array.isArray(leverageTransactions) || leverageTransactions.length !== 1) {
    throw new LoopPreviewError('Open requires one Kamino SDK transaction; split economic fallback is disabled.')
  }
  const leverage = leverageTransactions[0]
  const leverageInputBaseUnits = leverage?.swapInputs?.inputAmountLamports?.toString() ?? null
  const capturedRoutes = typeof callbacks.composedQuotes === 'function' ? callbacks.composedQuotes() : []
  const composedLeverageRoute = capturedRoutes.filter((candidate) => candidate.inputMint === TOKENS['svm-usdc'].mint
    && candidate.outputMint === TOKENS['svm-usdy'].mint
    && (leverageInputBaseUnits == null || candidate.inputAmountBaseUnits === leverageInputBaseUnits)).at(-1)
  if (typeof callbacks.composedQuotes === 'function' && !composedLeverageRoute) {
    throw new LoopPreviewError('The exact fee-aware leverage route composed by Kamino could not be identified.')
  }
  const route = await assertComposableFeeRoute(composedLeverageRoute ?? leverage?.quote,
    TOKENS['svm-usdc'].mint, TOKENS['svm-usdy'].mint, {
      wallet, validateRoute, authorizeRoute: callbacks.authorizeComposedRoute, now: Math.max(now, Date.now()),
    })
  const instructions = composeAtomicOpenInstructions(initial.instructions, leverage.ixs ?? [])
  const application = mergeApplicationParts({
    routes: [initial, route],
    instructionGroups: [instructions],
    lookupTables: leverage.lookupTables ?? [],
    simulationAccounts: [sdkInputs.multiplyObligationAddress],
  })
  return {
    ...application,
    quotePlan: {
      acquisitionQuote: initial,
      leverageQuote: route,
      leverageSwapInputBaseUnits: leverageInputBaseUnits,
      leverageSwapMinimumOutputBaseUnits: leverage.swapInputs?.minOutAmountLamports?.toString() ?? null,
      flashBorrowFee: leverage.flashLoanInfo?.flashLoanFee?.toString() ?? null,
      collateralToDeposit: leverage.initialInputs?.calcs?.collTokenToDeposit?.toString() ?? null,
      debtToBorrow: leverage.initialInputs?.calcs?.debtTokenToBorrow?.toString() ?? null,
    },
  }
}

/** Compose the SDK's protocol full-close branch and its fee-aware collateral sale as one transaction. */
export async function buildAtomicMultiplyFullCloseApplication({
  sdkInputs,
  callbacks,
  wallet,
  validateRoute = validateProviderSwapInstructions,
  builder = getWithdrawWithLeverageIxs,
  now = Date.now(),
} = {}) {
  if (!sdkInputs || !callbacks) throw new LoopPreviewError('Full-close application builder inputs are incomplete.')
  const leverageTransactions = await buildMultiplyFullCloseIxs(sdkInputs, callbacks, builder)
  if (!Array.isArray(leverageTransactions) || leverageTransactions.length !== 1) {
    throw new LoopPreviewError('Full close requires one Kamino SDK transaction; split economic fallback is disabled.')
  }
  const leverage = leverageTransactions[0]
  const leverageInputBaseUnits = leverage?.swapInputs?.inputAmountLamports?.toString() ?? null
  const capturedRoutes = typeof callbacks.composedQuotes === 'function' ? callbacks.composedQuotes() : []
  const composedCloseRoute = capturedRoutes.filter((candidate) => candidate.inputMint === TOKENS['svm-usdy'].mint
    && candidate.outputMint === TOKENS['svm-usdc'].mint
    && (leverageInputBaseUnits == null || candidate.inputAmountBaseUnits === leverageInputBaseUnits)).at(-1)
  if (typeof callbacks.composedQuotes === 'function' && !composedCloseRoute) {
    throw new LoopPreviewError('The exact fee-aware close route composed by Kamino could not be identified.')
  }
  const route = await assertComposableFeeRoute(composedCloseRoute ?? leverage?.quote,
    TOKENS['svm-usdy'].mint, TOKENS['svm-usdc'].mint, {
    wallet: wallet ?? String(sdkInputs.owner?.address ?? sdkInputs.owner ?? ''), validateRoute, now: Math.max(now, Date.now()),
    authorizeRoute: callbacks.authorizeComposedRoute,
  })
  const application = mergeApplicationParts({
    routes: [route],
    instructionGroups: [leverage.ixs ?? []],
    lookupTables: leverage.lookupTables ?? [],
    simulationAccounts: [sdkInputs.positionObligationAddress],
  })
  return {
    ...application,
    quotePlan: {
      closeQuote: route,
      closeSwapInputBaseUnits: leverageInputBaseUnits,
      closeSwapMinimumOutputBaseUnits: leverage.swapInputs?.minOutAmountLamports?.toString() ?? null,
      flashBorrowFee: leverage.flashLoanInfo?.flashLoanFee?.toString() ?? null,
    },
  }
}

/** Compare simulated token-account deltas with composed router fees, allowing bounded raw-unit rounding. */
export function verifyAtomicLoopFeeDeltas(feeEvents, tokenDeltas) {
  if (!Array.isArray(feeEvents) || !feeEvents.length || !Array.isArray(tokenDeltas)) {
    throw new LoopPreviewError('Atomic loop fee balance deltas are unavailable.')
  }
  const expected = new Map()
  const eventCounts = new Map()
  for (const fee of feeEvents) {
    if (typeof fee?.account !== 'string' || typeof fee.mint !== 'string'
      || !/^[1-9]\d*$/.test(String(fee.amountBaseUnits)) || fee.bps !== 10) {
      throw new LoopPreviewError('Atomic loop contains an invalid router fee event.')
    }
    const key = `${fee.account}:${fee.mint}`
    expected.set(key, (expected.get(key) ?? 0n) + BigInt(fee.amountBaseUnits))
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1)
  }
  const actual = new Map()
  for (const delta of tokenDeltas) {
    if (typeof delta?.account !== 'string' || typeof delta.mint !== 'string' || !/^[1-9]\d*$/.test(String(delta.deltaBaseUnits))) {
      throw new LoopPreviewError('Atomic loop fee account balance delta is invalid.')
    }
    const key = `${delta.account}:${delta.mint}`
    if (actual.has(key)) throw new LoopPreviewError('Atomic loop fee account balance delta is duplicated.')
    actual.set(key, BigInt(delta.deltaBaseUnits))
  }
  if (expected.size !== actual.size || [...expected].some(([key, amount]) => {
    const collected = actual.get(key)
    const roundingAllowance = BigInt(eventCounts.get(key) ?? 0) * MAX_ROUTER_FEE_ROUNDING_BASE_UNITS
    return collected == null || collected > amount + roundingAllowance || amount > collected + roundingAllowance
  })) {
    throw new LoopPreviewError('Atomic loop simulated fee account balance delta does not match the router fee.')
  }
  return [...expected].map(([key, amount]) => {
    const separator = key.lastIndexOf(':')
    return { account: key.slice(0, separator), mint: key.slice(separator + 1), deltaBaseUnits: String(actual.get(key)) }
  })
}

function currentUsdYUsdcContext(wallet) {
  const owner = address(wallet)
  const marketConfig = LIVE.find((market) => market.id === 'sol-usdy-usdc')
  if (!marketConfig) throw new LoopPreviewError('The USDY/USDC Multiply market is not configured.')
  const { market, now: currentLedgerInstant } = getLive(marketConfig)
  const collateral = TOKENS['svm-usdy']
  const liability = TOKENS['svm-usdc']
  const collateralReserve = reserveOf(market, collateral)
  const liabilityReserve = reserveOf(market, liability)
  return { owner, marketConfig, market, currentLedgerInstant, collateral, liability, collateralReserve, liabilityReserve }
}

/** Use Kamino's own SDK builder for the documented metadata-only setup; do not mix it with economic actions. */
export async function buildLoopMetadataSetupBundle({ kaminoMarket, owner, payer = owner, referrer = none(), sdkBuilder } = {}) {
  if (!kaminoMarket || !owner?.address || typeof kaminoMarket.getUserMetadata !== 'function') {
    throw new LoopPreviewError('Kamino metadata setup dependencies are incomplete.')
  }
  const [metadataAddress, existing] = await kaminoMarket.getUserMetadata(owner.address)
  if (existing) return { required: false, metadataAddress: String(metadataAddress) }
  const buildSetup = sdkBuilder ?? ((args) => KaminoAction.buildUserMetadataSetupIxs(args))
  const setupBundle = await buildSetup({
    kaminoMarket, owner, payer, referrer,
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
  })
  if (!Array.isArray(setupBundle?.ixs) || setupBundle.ixs.length !== 1
    || String(setupBundle.ixs[0]?.programAddress) !== String(PROGRAM_ID)) {
    throw new LoopPreviewError('Kamino metadata setup did not produce the expected single SDK initialization instruction.')
  }
  if ((setupBundle.luts ?? []).length) throw new LoopPreviewError('Kamino metadata setup unexpectedly requires lookup-table creation.')
  return { required: true, metadataAddress: String(metadataAddress), ixs: setupBundle.ixs }
}

/** Read the wallet-specific one-time setup state without building or exposing transaction instructions. */
export async function loopMetadataStatus({ wallet } = {}) {
  if (typeof wallet !== 'string' || !wallet) throw new LoopPreviewError('Wallet address is required for Kamino metadata status.')
  await refreshMarketForExecution()
  const fresh = currentUsdYUsdcContext(wallet)
  const [metadataAddress, metadata] = await fresh.market.getUserMetadata(fresh.owner)
  if (metadata && String(metadata.owner) !== wallet) throw new LoopPreviewError('Kamino UserMetadata owner does not match this wallet.')
  return { required: !metadata, metadataAddress: String(metadataAddress) }
}

/** Build the SDK's documented one-time metadata initialization as an isolated, non-economic setup transaction. */
export async function buildLoopMetadataSetupApplication({ wallet } = {}) {
  if (typeof wallet !== 'string' || !wallet) throw new LoopPreviewError('Wallet address is required for Kamino metadata setup.')
  await refreshMarketForExecution()
  const fresh = currentUsdYUsdcContext(wallet)
  const owner = createNoopSigner(fresh.owner)
  const [, existing] = await fresh.market.getUserMetadata(fresh.owner)
  if (existing && String(existing.owner) !== wallet) throw new LoopPreviewError('Kamino UserMetadata owner does not match this wallet.')
  const setup = await buildLoopMetadataSetupBundle({ kaminoMarket: fresh.market, owner, payer: owner })
  if (!setup.required) return { required: false, metadataAddress: setup.metadataAddress }
  return {
    required: true,
    atomic: true,
    kind: 'loop-setup',
    instructions: setup.ixs,
    lookupTables: [],
    programIds: [String(PROGRAM_ID)],
    simulationAccounts: [setup.metadataAddress],
    feeEvents: [],
    ownerTokenAccounts: [],
    expiresAt: Date.now() + 15_000,
    simulationContext: { kind: 'loop-setup', wallet, metadataAddress: setup.metadataAddress },
  }
}

/** Setup must create the exact owner-bound Kamino UserMetadata PDA before it is offered to the wallet. */
export function verifyLoopMetadataSetupSimulation({ built, simulation } = {}) {
  const context = built?.simulationContext
  if (!context || context.kind !== 'loop-setup' || simulation?.ok !== true) return false
  const data = simulation.accountData?.get(context.metadataAddress)
  if (!(data instanceof Uint8Array)) return false
  try {
    const metadata = UserMetadata.decode(Buffer.from(data))
    return String(metadata.owner) === context.wallet
  } catch { return false }
}

/** Build a fresh atomic USDY Multiply open from the exact wallet-bound read-only preview context. */
export async function buildLoopOpenApplication({
  wallet, amount, leverage, preview, now = Date.now(),
  flashBorrowType = 'coll',
  validateRoute = validateProviderSwapInstructions,
  refreshMarket = refreshMarketForExecution,
  contextReader = currentUsdYUsdcContext,
  applicationBuilder = buildAtomicMultiplyOpenApplication,
} = {}) {
  const application = preview?.applicationContext
  if (!application || application.wallet !== wallet || application.fundingAmount !== amount
    || Number(application.leverage) !== Number(leverage)) {
    throw new LoopPreviewError('The exact server-side loop preview is unavailable; build a fresh preview.')
  }
  await refreshMarket()
  const fresh = contextReader(wallet)
  const freshRisk = assertCurrentLoopMarketRisk(preview.sdk?.marketRisk, fresh)
  const [, userMetadata] = await fresh.market.getUserMetadata(fresh.owner)
  if (!userMetadata || String(userMetadata.owner) !== wallet) {
    throw new LoopPreviewError('Initialize this wallet’s Kamino UserMetadata account before opening a Multiply position.')
  }
  const multiplyType = getObligationType(fresh.market, ObligationTypeTag.Multiply,
    some(fresh.collateralReserve.address), some(fresh.liabilityReserve.address))
  const existing = await fresh.market.getObligationByWallet(fresh.owner, multiplyType)
  if (existing) {
    const deposits = existing.refreshedStats?.userTotalDeposit
    const debt = existing.refreshedStats?.userTotalBorrow
    if (deposits == null || debt == null || positiveDecimal(deposits, 'existing Multiply deposits', true).gt(0)
      || positiveDecimal(debt, 'existing Multiply debt', true).gt(0)) {
      throw new LoopPreviewError('A Multiply position already exists for this pair; opening cannot top it up.')
    }
  }
  const multiplyObligationAddress = await multiplyType.toPda(address(fresh.marketConfig.kaminoMarket), fresh.owner)
  const acquiredCollateral = new Decimal(application.acquisitionQuote.outputAmountBaseUnits)
    .div(new Decimal(10).pow(fresh.collateral.decimals))
  const collateralPrice = positiveDecimal(freshRisk.collateralPriceUsd, 'USDY oracle price')
  const liabilityPrice = positiveDecimal(freshRisk.liabilityPriceUsd, 'USDC oracle price')
  const sdkInputs = {
    owner: createNoopSigner(fresh.owner),
    kaminoMarket: fresh.market,
    debtReserveAddress: fresh.liabilityReserve.address,
    collReserveAddress: fresh.collateralReserve.address,
    depositAmount: acquiredCollateral,
    priceDebtToColl: liabilityPrice.div(collateralPrice),
    slippagePct: sdkSlippagePctFromBps(50),
    obligation: existing,
    referrer: none(),
    currentLedgerInstant: fresh.currentLedgerInstant,
    targetLeverage: new Decimal(String(leverage)),
    flashBorrowType,
    selectedTokenMint: address(fresh.collateral.mint),
    obligationTypeTagOverride: ObligationTypeTag.Multiply,
    scopeRefreshIx: [],
    budgetAndPriorityFeeIxs: [],
    quoteBufferBps: new Decimal(0),
    useV2Ixs: true,
    logger: () => {},
    multiplyObligationAddress: String(multiplyObligationAddress),
  }
  application.callbacks?.beginComposition?.()
  let built
  try {
    built = await applicationBuilder({
      wallet,
      acquisitionQuote: application.acquisitionQuote,
      sdkInputs,
      callbacks: application.callbacks,
      validateRoute,
      now,
    })
  } finally { application.callbacks?.sealQuotes?.() }
  if (built.quotePlan.acquisitionQuote !== application.acquisitionQuote
    || built.quotePlan.leverageQuote !== application.leverageQuote
    || built.quotePlan.leverageSwapInputBaseUnits !== preview.sdk?.leverageSwapInputBaseUnits
    || built.quotePlan.leverageSwapMinimumOutputBaseUnits !== preview.sdk?.leverageSwapMinimumOutputBaseUnits
    || built.quotePlan.flashBorrowFee !== preview.sdk?.flashBorrowFee
    || built.quotePlan.collateralToDeposit !== preview.sdk?.collateralToDeposit
    || built.quotePlan.debtToBorrow !== preview.sdk?.debtToBorrow) {
    throw new LoopPreviewError('Loop economics changed after preview; build a fresh preview before opening.')
  }
  const [walletUsdc, walletUsdy] = await Promise.all([
    ataOf(fresh.owner, address(fresh.liability.mint), fresh.liabilityReserve.getLiquidityTokenProgram()),
    ataOf(fresh.owner, address(fresh.collateral.mint), fresh.collateralReserve.getLiquidityTokenProgram()),
  ])
  const collateralExchangeRate = fresh.collateralReserve.getEstimatedCollateralExchangeRate(
    fresh.currentLedgerInstant, fresh.market.state.referralFeeBps,
  )
  const authorizedCollateral = sdkDepositPositionBaseUnitsWithExchangeRate(
    preview.sdk.collateralToDeposit, fresh.collateralReserve.stats.decimals, collateralExchangeRate,
  )
  const authorizedDebtBaseUnits = sdkBorrowDebtBaseUnitsWithProtocolFee(
    preview.sdk.debtToBorrow, fresh.liabilityReserve.stats.decimals, fresh.market, fresh.liabilityReserve, false,
  )
  const maxProjectedLtvPct = projectedLtvLimitPct(
    freshRisk.maxBorrowLtvPct,
    freshRisk.liquidationLtvPct,
    Number(preview.limits?.projectedLtvPct),
  )
  return {
    ...built,
    ownerTokenAccounts: [
      { account: String(walletUsdc), mint: fresh.liability.mint },
      { account: String(walletUsdy), mint: fresh.collateral.mint },
    ],
    simulationAccounts: [...built.simulationAccounts, String(multiplyObligationAddress)],
    simulationContext: {
      kind: 'loop-open', wallet,
      market: fresh.market,
      marketAddress: fresh.marketConfig.kaminoMarket,
      currentLedgerInstant: fresh.currentLedgerInstant,
      positionObligationAddress: String(multiplyObligationAddress),
      collateralReserveAddress: String(fresh.collateralReserve.address),
      liabilityReserveAddress: String(fresh.liabilityReserve.address),
      collateralMintFactor: String(fresh.collateralReserve.getMintFactor()),
      liabilityMintFactor: String(fresh.liabilityReserve.getMintFactor()),
      fundingBaseUnits: application.fundingBaseUnits,
      collateralExchangeRate: String(collateralExchangeRate),
      authorizedPosition: {
        collateralAmount: decimalText(new PreciseDecimal(authorizedCollateral.positionRawAmount)
          .div(positiveDecimal(fresh.collateralReserve.getMintFactor(), 'collateral mint factor'))),
        collateralBaseUnits: authorizedCollateral.positionBaseUnits,
        collateralCTokenBaseUnits: authorizedCollateral.cTokenBaseUnits,
        liquidityBaseUnits: authorizedCollateral.liquidityBaseUnits,
        debtAmount: decimalText(new PreciseDecimal(authorizedDebtBaseUnits)
          .div(positiveDecimal(fresh.liabilityReserve.getMintFactor(), 'liability mint factor'))),
        debtBaseUnits: authorizedDebtBaseUnits,
        collateralPriceUsd: freshRisk.collateralPriceUsd,
        debtPriceUsd: freshRisk.liabilityPriceUsd,
        maxProjectedLtvPct,
        maxLeverage: Math.min(Number(preview.limits?.maxLeverage), DEFAULT_LOOP_LIMITS.maxLeverage),
      },
    },
  }
}

/** Build a fresh protocol full-close transaction only for the exact wallet-owned Nysa Multiply PDA. */
export async function buildLoopCloseApplication({
  wallet, position,
  flashBorrowType = 'coll',
  validateRoute = validateProviderSwapInstructions,
  localForkSimulation = false,
  localForkRpcUrl,
  localRouteProgramVerifier,
  refreshMarket = refreshMarketForExecution,
  contextReader = currentUsdYUsdcContext,
  callbacks: suppliedCallbacks,
  applicationBuilder = buildAtomicMultiplyFullCloseApplication,
} = {}) {
  if (!position || position.wallet !== wallet || position.market?.id !== 'sol-usdy-usdc'
    || position.obligation?.type !== 'multiply') throw new LoopPreviewError('The selected Multiply position is not owned by this wallet.')
  await refreshMarket()
  const fresh = contextReader(wallet)
  const multiplyType = getObligationType(fresh.market, ObligationTypeTag.Multiply,
    some(fresh.collateralReserve.address), some(fresh.liabilityReserve.address))
  const obligationAddress = await multiplyType.toPda(address(fresh.marketConfig.kaminoMarket), fresh.owner)
  if (String(obligationAddress) !== position.obligation.address) throw new LoopPreviewError('Multiply obligation identity changed; refresh the selected position.')
  const obligation = await fresh.market.getObligationByWallet(fresh.owner, multiplyType)
  if (!obligation || String(obligation.obligationAddress) !== position.obligation.address || String(obligation.state.owner) !== wallet) {
    throw new LoopPreviewError('The selected Multiply obligation is no longer owned by this wallet.')
  }
  assertSupportedLoopObligationReserves(obligation, fresh.collateralReserve.address, fresh.liabilityReserve.address)
  const depositedRaw = obligation.getDepositByReserve(fresh.collateralReserve.address)?.amount ?? 0
  const borrowedRaw = obligation.getBorrowByReserve(fresh.liabilityReserve.address)?.amount ?? 0
  const deposited = new Decimal(String(depositedRaw)).div(String(fresh.collateralReserve.getMintFactor()))
  const borrowed = new Decimal(String(borrowedRaw)).div(String(fresh.liabilityReserve.getMintFactor()))
  if (!deposited.gt(0)) throw new LoopPreviewError('The selected Multiply obligation has no collateral to close.')
  const collateralPrice = positiveDecimal(fresh.collateralReserve.getOracleMarketPrice(), 'USDY oracle price')
  const liabilityPrice = positiveDecimal(fresh.liabilityReserve.getOracleMarketPrice(), 'USDC oracle price')
  const callbacks = suppliedCallbacks ?? createKaminoSwapCallbacks({ wallet, validateRoute, localForkSimulation, localForkRpcUrl, localRouteProgramVerifier })
  const sdkInputs = {
    owner: createNoopSigner(fresh.owner),
    kaminoMarket: fresh.market,
    debtReserveAddress: fresh.liabilityReserve.address,
    collReserveAddress: fresh.collateralReserve.address,
    obligation,
    deposited,
    borrowed,
    withdrawAmount: deposited,
    priceCollToDebt: collateralPrice.div(liabilityPrice),
    slippagePct: sdkSlippagePctFromBps(50),
    isClosingPosition: true,
    selectedTokenMint: address(fresh.collateral.mint),
    budgetAndPriorityFeeIxs: [],
    scopeRefreshIx: [],
    quoteBufferBps: new Decimal(0),
    currentLedgerInstant: fresh.currentLedgerInstant,
    userSolBalanceLamports: 0,
    useV2Ixs: true,
    flashBorrowType,
    positionObligationAddress: String(obligationAddress),
  }
  callbacks.setPricingQuote?.(null)
  callbacks.beginComposition?.()
  let built
  try { built = await applicationBuilder({ sdkInputs, callbacks, wallet, validateRoute }) }
  finally { callbacks.sealQuotes?.() }
  const [walletUsdc, walletUsdy] = await Promise.all([
    ataOf(fresh.owner, address(fresh.liability.mint), fresh.liabilityReserve.getLiquidityTokenProgram()),
    ataOf(fresh.owner, address(fresh.collateral.mint), fresh.collateralReserve.getLiquidityTokenProgram()),
  ])
  return {
    ...built,
    ownerTokenAccounts: [
      { account: String(walletUsdc), mint: fresh.liability.mint },
      { account: String(walletUsdy), mint: fresh.collateral.mint },
    ],
    simulationAccounts: [...built.simulationAccounts, String(obligationAddress)],
    simulationContext: {
      kind: 'loop-close', wallet,
      market: fresh.market,
      marketAddress: fresh.marketConfig.kaminoMarket,
      currentLedgerInstant: fresh.currentLedgerInstant,
      positionObligationAddress: String(obligationAddress),
      collateralReserveAddress: String(fresh.collateralReserve.address),
      liabilityReserveAddress: String(fresh.liabilityReserve.address),
      collateralMintFactor: String(fresh.collateralReserve.getMintFactor()),
      liabilityMintFactor: String(fresh.liabilityReserve.getMintFactor()),
    },
  }
}

/** Simulate the composed instruction set and read the Multiply obligation from the simulated account image. */
export async function simulateLoopApplication({ built, compiled, simulate = simulateAtomicTransaction } = {}) {
  if (!built?.simulationContext) throw new LoopPreviewError('Loop simulation context is unavailable.')
  const tokenAccounts = [...new Map([...built.feeEvents, ...built.ownerTokenAccounts]
    .map((item) => [`${item.account}:${item.mint}`, { account: item.account, mint: item.mint }])).values()]
  const simulated = await simulate({ compiled, accounts: built.simulationAccounts, tokenAccounts })
  const context = built.simulationContext
  if (context.kind === 'loop-setup') return simulated
  const accountData = simulated.accountData.get(context.positionObligationAddress)
  const accountOwner = simulated.accountOwners?.get(context.positionObligationAddress)
  if (context.kind === 'loop-close' && accountData instanceof Uint8Array && accountData.length === 0
    && accountOwner === DEFAULT_RESERVE_ADDRESS) {
    // Kamino may close the Multiply PDA on a full close. Its system-owned empty post-state is
    // the protocol's zero-position representation; the pre-build path already verified PDA ownership.
    simulated.remainingDebtBaseUnits = '0'
    simulated.positionOwner = context.wallet
    simulated.positionCollateralBaseUnits = '0'
    simulated.positionCollateralCTokenBaseUnits = '0'
    simulated.positionDebtBaseUnits = '0'
    simulated.obligationBalances = { deposits: [], borrows: [] }
    simulated.positionCollateralAmount = '0'
    simulated.positionDebtAmount = '0'
    simulated.positionClosed = true
    return simulated
  }
  if (!(accountData instanceof Uint8Array)) throw new LoopPreviewError('Simulation did not return the selected Multiply obligation account.')
  let obligation
  try {
    obligation = KaminoObligation.fromAccountData(
      new Map([[address(context.marketAddress), context.market]]),
      address(context.positionObligationAddress),
      Buffer.from(accountData),
      context.currentLedgerInstant,
    )
  } catch {
    throw new LoopPreviewError(`Simulated Multiply obligation could not be decoded (kind=${context.kind}, owner=${accountOwner ?? 'missing'}, dataLength=${accountData.length}).`)
  }
  if (!obligation || String(obligation.state.owner) !== context.wallet) throw new LoopPreviewError('Simulated Multiply obligation owner did not verify.')
  const collateral = obligation.getDepositByReserve(address(context.collateralReserveAddress))?.amount ?? 0
  const debt = obligation.getBorrowByReserve(address(context.liabilityReserveAddress))?.amount ?? 0
  const collateralBaseUnits = obligationRawAmountBaseUnits(collateral)
  const collateralCTokenBaseUnits = obligationDepositCTokenBaseUnits(obligation, address(context.collateralReserveAddress))
  const debtBaseUnits = obligationRawAmountBaseUnits(debt)
  simulated.remainingDebtBaseUnits = debtBaseUnits
  simulated.positionOwner = String(obligation.state.owner)
  simulated.positionCollateralBaseUnits = collateralBaseUnits
  simulated.positionCollateralCTokenBaseUnits = collateralCTokenBaseUnits
  simulated.positionDebtBaseUnits = debtBaseUnits
  simulated.obligationBalances = obligationSimulationBalances(obligation)
  simulated.positionCollateralAmount = decimalText(new PreciseDecimal(String(collateral))
    .div(positiveDecimal(context.collateralMintFactor, 'collateral mint factor')))
  simulated.positionDebtAmount = decimalText(new Decimal(debtBaseUnits).div(context.liabilityMintFactor))
  return simulated
}

/** Verify the fee events and post-state before an exact-message intent may be issued. */
export function verifyLoopApplicationSimulation({ kind, built, simulation } = {}) {
  const context = built?.simulationContext
  if (!context || context.kind !== kind || simulation?.ok !== true || simulation.positionOwner !== context.wallet) return false
  const feeAccounts = new Set(built.feeEvents.map((fee) => `${fee.account}:${fee.mint}`))
  const feeDeltas = simulation.tokenDeltas.filter((delta) => feeAccounts.has(`${delta.account}:${delta.mint}`))
  try { verifyAtomicLoopFeeDeltas(built.feeEvents, feeDeltas) } catch { return false }
  if (kind === 'loop-open') {
    const usdc = TOKENS['svm-usdc']
    const usdy = TOKENS['svm-usdy']
    const inputAccount = built.ownerTokenAccounts.find((item) => item.mint === usdc.mint)
    const collateralAccount = built.ownerTokenAccounts.find((item) => item.mint === usdy.mint)
    const inputDelta = simulation.tokenDeltas.find((item) => item.account === inputAccount?.account && item.mint === usdc.mint)?.deltaBaseUnits
    const collateralDelta = simulation.tokenDeltas.find((item) => item.account === collateralAccount?.account && item.mint === usdy.mint)?.deltaBaseUnits
    const authorized = context.authorizedPosition
    if (!authorized || !inputAccount || !collateralAccount || inputDelta !== `-${context.fundingBaseUnits}`
      || !/^-?\d+$/.test(String(collateralDelta)) || BigInt(collateralDelta) < 0n) return false
    try {
      if (!/^\d+$/.test(String(simulation.positionCollateralBaseUnits))
        || !/^\d+$/.test(String(simulation.positionCollateralCTokenBaseUnits))
        || !/^\d+$/.test(String(simulation.positionDebtBaseUnits))
        || !/^\d+$/.test(String(authorized.collateralBaseUnits))
        || !/^\d+$/.test(String(authorized.collateralCTokenBaseUnits))
        || !/^\d+$/.test(String(authorized.debtBaseUnits))
        || simulation.positionCollateralBaseUnits !== authorized.collateralBaseUnits
        || simulation.positionCollateralCTokenBaseUnits !== authorized.collateralCTokenBaseUnits
        || simulation.positionDebtBaseUnits !== authorized.debtBaseUnits) return false
      const collateralAmount = positiveDecimal(simulation.positionCollateralAmount, 'simulated collateral amount')
      const debtAmount = positiveDecimal(new PreciseDecimal(simulation.positionDebtBaseUnits)
        .div(positiveDecimal(context.liabilityMintFactor, 'liability mint factor')), 'simulated debt amount')
      const expectedCollateral = positiveDecimal(authorized.collateralAmount, 'approved collateral amount')
      const expectedDebt = positiveDecimal(new PreciseDecimal(authorized.debtBaseUnits)
        .div(positiveDecimal(context.liabilityMintFactor, 'liability mint factor')), 'approved debt amount')
      const collateralPrice = positiveDecimal(authorized.collateralPriceUsd, 'approved collateral price')
      const debtPrice = positiveDecimal(authorized.debtPriceUsd, 'approved debt price')
      const collateralUsd = collateralAmount.mul(collateralPrice)
      const debtUsd = debtAmount.mul(debtPrice)
      const ltvPct = debtUsd.div(collateralUsd).mul(100)
      const leverage = collateralUsd.div(collateralUsd.minus(debtUsd))
      return collateralAmount.eq(expectedCollateral)
        && debtAmount.eq(expectedDebt)
        && debtUsd.lt(collateralUsd)
        && ltvPct.lte(positiveDecimal(authorized.maxProjectedLtvPct, 'approved projected LTV'))
        && leverage.lte(positiveDecimal(authorized.maxLeverage, 'approved leverage'))
    } catch { return false }
  }
  if (kind === 'loop-close') {
    const ownerDeltas = simulation.tokenDeltas.filter((item) => built.ownerTokenAccounts.some((account) => account.account === item.account && account.mint === item.mint))
    const usdc = TOKENS['svm-usdc']
    const balances = simulation.obligationBalances
    const exactZero = (value) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && !/[1-9]/.test(value)
    const allCollateralZero = Array.isArray(balances?.deposits) && balances.deposits.every((item) =>
      typeof item?.reserve === 'string' && exactZero(item.cTokenBaseUnits) && exactZero(item.amountBaseUnits))
    const allDebtZero = Array.isArray(balances?.borrows) && balances.borrows.every((item) =>
      typeof item?.reserve === 'string' && exactZero(item.amountScaled) && exactZero(item.amountBaseUnits))
    return simulation.remainingDebtBaseUnits === '0'
      && new Decimal(String(simulation.positionCollateralAmount ?? '-1')).isZero()
      && allCollateralZero && allDebtZero
      && ownerDeltas.every((item) => /^-?\d+$/.test(item.deltaBaseUnits) && BigInt(item.deltaBaseUnits) >= 0n)
      && ownerDeltas.some((item) => item.mint === usdc.mint && BigInt(item.deltaBaseUnits) > 0n)
  }
  return false
}

/**
 * Build a quote-only USDY Multiply preview with the installed Kamino SDK and shared fee-aware Jupiter adapter.
 * It never returns instructions, simulates an economic transaction, or offers a signer path.
 */
export async function buildReadOnlyLoopPreview({ wallet, fundingAmount, leverage, snapshot, strategy, now = Date.now(), signal, onApplicationContext,
  localForkSimulation = false, localForkRpcUrl, localRouteProgramVerifier } = {}) {
  const collateral = TOKENS['svm-usdy']
  const liability = TOKENS['svm-usdc']
  const fundingBaseUnits = parseBaseUnits(String(fundingAmount), liability.decimals).toString()
  const initialFeeAccount = configuredFeeAccountForMint(collateral.mint)
  const strategyView = strategy ?? { enabled: false, unavailableReasons: [], carry: { estimatedCarryPct: null } }
  const reserves = snapshot?.reserves ?? {}
  const limits = {
    maxBorrowLtvPct: reserves[collateral.token_id]?.maxLtv,
    liquidationLtvPct: reserves[collateral.token_id]?.liqLtv,
  }
  if (!initialFeeAccount) return {
    ...buildLoopPreview({ fundingAmount, leverage, strategy: strategyView, ...limits }),
    quoteStatus: 'fee-account-unavailable',
    quoteError: 'The USDY fee account is not configured.',
  }
  if (!rpc) return {
    ...buildLoopPreview({ fundingAmount, leverage, strategy: strategyView, ...limits }),
    quoteStatus: 'rpc-unavailable',
    quoteError: 'Backend RPC is not configured.',
  }

  const live = getLive({ id: 'sol-usdy-usdc' })
  const market = live.market
  const collReserve = reserveOf(market, collateral)
  const debtReserve = reserveOf(market, liability)
  const marketRisk = loopSdkMarketRisk(collReserve, debtReserve)
  const marketBlockTime = Number(live.now?.blockTime)
  const taker = wallet || '11111111111111111111111111111111'
  let acquisitionQuote = await buildSwap({
    inputMint: liability.mint,
    outputMint: collateral.mint,
    inputAmountBaseUnits: fundingBaseUnits,
    wallet: taker,
    feeAccount: initialFeeAccount.account,
    feeAccountMint: collateral.mint,
    slippageBps: 50,
    signal,
  })
  const validatePreviewRoute = async (request, built) => {
    if (!localForkSimulation) return validateProviderSwapInstructions(request, built)
    if (typeof localRouteProgramVerifier !== 'function' || !await localRouteProgramVerifier(built)) {
      throw new LoopPreviewError('The local route does not use only the approved DEX and executable programs cloned into Surfpool.')
    }
    return validateProviderSwapInstructions(request, { ...built, programPolicy: { approved: true, unreviewed: [] } })
  }
  acquisitionQuote = await assertComposableFeeRoute(acquisitionQuote, liability.mint, collateral.mint, {
    wallet: taker,
    validateRoute: validatePreviewRoute,
    authorizeRoute: async (route) => localForkSimulation
      ? route?.fee?.routeDeltaVerified === true && route?.feeAccountMintVerified === true
        && typeof localRouteProgramVerifier === 'function' && await localRouteProgramVerifier(route)
      : route?.programPolicy?.approved === true,
    now: Math.max(now, Date.now()),
  })
  const acquiredCollateral = new Decimal(acquisitionQuote.outputAmountBaseUnits).div(new Decimal(10).pow(collateral.decimals))
  const callbacks = createKaminoSwapCallbacks({ wallet: taker, slippageBps: 49, signal, routeQuotes: [acquisitionQuote],
    localForkSimulation, localForkRpcUrl, localRouteProgramVerifier, validateRoute: validatePreviewRoute })
  const sdkQuote = await quoteMultiplyOpenAtFinalAmount({
    owner: createNoopSigner(address(taker)),
    kaminoMarket: market,
    debtReserveAddress: debtReserve.address,
    collReserveAddress: collReserve.address,
    depositAmount: acquiredCollateral,
    priceDebtToColl: new Decimal(marketRisk.liabilityPriceUsd).div(marketRisk.collateralPriceUsd),
    slippagePct: sdkSlippagePctFromBps(50),
    obligation: null,
    referrer: none(),
    currentLedgerInstant: live.now,
    targetLeverage: new Decimal(String(leverage)),
    selectedTokenMint: address(collateral.mint),
    obligationTypeTagOverride: ObligationTypeTag.Multiply,
    scopeRefreshIx: [],
    budgetAndPriorityFeeIxs: [],
    quoteBufferBps: new Decimal(0),
    useV2Ixs: true,
    logger: () => {},
  }, callbacks)
  const sdkPreview = sdkQuote.sdkPreview
  const leverageQuote = sdkQuote.leverageQuote
  callbacks.sealQuotes()
  const oracleAges = [marketRisk.collateralOracleTimestamp, marketRisk.liabilityOracleTimestamp]
    .map((timestamp) => marketBlockTime - timestamp)
  const heartbeats = [marketRisk.collateralOracleHeartbeatSeconds, marketRisk.liabilityOracleHeartbeatSeconds]
  const quoteTimes = [acquisitionQuote.quoteAt, leverageQuote?.quoteAt]
  const riskInputs = {
    slippageBps: 50,
    priceImpactPct: Math.max(acquisitionQuote.priceImpactPct, leverageQuote?.priceImpactPct ?? Infinity),
    quoteAgeSeconds: Math.max(...quoteTimes.map((at) => at == null ? Infinity : (now - at) / 1000)),
    oracleAgeSeconds: Math.max(...oracleAges),
    oracleHeartbeatSeconds: Math.min(...heartbeats),
  }
  const feePricesUsd = {
    [collateral.mint]: Number(marketRisk.collateralPriceUsd),
    [liability.mint]: Number(marketRisk.liabilityPriceUsd),
  }
  const freshLimits = {
    maxBorrowLtvPct: marketRisk.maxBorrowLtvPct,
    liquidationLtvPct: marketRisk.liquidationLtvPct,
  }
  const result = {
    ...buildLoopPreview({
      fundingAmount,
      leverage,
      strategy: strategyView,
      ...freshLimits,
      riskInputs,
      acquisitionQuote,
      leverageQuote,
      feePricesUsd,
      sdkPosition: {
        collateralMint: collateral.mint,
        collateralDecimals: collReserve.stats.decimals,
        collateralAmount: sdkPreview.initialInputs.calcs.collTokenToDeposit,
        collateralPriceUsd: marketRisk.collateralPriceUsd,
        liabilityMint: liability.mint,
        liabilityDecimals: debtReserve.stats.decimals,
        debtBorrowAmount: sdkPreview.initialInputs.calcs.debtTokenToBorrow,
        borrowFeeRatio: debtReserve.getBorrowFee(),
        liabilityPriceUsd: marketRisk.liabilityPriceUsd,
        flashBorrowAmount: sdkPreview.initialInputs.calcs.flashBorrowInCollToken,
        flashFeeRatio: sdkPreview.flashLoanInfo.flashLoanFee,
      },
    }),
    quoteStatus: 'quoted',
    quoteAt: Math.min(...quoteTimes),
    sdk: {
      marketRisk,
      flashBorrowFee: sdkPreview.flashLoanInfo.flashLoanFee.toString(),
      collateralToDeposit: sdkPreview.initialInputs.calcs.collTokenToDeposit.toString(),
      debtToBorrow: sdkPreview.initialInputs.calcs.debtTokenToBorrow.toString(),
      leverageSwapInputBaseUnits: sdkPreview.swapInputs.inputAmountLamports.toString(),
      leverageSwapMinimumOutputBaseUnits: sdkPreview.swapInputs.minOutAmountLamports?.toString() ?? null,
    },
  }
  if (typeof onApplicationContext === 'function' && wallet) {
    await onApplicationContext({
      wallet,
      marketId: 'sol-usdy-usdc',
      fundingAmount: String(fundingAmount),
      fundingBaseUnits,
      leverage: Number(leverage),
      acquisitionQuote,
      leverageQuote,
      callbacks,
    })
  }
  return result
}
