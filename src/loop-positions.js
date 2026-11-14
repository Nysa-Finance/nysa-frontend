// Multiply positions stay separate from the vanilla and vault totals: no token-key collisions.
export function loopPortfolioTotals(positions = [], prices = {}, rates = {}) {
  const seen = new Set()
  let suppliedUsd = 0
  let borrowedUsd = 0
  let netAprUsd = 0
  let healthFactor = null
  let hasActiveDebt = false
  let hasUnknownHealth = false
  for (const position of positions ?? []) {
    if (!position || typeof position.id !== 'string' || !position.id || seen.has(position.id)) continue
    seen.add(position.id)
    const collateralAmount = Number(position.collateral?.amount)
    const collateralPrice = Number(prices[position.collateral?.tokenId])
    const liabilityAmount = Number(position.liability?.amount)
    const liabilityPrice = Number(prices[position.liability?.tokenId])
    if (Number.isFinite(liabilityAmount) && liabilityAmount > 0) hasActiveDebt = true
    if (Number.isFinite(collateralAmount) && collateralAmount >= 0 && Number.isFinite(collateralPrice) && collateralPrice >= 0) {
      const value = collateralAmount * collateralPrice
      suppliedUsd += value
      const supplyApr = Number(rates[position.collateral?.tokenId]?.supplyAPR)
      if (Number.isFinite(supplyApr)) netAprUsd += value * supplyApr
    }
    if (Number.isFinite(liabilityAmount) && liabilityAmount >= 0 && Number.isFinite(liabilityPrice) && liabilityPrice >= 0) {
      const value = liabilityAmount * liabilityPrice
      borrowedUsd += value
      const borrowApr = Number(rates[position.liability?.tokenId]?.borrowAPR)
      if (Number.isFinite(borrowApr)) netAprUsd -= value * borrowApr
    }
    const factor = Number(position.healthFactor)
    if (Number.isFinite(factor) && factor > 0) healthFactor = healthFactor == null ? factor : Math.min(healthFactor, factor)
    else if (Number.isFinite(liabilityAmount) && liabilityAmount > 0) hasUnknownHealth = true
  }
  return {
    suppliedUsd, borrowedUsd, netAprUsd,
    healthFactor: hasUnknownHealth ? null : healthFactor,
    healthFactorKnown: !hasActiveDebt || !hasUnknownHealth,
  }
}

// Unknown health stays distinct from an infinite factor, which means no debt at all.
export function portfolioHealthFactor(loanHealthFactors = [], loopTotals = {}) {
  if (loopTotals.healthFactorKnown === false) return null
  const factors = loanHealthFactors.filter(Number.isFinite)
  if (Number.isFinite(loopTotals.healthFactor)) factors.push(loopTotals.healthFactor)
  return factors.length ? Math.min(...factors) : Infinity
}

export function selectedLoopCloseReadiness(readiness, position, wallet, loopPositionReadStatus) {
  if (!readiness) return null
  const identityVerified = typeof wallet === 'string' && position?.wallet === wallet
    && position?.market?.id === 'sol-usdy-usdc' && position?.obligation?.type === 'multiply'
    && typeof position?.obligation?.address === 'string' && position.obligation.address.length > 0
    && typeof position.id === 'string' && /^multiply:[a-f0-9]{64}$/.test(position.id)
    && loopPositionReadStatus?.['sol-usdy-usdc'] === 'verified'
  const exactRawAmount = (value) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
  const balances = position?.obligation?.balances
  const balancesVerified = Array.isArray(balances?.deposits) && balances.deposits.every((item) =>
    typeof item?.reserve === 'string' && exactRawAmount(item.cTokenBaseUnits) && exactRawAmount(item.amountBaseUnits))
    && Array.isArray(balances?.borrows) && balances.borrows.every((item) =>
      typeof item?.reserve === 'string' && exactRawAmount(item.amountScaled) && exactRawAmount(item.amountBaseUnits))
  const unsupportedReserves = position?.obligation?.unsupportedReserves
  const noUnsupportedReserves = Array.isArray(unsupportedReserves) && unsupportedReserves.length === 0
  const verified = identityVerified && balancesVerified && noUnsupportedReserves
  const unavailableReasons = (readiness.unavailableReasons ?? []).filter((item) =>
    !(identityVerified && item?.code === 'loop-position-identity-required'))
  if (!identityVerified && !unavailableReasons.some((item) => item?.code === 'loop-position-owner-unverified')) {
    unavailableReasons.push({ code: 'loop-position-owner-unverified', message: 'Select a Multiply position verified for this wallet.' })
  }
  if (identityVerified && !balancesVerified) unavailableReasons.push({
    code: 'loop-position-balances-unverified', message: 'The complete Multiply reserve balances could not be verified.',
  })
  if (identityVerified && balancesVerified && !noUnsupportedReserves) unavailableReasons.push({
    code: 'loop-position-extra-reserves', message: 'This Multiply position has active reserves outside the supported USDY/USDC pair.',
  })
  return { ...readiness, unavailableReasons, executionEnabled: verified && unavailableReasons.length === 0 }
}

// A full close is complete only when the identified obligation is absent or has no debt or collateral.
export function loopPositionFullyClosed(positions, positionId, loopPositionReadStatus) {
  if (typeof positionId !== 'string' || !positionId) return false
  if (loopPositionReadStatus?.['sol-usdy-usdc'] !== 'verified') return false
  const position = (positions ?? []).find((item) => item?.id === positionId)
  if (!position) return true
  const isExactRawZero = (value) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
    && !/[1-9]/.test(value)
  const balances = position.obligation?.balances
  return isExactRawZero(position.liability?.amountBaseUnits) && isExactRawZero(position.collateral?.amountBaseUnits)
    && Array.isArray(balances?.deposits) && balances.deposits.every((item) =>
      typeof item?.reserve === 'string' && isExactRawZero(item.cTokenBaseUnits) && isExactRawZero(item.amountBaseUnits))
    && Array.isArray(balances?.borrows) && balances.borrows.every((item) =>
      typeof item?.reserve === 'string' && isExactRawZero(item.amountScaled) && isExactRawZero(item.amountBaseUnits))
}
