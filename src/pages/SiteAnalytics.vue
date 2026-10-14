<script setup>
// Private site analytics (/admin/analytics): Plausible's statistics and the unique connected wallets, in Nysa's UI.
// Every call goes through the backend with the dashboard password (ANALYTICS_PASSWORD); the Plausible API key never
// reaches the browser. The password is kept in this tab's sessionStorage only.
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { amt, pct } from '../logic.js'
import Section from '../components/Section.vue'
import StatList from '../components/StatList.vue'
import TrafficChart from '../components/TrafficChart.vue'

const PW_KEY = 'nysaAnalyticsPw'
const safe = (fn) => { try { return fn() } catch { return null } }
const password = ref(safe(() => sessionStorage.getItem(PW_KEY)))
const authed = ref(false), loginError = ref(null), typed = ref(''), checking = ref(false)
const plausibleOn = ref(true)

class AuthError extends Error {}
async function adminApi(path) {
  const res = await fetch(`/api/admin/${path}`, { headers: { authorization: `Bearer ${password.value}` } })
  const body = await res.json().catch(() => ({}))
  if (res.status === 401) { logout(); throw new AuthError(body.error) }
  if (!res.ok) throw new Error(body.error ?? `Server responded ${res.status}`)
  return body
}
async function login(pw) {
  checking.value = true
  loginError.value = null
  password.value = pw
  try {
    plausibleOn.value = (await adminApi('check')).plausible
    safe(() => sessionStorage.setItem(PW_KEY, pw))
    authed.value = true
  } catch (e) {
    loginError.value = e instanceof AuthError ? 'Wrong password.' : e.message
  } finally { checking.value = false }
}
function logout() {
  safe(() => sessionStorage.removeItem(PW_KEY))
  password.value = null
  authed.value = false
}
onMounted(() => { if (password.value) login(password.value) })

