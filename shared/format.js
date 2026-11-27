import { DAY, floorTo } from './finance.js'

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// Thousands get separators (an incentive APY on a tiny vault can reach 11,214.30%).
export function pct(value, decimals = 2) {
  if (!isNumber(value)) return '—'
  if (Math.abs(value) < 1000) return `${value.toFixed(decimals)}%`
  return `${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`
}

export function usd(value) {
  if (!isNumber(value)) return '—'
  const size = Math.abs(value)
  if (size >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B'
  if (size >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M'
  if (size >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K'
  return '$' + value.toFixed(2)
}

export function usdFull(value) {
  if (!isNumber(value)) return '—'
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Truncated, never rounded up: a max or balance shown is one that can be typed back and sent (9.99996 reads 9.9999,
// not 10). Like Aave, amounts below the last shown digit read "< 0.0001", not a misleading 0.
export function amt(value, decimals = 4) {
  if (!isNumber(value)) return '—'
  const smallest = 10 ** -decimals
  if (value > 0 && value < smallest) return `< ${smallest.toFixed(decimals)}`
  return value.toLocaleString('en-US', { maximumFractionDigits: decimals, roundingMode: 'trunc' })
}

export function compact(value, unit) {
  if (!isNumber(value)) return '—'
  const text = compactNumber(value)
  return unit ? `${text} ${unit}` : text
}

function compactNumber(value) {
  const size = Math.abs(value)
  if (size >= 1e6) return (value / 1e6).toFixed(1) + 'M'
  if (size >= 1e3) return (value / 1e3).toFixed(0) + 'K'
  return value.toFixed(0)
}

// "7xKX…sAsU": the first and last characters of an address.
export function short(text, head = 4, tail = 4) {
  if (!text || text.length <= head + tail + 1) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

// Applied to amount inputs as typed. The last "," or "." is the decimal point (phone keyboards type ","), shown as "."
// at once so "1,000" reads 1.000, never a silent 1; "1,000.5" and "1.000,5" read 1000.5. Digits past the token's
// decimals are dropped: the chain can't move them.
export function cleanAmount(input, decimals) {
  const text = String(input ?? '')
  const onlyDigits = (part) => part.replace(/\D/g, '')
  const decimalAt = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','))
  if (decimalAt < 0) return onlyDigits(text)
  const whole = onlyDigits(text.slice(0, decimalAt)) || '0'
  const fraction = onlyDigits(text.slice(decimalAt + 1)).slice(0, decimals)
  return `${whole}.${fraction}`
}

// "," or "." as the decimal separator; anything else is invalid → 0.
export function num(input) {
  const text = String(input ?? '')
    .trim()
    .replace(',', '.')
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function ago(ts, now = Date.now()) {
  if (!ts) return 'unknown'
  const seconds = Math.floor(now / 1000 - ts)
  if (seconds < 90) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// Rounded down (never shown safer than it is), with 3 decimals near 1: 0.9996 reads 0.999, not a healthy-looking 1.00.
export function hfText(hf) {
  if (!Number.isFinite(hf) || hf > 999) return '∞'
  const decimals = hf < 1.1 ? 3 : 2
  return floorTo(hf, decimals).toFixed(decimals)
}

export function hfColor(hf) {
  if (!Number.isFinite(hf) || hf >= 1.8) return 'var(--n-green)'
  if (hf >= 1.3) return 'var(--n-amber)'
  return 'var(--n-red)'
}

export function dur(sec) {
  if (!Number.isFinite(sec)) return '—'
  const seconds = Math.max(Math.round(sec), 0)
  if (seconds < 90) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 2 * DAY) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / DAY)}d`
}
