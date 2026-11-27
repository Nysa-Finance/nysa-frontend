// Read-only data for every visitor: the market stream, analytics, updates, liquidations, Farm Points, APY history, health.
import { rpcCallsLastHour } from '../rpc.js'
import { getSnapshot, onSnapshot } from '../market.js'
import { getFeeReceiverMetadata, getPositions, getVaultHolders } from '../analytics.js'
import { marketUpdates, marketLiquidations } from '../updates.js'
import { screeningStatus } from '../screening.js'
import { read, POINTS, HISTORY } from '../storage.js'
import { clientIp, geoBlocked, send } from '../http.js'

const EMPTY_POINTS = 'address,cumulative_points,last_supplied_usd,last_snapshot_ts\n'

// Streams are capped per client IP, so one client can't take every slot; a browser turned away polls /api/market.
const clients = new Set()
const MAX_CLIENTS = 5000
const MAX_STREAMS_PER_IP = 5
const streams = new Map()
const event = (data) => `event: market\ndata: ${JSON.stringify(data)}\n\n`
function events(req, res) {
  const ip = clientIp(req)
  if ((streams.get(ip) ?? 0) >= MAX_STREAMS_PER_IP)
    return send(res, 429, { error: 'Too many connections from this address' })
  if (clients.size >= MAX_CLIENTS) return send(res, 503, { error: 'Too many connections' })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  res.write('retry: 5000\n\n')
  const snapshot = getSnapshot()
  if (snapshot) res.write(event(snapshot))
  clients.add(res)
  streams.set(ip, (streams.get(ip) ?? 0) + 1)
  let open = true
  const drop = () => {
    if (!open) return
    open = false
    clients.delete(res)
    const n = streams.get(ip) - 1
    if (n > 0) streams.set(ip, n)
    else streams.delete(ip)
  }
  req.on('close', drop)
  res.on('close', drop)
  res.on('error', drop) // client gone mid-write
}
onSnapshot((snapshot) => {
  const msg = event(snapshot)
  for (const c of clients) c.write(msg)
})
setInterval(() => {
  for (const c of clients) c.write(': ping\n\n')
}, 25_000).unref() // under Cloudflare's 100s idle cut

// Ends every open stream (on shutdown): browsers reconnect to the new container.
export function closeStreams() {
  for (const c of clients) c.end()
}

export const publicRoutes = [
  [
    'GET',
    /^\/api\/market$/,
    (req, res) => {
      const s = getSnapshot()
      return s ? send(res, 200, s) : send(res, 503, { error: 'Market data is still loading' })
    },
  ],
  ['GET', /^\/api\/events$/, events],
  [
    'GET',
    /^\/api\/analytics$/,
    async (req, res) => {
      // Positions are required by analytics and liquidations; vault holders are optional.
      const [positions, vaults] = await Promise.all([
        getPositions(),
        getVaultHolders().catch((e) => {
          console.error('[analytics] vault holders', e?.message)
          return null
        }),
      ])
      send(res, 200, { positions, vaults, feeReceivers: getFeeReceiverMetadata() }, { maxAge: 30 })
    },
  ],
  ['GET', /^\/api\/geo$/, (req, res) => send(res, 200, { blocked: geoBlocked(req) })],
  ['GET', /^\/api\/fee-receivers$/, (req, res) => send(res, 200, getFeeReceiverMetadata(), { maxAge: 30 })],
  ['GET', /^\/api\/market-updates$/, async (req, res) => send(res, 200, await marketUpdates(), { maxAge: 60 })],
  ['GET', /^\/api\/liquidations$/, async (req, res) => send(res, 200, await marketLiquidations(), { maxAge: 60 })],
  [
    'GET',
    /^\/api\/points$/,
    async (req, res) =>
      send(res, 200, (await read(POINTS)) ?? EMPTY_POINTS, { type: 'text/csv; charset=utf-8', maxAge: 300 }),
  ],
  [
    'GET',
    /^\/api\/apy-history$/,
    async (req, res) => send(res, 200, (await read(HISTORY)) ?? '{"tokens":{}}', { maxAge: 300 }),
  ],
  [
    'GET',
    /^\/api\/health$/,
    (req, res) => {
      const s = getSnapshot()
      const age = s ? Math.round((Date.now() - s.updatedAt) / 1000) : null
      send(res, s && age < 300 ? 200 : 503, {
        ok: !!s && age < 300,
        marketAgeSec: age,
        sseClients: clients.size,
        rpcCallsLastHour: rpcCallsLastHour(),
        sanctionsScreening: screeningStatus(),
      })
    },
  ],
]
