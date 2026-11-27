// Starts the HTTP server: API routes (routes/), the built app with its sitemap, and the hourly Farm Points snapshot.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RPC_URL } from './rpc.js'
import { refreshMarket } from './market.js'
import { UserError } from './tx.js'
import { runSnapshot } from './snapshot.js'
import { startScreening } from './screening.js'
import { LIVE, LOOP_ENABLED, LOOPS, VAULTS, marketById, vaultById } from '../shared/config.js'
import { explain } from './errors.js'
import { send } from './http.js'
import { closeStreams, publicRoutes } from './routes/public.js'
import { currentSwapReadiness, swapRoutes } from './routes/swap.js'
import { loopOn, loopRoutes } from './routes/loop.js'
import { lendingRoutes } from './routes/lending.js'

if (!RPC_URL) {
  console.error('SOLANA_RPC is not set (see .env.example)')
  process.exit(1)
}

const PORT = Number(process.env.PORT) || 3000
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const routes = [...publicRoutes, ...lendingRoutes, ...swapRoutes, ...loopRoutes]

// Client-side routes of the SPA (keep in sync with src/main.js). '/', '/lend' and '/market/:id' are old links it redirects.
const APP_ROUTES = new Set([
  '/',
  '/earn',
  '/lend',
  '/borrow',
  '/portfolio',
  '/swap',
  ...(loopOn ? ['/loop', ...LOOPS.map((loop) => `/loop/${loop.id}`)] : []),
  '/analytics',
  '/liquidations',
  '/dashboard',
])
const isAppRoute = (p) =>
  APP_ROUTES.has(p.replace(/\/$/, '') || '/') ||
  !!vaultById(p.match(/^\/earn\/([\w-]+)\/?$/)?.[1]) ||
  !!marketById(p.match(/^\/(?:borrow|market)\/([\w-]+)\/?$/)?.[1])

const SITE = 'https://app.nysa.finance'
const sitemap = () => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['/earn', ...VAULTS.map((v) => `/earn/${v.id}`), '/borrow', ...LIVE.map((m) => `/borrow/${m.id}`), ...(currentSwapReadiness().visible ? ['/swap'] : []), ...(LOOP_ENABLED ? ['/loop'] : []), '/analytics', '/liquidations'].map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join('\n')}
</urlset>
`

async function serveStatic(pathname, res) {
  const file = normalize(join(DIST, decodeURIComponent(pathname)))
  if (!file.startsWith(DIST)) return send(res, 400, 'Bad request', { type: 'text/plain' }) // no ../ escapes
  let body,
    served = file
  try {
    body = await readFile(file)
  } catch {
    // A missing file is a plain 404. Other paths get the SPA, with a real 404 status when they aren't one of its routes,
    // so search engines don't index "soft 404s".
    if (extname(pathname)) return send(res, 404, 'Not found', { type: 'text/plain' })
    if (!isAppRoute(pathname)) res.statusCode = 404
    served = join(DIST, 'index.html')
    body = await readFile(served)
  }
  const type = TYPES[extname(served)] ?? 'application/octet-stream'
  res.setHeader('content-type', type)
  // Images readable from any origin: wallets like Phantom load the app icon for their dialogs from their own origin.
  if (type.startsWith('image/')) res.setHeader('access-control-allow-origin', '*')
  // Hashed build assets never change; everything else is revalidated so new deploys show up.
  res.setHeader('cache-control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname.startsWith('/api/')) {
      if (!loopOn && pathname.startsWith('/api/loop-')) return send(res, 404, { error: 'Not found' })
      for (const [method, re, handler] of routes) {
        const match = pathname.match(re)
        if (!match) continue
        if (req.method !== method) return send(res, 405, { error: 'Method not allowed' })
        return await handler(req, res, match.slice(1))
      }
      return send(res, 404, { error: 'Not found' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(res, 405, 'Method not allowed', { type: 'text/plain' })
    if (pathname === '/sitemap.xml')
      return send(res, 200, sitemap(), { type: 'application/xml; charset=utf-8', maxAge: 3600 })
    await serveStatic(pathname === '/' ? '/index.html' : pathname, res)
  } catch (e) {
    if (e instanceof UserError) return send(res, 400, { error: e.message })
    const { status, error: message } = explain(
      e,
      `server ${req.method} ${req.url}`,
      'Something went wrong on our side.',
    )
    if (!res.headersSent) send(res, status === 502 ? 500 : status, { error: message })
    else res.end()
  }
})

// Deploys swap containers and Caddy holds requests meanwhile (lb_try_duration): listen only once the market and the
// sanctions list are loaded (or after READY_TIMEOUT_MS), so nobody gets "still loading".
const READY_TIMEOUT_MS = 15_000
await Promise.race([
  Promise.all([refreshMarket(), startScreening()]),
  new Promise((r) => setTimeout(r, READY_TIMEOUT_MS)),
])
server.listen(PORT, () => console.log(`nysa listening on :${PORT}`))

// Node as PID 1 ignores SIGTERM unless handled, and Docker would kill it after 10 s: stop taking connections, end the
// streams (browsers reconnect to the new container), let requests finish, exit; forced after 8 s.
process.once('SIGTERM', () => {
  console.log('[server] SIGTERM: draining')
  server.close(() => process.exit(0))
  closeStreams()
  setTimeout(() => process.exit(0), 8_000).unref()
})

// A random minute each hour, so nobody can time a deposit to be in only when the snapshot runs. A missed run is
// harmless: the next one accrues the whole gap.
const HOUR_MS = 3_600_000
function scheduleSnapshot() {
  const now = Date.now()
  const next = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS + Math.floor(Math.random() * HOUR_MS)
  setTimeout(
    () =>
      runSnapshot()
        .then((r) => console.log('[snapshot] done', r))
        .catch((e) => console.error('[snapshot] failed', e))
        .finally(scheduleSnapshot),
    next - now,
  )
}
scheduleSnapshot()
