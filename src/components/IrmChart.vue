<script setup>
import { computed } from 'vue'
import { borrowRateAt, supplyRateAt, pct } from '../logic.js'

const props = defineProps({ irm: Object, utilization: Number })
const W = 600, H = 220, L = 44, B = 28, T = 8, R = 8
const yMax = computed(() => Math.ceil(Math.max(...props.irm.points.map((p) => p[1])) / 5) * 5 || 5)
const x = (u) => L + (u / 100) * (W - L - R)
const y = (r) => T + (1 - r / yMax.value) * (H - T - B)
const us = Array.from({ length: 101 }, (_, i) => i)
const line = (f) => us.map((u, i) => `${i ? 'L' : 'M'}${x(u).toFixed(1)},${y(f(u)).toFixed(1)}`).join('')
const borrowPath = computed(() => line((u) => borrowRateAt(props.irm.points, u)))
const supplyPath = computed(() => line((u) => supplyRateAt(props.irm, u)))
const yTicks = computed(() => [0, 1, 2, 3].map((i) => (yMax.value / 3) * i))
const cur = computed(() => props.utilization ?? 0)
const curBorrow = computed(() => borrowRateAt(props.irm.points, cur.value))
</script>

<template>
  <div class="legend">
    <span><i class="line" style="background: #F94075" />Borrow rate</span>
    <span><i class="line" style="background: #3ddc84" />Supply rate</span>
    <span><i class="dash" />Current utilization {{ pct(cur, 1) }} · borrow {{ pct(curBorrow) }}</span>
  </div>
  <svg :viewBox="`0 0 ${W} ${H}`" class="chart" role="img" aria-label="Interest rate model">
    <g font-size="10" fill="#666">
      <template v-for="t in yTicks" :key="t">
        <line :x1="L" :x2="W - R" :y1="y(t)" :y2="y(t)" stroke="#1a1a1a" />
        <text :x="L - 8" :y="y(t) + 3" text-anchor="end">{{ t.toFixed(t % 1 ? 1 : 0) }}%</text>
      </template>
      <template v-for="u in [0, 25, 50, 75, 100]" :key="u">
        <line :x1="x(u)" :x2="x(u)" :y1="T" :y2="H - B" stroke="#141414" />
        <text :x="x(u)" :y="H - B + 14" text-anchor="middle">{{ u }}%</text>
      </template>
      <text :x="(L + W - R) / 2" :y="H - 2" text-anchor="middle">Utilization</text>
    </g>
    <line :x1="x(cur)" :x2="x(cur)" :y1="T" :y2="H - B" stroke="rgba(255,255,255,.55)" stroke-dasharray="3 3" />
    <path :d="supplyPath" fill="none" stroke="#3ddc84" stroke-width="1.5" />
    <path :d="borrowPath" fill="none" stroke="#F94075" stroke-width="1.5" />
    <circle :cx="x(cur)" :cy="y(curBorrow)" r="4" fill="#F94075" stroke="#000" stroke-width="2" />
  </svg>
</template>

<style scoped>
.legend { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 12px; color: var(--n-text-3); margin-bottom: 14px; }
.legend span { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.line { width: 14px; height: 2px; border-radius: 1px; display: inline-block; }
.dash { width: 14px; border-top: 1px dashed rgba(255,255,255,.55); display: inline-block; }
.chart { width: 100%; height: auto; display: block; }
</style>
