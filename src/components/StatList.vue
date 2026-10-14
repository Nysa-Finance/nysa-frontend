<script setup>
// A ranked breakdown card (sources, pages, locations, devices) with tabs, like Plausible's: one row per value, a bar
// sized against the top row. Each tab is one named query of /api/admin/stats, loaded when shown.
import { ref, watch } from 'vue'
import { amt } from '../logic.js'

const props = defineProps({ title: String, tabs: Array, period: String, load: Function })
const tab = ref(props.tabs[0])
const rows = ref(null), error = ref(null)

async function fetchRows() {
  rows.value = null
  error.value = null
  const want = [tab.value.q, props.period]
  try {
    const r = await props.load({ q: tab.value.q })
    if (want[0] === tab.value.q && want[1] === props.period) rows.value = r.rows
  } catch (e) { error.value = e.message }
}
watch([tab, () => props.period], fetchRows, { immediate: true })

const cols = () => tab.value.cols ?? [['visitors', 'Visitors']]
const max = () => Math.max(...(rows.value ?? []).map((r) => r[cols()[0][0]]), 1)
</script>

<template>
  <div class="sl">
    <div class="sl-head">
      <span class="sl-title">{{ title }}</span>
      <div class="sl-tabs">
        <button v-for="t in tabs" :key="t.q" :class="{ on: t === tab }" @click="tab = t">{{ t.label }}</button>
      </div>
    </div>
    <div class="sl-cols"><span>{{ tab.label }}</span><span v-for="[, label] in cols()" :key="label">{{ label }}</span></div>
    <div v-if="error" class="n-empty sl-empty">{{ error }}</div>
    <div v-else-if="!rows" class="sl-rows"><div v-for="i in 5" :key="i" class="sl-row"><span class="n-skel" /></div></div>
    <div v-else-if="!rows.length" class="n-empty sl-empty">No data for this period.</div>
    <div v-else class="sl-rows">
      <div v-for="r in rows" :key="r.name" class="sl-row">
        <div class="sl-bar" :style="{ width: (r[cols()[0][0]] / max()) * 100 + '%' }" />
        <span class="sl-name" :title="r.name">{{ r.name }}</span>
        <span v-for="[key] in cols()" :key="key" class="sl-num">{{ amt(r[key], 0) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sl { border: 1px solid var(--n-line); border-radius: 8px; background: var(--n-bg-2); padding: 18px 20px; display: flex; flex-direction: column; min-height: 360px; }
.sl-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.sl-title { font-weight: 600; font-size: 15px; }
.sl-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.sl-tabs button { font-size: 12px; color: var(--n-text-3); padding: 4px 9px; border-radius: 999px; border: 1px solid transparent; }
.sl-tabs button:hover { color: #fff; }
.sl-tabs button.on { color: var(--n-pink); border-color: #ec008c66; background: #ec008c14; }
.sl-cols { display: flex; gap: 18px; font-size: 11px; color: var(--n-text-4); text-transform: uppercase; letter-spacing: .5px; padding: 0 10px 8px; }
.sl-cols span:first-child { flex: 1; }
.sl-cols span:not(:first-child) { width: 72px; text-align: right; }
.sl-rows { display: flex; flex-direction: column; gap: 4px; max-height: 380px; overflow-y: auto; }
.sl-row { position: relative; display: flex; align-items: center; gap: 18px; padding: 7px 10px; font-size: 13px; border-radius: 4px; min-height: 32px; }
.sl-bar { position: absolute; inset: 0 auto 0 0; background: #ec008c1f; border-radius: 4px; }
.sl-name { position: relative; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--n-text); }
.sl-num { position: relative; width: 72px; text-align: right; font-variant-numeric: tabular-nums; color: var(--n-text-2); }
.sl-num:first-of-type { color: #fff; font-weight: 500; }
.sl-empty { flex: 1; display: grid; place-items: center; }
.sl-row .n-skel { width: 100%; }
</style>
