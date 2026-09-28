<script setup>
// Latest admin changes to the market / its reserves: action + new value, target, and a link to the transaction.
import { ref, computed } from 'vue'
import { txUrl } from '../config.js'

const props = defineProps({ updates: Array, error: String })
const all = ref(false)
const shown = computed(() => (all.value ? props.updates : props.updates?.slice(0, 10)) ?? [])
const when = (ts) => new Date(ts * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
</script>

<template>
  <div class="n-table">
    <div class="n-thead mu-grid"><div>Date</div><div>Action</div><div>Applied to</div><div>Transaction</div></div>
    <div v-if="error" class="n-empty">Could not load market updates.</div>
    <div v-else-if="!updates" class="n-empty">Reading on-chain history…</div>
    <div v-else-if="!updates.length" class="n-empty">No configuration changes yet.</div>
    <div v-for="u in shown" :key="u.id" class="n-tr sm mu-grid">
      <div class="n-cell n-muted n-num" data-label="Date">{{ when(u.ts) }}</div>
      <div class="n-cell" data-label="Action">
        <span class="mu-action">{{ u.action }}<span v-if="u.value" class="mu-value"> → {{ u.value }}</span></span>
      </div>
      <div class="n-cell" data-label="Applied to"><span class="n-chip">{{ u.target }}</span></div>
      <div class="n-cell" data-label="Transaction">
        <a class="mu-link" :href="txUrl(u.sig)" target="_blank" rel="noopener noreferrer">{{ u.sig.slice(0, 4) }}…{{ u.sig.slice(-4) }} ↗</a>
      </div>
    </div>
  </div>
  <button v-if="updates && updates.length > 10" class="n-btn-sm ghost mu-more" @click="all = !all">
    {{ all ? 'Show latest 10' : `Show all ${updates.length} updates` }}
  </button>
  <p class="hint">Configuration changes signed by the market's admin, decoded from Kamino Lend transactions on Solana.</p>
</template>

<style scoped>
.mu-grid { grid-template-columns: 1fr 2.6fr 1.1fr .9fr; }
.n-thead { font-size: 11px; padding: 14px 20px; }
.n-tr.sm { padding: 14px 20px; font-size: 14px; }
.mu-action { font-weight: 500; overflow-wrap: anywhere; }
.mu-value { color: var(--n-text-2); font-weight: 400; }
.mu-link { font-family: var(--mono); font-size: 12.5px; color: var(--n-text-2); white-space: nowrap; }
.mu-link:hover { color: var(--n-pink); }
.mu-more { margin-top: 14px; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
@media (max-width: 860px) { .n-tr > .n-cell { align-items: flex-start; } .mu-action { text-align: right; } }
</style>
