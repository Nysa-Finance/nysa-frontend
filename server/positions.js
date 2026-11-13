import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'

const finitePositiveDecimal = (value, label, allowZero = false) => {
  let parsed
  try { parsed = new Decimal(String(value)) } catch { throw new TypeError(`Invalid ${label}.`) }
  if (!parsed.isFinite() || (allowZero ? parsed.isNegative() : !parsed.gt(0))) throw new TypeError(`Invalid ${label}.`)
  return parsed
}

/** Stable identity that keeps same-token positions separate across wallets, markets and obligations. */
export function loopPositionIdentity({ wallet, marketId, obligationAddress, collateralReserve, liabilityReserve } = {}) {
  const fields = [wallet, marketId, obligationAddress, collateralReserve, liabilityReserve]
  if (fields.some((value) => typeof value !== 'string' || !value.trim())) throw new TypeError('Loop position identity requires wallet, market, obligation and reserve addresses.')
  return `multiply:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`
}

function rawAmount(obligation, method, reserve, label) {
  let raw
  try { raw = obligation?.[method]?.(reserve)?.amount ?? 0 } catch { throw new TypeError(`Could not read Multiply ${label}.`) }
  return finitePositiveDecimal(raw, `Multiply ${label}`, true)
}

function amountInTokens(raw, factor, label) {
  return raw.div(finitePositiveDecimal(factor, `${label} mint factor`)).toDecimalPlaces(18, Decimal.ROUND_DOWN).toString()
}

function rawAmountBaseUnits(raw) {
  return raw.toFixed() // Decimal.js fixed form preserves tiny positive interest without exponential notation.
}

const DEFAULT_RESERVE = '11111111111111111111111111111111'

function obligationBalances(obligation, collateralReserve, liabilityReserve) {
  const state = obligation?.state
  if (!Array.isArray(state?.deposits) || !Array.isArray(state?.borrows)
    || typeof obligation.getDeposits !== 'function' || typeof obligation.getBorrows !== 'function') {
    throw new TypeError('Multiply obligation does not expose complete reserve balances.')
  }
  const hydratedDeposits = obligation.getDeposits()
  const hydratedBorrows = obligation.getBorrows()
  if (!Array.isArray(hydratedDeposits) || !Array.isArray(hydratedBorrows)) throw new TypeError('Multiply reserve positions are unavailable.')
  const depositsByReserve = new Map(hydratedDeposits.map((position) => [String(position.reserveAddress), position]))
  const borrowsByReserve = new Map(hydratedBorrows.map((position) => [String(position.reserveAddress), position]))
  const deposits = state.deposits.flatMap((deposit) => {
    const reserve = String(deposit.depositReserve)
    if (reserve === DEFAULT_RESERVE) return []
    const cTokenBaseUnits = String(deposit.depositedAmount)
    if (!/^\d+$/.test(cTokenBaseUnits)) throw new TypeError('Multiply obligation cToken amount is invalid.')
    const hydrated = depositsByReserve.get(reserve)
    return [{
      reserve,
      cTokenBaseUnits: BigInt(cTokenBaseUnits).toString(),
      amountBaseUnits: hydrated ? rawAmountBaseUnits(finitePositiveDecimal(hydrated.amount, 'Multiply reserve deposit amount', true)) : null,
    }]
  })
  const borrows = state.borrows.flatMap((borrow) => {
    const reserve = String(borrow.borrowReserve)
    if (reserve === DEFAULT_RESERVE) return []
    const amountScaled = String(borrow.borrowedAmountSf)
    if (!/^\d+$/.test(amountScaled)) throw new TypeError('Multiply obligation scaled debt amount is invalid.')
    const hydrated = borrowsByReserve.get(reserve)
    return [{
      reserve,
      amountScaled: BigInt(amountScaled).toString(),
      amountBaseUnits: hydrated ? rawAmountBaseUnits(finitePositiveDecimal(hydrated.amount, 'Multiply reserve debt amount', true)) : null,
    }]
  })
  const nonZero = (value) => value != null && finitePositiveDecimal(value, 'Multiply reserve raw amount', true).gt(0)
  const unsupportedReserves = [...new Set([
    ...deposits.filter((item) => item.reserve !== String(collateralReserve)
      && (nonZero(item.cTokenBaseUnits) || nonZero(item.amountBaseUnits))).map((item) => item.reserve),
    ...borrows.filter((item) => item.reserve !== String(liabilityReserve)
      && (nonZero(item.amountScaled) || nonZero(item.amountBaseUnits))).map((item) => item.reserve),
  ])].sort()
  return { deposits, borrows, unsupportedReserves }
}

/** Record every obligation kind through the same deduplicated market index. */
export function recordIndexedObligation(index, marketAddress, obligationAddress, owner) {
  if (!index || typeof index !== 'object' || typeof marketAddress !== 'string' || !marketAddress
    || typeof obligationAddress !== 'string' || !obligationAddress || typeof owner !== 'string' || !owner) {
    throw new TypeError('Indexed obligation requires a market, obligation and owner address.')
  }
  index.obligations ??= {}
  index.owners ??= {}
  const obligations = index.obligations[marketAddress] ??= []
  if (!obligations.includes(obligationAddress)) obligations.push(obligationAddress)
  index.owners[obligationAddress] = owner
}

