import Decimal from 'decimal.js'

const U64_MAX = 18_446_744_073_709_551_615n

export async function readFreshWithdrawalAllowance({ wallet, refreshMarket, getAccount, marketId = 'sol-usdy-usdc', tokenId = 'svm-usdy' } = {}) {
  if (typeof wallet !== 'string' || !wallet || typeof refreshMarket !== 'function' || typeof getAccount !== 'function') {
    throw new TypeError('Fresh withdrawal allowance dependencies are required.')
  }
  const snapshot = await refreshMarket()
  const account = await getAccount(wallet, true)
  const maxWithdrawBaseUnits = account?.positionsBaseUnits?.[marketId]?.[tokenId]?.maxWithdraw
  if (typeof maxWithdrawBaseUnits !== 'string' || !/^\d+$/.test(maxWithdrawBaseUnits)) {
    throw new Error('Fresh withdrawal allowance is unavailable.')
  }
  if (!Number.isSafeInteger(snapshot?.updatedAt) || snapshot.updatedAt <= 0
    || typeof snapshot.slot !== 'number' && typeof snapshot.slot !== 'bigint' && typeof snapshot.slot !== 'string') {
    throw new Error('Fresh withdrawal market timestamp is unavailable.')
  }
  return { maxWithdrawBaseUnits, updatedAt: snapshot.updatedAt, slot: snapshot.slot }
}

export function requestedWithdrawalBaseUnits({ amountBaseUnits, amount, decimals } = {}) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new TypeError('Invalid token decimals.')
  }
  if (amountBaseUnits != null) {
    if (typeof amountBaseUnits !== 'string' || !/^\d+$/.test(amountBaseUnits) || BigInt(amountBaseUnits) <= 0n) {
      throw new Error('Withdrawal amount must be a positive integer in token base units.')
    }
    return amountBaseUnits
  }
  let requested
  try { requested = new Decimal(String(amount)).mul(new Decimal(10).pow(decimals)).floor().toFixed(0) }
  catch { throw new Error('Withdrawal amount must be a positive integer in token base units.') }
  if (!/^\d+$/.test(requested) || BigInt(requested) <= 0n) {
    throw new Error('Withdrawal amount must be a positive integer in token base units.')
  }
  return requested
}

export function requestedTokenBaseUnits({ amountBaseUnits, amount, decimals } = {}) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new TypeError('Invalid token decimals.')
  let requested
  if (amountBaseUnits != null) {
    if (typeof amountBaseUnits !== 'string' || !/^\d+$/.test(amountBaseUnits)) {
      throw new Error('Token amount must be a positive integer in base units.')
    }
    requested = BigInt(amountBaseUnits)
  } else {
    try { requested = BigInt(new Decimal(String(amount)).mul(new Decimal(10).pow(decimals)).floor().toFixed(0)) }
    catch { throw new Error('Token amount must be a positive integer in base units.') }
  }
  if (requested <= 0n) throw new Error('Token amount must be a positive integer in base units.')
  if (requested > U64_MAX) throw new Error('Token amount exceeds the u64 limit.')
  return requested.toString()
}

export function assertRawWithdrawalWithinAllowance(requestedBaseUnits, maxWithdrawBaseUnits) {
  if (typeof requestedBaseUnits !== 'string' || !/^\d+$/.test(requestedBaseUnits) || BigInt(requestedBaseUnits) <= 0n) {
    throw new Error('Withdrawal amount must be a positive integer in token base units.')
  }
  if (typeof maxWithdrawBaseUnits !== 'string' || !/^\d+$/.test(maxWithdrawBaseUnits)
    || BigInt(requestedBaseUnits) > BigInt(maxWithdrawBaseUnits)) {
    throw new Error('Withdrawal amount exceeds the fresh free-withdrawal allowance.')
  }
  return requestedBaseUnits
}
