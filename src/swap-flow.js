import { formatBaseUnits, parseBaseUnits } from './swap-fees.js'

const U64_MAX = (1n << 64n) - 1n

export const baseUnitsToAmount = (value, decimals) => formatBaseUnits(BigInt(value), decimals)

/** Parse a user-entered decimal amount without floating-point rounding. */
export function amountToBaseUnits(value, decimals) {
  const units = parseBaseUnits(value, decimals)
  if (units <= 0n) throw new RangeError('Amount must be positive.')
  if (units > U64_MAX) throw new RangeError('Amount exceeds the token amount limit.')
  return String(units)
}

/** Derive any optional next action only from the confirmed swap amount. */
export function resolveSwapFlow({ flow, primaryStatus, confirmedAmountBaseUnits, followUpStatus } = {}) {
  const action = flow === 'acquire-supply' ? 'supply' : flow === 'withdraw-sell' ? 'sell' : null
  if (!action) throw new TypeError('Unsupported flow.')
  const primaryAction = flow === 'acquire-supply' ? 'swap' : 'withdraw'
  if (primaryStatus === 'idle') return { status: 'idle', primaryAction, action, amountBaseUnits: null }
  if (primaryStatus === 'pending' || primaryStatus === 'sending' || primaryStatus === 'confirmed-amount-unknown') return { status: 'pending', primaryAction, action, amountBaseUnits: null }
  if (primaryStatus === 'failed' || primaryStatus === 'rejected') return { status: 'failed', primaryAction, action, amountBaseUnits: null }
  if (primaryStatus !== 'confirmed') throw new TypeError('Unsupported primary action status.')
  if (typeof confirmedAmountBaseUnits !== 'string' || !/^\d+$/.test(confirmedAmountBaseUnits) || BigInt(confirmedAmountBaseUnits) <= 0n) {
    throw new TypeError('A confirmed amount is required before the follow-up action.')
  }
  const common = { primaryAction, action, amountBaseUnits: confirmedAmountBaseUnits }
  if (followUpStatus == null) return { status: 'offer-next', ...common }
  if (followUpStatus === 'pending') return { status: 'follow-up-pending', ...common }
  if (followUpStatus === 'confirmed') return { status: 'complete', ...common }
  if (followUpStatus === 'declined' || followUpStatus === 'failed') {
    return { status: 'wallet-has-token', ...common, followUpFailed: followUpStatus === 'failed' }
  }
  throw new TypeError('Unsupported follow-up status.')
}
