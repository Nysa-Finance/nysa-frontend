const U64_MAX = (1n << 64n) - 1n

export function baseUnitsToAmount(value, decimals) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new TypeError('Invalid base-unit amount.')
  }
  const scale = 10n ** BigInt(decimals)
  const units = BigInt(value)
  const whole = units / scale
  if (decimals === 0) return String(whole)
  const fraction = String(units % scale).padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

/** Parse a user-entered decimal amount without floating-point rounding. */
export function amountToBaseUnits(value, decimals) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18
    || typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError('Invalid decimal amount.')
  }
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) throw new TypeError('Invalid decimal amount precision.')
  const baseUnits = BigInt(whole) * 10n ** BigInt(decimals)
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  if (baseUnits <= 0n) throw new RangeError('Amount must be positive.')
  if (baseUnits > U64_MAX) throw new RangeError('Amount exceeds the token amount limit.')
  return String(baseUnits)
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
