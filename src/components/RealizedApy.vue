<script setup>
// Realized APY for one lendable asset: 30D / 7D realized (from the growth of a deposit share's value, recorded
// daily) + the live APY, and a daily realized-APY chart styled like the interest-rate chart.
import { ref, computed, watch, onUnmounted } from 'vue'
import { pct, ago, windowApy, dailyApySeries, niceTicks } from '../logic.js'

const props = defineProps({ token: Object, history: Object, currentApy: Number })

const recorded = computed(() => props.history?.points ?? [])
// A reserve's share value is exactly 1 at creation: that anchor makes "since launch" exact for young reserves.
const withLaunch = computed(() => (props.history?.inception ? [{ ts: props.history.inception, rate: 1 }, ...recorded.value] : recorded.value))
const w30 = computed(() => windowApy(withLaunch.value, 30))
const w7 = computed(() => windowApy(recorded.value, 7))
const days = (d) => `${d < 1 ? d.toFixed(1) : Math.round(d)}d`
const sub = (w, n) => !w ? 'collecting data' : w.from === props.history?.inception ? `since launch · ${days(w.spanDays)}` : w.full ? `${n}-day window` : `based on ${days(w.spanDays)}`
const lastTs = computed(() => recorded.value.at(-1)?.ts)

// ---- chart ----
const series = computed(() => dailyApySeries(recorded.value))
const COLOR = '#EC008C'
const H = 220, L = 48, R = 12, T = 10, B = 34
const box = ref(null)
const W = ref(600)
// The chart only renders once history exists, so (re)attach the width observer whenever it appears.
const ro = new ResizeObserver(([e]) => { W.value = Math.max(e.contentRect.width, 200) })
watch(box, (el) => { ro.disconnect(); if (el) ro.observe(el) }, { flush: 'post' })
onUnmounted(() => ro.disconnect())
const t0 = computed(() => series.value[0]?.ts ?? 0)
const t1 = computed(() => series.value.at(-1)?.ts ?? 1)
const x = (ts) => L + (t1.value === t0.value ? 0.5 : (ts - t0.value) / (t1.value - t0.value)) * (W.value - L - R)
const yAxis = computed(() => niceTicks(Math.max(...series.value.map((p) => p.apy), props.currentApy ?? 0, 0.1)))
const y = (v) => T + (1 - v / yAxis.value.top) * (H - T - B)
const path = computed(() => series.value.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.apy).toFixed(1)}`).join(''))
const date = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
// Date labels at least 64px apart; the latest day is always labelled.
const xTicks = computed(() => {
  const out = []
  for (const p of [...series.value].reverse()) if (!out.length || x(out.at(-1).ts) - x(p.ts) >= 64) out.push(p)
  return out
})
const hover = ref(null)
function onMove(e) {
  const px = e.clientX - box.value.getBoundingClientRect().left
  hover.value = series.value.reduce((best, p) => (!best || Math.abs(x(p.ts) - px) < Math.abs(x(best.ts) - px) ? p : best), null)
}
</script>

<template>
  <div class="n-stats ra-stats">
    <div class="n-stat">
      <div class="k">30D Realized APY</div>
      <div class="v sm">{{ w30 ? pct(w30.apy) : '—' }}</div>
      <div class="s">{{ sub(w30, 30) }}</div>
    </div>
    <div class="n-stat">
      <div class="k">7D Realized APY</div>
      <div class="v sm">{{ w7 ? pct(w7.apy) : '—' }}</div>
      <div class="s">{{ sub(w7, 7) }}</div>
    </div>
    <div class="n-stat">
      <div class="k">Current APY</div>
      <div class="v sm accent">{{ pct(currentApy) }}</div>
      <div class="s">live supply APY</div>
    </div>
  </div>

  <div class="ra-chart">
    <div class="legend">
      <span><i class="line" :style="{ background: COLOR }" />Daily realized APY · {{ token.name }}</span>
    </div>
    <div v-if="series.length" ref="box" class="canvas" @pointermove="onMove" @pointerleave="hover = null">
      <svg :width="W" :height="H" role="img" :aria-label="`Daily realized APY for ${token.name}`">
        <g font-size="11" fill="#8a8a8a" font-weight="300">
          <template v-for="t in yAxis.ticks" :key="'y' + t">
            <line :x1="L" :x2="W - R" :y1="y(t)" :y2="y(t)" stroke="#141414" />
            <text :x="L - 8" :y="y(t) + 4" text-anchor="end">{{ pct(t, t < 10 ? 1 : 0) }}</text>
          </template>
          <text v-for="p in xTicks" :key="'x' + p.ts" :x="x(p.ts)" :y="H - B + 16" text-anchor="middle">{{ date(p.ts) }}</text>
        </g>
        <line :x1="L" :x2="W - R" :y1="H - B" :y2="H - B" stroke="#1a1a1a" />
        <path :d="path" fill="none" :stroke="COLOR" stroke-width="2" stroke-linejoin="round" />
        <circle v-for="p in series" :key="p.ts" :cx="x(p.ts)" :cy="y(p.apy)" r="2.5" :fill="COLOR" />
        <g v-if="hover">
          <line :x1="x(hover.ts)" :x2="x(hover.ts)" :y1="T" :y2="H - B" stroke="#333" />
          <circle :cx="x(hover.ts)" :cy="y(hover.apy)" r="4.5" :fill="COLOR" stroke="#fff" stroke-width="2" />
        </g>
      </svg>
      <div v-if="hover" class="tip" :style="{ left: Math.min(x(hover.ts) + 12, W - 160) + 'px' }">
        <div class="tip-t">{{ date(hover.ts) }}</div>
        <div><i :style="{ background: COLOR }" />Realized APY <b>{{ pct(hover.apy) }}</b></div>
      </div>
    </div>
    <div v-else class="n-empty ra-empty">
      Daily history is being collected: the first point appears after the next daily snapshot (00:00 UTC).
    </div>
  </div>
  <p class="hint">
    Realized APY is measured from the growth in value of a {{ token.name }} deposit, recorded daily{{ lastTs ? ` · last snapshot ${ago(lastTs)}` : '' }}.
  </p>
</template>

<style scoped>
.ra-stats { grid-template-columns: repeat(3, 1fr); }
.n-stat .v.sm { font-size: 22px; }
.ra-chart { margin-top: 18px; border: 1px solid var(--n-line); border-radius: 4px; padding: 18px 20px 14px; background: #000; }
.legend { display: flex; gap: 20px; font-size: 12px; color: var(--n-text-3); margin-bottom: 14px; }
.legend span { display: inline-flex; align-items: center; gap: 8px; }
.line { width: 14px; height: 2px; border-radius: 1px; display: inline-block; }
.canvas { position: relative; height: 220px; touch-action: pan-y; }
.canvas svg { display: block; }
.ra-empty { padding: 36px 12px; }
.tip { position: absolute; top: 12px; min-width: 150px; pointer-events: none; background: #0d0d0d; border: 1px solid #333; border-radius: 6px; padding: 10px; font-size: 12px; color: var(--n-text-2); display: flex; flex-direction: column; gap: 4px; }
.tip-t { color: #fff; font-weight: 500; }
.tip i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 8px; vertical-align: -1px; }
.tip b { color: #fff; font-weight: 500; margin-left: 6px; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
@media (max-width: 860px) { .ra-stats { grid-template-columns: 1fr; } }
</style>
