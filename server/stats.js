// Site analytics for the private dashboard (/admin/analytics): reads the self-hosted Plausible through its Stats API
// (v2 /api/v2/query) with a key that stays on the server. Only the named queries below can be run, each cached for a
// minute so the dashboard stays well under the API's 600 requests/hour.
const BASE = process.env.PLAUSIBLE_URL || 'https://analytics.nysa.finance'
const KEY = process.env.PLAUSIBLE_API_KEY
const SITE = 'app.nysa.finance'
const TTL_MS = 60_000

export const PERIODS = ['day', '7d', '30d', 'month', '6mo', '12mo', 'all']
export const statsReady = () => !!KEY

const TOP = ['visitors', 'visits', 'pageviews', 'views_per_visit', 'bounce_rate', 'visit_duration']
const list = (dimension, metrics = ['visitors']) => ({ metrics, dimensions: [dimension], pagination: { limit: 50 } })
// name -> query (without site and date range)
const QUERIES = {
  channels: list('visit:channel'),
  sources: list('visit:source'),
  utm_medium: list('visit:utm_medium'),
  utm_source: list('visit:utm_source'),
  utm_campaign: list('visit:utm_campaign'),
  pages: list('event:page', ['visitors', 'pageviews']),
  entry_pages: list('visit:entry_page', ['visitors', 'visits']),
  exit_pages: list('visit:exit_page', ['visitors', 'visits']),
  countries: list('visit:country_name'),
  regions: list('visit:region_name'),
  cities: list('visit:city_name'),
  browsers: list('visit:browser'),
  os: list('visit:os'),
  devices: list('visit:device'),
  goals: list('event:goal', ['visitors', 'events', 'conversion_rate']),
}

async function plausible(body) {
  const res = await fetch(`${BASE}/api/v2/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ site_id: SITE, ...body }),
    signal: AbortSignal.timeout(20_000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Plausible ${res.status}: ${json.error ?? 'query failed'}`)
  return json
}

const cache = new Map() // JSON body -> { at, value }
function cached(body, ttl = TTL_MS) {
  const k = JSON.stringify(body)
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < ttl) return hit.value
  const value = plausible(body).catch((e) => { cache.delete(k); throw e })
  cache.set(k, { at: Date.now(), value })
  if (cache.size > 500) cache.delete(cache.keys().next().value)
  return value
}

const rows = (r) => r.results.map((x) => ({ name: x.dimensions[0] ?? '(none)', ...Object.fromEntries(r.query.metrics.map((m, i) => [m, x.metrics[i]])) }))
const totals = (r) => Object.fromEntries(r.query.metrics.map((m, i) => [m, r.results[0]?.metrics[i] ?? 0]))

// Headline numbers for the period, and the same numbers for the period just before it (same length).
async function top(period) {
  const now = await cached({ metrics: TOP, date_range: period })
  if (period === 'all') return { current: totals(now), previous: null }
  const [from, to] = now.query.date_range.map((d) => Date.parse(d))
  const prevRange = [new Date(from - (to - from) - 1000).toISOString(), new Date(from - 1000).toISOString()]
  const prev = await cached({ metrics: TOP, date_range: prevRange })
  return { current: totals(now), previous: totals(prev) }
}

// Time series of the headline metrics: hours for today, days up to a month, months beyond.
async function series(period) {
  const unit = period === 'day' ? 'time:hour' : ['6mo', '12mo', 'all'].includes(period) ? 'time:month' : 'time:day'
  // Plausible refuses views_per_visit with dimensions: it is pageviews / visits, computed per point here.
  const metrics = TOP.filter((m) => m !== 'views_per_visit')
  const r = await cached({ metrics, date_range: period, dimensions: [unit], include: { time_labels: true } })
  const byTime = new Map(r.results.map((x) => [x.dimensions[0], x.metrics]))
  return {
    unit,
    points: r.meta.time_labels.map((t) => {
      const p = { t, ...Object.fromEntries(metrics.map((m, i) => [m, byTime.get(t)?.[i] ?? 0])) }
      return { ...p, views_per_visit: p.visits ? +(p.pageviews / p.visits).toFixed(2) : 0 }
    }),
  }
}

// Visitors in the last 5 minutes.
async function realtime() {
  const to = Date.now()
  const r = await cached({ metrics: ['visitors'], date_range: [new Date(to - 5 * 60_000).toISOString(), new Date(to).toISOString()] }, 15_000)
  return { visitors: totals(r).visitors }
}

// Breakdown of one custom property (e.g. "via") for one goal (e.g. "Wallet connected").
async function props(period, goal, prop) {
  const r = await cached({ metrics: ['visitors', 'events'], date_range: period, dimensions: [`event:props:${prop}`], filters: [['is', 'event:goal', [goal]]], pagination: { limit: 50 } })
  return { rows: rows(r) }
}

// q: top | series | realtime | props | one of QUERIES.
export async function siteStats({ q, period, goal, prop }) {
  if (q === 'realtime') return realtime()
  if (!PERIODS.includes(period)) throw new Error('Unknown period')
  if (q === 'top') return top(period)
  if (q === 'series') return series(period)
  if (q === 'props') {
    if (!/^[\w :.-]{1,80}$/.test(goal ?? '') || !/^\w{1,40}$/.test(prop ?? '')) throw new Error('Invalid goal or property')
    return props(period, goal, prop)
  }
  if (!QUERIES[q]) throw new Error('Unknown query')
  return { rows: rows(await cached({ ...QUERIES[q], date_range: period })) }
}
