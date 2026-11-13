const BASIS_POINTS_DENOMINATOR = 10_000n
const DECIMAL_AMOUNT = /^(\d+)(?:\.(\d+))?$/

function validDecimals(decimals) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError('Invalid token decimals')
}

export function calculateSwapFeeBaseUnits(amountBaseUnits, feeBps = 10) {
  if (typeof amountBaseUnits !== 'string' && typeof amountBaseUnits !== 'bigint') throw new TypeError('Invalid base-unit amount')
  const raw = String(amountBaseUnits)
  if (!/^\d+$/.test(raw)) throw new TypeError('Invalid base-unit amount')
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new RangeError('Invalid fee basis points')
  // Match integer on-chain token accounting: discard fractions of one base unit, never round up.
  return BigInt(raw) * BigInt(feeBps) / BASIS_POINTS_DENOMINATOR
}

export function parseBaseUnits(amount, decimals) {
  validDecimals(decimals)
  if (typeof amount !== 'string') throw new TypeError('Invalid amount')
  const match = amount.match(DECIMAL_AMOUNT)
  if (!match || (match[2]?.length ?? 0) > decimals) throw new TypeError('Invalid amount for token decimals')
  const whole = BigInt(match[1]) * 10n ** BigInt(decimals)
  const fraction = BigInt((match[2] ?? '').padEnd(decimals, '0') || '0')
  return whole + fraction
}

export function formatBaseUnits(amountBaseUnits, decimals) {
  validDecimals(decimals)
  if (typeof amountBaseUnits !== 'bigint' || amountBaseUnits < 0n) throw new TypeError('Invalid base-unit amount')
  const scale = 10n ** BigInt(decimals)
  const whole = amountBaseUnits / scale
  const fraction = amountBaseUnits % scale
  if (decimals === 0 || fraction === 0n) return String(whole)
  return `${whole}.${String(fraction).padStart(decimals, '0').replace(/0+$/, '')}`
}
