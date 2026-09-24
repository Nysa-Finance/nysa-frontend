<script setup>
import { ref, computed, onMounted } from 'vue'
import { state } from '../store.js'
import { explorer } from '../config.js'
import { parsePoints, short, ago } from '../logic.js'

const emit = defineEmits(['close'])
const board = ref(null)
const error = ref(null)
const fmt = (n) => (n === 0 ? '0' : n < 0.01 ? '<0.01' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }))
const me = computed(() => board.value?.rows.find((r) => r.address === state.address))
const stale = computed(() => board.value && Date.now() / 1000 - board.value.updatedTs > 36 * 3600)

onMounted(async () => {
  try {
    const res = await fetch('/api/points', { headers: { accept: 'text/csv' } })
    if (!res.ok) throw new Error(`Points source responded ${res.status}`)
    board.value = parsePoints(await res.text())
  } catch (e) {
    error.value = e.message || 'Could not load Farm Points.'
  }
})
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="fp-modal" role="dialog" aria-modal="true" aria-labelledby="fp-title">
      <div class="fp-head">
        <div>
          <h3 id="fp-title" class="fp-title">Farm Points</h3>
          <p class="fp-sub">Points accrue as supplied balance × time. Updated daily.</p>
        </div>
        <button class="x-btn" aria-label="Close" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="fp-you" :class="{ ranked: me }">
        <template v-if="me">
          <div class="fp-you-rank">#{{ me.rank }}</div>
          <div><div class="fp-you-k">Your points</div><div class="fp-you-v">{{ fmt(me.points) }}</div></div>
          <div><div class="fp-you-k">Your supplied</div><div class="fp-you-v sm">${{ fmt(me.supplied) }}</div></div>
        </template>
        <span v-else-if="!board && !error" class="n-skel" style="min-width: 180px" />
        <div v-else-if="state.address" class="fp-you-note">
          No points for <b>{{ short(state.address, 6) }}</b> yet. Supply to this market and your first points appear after the next daily snapshot.
        </div>
        <div v-else class="fp-you-note">Connect a Phantom wallet to see your position.</div>
      </div>
      <div v-if="error" class="n-empty fp-block">{{ error }}</div>
      <div v-else-if="!board" class="fp-block">
        <div v-for="i in 6" :key="i" class="fp-row"><span class="n-skel" style="min-width: 28px" /><span class="n-skel" style="min-width: 140px" /><span class="n-skel" /></div>
      </div>
      <div v-else-if="!board.rows.length" class="n-empty fp-block">No one is farming this market yet.</div>
      <div v-else class="fp-table">
        <div class="fp-row head"><div>#</div><div>Address</div><div>Points</div></div>
        <div v-for="r in board.rows" :key="r.address" class="fp-row" :class="{ me: r.address === state.address }">
          <div class="fp-rank">{{ r.rank }}</div>
          <div class="fp-addr">
            <a :href="explorer(r.address)" target="_blank" rel="noopener noreferrer" class="fp-link">{{ short(r.address, 6) }}</a>
            <span v-if="r.address === state.address" class="fp-tag">You</span>
          </div>
          <div class="n-num">{{ fmt(r.points) }}</div>
        </div>
      </div>
      <p v-if="board" class="fp-foot">
        <span :class="{ warn: stale }">Updated {{ ago(board.updatedTs) }}</span><template v-if="stale"> — the daily snapshot may have failed.</template>
      </p>
    </div>
  </div>
</template>

<style scoped>
.fp-modal { width: 100%; max-width: 560px; background: var(--n-bg-2); border: 1px solid var(--n-line); border-radius: 6px; padding: 24px; box-shadow: 0 40px 100px -20px #000c; }
.fp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.fp-title { font-family: var(--serif); font-style: italic; font-weight: 400; font-size: 28px; line-height: 1.1; }
.fp-sub { color: var(--n-text-3); font-size: 13px; margin-top: 6px; }
.fp-you { display: flex; align-items: center; gap: 24px; margin: 20px 0 16px; padding: 16px 18px; border: 1px solid var(--n-line); border-radius: 4px; background: #000; min-height: 62px; }
.fp-you.ranked { border-color: #ec008c73; background: #ec008c0f; }
.fp-you-rank { font-size: 26px; font-weight: 600; color: var(--n-pink); }
.fp-you-k { color: var(--n-text-3); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
.fp-you-v { font-size: 20px; font-weight: 600; margin-top: 2px; }
.fp-you-v.sm { font-size: 16px; color: var(--n-text-2); }
.fp-you-note { color: var(--n-text-3); font-size: 13px; }
.fp-you-note b { color: var(--n-text-2); font-weight: 500; }
.fp-table { border: 1px solid var(--n-line); border-radius: 4px; max-height: 46vh; overflow-y: auto; }
.fp-block { border: 1px solid var(--n-line); border-radius: 4px; padding: 16px; }
.fp-row { display: grid; grid-template-columns: 40px 1fr auto; gap: 12px; align-items: center; padding: 11px 16px; border-bottom: 1px solid var(--n-hair); font-size: 14px; }
.fp-row:last-child { border-bottom: none; }
.fp-row.head { position: sticky; top: 0; background: var(--n-bg-3); color: var(--n-text-3); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
.fp-row.me { background: #ec008c14; }
.fp-rank { color: var(--n-text-3); }
.fp-row.me .fp-rank { color: var(--n-pink); }
.fp-addr { display: flex; align-items: center; gap: 8px; }
.fp-link { color: var(--n-text-2); font-family: var(--mono); font-size: 13px; }
.fp-link:hover { color: var(--n-pink); text-decoration: underline; }
.fp-tag { padding: 1px 7px; border: 1px solid rgba(236,0,140,.45); border-radius: 999px; background: #ec008c1f; color: var(--n-pink); font-size: 10px; font-weight: 600; }
.fp-foot { margin-top: 14px; color: var(--n-text-4); font-size: 11.5px; text-align: right; }
.fp-foot .warn { color: var(--n-amber); }
</style>
