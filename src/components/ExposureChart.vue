<script setup>
// A vault's exposure: a donut of where its deposits are (each allocated market, the liquidity buffer, tokens waiting for
// the next sync) and a table of those markets with their targets. Before anything is invested it shows the targets.
import { ref, computed } from 'vue'
import { tok } from '../config.js'
import { pct, usd, pieSlices, arcPath } from '../logic.js'
import TokenIcon from './TokenIcon.vue'

const props = defineProps({ vault: Object, price: Number })
const COLORS = ['#EC008C', '#9945ff', '#3ddc84', '#E8B339', '#ff5d9e', '#4da3ff']
const IDLE = '#3a3a3a'

const SYNC = '#5f5f5f'
const invested = computed(() => props.vault.invested > 0)
// Slices: allocated markets, the liquidity buffer (uninvested by design, up to its target) and any other uninvested
// tokens, which Kamino's bot invests at its next sync (about every 15 minutes). Targets before any investment.
const parts = computed(() => {
  const v = props.vault
  const a = v.allocations.map((x, i) => ({
    label: x.marketName ?? `Market ${x.market.slice(0, 4)}…`, color: COLORS[i % COLORS.length], value: invested.value ? x.invested : x.targetShare,
  }))
  if (!invested.value) return [...a, { label: 'Liquidity buffer', color: IDLE, value: v.total > 0 ? (v.bufferTarget / v.total) * 100 : 0 }]
  const buffer = Math.min(v.available, v.bufferTarget)
  // A slice only when it matters (≥ 0.01%): a few micro-USDC aren't worth a label.
  return [...a, { label: 'Liquidity buffer', color: IDLE, value: buffer }, { label: 'Awaiting sync', color: SYNC, value: v.available - buffer }]
    .filter((p) => p.value / v.total >= 1e-4 || a.some((x) => x === p))
})
const slices = computed(() => pieSlices(parts.value.map((p) => p.value)).map((s, i) => ({ ...s, ...parts.value[i] })))
const hover = ref(null)
const shown = computed(() => slices.value[hover.value] ?? null)
const C = 90, R = 84, RI = 56
</script>

<template>
  <div class="ex">
    <div class="ex-chart">
      <svg :viewBox="`0 0 ${C * 2} ${C * 2}`" role="img" :aria-label="`Allocation of ${vault.name}`">
        <circle v-if="!slices.some((s) => s.share > 0)" :cx="C" :cy="C" :r="(R + RI) / 2" fill="none" :stroke="IDLE" :stroke-width="R - RI" />
        <path
          v-for="(s, i) in slices" v-show="s.share > 0" :key="i" :d="arcPath(C, C, R, RI, s.start, s.end)" :fill="s.color"
          :opacity="hover == null || hover === i ? 1 : 0.35" @pointerenter="hover = i" @pointerleave="hover = null"
        />
      </svg>
      <div class="ex-center">
        <template v-if="shown"><b>{{ pct(shown.share, 1) }}</b><span>{{ shown.label }}</span></template>
        <template v-else><b>{{ usd(vault.totalUsd) }}</b><span>{{ invested ? 'in the vault' : 'target allocation' }}</span></template>
      </div>
    </div>
    <ul class="ex-legend">
      <li v-for="(s, i) in slices" :key="i" @pointerenter="hover = i" @pointerleave="hover = null">
        <i :style="{ background: s.color }" /><span>{{ s.label }}</span><b>{{ pct(s.share, 1) }}</b>
      </li>
    </ul>
  </div>

  <div class="n-table ex-table">
    <div class="n-thead ex-grid"><div>Market</div><div>Collateral</div><div>Allocation</div><div>Target</div><div>Deposited</div><div>Supply APY</div></div>
    <div v-for="(x, i) in vault.allocations" :key="x.reserve" class="n-tr sm ex-grid">
      <div class="n-cell" data-label="Market">
        <i class="dot" :style="{ background: COLORS[i % COLORS.length] }" />
        <RouterLink v-if="x.marketId" :to="{ name: 'market-detail', params: { id: x.marketId } }" class="ex-link">{{ x.marketName }}</RouterLink>
        <span v-else class="mono">{{ x.market.slice(0, 4) }}…{{ x.market.slice(-4) }}</span>
      </div>
      <div class="n-cell" data-label="Collateral"><div class="n-tok-group"><TokenIcon v-for="c in x.collateral" :key="c" :token="tok(c)" size="sm" /></div></div>
      <div class="n-cell n-num" data-label="Allocation">{{ pct(x.share, 1) }}</div>
      <div class="n-cell n-num" data-label="Target" :title="`Weight ${x.weight}${x.cap != null ? ` · capped at ${usd(x.cap * (price ?? 1))}` : ', no cap'}`">{{ pct(x.targetShare, 1) }}<span v-if="x.cap != null" class="cap">cap {{ usd(x.cap * (price ?? 1)) }}</span></div>
      <div class="n-cell n-num" data-label="Deposited">{{ usd(x.invested * (price ?? 1)) }}</div>
      <div class="n-cell n-accent n-num" data-label="Supply APY">{{ pct(x.supplyApy) }}</div>
    </div>
  </div>
  <p class="hint">
    Targets come from the curator's on-chain weights and caps, read live from Kamino.
    <template v-if="vault.bufferTarget > 0">A liquidity buffer ({{ pct((vault.bufferTarget / vault.total) * 100, 1) }} today) stays uninvested so withdrawals are paid at once.</template>
    Kamino's bot syncs the vault to its targets about every 15 minutes; deposits made on Nysa are usually invested in the same transaction.
    <template v-if="!invested">Nothing is invested yet: the chart shows the targets.</template>
  </p>
</template>

<style scoped>
.ex { display: flex; align-items: center; gap: 36px; flex-wrap: wrap; margin-bottom: 20px; }
.ex-chart { position: relative; width: 200px; height: 200px; flex-shrink: 0; }
.ex-chart svg { width: 100%; height: 100%; }
.ex-chart path { transition: opacity .15s; cursor: default; }
.ex-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; pointer-events: none; padding: 0 44px; }
.ex-center b { font-size: 20px; font-weight: 600; }
.ex-center span { font-size: 11.5px; color: var(--n-text-3); margin-top: 2px; }
.ex-legend { list-style: none; display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 200px; }
.ex-legend li { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.ex-legend i, .dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; display: inline-block; }
.dot { margin-right: 10px; }
.ex-legend span { flex: 1; color: var(--n-text-2); }
.ex-legend b { font-weight: 500; font-variant-numeric: tabular-nums; }
.n-thead { font-size: 11px; padding: 14px 20px; }
.n-tr.sm { padding: 14px 20px; font-size: 14px; }
.ex-grid { grid-template-columns: 1.6fr .9fr .9fr .9fr 1fr .9fr; }
.cap { display: block; font-size: 11.5px; color: var(--n-text-4); }
.ex-link:hover { color: var(--n-pink); }
.mono { font-family: var(--mono); font-size: 13px; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
@media (max-width: 1180px) { .ex-table { overflow-x: auto; } }
</style>
