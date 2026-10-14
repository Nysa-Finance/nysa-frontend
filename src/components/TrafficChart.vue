<script setup>
// One metric over time (visitors, pageviews…), styled like the Realized APY chart. points: [{ t, value }] where t is a
// Plausible time label ("2026-10-14", "2026-10-14 13:00:00" or a month's first day); unit: hour | day | month.
import { ref, computed, watch, onUnmounted } from 'vue'
import { niceTicks } from '../logic.js'

const props = defineProps({ points: Array, unit: String, label: String, format: Function })
const COLOR = '#EC008C'
const H = 240, L = 52, R = 12, T = 10, B = 34
const box = ref(null)
const W = ref(600)
const ro = new ResizeObserver(([e]) => { W.value = Math.max(e.contentRect.width, 200) })
watch(box, (el) => { ro.disconnect(); if (el) ro.observe(el) }, { flush: 'post' })
onUnmounted(() => ro.disconnect())

const n = computed(() => props.points.length)
const x = (i) => L + (n.value > 1 ? i / (n.value - 1) : 0.5) * (W.value - L - R)
const yAxis = computed(() => niceTicks(Math.max(...props.points.map((p) => p.value), 1)))
const y = (v) => T + (1 - v / yAxis.value.top) * (H - T - B)
const line = computed(() => props.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(''))
const area = computed(() => (n.value ? `${line.value}L${x(n.value - 1).toFixed(1)},${H - B}L${x(0).toFixed(1)},${H - B}Z` : ''))

// Labels are in the site's timezone already: parse and print them as-is (via UTC, so the browser's zone can't shift them).
const when = (t, long) => {
  const d = new Date(t.replace(' ', 'T') + (t.length > 10 ? 'Z' : 'T00:00:00Z'))
  if (props.unit === 'hour') return d.toLocaleString('en-US', { ...(long && { month: 'short', day: 'numeric' }), hour: 'numeric', timeZone: 'UTC' })
  if (props.unit === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: long ? 'numeric' : '2-digit', timeZone: 'UTC' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
// Labels at least 64px apart, the latest one always shown.
const xTicks = computed(() => {
  const out = []
  for (let i = n.value - 1; i >= 0; i--) if (!out.length || x(out.at(-1)) - x(i) >= 64) out.push(i)
  return out
})
const hover = ref(null)
function onMove(e) {
  const px = e.clientX - box.value.getBoundingClientRect().left
  let best = 0
  for (let i = 1; i < n.value; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i
  hover.value = n.value ? best : null
}
</script>

<template>
  <div ref="box" class="tc" @pointermove="onMove" @pointerleave="hover = null">
    <svg :width="W" :height="H" role="img" :aria-label="`${label} over time`">
      <defs>
        <linearGradient id="tc-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" :stop-color="COLOR" stop-opacity=".28" />
          <stop offset="1" :stop-color="COLOR" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g font-size="11" fill="#8a8a8a" font-weight="300">
        <template v-for="t in yAxis.ticks" :key="'y' + t">
          <line :x1="L" :x2="W - R" :y1="y(t)" :y2="y(t)" stroke="#141414" />
          <text :x="L - 8" :y="y(t) + 4" text-anchor="end">{{ format(t, true) }}</text>
        </template>
        <text v-for="i in xTicks" :key="'x' + i" :x="x(i)" :y="H - B + 16" :text-anchor="x(i) > W - R - 30 ? 'end' : x(i) < L + 30 ? 'start' : 'middle'">{{ when(points[i].t) }}</text>
      </g>
      <line :x1="L" :x2="W - R" :y1="H - B" :y2="H - B" stroke="#1a1a1a" />
      <path :d="area" fill="url(#tc-fill)" />
      <path :d="line" fill="none" :stroke="COLOR" stroke-width="2" stroke-linejoin="round" />
      <g v-if="hover != null">
        <line :x1="x(hover)" :x2="x(hover)" :y1="T" :y2="H - B" stroke="#333" />
        <circle :cx="x(hover)" :cy="y(points[hover].value)" r="4.5" :fill="COLOR" stroke="#fff" stroke-width="2" />
      </g>
    </svg>
    <div v-if="hover != null" class="tip" :style="{ left: Math.min(x(hover) + 12, W - 170) + 'px' }">
      <div class="tip-t">{{ when(points[hover].t, true) }}</div>
      <div><i :style="{ background: COLOR }" />{{ label }} <b>{{ format(points[hover].value) }}</b></div>
    </div>
  </div>
</template>

<style scoped>
.tc { position: relative; height: 240px; touch-action: pan-y; }
.tc svg { display: block; }
.tip { position: absolute; top: 12px; min-width: 160px; pointer-events: none; background: #0d0d0d; border: 1px solid #333; border-radius: 6px; padding: 10px; font-size: 12px; color: var(--n-text-2); display: flex; flex-direction: column; gap: 4px; }
.tip-t { color: #fff; font-weight: 500; }
.tip i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 8px; vertical-align: -1px; }
.tip b { color: #fff; font-weight: 500; margin-left: 6px; }
</style>
