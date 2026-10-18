<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { state, loadAnalytics, loadPoints } from '../store.js'
import { LIVE, VAULTS, tokensOf, explorer } from '../config.js'
import { usd, pct, amt, compact, short, ago, dur, hfText, hfColor } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'
import Section from '../components/Section.vue'
import FarmPointsModal from '../components/FarmPointsModal.vue'

const m = LIVE[0] // ponytail: single live market; iterate LIVE here when a second one ships
const positions = ref(undefined) // undefined = loading, null = unavailable
const holders = ref(undefined) // { [vaultId]: [{ owner, wallet, staked }] }; undefined = loading, null = unavailable
const pointsOpen = ref(false)
const nowSec = ref(Date.now() / 1000)

async function load() {
  try {
    const a = await loadAnalytics()
    positions.value = a.positions.map((p) => ({ ...p, hf: p.hf ?? Infinity }))
    holders.value = a.vaults ?? null
  } catch (e) {
    console.error('[analytics] positions', e)
    positions.value = null
    holders.value = null
  }
  nowSec.value = Date.now() / 1000
}
let timer
onMounted(() => { load(); loadPoints(); timer = setInterval(load, 60_000) })
onUnmounted(() => clearInterval(timer))

// Reserve data is live from the backend's market stream (store.js); only positions are fetched here.
const reserves = computed(() => tokensOf(m).filter((t) => state.reserves[t.token_id]).map((t) => ({ token: t, ...state.reserves[t.token_id] })))
const collateral = computed(() => reserves.value.filter((r) => m.collateral.includes(r.token.token_id)))
const borrowable = computed(() => reserves.value.filter((r) => m.loans.includes(r.token.token_id)))
// TVL: everything supplied in the market (vault deposits it has invested included) + what vaults hold uninvested.
const vaultCashUsd = computed(() => VAULTS.reduce((s, v) => { const x = state.vaults[v.id]; return s + (x && x.total > 0 ? x.available * (x.totalUsd / x.total) : 0) }, 0))
const tvl = computed(() => reserves.value.reduce((s, r) => s + r.supplyUsd, 0) + vaultCashUsd.value)
const borrowed = computed(() => reserves.value.reduce((s, r) => s + r.borrowUsd, 0))
const lendable = computed(() => borrowable.value.reduce((s, r) => s + r.supplyUsd, 0))
const avgUtil = computed(() => (lendable.value > 0 ? (borrowed.value / lendable.value) * 100 : 0))
const rwaUsd = computed(() => reserves.value.filter((r) => r.token.rwa).reduce((s, r) => s + r.supplyUsd, 0))
const maxSupply = computed(() => Math.max(...reserves.value.map((r) => r.supplyUsd), 1e-9))

// Kamino rejects prices older than the reserve's maxAge; RefreshReserve in every user tx pulls a fresh Scope price.
const age = (r) => nowSec.value - r.oracleTs
const fresh = (r) => r.oracleTs > 0 && age(r) <= r.maxAge
const stale = computed(() => reserves.value.filter((r) => !fresh(r)).map((r) => r.token.name))

// Each vault and its depositors (shares in the wallet + staked in the vault farm), valued at the live share price.
const vaults = computed(() => VAULTS.map((v) => {
  const live = state.vaults[v.id]
  const price = live && live.total > 0 ? live.totalUsd / live.total : 1
  const list = holders.value?.[v.id]
  const total = list?.reduce((s, h) => s + h.wallet + h.staked, 0) ?? 0
  const rows = list?.map((h) => ({ ...h, value: (h.wallet + h.staked) * (live?.tokensPerShare ?? 0) * price, share: total > 0 ? ((h.wallet + h.staked) / total) * 100 : 0 }))
  return { v, live, rows }
}))

