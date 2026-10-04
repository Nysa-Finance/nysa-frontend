// Nysa backend (VPS / Docker, behind Caddy and the Cloudflare Tunnel):
// - serves the Vite build (dist/) with SPA fallback;
// - JSON API under /api (market, account, transactions, analytics, points, history, market updates, health);
// - pushes market updates to browsers over Server-Sent Events (/api/events);
// - runs the daily snapshot at 00:00 UTC.
// The browser never calls the Solana RPC: it reads from here and only uses the wallet to sign and send.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAddress } from '@solana/kit'
import { RPC_URL, rpcCallsLastHour } from './rpc.js'
import { getSnapshot, onSnapshot, refreshMarket } from './market.js'
import { getAccount } from './account.js'
import { buildTx, sendSigned, txStatus, KINDS, UserError } from './tx.js'
import { getPositions } from './analytics.js'
import { marketUpdates } from './updates.js'
import { runSnapshot } from './snapshot.js'
import { read, POINTS, HISTORY } from './storage.js'

if (!RPC_URL) {
  console.error('SOLANA_RPC is not set (see .env.example)')
  process.exit(1)
}

const PORT = Number(process.env.PORT) || 3000
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}
const EMPTY_POINTS = 'address,cumulative_points,last_supplied_usd,last_snapshot_ts\n'

// ---- helpers ----
function send(res, status, body, { type = 'application/json', maxAge = 0 } = {}) {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', maxAge ? `public, max-age=${maxAge}` : 'no-store')
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

// Per-IP fixed-window limits on the endpoints that cost RPC calls. Only Cloudflare reaches us (tunnel), so its
// CF-Connecting-IP header is the real client.
const hits = new Map()
function limited(req, name, perMinute) {
  const key = `${name}:${req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress}`
  const now = Date.now()
  let e = hits.get(key)
  if (!e || now - e.start > 60_000) hits.set(key, (e = { start: now, n: 0 }))
  return ++e.n > perMinute
}
setInterval(() => { for (const [k, e] of hits) if (Date.now() - e.start > 60_000) hits.delete(k) }, 60_000).unref()

async function jsonBody(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new UserError('Expected application/json')
  let raw = ''
  for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw new UserError('Request too large') }
  try { return JSON.parse(raw) } catch { throw new UserError('Invalid JSON') }
}

// ---- Server-Sent Events: the market snapshot on connect and after every refresh ----
const clients = new Set()
const MAX_CLIENTS = 5000
const event = (data) => `event: market\ndata: ${JSON.stringify(data)}\n\n`
function events(req, res) {
  if (clients.size >= MAX_CLIENTS) return send(res, 503, { error: 'Too many connections' })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  res.write('retry: 5000\n\n')
  const snapshot = getSnapshot()
  if (snapshot) res.write(event(snapshot))
  clients.add(res)
  const drop = () => clients.delete(res)
  req.on('close', drop)
  res.on('error', drop) // client gone mid-write
}
onSnapshot((snapshot) => { const msg = event(snapshot); for (const c of clients) c.write(msg) })
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 25_000).unref() // under Cloudflare's 100s idle cut

