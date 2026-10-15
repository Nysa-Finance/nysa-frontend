<script setup>
// A vault's exposure: a donut of where its deposits are (each allocated market, plus what is still uninvested) and a
// table of those markets. Before anything is invested it shows the target allocation (on-chain weights) instead.
import { ref, computed } from 'vue'
import { tok } from '../config.js'
import { pct, usd, pieSlices, arcPath } from '../logic.js'
import TokenIcon from './TokenIcon.vue'

const props = defineProps({ vault: Object, price: Number })
const COLORS = ['#EC008C', '#9945ff', '#3ddc84', '#E8B339', '#ff5d9e', '#4da3ff']
const IDLE = '#3a3a3a'

const invested = computed(() => props.vault.invested > 0)
// Slices: allocated markets (invested amounts, or target weights before any investment), then uninvested tokens.
const parts = computed(() => {
  const a = props.vault.allocations.map((x, i) => ({
    label: x.marketName ?? `Market ${x.market.slice(0, 4)}…`, color: COLORS[i % COLORS.length], value: invested.value ? x.invested : x.weight, alloc: x,
  }))
  // Uninvested tokens get a slice only when they matter (≥ 0.01%): a few micro-USDC left over isn't worth a label.
  const idle = props.vault.total > 0 ? props.vault.available / props.vault.total : 0
  return invested.value && idle >= 1e-4 ? [...a, { label: 'Not invested yet', color: IDLE, value: props.vault.available }] : a
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
    <div class="n-thead ex-grid"><div>Market</div><div>Collateral</div><div>Allocation</div><div>Deposited</div><div>Supply APY</div></div>
    <div v-for="(x, i) in vault.allocations" :key="x.reserve" class="n-tr sm ex-grid">
      <div class="n-cell" data-label="Market">
        <i class="dot" :style="{ background: COLORS[i % COLORS.length] }" />
        <RouterLink v-if="x.marketId" :to="{ name: 'market-detail', params: { id: x.marketId } }" class="ex-link">{{ x.marketName }}</RouterLink>
        <span v-else class="mono">{{ x.market.slice(0, 4) }}…{{ x.market.slice(-4) }}</span>
      </div>
      <div class="n-cell" data-label="Collateral"><div class="n-tok-group"><TokenIcon v-for="c in x.collateral" :key="c" :token="tok(c)" size="sm" /></div></div>
      <div class="n-cell n-num" data-label="Allocation">{{ invested ? pct(x.share, 1) : `${pct(x.weight / (vault.allocations.reduce((s, a) => s + a.weight, 0) || 1) * 100, 0)} target` }}</div>
      <div class="n-cell n-num" data-label="Deposited">{{ usd(x.invested * (price ?? 1)) }}</div>
      <div class="n-cell n-accent n-num" data-label="Supply APY">{{ pct(x.supplyApy) }}</div>
    </div>
  </div>
  <p class="hint">
    Allocations are set on-chain by the vault's curator and read live from Kamino.
    <template v-if="!invested">Nothing is invested yet: the chart shows the target allocation.</template>
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
.ex-grid { grid-template-columns: 1.6fr .9fr .9fr 1fr .9fr; }
.ex-link:hover { color: var(--n-pink); }
.mono { font-family: var(--mono); font-size: 13px; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
@media (max-width: 1180px) { .ex-table { overflow-x: auto; } }
</style>
