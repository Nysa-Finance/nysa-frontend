import { parseBaseUnits } from './swap-fees.js'

const U64_MAX = (1n << 64n) - 1n

/** Parse a user-entered decimal amount without floating-point rounding. */
export function amountToBaseUnits(value, decimals) {
  const units = parseBaseUnits(value, decimals)
  if (units <= 0n) throw new RangeError('Amount must be positive.')
  if (units > U64_MAX) throw new RangeError('Amount exceeds the token amount limit.')
  return String(units)
}