const board = computed(() => state.points.board)
const totalPoints = computed(() => board.value?.rows.reduce((s, r) => s + r.points, 0) ?? 0)
const farming = computed(() => board.value?.rows.filter((r) => r.supplied > 0).length ?? 0)
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Analytics</h1>
    <p class="n-sub">Live protocol metrics and oracle health, read on-chain from Kamino Lend</p>
  </div>

  <div v-if="stale.length" class="n-banner warn" role="status">
    {{ stale.length }} price {{ stale.length === 1 ? 'feed is' : 'feeds are' }} past the reserve's max age ({{ stale.join(', ') }}).
    Kamino refreshes the price inside every transaction, so this only matters if the Scope feed itself stops updating.
  </div>

  <div class="n-stats stat-4">
    <div class="n-stat">
      <div class="k">Total value locked</div>
      <div class="v"><span v-if="state.loaded">{{ usd(tvl) }}</span><span v-else class="n-skel" /></div>
      <div class="s">{{ reserves.length }} reserves{{ vaultCashUsd > 0 ? ` + ${usd(vaultCashUsd)} in vaults` : '' }}</div>
    </div>
    <div class="n-stat">
      <div class="k">Total borrowed</div>
      <div class="v"><span v-if="state.loaded">{{ usd(borrowed) }}</span><span v-else class="n-skel" /></div>
      <div class="s">{{ usd(lendable - borrowed) }} available</div>
    </div>
    <div class="n-stat">
      <div class="k">Avg utilization</div>
      <div class="v"><span v-if="state.loaded">{{ pct(avgUtil, 1) }}</span><span v-else class="n-skel" /></div>
      <div class="s">across {{ borrowable.length }} borrowable {{ borrowable.length === 1 ? 'reserve' : 'reserves' }}</div>
    </div>
    <div class="n-stat">
      <div class="k">RWA share of TVL</div>
      <div class="v accent"><span v-if="state.loaded">{{ pct(tvl > 0 ? (rwaUsd / tvl) * 100 : 0, 1) }}</span><span v-else class="n-skel" /></div>
      <div class="s">{{ usd(rwaUsd) }} in RWAs</div>
    </div>
  </div>

  <div class="sections">
    <Section title="Oracle feeds" open>
      <template #meta>{{ reserves.length }} feeds · live</template>
      <div class="n-table">
        <div class="n-thead or-grid"><div>Feed</div><div>Price</div><div>Last update</div><div>Window</div><div>Expires in</div><div>Status</div></div>
        <div v-if="!state.loaded" class="n-empty">Reading on-chain data…</div>
        <div v-for="r in reserves" :key="r.token.token_id" class="n-tr sm or-grid">
          <div class="n-cell n-asset" data-label="Feed">
            <TokenIcon :token="r.token" size="sm" />
            <div><div>{{ r.token.name }}</div><a class="sub-link" :href="explorer(r.token.priceFeed)" target="_blank" rel="noopener noreferrer">{{ r.token.feedNote }} ↗</a></div>
          </div>
          <div class="n-cell n-num" data-label="Price">${{ amt(r.price, 4) }}</div>
          <div class="n-cell n-muted" data-label="Last update">{{ ago(r.oracleTs, nowSec * 1000) }}</div>
          <div class="n-cell n-muted" data-label="Window">{{ dur(r.maxAge) }}</div>
          <div class="n-cell n-muted" data-label="Expires in">{{ fresh(r) ? dur(r.maxAge - age(r)) : 'expired' }}</div>
          <div class="n-cell" data-label="Status"><span class="n-chip" :class="fresh(r) ? 'ok' : 'warn'">{{ fresh(r) ? 'Fresh' : 'Stale' }}</span></div>
        </div>
      </div>
    </Section>

    <Section title="Markets by size">
      <template #meta>by total supplied</template>
      <div class="bars">
        <div v-for="r in [...reserves].sort((a, b) => b.supplyUsd - a.supplyUsd)" :key="r.token.token_id" class="bar-row">
          <div class="n-asset"><TokenIcon :token="r.token" size="sm" />{{ r.token.name }}</div>
          <div class="bar"><span :style="{ width: Math.max((r.supplyUsd / maxSupply) * 100, 1) + '%' }" /></div>
          <div class="n-num">{{ usd(r.supplyUsd) }}</div>
        </div>
      </div>
    </Section>

    <Section title="Collateral assets">
      <template #meta>{{ collateral.length }} {{ collateral.length === 1 ? 'reserve' : 'reserves' }} · borrowing disabled</template>
      <div class="n-table">
        <div class="n-thead co-grid"><div>Asset</div><div>Price</div><div>Total deposited</div><div>Max LTV</div><div>Supply cap</div><div>Status</div></div>
        <div v-for="r in collateral" :key="r.token.token_id" class="n-tr sm co-grid">
          <div class="n-cell n-asset" data-label="Asset"><TokenIcon :token="r.token" size="sm" />{{ r.token.name }}</div>
          <div class="n-cell n-num" data-label="Price">${{ amt(r.price, 4) }}</div>
          <div class="n-cell n-num" data-label="Total deposited">{{ usd(r.supplyUsd) }}</div>
          <div class="n-cell n-num" data-label="Max LTV">{{ pct(r.maxLtv, 0) }}</div>
          <div class="n-cell n-num" data-label="Supply cap">{{ compact(r.supplyCap, r.token.name) }}</div>
          <div class="n-cell" data-label="Status"><span class="n-chip ok">Active</span></div>
        </div>
      </div>
    </Section>

    <Section title="Borrowable assets">
      <template #meta>{{ borrowable.length }} {{ borrowable.length === 1 ? 'reserve' : 'reserves' }}</template>
      <div class="n-table">
        <div class="n-thead bo-grid"><div>Asset</div><div>Price</div><div>Supplied</div><div>Borrowed</div><div>Utilization</div><div>Supply APY</div><div>Borrow APY</div></div>
        <div v-for="r in borrowable" :key="r.token.token_id" class="n-tr sm bo-grid">
          <div class="n-cell n-asset" data-label="Asset"><TokenIcon :token="r.token" size="sm" />{{ r.token.name }}</div>
          <div class="n-cell n-num" data-label="Price">${{ amt(r.price, 4) }}</div>
          <div class="n-cell n-num" data-label="Supplied">{{ usd(r.supplyUsd) }}</div>
          <div class="n-cell n-num" data-label="Borrowed">{{ usd(r.borrowUsd) }}</div>
          <div class="n-cell n-num" data-label="Utilization">{{ pct(r.utilization, 1) }}</div>
          <div class="n-cell n-accent n-num" data-label="Supply APY">{{ pct(r.supplyAPR) }}</div>
          <div class="n-cell n-accent n-num" data-label="Borrow APY">{{ pct(r.borrowAPR) }}</div>
        </div>
      </div>
    </Section>

    <Section v-for="x in vaults" :key="x.v.id" :title="x.live?.name ?? x.v.name">
      <template #meta>Earn vault · {{ x.rows ? `${x.rows.length} ${x.rows.length === 1 ? 'depositor' : 'depositors'}` : '' }}</template>
      <div class="n-stats stat-4 vs-stats">
        <div class="n-stat"><div class="k">Total deposits</div><div class="v sm">{{ x.live ? usd(x.live.totalUsd) : '—' }}</div></div>
        <div class="n-stat"><div class="k">Invested</div><div class="v sm">{{ x.live ? usd(x.live.invested * (x.live.totalUsd / x.live.total || 1)) : '—' }}</div></div>
        <div class="n-stat"><div class="k">In the vault</div><div class="v sm">{{ x.live ? usd(x.live.available * (x.live.totalUsd / x.live.total || 1)) : '—' }}</div></div>
        <div class="n-stat"><div class="k">APY</div><div class="v sm accent">{{ x.live ? pct(x.live.apy) : '—' }}</div></div>
      </div>
      <div class="n-table">
        <div class="n-thead vh-grid"><div>Wallet</div><div>Shares in wallet</div><div>Staked in vault farm</div><div>Value</div><div>Share of vault</div></div>
        <div v-if="holders === null" class="n-empty">Depositors are temporarily unavailable.</div>
        <div v-else-if="x.rows?.length === 0" class="n-empty">No deposits in this vault yet.</div>
        <div v-for="h in x.rows ?? []" :key="h.owner" class="n-tr sm vh-grid">
          <div class="n-cell" data-label="Wallet"><a class="sub-link mono" :href="explorer(h.owner)" target="_blank" rel="noopener noreferrer">{{ short(h.owner, 6) }} ↗</a></div>
          <div class="n-cell n-num" data-label="Shares in wallet">{{ amt(h.wallet, 4) }}</div>
          <div class="n-cell n-num" data-label="Staked in vault farm">{{ h.staked > 0 ? amt(h.staked, 4) : '—' }}</div>
          <div class="n-cell n-num" data-label="Value">{{ usd(h.value) }}</div>
          <div class="n-cell n-num" data-label="Share of vault">{{ pct(h.share, 1) }}</div>
        </div>
      </div>
      <p class="hint">Read on-chain: every holder of the vault's shares, including shares staked in the vault farm (deposits made on Kamino's interface).</p>
    </Section>

    <Section title="Positions">
      <template #meta>{{ positions ? `${positions.length} open in the market · sorted by risk` : '' }}</template>
      <div class="n-table">
        <div class="n-thead po-grid"><div>Wallet</div><div>Deposits</div><div>Debt</div><div>LTV</div><div>Liq. LTV</div><div>Health factor</div></div>
        <div v-if="positions === null" class="n-empty">Open positions are temporarily unavailable.</div>
        <div v-else-if="positions?.length === 0" class="n-empty">No open positions in this market yet.</div>
        <div v-for="p in positions ?? []" :key="p.owner" class="n-tr sm po-grid">
          <div class="n-cell" data-label="Wallet"><a class="sub-link mono" :href="explorer(p.owner)" target="_blank" rel="noopener noreferrer">{{ short(p.owner, 6) }} ↗</a></div>
          <div class="n-cell n-num" data-label="Deposits">{{ usd(p.deposits) }}</div>
          <div class="n-cell n-num" data-label="Debt">{{ usd(p.debt) }}</div>
          <div class="n-cell n-num" data-label="LTV">{{ pct(p.ltv, 1) }}</div>
          <div class="n-cell n-num" data-label="Liq. LTV">{{ p.debt > 0 ? pct(p.liqLtv, 0) : '—' }}</div>
          <div class="n-cell n-num" data-label="Health factor" :style="{ color: hfColor(p.hf), fontWeight: 600 }">{{ hfText(p.hf) }}</div>
        </div>
      </div>
    </Section>

    <Section title="Farm Points">
      <template #meta>{{ farming }} wallets farming</template>
      <div class="n-stats fp-stats">
        <div class="n-stat"><div class="k">Wallets farming</div><div class="v sm">{{ board ? farming : '—' }}</div></div>
        <div class="n-stat"><div class="k">Points issued</div><div class="v sm">{{ board ? amt(totalPoints, 0) : '—' }}</div></div>
        <div class="n-stat"><div class="k">Last snapshot</div><div class="v sm">{{ board?.updatedTs ? ago(board.updatedTs) : '—' }}</div></div>
      </div>
      <button class="n-btn-sm ghost" style="margin-top: 16px" @click="pointsOpen = true">View leaderboard</button>
    </Section>
  </div>
  <FarmPointsModal v-if="pointsOpen" @close="pointsOpen = false" />
