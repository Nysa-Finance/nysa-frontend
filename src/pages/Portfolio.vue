<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { state, rowOf, priceOf } from '../store.js'
import { LIVE, tok, tokensOf } from '../config.js'
import { usd, pct, amt, healthFactor } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'

const router = useRouter()
const view = ref('deposits')
const on = computed(() => !!state.address)

const deposits = computed(() =>
  LIVE.flatMap((m) => tokensOf(m).map((t) => ({ m, t, units: rowOf(t.token_id)?.supplied ?? 0 })))
    .filter((d) => d.units > 0)
    .map((d) => ({ ...d, usd: d.units * priceOf(d.t.token_id), apr: rowOf(d.t.token_id)?.reserve.supplyAPR ?? 0 })),
)
const loans = computed(() =>
  LIVE.flatMap((m) =>
    m.loans.map((id) => {
      const units = rowOf(id)?.borrowed ?? 0
      const debtUsd = units * priceOf(id)
      const coll = m.collateral.map((c) => ({ t: tok(c), usd: (rowOf(c)?.supplied ?? 0) * priceOf(c) }))
      const collUsd = coll.reduce((s, c) => s + c.usd, 0)
      const liq = m.pairs.find((p) => p.liability === id)?.liqLtv ?? 0
      return { m, t: tok(id), units, usd: debtUsd, coll, collUsd, hf: healthFactor(collUsd, liq, debtUsd), apr: rowOf(id)?.reserve.borrowAPR ?? 0 }
    }),
  ).filter((l) => l.units > 0),
)
const supplied = computed(() => deposits.value.reduce((s, d) => s + d.usd, 0))
const borrowed = computed(() => loans.value.reduce((s, l) => s + l.usd, 0))
const netApy = computed(() => {
  if (!supplied.value) return null
  const earn = deposits.value.reduce((s, d) => s + d.usd * d.apr, 0) - loans.value.reduce((s, l) => s + l.usd * l.apr, 0)
  return earn / supplied.value
})
const hf = computed(() => (loans.value.length ? Math.min(...loans.value.map((l) => l.hf)) : Infinity))
const hfText = (v) => (!on.value ? '—' : !Number.isFinite(v) || v > 999 ? '∞' : v.toFixed(2))
const hfColor = (v) => (!on.value ? 'var(--n-text-3)' : v >= 1.8 ? 'var(--n-green)' : v >= 1.3 ? 'var(--n-amber)' : 'var(--n-red)')
const go = (m, mode, tab, asset) => router.push({ name: 'market-detail', params: { id: m.id }, query: { mode, tab, asset } })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Portfolio</h1>
    <p class="n-sub">Track your positions across all markets</p>
  </div>
  <div v-if="!on" class="n-banner">Connect a wallet to see your positions.</div>

  <div class="n-stats stat-4">
    <div class="n-stat"><div class="k">Total Supplied</div><div class="v">{{ on ? usd(supplied) : '—' }}</div></div>
    <div class="n-stat"><div class="k">Total Borrowed</div><div class="v">{{ on ? usd(borrowed) : '—' }}</div></div>
    <div class="n-stat"><div class="k">Net APY</div><div class="v accent">{{ on ? pct(netApy) : '—' }}</div></div>
    <div class="n-stat"><div class="k">Health Factor</div><div class="v" :style="{ color: hfColor(hf) }">{{ hfText(hf) }}</div></div>
  </div>

  <div class="n-seg toggle">
    <button :class="{ on: view === 'deposits' }" @click="view = 'deposits'">Active Deposits</button>
    <button :class="{ on: view === 'loans' }" @click="view = 'loans'">Active Loans</button>
  </div>

  <div v-if="view === 'deposits'" class="n-table">
    <div class="n-thead dp-grid"><div>Market</div><div>Asset Supplied</div><div>$ Value</div><div /></div>
    <div v-if="!on" class="n-empty">Connect a wallet to see your deposits.</div>
    <div v-else-if="!deposits.length" class="n-empty">No active deposits.</div>
    <template v-else><div v-for="d in deposits" :key="d.m.id + d.t.token_id" class="n-tr dp-grid">
      <div class="n-cell" data-label="Market"><span class="mk">{{ d.m.name }}</span> <span class="n-chip mainnet">Solana</span></div>
      <div class="n-cell n-asset" data-label="Asset Supplied"><TokenIcon :token="d.t" size="sm" /><span class="n-num">{{ amt(d.units) }} {{ d.t.name }}</span></div>
      <div class="n-cell n-muted n-num" data-label="$ Value">{{ usd(d.usd) }}</div>
      <div class="n-cell n-actions">
        <button class="n-btn-sm ghost" @click="go(d.m, 'lend', 'withdraw', d.t.token_id)">Withdraw</button>
      </div>
    </div></template>
  </div>

  <div v-else class="n-table">
    <div class="n-thead pl-grid"><div>Loan</div><div>Loan $ Value</div><div>Collateral</div><div>Collateral $ Value</div><div>HF</div><div /></div>
    <div v-if="!on" class="n-empty">Connect a wallet to see your loans.</div>
    <div v-else-if="!loans.length" class="n-empty">No active loans.</div>
    <template v-else><div v-for="l in loans" :key="l.m.id + l.t.token_id" class="n-tr pl-grid">
      <div class="n-cell n-asset" data-label="Loan"><TokenIcon :token="l.t" size="sm" /><span class="n-num">{{ amt(l.units) }} {{ l.t.name }}</span></div>
      <div class="n-cell n-muted n-num" data-label="Loan $ Value">{{ usd(l.usd) }}</div>
      <div class="n-cell" data-label="Collateral"><div class="n-tok-group"><TokenIcon v-for="c in l.coll" :key="c.t.token_id" :token="c.t" size="sm" /></div></div>
      <div class="n-cell n-muted n-num" data-label="Collateral $ Value">{{ usd(l.collUsd) }}</div>
      <div class="n-cell n-num" data-label="HF" :style="{ color: hfColor(l.hf), fontWeight: 600 }">{{ hfText(l.hf) }}</div>
      <div class="n-cell n-actions">
        <button class="n-btn-sm" @click="go(l.m, 'borrow', 'repay', l.t.token_id)">Repay</button>
        <button class="n-btn-sm ghost" @click="go(l.m, 'borrow', 'borrow', l.t.token_id)">Add collateral</button>
      </div>
    </div></template>
  </div>
</template>

<style scoped>
.mk { font-weight: 600; }
</style>
