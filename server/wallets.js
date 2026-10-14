// Unique users = unique connected wallets. Every wallet that reads its account (/api/account, i.e. connects in the app)
// is counted once per day, across devices and browsers. Only a keyed hash of the address is stored (HMAC-SHA256 with
// a random key kept in DATA_DIR), never the address itself, and nothing leaves the server.
// Print the numbers: `docker compose exec app node server/wallets.js`; the dashboard reads walletStats().
import { createHmac, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { read, write, WALLETS, WALLETS_KEY } from './storage.js'

const DAY_MS = 86_400_000
const isoDay = (t) => new Date(t).toISOString().slice(0, 10) // UTC day

let state = null // { firstSeen: { hash: day }, days: { day: [hash] } }
let key = null
let loading = null
const load = () => (loading ??= (async () => {
  key = await read(WALLETS_KEY)
  if (!key) await write(WALLETS_KEY, (key = randomBytes(32).toString('hex')))
  state = { firstSeen: {}, days: {}, ...JSON.parse((await read(WALLETS)) ?? '{}') }
})())

const hashOf = (wallet) => createHmac('sha256', key).update(wallet).digest('base64url').slice(0, 22)

// Writes are chained so two never overlap on the same temp file.
// ponytail: rewrites the whole file once per new wallet per day; move to SQLite past ~10k wallets a day.
let saving = Promise.resolve()
export async function recordWallet(wallet, now = Date.now()) {
  await load()
  const h = hashOf(wallet), day = isoDay(now)
  const today = (state.days[day] ??= [])
  if (today.includes(h)) return
  today.push(h)
  state.firstSeen[h] ??= day
  const body = JSON.stringify(state)
  saving = saving.then(() => write(WALLETS, body)).catch((e) => console.error('[wallets] save failed', e.message))
  return saving
}

// Days covered by a dashboard period (the same keywords as Plausible's date ranges), counting today.
export function periodDays(period, now = Date.now()) {
  const d = new Date(now)
  return { day: 1, '7d': 7, '30d': 30, month: d.getUTCDate(), '6mo': 183, '12mo': 365 }[period] ?? Infinity
}

// Unique wallets in the last `days` days (Infinity = all time): how many, how many connected for the first time
// ever in that window, and a series per day (per month for windows longer than a month).
export async function walletStats(days, now = Date.now()) {
  await load()
  const first = Object.keys(state.days).sort()[0]
  const span = Number.isFinite(days) ? days : first ? Math.floor((now - Date.parse(first)) / DAY_MS) + 1 : 1
  const bucket = (d) => (span > 31 ? d.slice(0, 7) : d)
  const buckets = new Map(), all = new Set()
  for (let back = span - 1; back >= 0; back--) {
    const d = isoDay(now - back * DAY_MS)
    const b = buckets.get(bucket(d)) ?? buckets.set(bucket(d), new Set()).get(bucket(d))
    for (const h of state.days[d] ?? []) { b.add(h); all.add(h) }
  }
  const start = isoDay(now - (span - 1) * DAY_MS)
  const isNew = (h) => state.firstSeen[h] >= start
  const fresh = [...all].filter(isNew).length
  return {
    unique: all.size,
    new: fresh,
    returning: all.size - fresh,
    allTime: Object.keys(state.firstSeen).length,
    unit: span > 31 ? 'month' : 'day',
    series: [...buckets].map(([t, hashes]) => ({ t, wallets: hashes.size, new: [...hashes].filter((h) => bucket(state.firstSeen[h]) === t).length })),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [today, week, month] = await Promise.all([1, 7, 30].map((n) => walletStats(n)))
  console.log(`Unique wallets — today ${today.unique} · 7 days ${week.unique} · 30 days ${month.unique} · all time ${month.allTime}`)
  for (const d of month.series.filter((x) => x.wallets)) console.log(`  ${d.t}  ${d.wallets} wallets (${d.new} new)`)
}