</template>

<style scoped>
.sections { display: flex; flex-direction: column; gap: 16px; }
.n-thead { font-size: 11px; padding: 14px 20px; }
.n-tr.sm { padding: 15px 20px; font-size: 14px; }
.or-grid { grid-template-columns: 1.5fr 1fr 1fr .8fr .9fr .8fr; }
.co-grid { grid-template-columns: 1.4fr 1fr 1.2fr .9fr 1.1fr .8fr; }
.bo-grid { grid-template-columns: 1.3fr 1fr 1fr 1fr 1fr 1fr 1fr; }
.po-grid { grid-template-columns: 1.5fr 1fr 1fr .8fr .8fr 1fr; }
.vh-grid { grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr; }
.vs-stats { margin-bottom: 16px; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
.sub-link { color: var(--n-text-3); font-size: 12px; font-weight: 400; }
.sub-link:hover { color: var(--n-pink); }
.sub-link.mono { font-family: var(--mono); font-size: 13px; color: var(--n-text-2); }
.bars { display: flex; flex-direction: column; gap: 14px; }
.bar-row { display: grid; grid-template-columns: 140px 1fr 90px; gap: 16px; align-items: center; font-size: 14px; }
.bar-row .n-num { text-align: right; }
.bar { height: 8px; border-radius: 4px; background: var(--n-bg-3); overflow: hidden; }
.bar span { display: block; height: 100%; border-radius: 4px; background: var(--n-grad); }
.fp-stats { grid-template-columns: repeat(3, 1fr); }
.n-stat .v.sm { font-size: 22px; }
@media (max-width: 1180px) { .n-table { overflow-x: auto; } }
@media (max-width: 860px) { .bar-row { grid-template-columns: 90px 1fr 70px; gap: 10px; } }
</style>