// ---- period ----
const PERIODS = [['day', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['6mo', '6 months'], ['12mo', '12 months'], ['all', 'All time']]
const period = ref(safe(() => localStorage.getItem('nysaAnalyticsPeriod')) ?? '30d')
watch(period, (p) => safe(() => localStorage.setItem('nysaAnalyticsPeriod', p)))
const stats = (params) => adminApi(`stats?${new URLSearchParams({ period: period.value, ...params })}`)

// ---- headline numbers + chart ----
const dur = (s) => { s = Math.round(s ?? 0); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }
const METRICS = [
  { key: 'visitors', label: 'Unique visitors', fmt: (v) => amt(v, 0) },
  { key: 'visits', label: 'Total visits', fmt: (v) => amt(v, 0) },
  { key: 'pageviews', label: 'Total pageviews', fmt: (v) => amt(v, 0) },
  { key: 'views_per_visit', label: 'Views per visit', fmt: (v) => amt(v, 2) },
  { key: 'bounce_rate', label: 'Bounce rate', fmt: (v) => pct(v, 0), lowerIsBetter: true },
  { key: 'visit_duration', label: 'Visit duration', fmt: dur },
]
const top = ref(null), series = ref(null), topError = ref(null), seriesError = ref(null)
const metric = ref(METRICS[0])
const live = ref(null)

// Headline numbers and chart load independently: one failing doesn't blank the other.
async function loadTop() {
  top.value = series.value = topError.value = seriesError.value = null
  const p = period.value
  stats({ q: 'top' }).then((t) => { if (p === period.value) top.value = t }).catch((e) => { if (!(e instanceof AuthError)) topError.value = e.message })
  stats({ q: 'series' }).then((s) => { if (p === period.value) series.value = s }).catch((e) => { if (!(e instanceof AuthError)) seriesError.value = e.message })
}
async function loadLive() {
  try { live.value = (await adminApi('stats?q=realtime')).visitors } catch { live.value = null }
}
const change = (m) => {
  const now = top.value?.current?.[m.key], before = top.value?.previous?.[m.key]
  if (before == null || now == null || before === 0) return null
  const c = ((now - before) / before) * 100
  return { c, good: m.lowerIsBetter ? c <= 0 : c >= 0 }
}
const chartPoints = computed(() => series.value?.points.map((p) => ({ t: p.t, value: p[metric.value.key] ?? 0 })) ?? [])
const axisFmt = (v, axis) => (metric.value.key === 'visit_duration' ? dur(v) : metric.value.key === 'bounce_rate' ? `${+v.toFixed(0)}%` : amt(v, axis ? 1 : 2))

// ---- wallets ----
const wallets = ref(null), walletsError = ref(null)
async function loadWallets() {
  wallets.value = walletsError.value = null
  try { wallets.value = await adminApi(`wallets?period=${period.value}`) } catch (e) { if (!(e instanceof AuthError)) walletsError.value = e.message }
}
const wMax = computed(() => Math.max(...(wallets.value?.series ?? []).map((d) => d.wallets), 1))
const wLabel = (t) => new Date(t.length > 7 ? `${t}T00:00:00Z` : `${t}-01T00:00:00Z`).toLocaleDateString('en-US', wallets.value?.unit === 'month' ? { month: 'short', year: '2-digit', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })

// ---- goals (custom events) and their properties ----
// Properties each tracked event carries (src/analytics.js callers).
const GOAL_PROPS = {
  'Wallet connected': ['via', 'wallet'],
  Deposit: ['token'], Withdraw: ['token'], Borrow: ['token'], Repay: ['token'],
  'Rewards claimed': ['market'], Liquidation: ['market'],
  'Transaction failed': ['action', 'reason'],
  'Farm Points opened': ['from'],
  'Outbound Link: Click': ['url'],
}
const goals = ref(null), goalsError = ref(null), openGoal = ref(null), goalProps = ref({})
async function loadGoals() {
  goals.value = goalsError.value = null
  openGoal.value = null
  try { goals.value = (await stats({ q: 'goals' })).rows } catch (e) { if (!(e instanceof AuthError)) goalsError.value = e.message }
}
async function toggleGoal(g) {
  if (openGoal.value === g) return (openGoal.value = null)
  openGoal.value = g
  goalProps.value = {}
  for (const prop of GOAL_PROPS[g] ?? []) {
    stats({ q: 'props', goal: g, prop }).then((r) => { if (openGoal.value === g) goalProps.value = { ...goalProps.value, [prop]: r.rows } }).catch(() => {})
  }
}

// ---- breakdown cards ----
const SOURCES = [{ q: 'channels', label: 'Channels' }, { q: 'sources', label: 'Sources' }, { q: 'utm_medium', label: 'UTM medium' }, { q: 'utm_source', label: 'UTM source' }, { q: 'utm_campaign', label: 'UTM campaign' }]
const PAGES = [{ q: 'pages', label: 'Top pages', cols: [['visitors', 'Visitors'], ['pageviews', 'Views']] }, { q: 'entry_pages', label: 'Entry pages', cols: [['visitors', 'Visitors'], ['visits', 'Entries']] }, { q: 'exit_pages', label: 'Exit pages', cols: [['visitors', 'Visitors'], ['visits', 'Exits']] }]
const LOCATIONS = [{ q: 'countries', label: 'Countries' }, { q: 'regions', label: 'Regions' }, { q: 'cities', label: 'Cities' }]
const DEVICES = [{ q: 'browsers', label: 'Browser' }, { q: 'os', label: 'OS' }, { q: 'devices', label: 'Size' }]

let liveTimer
function loadAll() {
  if (plausibleOn.value) { loadTop(); loadGoals() }
  loadWallets()
}
watch(authed, (ok) => {
  clearInterval(liveTimer)
  if (!ok) return
  loadAll()
  if (plausibleOn.value) { loadLive(); liveTimer = setInterval(loadLive, 30_000) }
})
watch(period, () => authed.value && loadAll())
onUnmounted(() => clearInterval(liveTimer))
</script>

<template>
  <div v-if="!authed" class="login">
    <form class="n-panel login-card" @submit.prevent="login(typed)">
      <h1 class="n-h1">Site analytics</h1>
      <p class="n-sub">Private dashboard. Enter the analytics password.</p>
      <input v-model="typed" class="n-input" type="password" autocomplete="current-password" placeholder="Password" :disabled="checking" />
      <p v-if="loginError" class="n-warn">{{ loginError }}</p>
      <button class="n-btn-block" :disabled="!typed || checking">{{ checking ? 'Checking…' : 'Open dashboard' }}</button>
    </form>
  </div>

  <template v-else>
    <div class="n-page-head head">
      <div>
        <h1 class="n-h1">Site analytics</h1>
        <p class="n-sub">Visits from Plausible (cookie-less) and unique connected wallets</p>
      </div>
      <div class="head-right">
        <span v-if="live != null" class="n-pill live"><span class="n-dot" />{{ live }} current {{ live === 1 ? 'visitor' : 'visitors' }}</span>
        <button class="n-btn-sm ghost" @click="logout">Lock</button>
      </div>
    </div>

    <div class="periods" role="tablist" aria-label="Period">
      <button v-for="[k, label] in PERIODS" :key="k" role="tab" :aria-selected="period === k" :class="{ on: period === k }" @click="period = k">{{ label }}</button>
    </div>

    <div v-if="!plausibleOn" class="n-banner warn">Plausible is not connected yet: set PLAUSIBLE_API_KEY in the server's .env. Wallet numbers below work already.</div>

    <template v-if="plausibleOn">
      <div class="n-stats tops">
        <button v-for="m in METRICS" :key="m.key" class="n-stat top" :class="{ sel: metric.key === m.key }" @click="metric = m">
          <div class="k">{{ m.label }}</div>
          <div class="v sm"><span v-if="top">{{ m.fmt(top.current[m.key]) }}</span><span v-else-if="topError">—</span><span v-else class="n-skel" /></div>
          <div class="s">
            <template v-if="change(m)"><span :class="change(m).good ? 'up' : 'down'">{{ change(m).c >= 0 ? '▲' : '▼' }} {{ Math.abs(change(m).c).toFixed(0) }}%</span> vs previous period</template>
            <template v-else>{{ period === 'all' ? 'all time' : 'no previous data' }}</template>
          </div>
        </button>
      </div>
      <div class="chart">
        <div class="legend"><span><i />{{ metric.label }}</span></div>
        <p v-if="seriesError" class="n-empty">{{ seriesError }}</p>
        <TrafficChart v-else-if="series" :points="chartPoints" :unit="series.unit.replace('time:', '')" :label="metric.label" :format="(v, axis) => axisFmt(v, axis)" />
        <div v-else class="chart-skel n-skel" />
      </div>
    </template>

    <div class="sections">
      <Section title="Connected wallets" open>
        <template #meta>every wallet counts as one user, on any device</template>
        <p v-if="walletsError" class="n-empty">{{ walletsError }}</p>
        <template v-else>
          <div class="n-stats wl-stats">
            <div class="n-stat"><div class="k">Unique wallets</div><div class="v sm accent">{{ wallets ? amt(wallets.unique, 0) : '—' }}</div><div class="s">in this period</div></div>
            <div class="n-stat"><div class="k">New wallets</div><div class="v sm">{{ wallets ? amt(wallets.new, 0) : '—' }}</div><div class="s">first connection ever</div></div>
            <div class="n-stat"><div class="k">Returning wallets</div><div class="v sm">{{ wallets ? amt(wallets.returning, 0) : '—' }}</div><div class="s">connected before this period</div></div>
            <div class="n-stat"><div class="k">All time</div><div class="v sm">{{ wallets ? amt(wallets.allTime, 0) : '—' }}</div><div class="s">since counting started</div></div>
          </div>
          <div v-if="wallets?.series.length" class="bars">
            <div v-for="d in wallets.series" :key="d.t" class="bar" :title="`${wLabel(d.t)}: ${d.wallets} wallets, ${d.new} connecting for the first time`">
              <div class="bar-stack" :style="{ height: (d.wallets / wMax) * 100 + '%' }">
                <div class="bar-ret" :style="{ flex: d.wallets - d.new }" />
                <div class="bar-new" :style="{ flex: d.new }" />
              </div>
              <span class="bar-l">{{ wLabel(d.t) }}</span>
            </div>
          </div>
          <div class="legend wl-legend"><span><i class="new" />First connection ever</span><span><i class="ret" />Seen on an earlier day</span></div>
          <p class="hint">Counted on the server when a wallet connects; only a keyed hash of each address is stored, never the address. Sanctioned wallets are not counted.</p>
        </template>
      </Section>

      <template v-if="plausibleOn">
        <div class="grid">
          <StatList title="Sources" :tabs="SOURCES" :period="period" :load="stats" />
          <StatList title="Pages" :tabs="PAGES" :period="period" :load="stats" />
          <StatList title="Locations" :tabs="LOCATIONS" :period="period" :load="stats" />
          <StatList title="Devices" :tabs="DEVICES" :period="period" :load="stats" />
        </div>

        <Section title="Goals" open>
          <template #meta>custom events · click one for its details</template>
          <div class="n-table">
            <div class="n-thead go-grid"><div>Goal</div><div>Uniques</div><div>Total</div><div>Conversion rate</div></div>
            <div v-if="goalsError" class="n-empty">{{ goalsError }}</div>
            <div v-else-if="!goals" class="n-empty">Loading…</div>
            <div v-else-if="!goals.length" class="n-empty">No goals in this period. Goals appear once they are added in Plausible (Site settings → Goals).</div>
            <template v-for="g in goals ?? []" :key="g.name">
              <button class="n-tr sm go-grid go-row" :class="{ open: openGoal === g.name }" @click="toggleGoal(g.name)">
                <div class="n-cell" data-label="Goal">{{ g.name }} <span v-if="GOAL_PROPS[g.name]" class="go-more">{{ openGoal === g.name ? '−' : '+' }}</span></div>
                <div class="n-cell n-num" data-label="Uniques">{{ amt(g.visitors, 0) }}</div>
                <div class="n-cell n-num" data-label="Total">{{ amt(g.events, 0) }}</div>
                <div class="n-cell n-num" data-label="Conversion rate">{{ pct(g.conversion_rate, 1) }}</div>
              </button>
              <div v-if="openGoal === g.name" class="go-props">
                <div v-for="prop in GOAL_PROPS[g.name]" :key="prop" class="go-prop">
                  <div class="go-prop-t">{{ prop }}</div>
                  <div v-if="!goalProps[prop]" class="n-skel" />
                  <div v-else-if="!goalProps[prop].length" class="go-none">no values</div>
                  <div v-for="r in goalProps[prop] ?? []" :key="r.name" class="go-val"><span>{{ r.name }}</span><b>{{ amt(r.visitors, 0) }}</b><em>{{ amt(r.events, 0) }} events</em></div>
                </div>
              </div>
            </template>
          </div>
        </Section>
      </template>
    </div>
  </template>
</template>

<style scoped>
.login { min-height: 60vh; display: grid; place-items: center; }
.login-card { width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 14px; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.head-right { display: flex; align-items: center; gap: 10px; }
.live .n-dot { background: var(--n-green); box-shadow: 0 0 0 3px #3ddc8433; }
.periods { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 22px; }
.periods button { font-size: 13px; color: var(--n-text-3); padding: 7px 14px; border: 1px solid var(--n-line); border-radius: 999px; background: var(--n-bg-2); }
.periods button:hover { color: #fff; }
.periods button.on { color: #fff; border-color: var(--n-pink); background: #ec008c1f; }
.tops { grid-template-columns: repeat(6, 1fr); }
.n-stat.top { text-align: left; cursor: pointer; transition: background .15s; }
.n-stat.top:hover { background: var(--n-bg-2); }
.n-stat.top.sel { box-shadow: inset 0 -2px 0 var(--n-pink); }
.n-stat .v.sm { font-size: 22px; }
.up { color: var(--n-green); }
.down { color: var(--n-red); }
.chart { margin: 16px 0 26px; border: 1px solid var(--n-line); border-radius: 4px; padding: 18px 20px 14px; background: #000; }
.chart-skel { height: 240px; width: 100%; }
.legend { display: flex; gap: 20px; font-size: 12px; color: var(--n-text-3); margin-bottom: 14px; }
.legend span { display: inline-flex; align-items: center; gap: 8px; }
.legend i { width: 14px; height: 2px; border-radius: 1px; background: var(--n-pink); display: inline-block; }
.sections { display: flex; flex-direction: column; gap: 16px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.wl-stats { grid-template-columns: repeat(4, 1fr); }
.bars { display: flex; align-items: flex-end; gap: 4px; height: 160px; margin-top: 18px; padding-bottom: 22px; overflow-x: auto; }
.bar { flex: 1; min-width: 14px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; position: relative; }
.bar-stack { width: 100%; max-width: 28px; display: flex; flex-direction: column; border-radius: 3px 3px 0 0; overflow: hidden; min-height: 1px; }
.bar-new { background: var(--n-pink); }
.bar-ret { background: #ec008c59; }
.bar-l { position: absolute; bottom: -20px; font-size: 10px; color: var(--n-text-4); white-space: nowrap; }
.bar:not(:first-child):not(:last-child):not(:nth-child(5n)) .bar-l { visibility: hidden; }
.wl-legend { margin-top: 10px; }
.wl-legend i.new { background: var(--n-pink); height: 10px; width: 10px; }
.wl-legend i.ret { background: #ec008c59; height: 10px; width: 10px; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
.n-thead { font-size: 11px; padding: 14px 20px; }
.n-tr.sm { padding: 14px 20px; font-size: 14px; }
.go-grid { grid-template-columns: 2fr 1fr 1fr 1fr; }
.go-row { width: 100%; text-align: left; cursor: pointer; }
.go-row:hover, .go-row.open { background: var(--n-bg-2); }
.go-more { color: var(--n-pink); margin-left: 6px; }
.go-props { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; padding: 16px 20px 20px; background: var(--n-bg-2); border-top: 1px solid var(--n-line); }
.go-prop-t { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--n-text-4); margin-bottom: 8px; }
.go-val { display: flex; align-items: baseline; gap: 10px; font-size: 13px; padding: 4px 0; }
.go-val span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.go-val em { font-style: normal; color: var(--n-text-4); font-size: 12px; }
.go-none { font-size: 12px; color: var(--n-text-4); }
@media (max-width: 1180px) { .tops { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 860px) { .grid { grid-template-columns: 1fr; } .wl-stats { grid-template-columns: repeat(2, 1fr); } }
</style>
