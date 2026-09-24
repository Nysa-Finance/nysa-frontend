<script setup>
// Interest-rate curve (borrow + supply vs utilization) with hover tooltip, matching the original Chart.js chart.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { borrowRateAt, supplyRateAt, pct } from '../logic.js'

const props = defineProps({ irm: Object, utilization: Number })
const BORROW = '#EC008C', SUPPLY = '#3ddc84'
const H = 240, L = 44, R = 12, T = 10, B = 40

const box = ref(null)
const W = ref(600)
let ro
onMounted(() => {
  ro = new ResizeObserver(([e]) => { W.value = Math.max(e.contentRect.width, 200) })
  ro.observe(box.value)
})
onUnmounted(() => ro?.disconnect())

// "Nice" y-axis like Chart.js: ~5 steps of 1/2/2.5/5 × 10^n.
const yAxis = computed(() => {
  const max = Math.max(...props.irm.points.map((p) => p[1]), 0.1)
  const mag = 10 ** Math.floor(Math.log10(max / 5))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => max / s <= 6)
  const top = Math.ceil(max / step) * step
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) }
})
const x = (u) => L + (u / 100) * (W.value - L - R)
const y = (r) => T + (1 - r / yAxis.value.top) * (H - T - B)
const borrow = (u) => borrowRateAt(props.irm.points, u)
const supply = (u) => supplyRateAt(props.irm, u)

// Every integer utilization plus the curve's own kinks, so corners stay sharp.
const us = computed(() => [...new Set([...Array.from({ length: 101 }, (_, i) => i), ...props.irm.points.map((p) => p[0])])].sort((a, b) => a - b))
const path = (f) => us.value.map((u, i) => `${i ? 'L' : 'M'}${x(u).toFixed(1)},${y(f(u)).toFixed(1)}`).join('')
const cur = computed(() => (Number.isFinite(props.utilization) ? Math.min(Math.max(props.utilization, 0), 100) : null))
const tickLabel = (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`

const hover = ref(null) // utilization (integer %) under the pointer
function onMove(e) {
  const px = e.clientX - box.value.getBoundingClientRect().left
  hover.value = px < L - 8 || px > W.value - R + 8 ? null : Math.round(Math.min(Math.max((px - L) / (W.value - L - R), 0), 1) * 100)
}
const tipLeft = computed(() => (hover.value == null ? 0 : Math.min(x(hover.value) + 12, W.value - 190)))
</script>

<template>
  <div class="legend">
    <span><i class="line" :style="{ background: BORROW }" />Borrow rate</span>
    <span><i class="line" :style="{ background: SUPPLY }" />Supply rate</span>
    <span v-if="cur != null"><i class="dash" />Current utilization {{ pct(cur, 1) }} · borrow {{ pct(borrow(cur)) }}</span>
  </div>
  <div ref="box" class="canvas" @pointermove="onMove" @pointerleave="hover = null">
    <svg :width="W" :height="H" role="img" aria-label="Interest rate curve">
      <g font-size="11" fill="#8a8a8a" font-weight="300">
        <template v-for="t in yAxis.ticks" :key="'y' + t">
          <line :x1="L" :x2="W - R" :y1="y(t)" :y2="y(t)" stroke="#141414" />
          <text :x="L - 8" :y="y(t) + 4" text-anchor="end">{{ tickLabel(t) }}</text>
        </template>
        <template v-for="u in [0, 25, 50, 75, 100]" :key="'x' + u">
          <line :x1="x(u)" :x2="x(u)" :y1="T" :y2="H - B" stroke="#141414" />
          <text :x="x(u)" :y="H - B + 16" text-anchor="middle">{{ u }}%</text>
        </template>
        <text :x="(L + W - R) / 2" :y="H - 4" text-anchor="middle" fill="#666">Utilization</text>
      </g>
      <line :x1="L" :x2="W - R" :y1="H - B" :y2="H - B" stroke="#1a1a1a" />
      <line :x1="L" :x2="L" :y1="T" :y2="H - B" stroke="#1a1a1a" />
      <line v-if="cur != null" :x1="x(cur)" :x2="x(cur)" :y1="T" :y2="H - B" stroke="rgba(255,255,255,.35)" stroke-dasharray="4 4" />
      <path :d="path(borrow)" fill="none" :stroke="BORROW" stroke-width="2" stroke-linejoin="round" />
      <path :d="path(supply)" fill="none" :stroke="SUPPLY" stroke-width="2" stroke-linejoin="round" />
      <circle v-if="cur != null" :cx="x(cur)" :cy="y(borrow(cur))" r="5" :fill="BORROW" stroke="#fff" stroke-width="2" />
      <g v-if="hover != null">
        <line :x1="x(hover)" :x2="x(hover)" :y1="T" :y2="H - B" stroke="#333" />
        <circle :cx="x(hover)" :cy="y(borrow(hover))" r="4" :fill="BORROW" />
        <circle :cx="x(hover)" :cy="y(supply(hover))" r="4" :fill="SUPPLY" />
      </g>
    </svg>
    <div v-if="hover != null" class="tip" :style="{ left: tipLeft + 'px' }">
      <div class="tip-t">Utilization {{ pct(hover, 0) }}</div>
      <div><i :style="{ background: BORROW }" />Borrow rate <b>{{ pct(borrow(hover)) }}</b></div>
      <div><i :style="{ background: SUPPLY }" />Supply rate <b>{{ pct(supply(hover)) }}</b></div>
    </div>
  </div>
</template>

<style scoped>
.legend { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 12px; color: var(--n-text-3); margin-bottom: 14px; }
.legend span { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.line { width: 14px; height: 2px; border-radius: 1px; display: inline-block; }
.dash { width: 14px; border-top: 1px dashed rgba(255,255,255,.55); display: inline-block; }
.canvas { position: relative; height: 240px; touch-action: pan-y; }
.canvas svg { display: block; }
.tip { position: absolute; top: 12px; min-width: 178px; pointer-events: none; background: #0d0d0d; border: 1px solid #333; border-radius: 6px; padding: 10px; font-size: 12px; color: var(--n-text-2); display: flex; flex-direction: column; gap: 4px; }
.tip-t { color: #fff; font-weight: 500; margin-bottom: 2px; }
.tip i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 8px; vertical-align: -1px; }
.tip b { color: #fff; font-weight: 500; margin-left: 6px; }
</style>
