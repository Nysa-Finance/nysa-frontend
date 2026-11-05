import Decimal from 'decimal.js'
import { address, createNoopSigner, none } from '@solana/kit'
import { fetchAddressLookupTable } from '@solana-program/address-lookup-table'
import {
  getDepositWithLeverageIxs, getDepositWithLeverageSwapInputs,
  getWithdrawWithLeverageIxs, getWithdrawWithLeverageSwapInputs,
} from '@kamino-finance/klend-sdk'
import { DEFAULT_LOOP_LIMITS, loopExposure, projectedLtvLimitPct } from '../src/loop-policy.js'
import { TOKENS } from '../src/config.js'
import { parseBaseUnits } from '../src/swap-fees.js'
import { ObligationTypeTag } from '@kamino-finance/klend-sdk'
import { buildSwap, configuredFeeAccountForMint } from './swap.js'
import { rpc } from './rpc.js'
import { getLive, reserveOf } from './market.js'

export class LoopPreviewError extends Error {}
const PreciseDecimal = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP })

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
  // The installed SDK budgets 50 bps when sizing flash repayment; quote the route at 49 bps so its provider min-out
  // remains above that repayment amount after 10-bps fee arithmetic and integer-base-unit rounding.
  slippageBps = 49,
  localForkSimulation = false,
  localForkRpcUrl,
  localRouteProgramVerifier,
} = {}) {
  if (typeof wallet !== 'string' || !wallet) throw new LoopPreviewError('Wallet address is required for the loop quote.')
  if (localForkSimulation) {
    let hostname
    try { hostname = new URL(localForkRpcUrl).hostname.toLowerCase() } catch { throw new LoopPreviewError('Local simulation requires a loopback validator URL.') }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) || typeof localRouteProgramVerifier !== 'function') {
      throw new LoopPreviewError('Unapproved route composition requires a loopback RPC and verified deployed programs on the local validator.')
    }
  }
  const prepare = async (inputs) => {
    const inputMint = String(inputs?.inputMint ?? '')
    const outputMint = String(inputs?.outputMint ?? '')
    const inputAmountBaseUnits = rawAmount(inputs?.inputAmountLamports)
    const feeDestination = await getFeeAccount(outputMint)
    if (!feeDestination || feeDestination.mint !== outputMint || typeof feeDestination.account !== 'string') {
      throw new LoopPreviewError('A validated output-mint Nysa fee account is not configured for this swap.')
    }
    const built = await buildSwapFn({
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
    })
    if (!built || !built.fee?.routeDeltaVerified || !built.programPolicy) throw new LoopPreviewError('Swap route did not verify its 10-bps fee and provider route.')
    return { built, inputMint, outputMint, inputAmountBaseUnits }
  }

  const quoter = async (inputs) => {
    const { built, inputMint, outputMint, inputAmountBaseUnits } = await prepare(inputs)
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
    if (localForkSimulation) {
      if (!built.fee.routeDeltaVerified || !built.feeAccountMintVerified || !await localRouteProgramVerifier(built)) {
        throw new LoopPreviewError('Local route must have a verified fee account and deployed local route programs before simulation.')
      }
    } else if (!built.programPolicy.approved || !built.feeAccountMintVerified || !built.feeBalanceDeltaVerified || !built.feeVerified || !built.executable) {
      throw new LoopPreviewError('Swap route, fee account or atomic fee-balance simulation is not approved for composition.')
    }
    if (inputs.minOutAmountLamports != null && BigInt(built.minimumOutputBaseUnits) < BigInt(rawAmount(new Decimal(inputs.minOutAmountLamports).ceil()))) {
      throw new LoopPreviewError(`Swap provider minimum output ${built.minimumOutputBaseUnits} is below Kamino’s required flash-repayment amount ${rawAmount(new Decimal(inputs.minOutAmountLamports).ceil())}.`)
    }
    const lookupTables = await resolveLookupTables(built, lookupTableResolver)
    return [{ preActionIxs: [], swapIxs: built.instructions, lookupTables, quote }]
  }

  return { quoter, swapper }
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
  for (const violation of violations) unavailableReasons.push({ code: violation, message: 'The preview cannot confirm that this request is within the current loop risk limits.' })
  if (fees.length !== 2) unavailableReasons.push({ code: 'swap-quotes-unavailable', message: 'Both the initial USDY acquisition and leverage swap need fee-aware provider quotes.' })
  return {
    available: !!strategy?.enabled && violations.length === 0 && fees.length === 2,
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
    carry: strategy?.carry ?? { estimatedCarryPct: null },
    fees,
    costs: estimatedCosts.costs,
    knownCostsTotalUsd: estimatedCosts.knownCostsTotalUsd,
    feeTotalUsd: fees.every((fee) => fee.usd != null) ? fees.reduce((sum, fee) => sum + fee.usd, 0) : null,
    unavailableReasons,
  }
}

/** Use the installed Kamino SDK quote path while preserving the provider-native fee in the quoter callback. */
export function quoteMultiplyOpen(inputs, callbacks) {
  return getDepositWithLeverageSwapInputs({ ...inputs, quoter: callbacks.quoter })
}