/** Shared analytics and Farm Points view of any indexed Kamino obligation, including Multiply. */
export function indexedPositionSummary(obligation) {
  const stats = obligation?.refreshedStats
  if (!stats) return null
  const numeric = (value) => {
    const parsed = Number(String(value ?? '0'))
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  const deposits = numeric(stats.userTotalDeposit)
  const debt = numeric(stats.userTotalBorrow)
  if (deposits == null || debt == null || (deposits <= 0 && debt <= 0)) return null
  const ltv = numeric(stats.loanToValue)
  const liquidationLtv = numeric(stats.liquidationLtv)
  const borrowLimit = stats.borrowLiquidationLimit == null ? null : numeric(stats.borrowLiquidationLimit)
  return {
    deposits,
    debt,
    ltv: ltv == null ? 0 : ltv * 100,
    liqLtv: liquidationLtv == null ? 0 : liquidationLtv * 100,
    hf: debt > 0 && borrowLimit != null ? borrowLimit / debt : null,
  }
}

// The collateral and debt tokens of a loan in market `m` (config.js): the largest deposit and the largest borrow by
// value, so liquidating it repays its main debt and seizes its main collateral. { collateral, debt }: token ids or null.
export function obligationPair(m, obligation) {
  const tokenOf = new Map(Object.entries(m.reserves).map(([id, reserve]) => [reserve, id]))
  const largest = (positions, ids) => [...(positions ?? new Map()).entries()]
    .filter(([reserve, p]) => ids.includes(tokenOf.get(String(reserve))) && Number(p.amount) > 0)
    .sort(([, a], [, b]) => Number(b.marketValueRefreshed) - Number(a.marketValueRefreshed))
    .map(([reserve]) => tokenOf.get(String(reserve)))[0] ?? null
  return { collateral: largest(obligation?.deposits, m.collateral), debt: largest(obligation?.borrows, m.loans) }
}

/** Shape one already-resolved Multiply PDA as an identified wallet position; it never reads or mutates chain state. */
export function multiplyPosition({
  wallet,
  marketId,
  marketName,
  obligation,
  collateralReserve,
  liabilityReserve,
  collateral,
  liability,
  collateralMintFactor,
  liabilityMintFactor,
} = {}) {
  if (!obligation?.obligationAddress || !collateral || !liability) return null
  if (String(obligation.state?.owner ?? '') !== wallet) throw new TypeError('Multiply obligation owner does not match the requested wallet.')
  const normalizeToken = (token) => ({ ...token, tokenId: token.tokenId ?? token.token_id })
  collateral = normalizeToken(collateral)
  liability = normalizeToken(liability)
  for (const token of [collateral, liability]) {
    if (typeof token.tokenId !== 'string' || !token.tokenId || typeof token.mint !== 'string' || !token.mint
      || !Number.isSafeInteger(token.decimals) || token.decimals < 0) throw new TypeError('Invalid Multiply position token identity.')
  }
  const collateralRaw = rawAmount(obligation, 'getDepositByReserve', collateralReserve, 'collateral amount')
  const liabilityRaw = rawAmount(obligation, 'getBorrowByReserve', liabilityReserve, 'debt amount')
  const balances = obligationBalances(obligation, collateralReserve, liabilityReserve)
  const hasAnyRawPosition = balances.deposits.some((item) => finitePositiveDecimal(item.cTokenBaseUnits, 'Multiply cToken amount', true).gt(0))
    || balances.borrows.some((item) => finitePositiveDecimal(item.amountScaled, 'Multiply scaled debt amount', true).gt(0))
  if (collateralRaw.isZero() && liabilityRaw.isZero() && !hasAnyRawPosition) return null
  finitePositiveDecimal(liabilityMintFactor, 'liability mint factor')
  const debtUsdRaw = obligation.refreshedStats?.userTotalBorrow
  const debtUsd = debtUsdRaw == null ? null : finitePositiveDecimal(debtUsdRaw, 'Multiply USD debt', true)
  const liquidationLimitRaw = obligation.refreshedStats?.borrowLiquidationLimit
  const liquidationLimit = liquidationLimitRaw == null
    ? null
    : finitePositiveDecimal(liquidationLimitRaw, 'Multiply liquidation limit', true)
  const healthFactor = debtUsd?.gt(0) && liquidationLimit ? Number(liquidationLimit.div(debtUsd).toString()) : null
  const { deposits, borrows, unsupportedReserves } = balances
  return {
    id: loopPositionIdentity({ wallet, marketId, obligationAddress: String(obligation.obligationAddress), collateralReserve, liabilityReserve }),
    wallet,
    market: { id: marketId, name: marketName ?? marketId },
    obligation: {
      address: String(obligation.obligationAddress), type: 'multiply',
      balances: { deposits, borrows }, unsupportedReserves,
    },
    collateral: { tokenId: collateral.tokenId, mint: collateral.mint, reserve: String(collateralReserve), decimals: collateral.decimals,
      amount: amountInTokens(collateralRaw, collateralMintFactor, 'collateral'), amountBaseUnits: rawAmountBaseUnits(collateralRaw) },
    liability: { tokenId: liability.tokenId, mint: liability.mint, reserve: String(liabilityReserve), decimals: liability.decimals,
      amount: amountInTokens(liabilityRaw, liabilityMintFactor, 'liability'), amountBaseUnits: rawAmountBaseUnits(liabilityRaw) },
    healthFactor: Number.isFinite(healthFactor) ? healthFactor : null,
  }
}