// ---- routes ----
const routes = [
  ['GET', /^\/api\/market$/, (req, res) => {
    const s = getSnapshot()
    return s ? send(res, 200, s) : send(res, 503, { error: 'Market data is still loading' })
  }],
  ['GET', /^\/api\/events$/, events],
  ['GET', /^\/api\/account\/(\w+)$/, async (req, res, [wallet]) => {
    if (!isAddress(wallet)) return send(res, 400, { error: 'Invalid wallet address' })
    if (limited(req, 'account', 60)) return send(res, 429, { error: 'Too many requests' })
    const fresh = new URL(req.url, 'http://x').searchParams.has('fresh')
    send(res, 200, await getAccount(wallet, fresh))
  }],
  ['POST', /^\/api\/tx$/, async (req, res) => {
    if (limited(req, 'tx', 20)) return send(res, 429, { error: 'Too many requests' })
    const b = await jsonBody(req)
    if (!KINDS.includes(b.kind)) throw new UserError('Unknown action')
    if (!isAddress(String(b.wallet))) throw new UserError('Invalid wallet address')
    try {
      send(res, 200, await buildTx({ kind: b.kind, wallet: b.wallet, market: b.market, token: b.token, amount: Number(b.amount), all: !!b.all }))
    } catch (e) {
      if (e instanceof UserError) throw e
      console.error('[tx] build failed', b.kind, e) // details stay in the logs (RPC errors can carry provider info)
      send(res, 502, { error: 'Could not build the transaction, please try again.' })
    }
  }],
  ['POST', /^\/api\/tx\/send$/, async (req, res) => {
    if (limited(req, 'send', 20)) return send(res, 429, { error: 'Too many requests' })
    const b = await jsonBody(req)
    if (!isAddress(String(b.wallet)) || typeof b.tx !== 'string' || b.tx.length > 2000) throw new UserError('Invalid request')
    send(res, 200, await sendSigned({ tx: b.tx, wallet: b.wallet }))
  }],
  ['GET', /^\/api\/tx\/(\w{64,90})$/, async (req, res, [signature]) => {
    if (limited(req, 'status', 120)) return send(res, 429, { error: 'Too many requests' })
    send(res, 200, await txStatus(signature))
  }],
  ['GET', /^\/api\/analytics$/, async (req, res) => send(res, 200, { positions: await getPositions() }, { maxAge: 30 })],
  ['GET', /^\/api\/market-updates$/, async (req, res) => send(res, 200, await marketUpdates(), { maxAge: 60 })],
  ['GET', /^\/api\/points$/, async (req, res) => send(res, 200, (await read(POINTS)) ?? EMPTY_POINTS, { type: 'text/csv; charset=utf-8', maxAge: 300 })],
  ['GET', /^\/api\/apy-history$/, async (req, res) => send(res, 200, (await read(HISTORY)) ?? '{"tokens":{}}', { maxAge: 300 })],
  ['GET', /^\/api\/health$/, (req, res) => {
    const s = getSnapshot()
    const age = s ? Math.round((Date.now() - s.updatedAt) / 1000) : null
    send(res, s && age < 300 ? 200 : 503, { ok: !!s && age < 300, marketAgeSec: age, sseClients: clients.size, rpcCallsLastHour: rpcCallsLastHour() })
  }],
]

async function serveStatic(pathname, res) {
  const file = normalize(join(DIST, decodeURIComponent(pathname)))
  if (!file.startsWith(DIST)) return send(res, 400, 'Bad request', { type: 'text/plain' }) // no ../ escapes
  let body, served = file
  try {
    body = await readFile(file)
  } catch {
    // A missing file (/favicon.ico, /x.png) is a 404; only extensionless paths are client-side routes (/lend, …).
    if (extname(pathname)) return send(res, 404, 'Not found', { type: 'text/plain' })
    served = join(DIST, 'index.html')
    body = await readFile(served)
  }
  res.setHeader('content-type', TYPES[extname(served)] ?? 'application/octet-stream')
  // Hashed build assets never change; everything else is revalidated so new deploys show up.
  res.setHeader('cache-control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  res.end(body)
}

http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname.startsWith('/api/')) {
      for (const [method, re, handler] of routes) {
        const match = pathname.match(re)
        if (!match) continue
        if (req.method !== method) return send(res, 405, { error: 'Method not allowed' })
        return await handler(req, res, match.slice(1))
      }
      return send(res, 404, { error: 'Not found' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { type: 'text/plain' })
    await serveStatic(pathname === '/' ? '/index.html' : pathname, res)
  } catch (e) {
    if (e instanceof UserError) return send(res, 400, { error: e.message })
    console.error('[server]', req.method, req.url, e)
    if (!res.headersSent) send(res, 500, { error: 'Internal error' })
    else res.end()
  }
}).listen(PORT, () => console.log(`nysa listening on :${PORT}`))

refreshMarket() // first read now, then every REFRESH_MS (market.js)

// Daily snapshot at 00:00 UTC. A missed run (e.g. restart at midnight) is harmless: the next one accrues the whole gap.
function scheduleSnapshot() {
  const now = new Date()
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  setTimeout(() => runSnapshot()
    .then((r) => console.log('[snapshot] done', r))
    .catch((e) => console.error('[snapshot] failed', e))
    .finally(scheduleSnapshot), next - now.getTime())
}
scheduleSnapshot()
