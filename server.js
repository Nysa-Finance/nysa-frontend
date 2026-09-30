// Production server for the VPS / Docker deploy: does what Vercel does for this project.
// - serves the Vite build (dist/), with SPA fallback to index.html;
// - routes /api/<name> to the same handlers Vercel runs (api/<name>.js);
// - runs the daily snapshot at 00:00 UTC (Vercel Cron's job), calling the handler in-process.
// Caddy sits in front for HTTPS; see docker-compose.yml.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT) || 3000
const DIST = fileURLToPath(new URL('./dist/', import.meta.url))
const API = new Set(['points', 'apy-history', 'market-updates', 'points-snapshot'])
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}

async function serveStatic(pathname, res) {
  const file = normalize(join(DIST, decodeURIComponent(pathname)))
  if (!file.startsWith(DIST)) { res.statusCode = 400; return res.end() } // no ../ escapes
  let body, served = file
  try {
    body = await readFile(file)
  } catch {
    served = join(DIST, 'index.html') // client-side routes (/lend, /market/…) → the SPA
    body = await readFile(served)
  }
  res.setHeader('content-type', TYPES[extname(served)] ?? 'application/octet-stream')
  // Hashed build assets never change; index.html must always be revalidated to pick up new deploys.
  res.setHeader('cache-control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  res.end(body)
}

http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost')
    const api = pathname.match(/^\/api\/([\w-]+)$/)?.[1]
    if (api) {
      if (!API.has(api)) { res.statusCode = 404; return res.end('Not found') }
      return (await import(`./api/${api}.js`)).default(req, res)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end() }
    await serveStatic(pathname === '/' ? '/index.html' : pathname, res)
  } catch (e) {
    console.error('[server]', e)
    if (!res.headersSent) res.statusCode = 500
    res.end('Internal error')
  }
}).listen(PORT, () => console.log(`nysa listening on :${PORT}`))

// Daily snapshot at 00:00 UTC. A missed run (e.g. restart at midnight) is harmless: the next one accrues the whole gap.
async function snapshot() {
  const { default: handler } = await import('./api/points-snapshot.js')
  await new Promise((done) => handler(
    { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
    { statusCode: 200, setHeader() {}, end(body) { console.log('[snapshot]', this.statusCode, String(body)); done() } },
  ))
}
function scheduleSnapshot() {
  const now = new Date()
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  setTimeout(() => snapshot().catch((e) => console.error('[snapshot]', e)).finally(scheduleSnapshot), next - now.getTime())
}
if (process.env.CRON_SECRET) scheduleSnapshot()
else console.warn('CRON_SECRET not set: daily snapshot disabled')
