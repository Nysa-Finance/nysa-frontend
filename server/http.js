// Request helpers shared by every API route: JSON responses, per-IP rate limits, body parsing, sanctions and geo checks.
import { UserError } from './tx.js'
import { isSanctioned, screeningReady } from './screening.js'

export function send(res, status, body, { type = 'application/json', maxAge = 0 } = {}) {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', maxAge ? `public, max-age=${maxAge}` : 'no-store')
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

// Only Cloudflare reaches us (tunnel), so CF-Connecting-IP is the real client.
export const clientIp = (req) => req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress
const hits = new Map()
export function limited(req, name, perMinute) {
  const key = `${name}:${clientIp(req)}`
  const now = Date.now()
  let e = hits.get(key)
  if (!e || now - e.start > 60_000) hits.set(key, (e = { start: now, n: 0 }))
  return ++e.n > perMinute
}
setInterval(() => {
  for (const [k, e] of hits) if (Date.now() - e.start > 60_000) hits.delete(k)
}, 60_000).unref()

export async function jsonBody(req) {
  if (!String(req.headers['content-type']).startsWith('application/json'))
    throw new UserError('Expected application/json')
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 4096) throw new UserError('Request too large')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new UserError('Invalid JSON')
  }
}

// Until the sanctions list is loaded, viewing works but no transaction is built or relayed (fail closed).
const BLOCKED = {
  error: 'This wallet address is on a sanctions list, so it cannot use the Nysa interface.',
  blocked: true,
}
// A sanctioned borrower's loan isn't liquidated through the interface either (the liquidator itself is fine).
export const BLOCKED_LOAN = {
  error: 'This loan belongs to a wallet on a sanctions list, so the Nysa interface cannot liquidate it.',
}
export function blocked(res, wallet, { failClosed }) {
  if (isSanctioned(wallet)) return (send(res, 403, BLOCKED), true)
  if (failClosed && !screeningReady())
    return (send(res, 503, { error: 'Sanctions screening is starting up, please try again shortly.' }), true)
  return false
}

// CF-IPCountry (T1 = Tor). Repaying and withdrawing stay open, so nobody is locked out of their own funds.
// ponytail: country by IP only, a VPN gets through; regions (Crimea, Donetsk, Luhansk) need Cloudflare's location headers.
const GEO_BLOCKED = new Set(['US', 'CA', 'CU', 'IR', 'KP', 'SY', 'RU', 'BY', 'T1'])
export const GEO_KINDS = new Set(['deposit', 'borrow', 'liquidate', 'loop-open']) // a loop deposits the collateral: USDY's market is geo-blocked
export const geoBlocked = (req) => GEO_BLOCKED.has(req.headers['cf-ipcountry'])
export const GEO_REFUSED = {
  error:
    'This market is not available in your country (United States, Canada and sanctioned countries). You can still repay and withdraw.',
  geoBlocked: true,
}