export function quoteMultiplyFullClose(inputs, callbacks) {
  return getWithdrawWithLeverageSwapInputs({ ...inputs, quoter: callbacks.quoter })
}

/** Compose Kamino's real leveraged-deposit instructions with the fee-aware Jupiter quote and swap callbacks. */
export function buildMultiplyOpenIxs(inputs, callbacks, builder = getDepositWithLeverageIxs) {
  if (typeof callbacks?.quoter !== 'function' || typeof callbacks?.swapper !== 'function') throw new LoopPreviewError('Open requires fee-aware quote and swap callbacks.')
  return builder({ ...inputs, quoter: callbacks.quoter, swapper: callbacks.swapper })
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

/**
 * Build a quote-only USDY Multiply preview with the installed Kamino SDK and shared fee-aware Jupiter adapter.
 * It never returns instructions, simulates an economic transaction, or offers a signer path.
 */
export async function buildReadOnlyLoopPreview({ wallet, fundingAmount, leverage, snapshot, strategy, now = Date.now() } = {}) {
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
  const taker = wallet || '11111111111111111111111111111111'
  const acquisitionQuote = await buildSwap({
    inputMint: liability.mint,
    outputMint: collateral.mint,
    inputAmountBaseUnits: fundingBaseUnits,
    wallet: taker,
    feeAccount: initialFeeAccount.account,
    feeAccountMint: collateral.mint,
    slippageBps: 50,
  })
  const acquiredCollateral = new Decimal(acquisitionQuote.outputAmountBaseUnits).div(new Decimal(10).pow(collateral.decimals))
  const callbacks = createKaminoSwapCallbacks({ wallet: taker, slippageBps: 49 })
  const sdkPreview = await quoteMultiplyOpen({
    owner: createNoopSigner(address(taker)),
    kaminoMarket: market,
    debtReserveAddress: debtReserve.address,
    collReserveAddress: collReserve.address,
    depositAmount: acquiredCollateral,
    priceDebtToColl: new Decimal(reserves[liability.token_id]?.price ?? 1).div(reserves[collateral.token_id]?.price ?? 1),
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
  const leverageQuote = sdkPreview.initialInputs.swapQuote.quoteResponse
  const oracleAges = [reserves[collateral.token_id], reserves[liability.token_id]].map((reserve) => now / 1000 - reserve?.oracleTs)
  const heartbeats = [reserves[collateral.token_id]?.maxAge, reserves[liability.token_id]?.maxAge]
  const quoteTimes = [acquisitionQuote.quoteAt, leverageQuote?.quoteAt]
  const riskInputs = {
    slippageBps: 50,
    priceImpactPct: Math.max(acquisitionQuote.priceImpactPct, leverageQuote?.priceImpactPct ?? Infinity),
    quoteAgeSeconds: Math.max(...quoteTimes.map((at) => at == null ? Infinity : (now - at) / 1000)),
    oracleAgeSeconds: Math.max(...oracleAges),
    oracleHeartbeatSeconds: Math.min(...heartbeats),
  }
  const feePricesUsd = {
    [collateral.mint]: reserves[collateral.token_id]?.price,
    [liability.mint]: reserves[liability.token_id]?.price,
  }
  return {
    ...buildLoopPreview({
      fundingAmount,
      leverage,
      strategy: strategyView,
      ...limits,
      riskInputs,
      acquisitionQuote,
      leverageQuote,
      feePricesUsd,
      sdkPosition: {
        collateralMint: collateral.mint,
        collateralDecimals: collReserve.stats.decimals,
        collateralAmount: sdkPreview.initialInputs.calcs.collTokenToDeposit,
        collateralPriceUsd: reserves[collateral.token_id]?.price,
        liabilityMint: liability.mint,
        liabilityDecimals: debtReserve.stats.decimals,
        debtBorrowAmount: sdkPreview.initialInputs.calcs.debtTokenToBorrow,
        borrowFeeRatio: debtReserve.getBorrowFee(),
        liabilityPriceUsd: reserves[liability.token_id]?.price,
        flashBorrowAmount: sdkPreview.initialInputs.calcs.flashBorrowInCollToken,
        flashFeeRatio: sdkPreview.flashLoanInfo.flashLoanFee,
      },
    }),
    quoteStatus: 'quoted',
    quoteAt: Math.min(...quoteTimes),
    sdk: {
      flashBorrowFee: sdkPreview.flashLoanInfo.flashLoanFee.toString(),
      collateralToDeposit: sdkPreview.initialInputs.calcs.collTokenToDeposit.toString(),
      debtToBorrow: sdkPreview.initialInputs.calcs.debtTokenToBorrow.toString(),
      leverageSwapInputBaseUnits: sdkPreview.swapInputs.inputAmountLamports.toString(),
      leverageSwapMinimumOutputBaseUnits: sdkPreview.swapInputs.minOutAmountLamports?.toString() ?? null,
    },
  }
}
