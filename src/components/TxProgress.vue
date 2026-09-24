<script setup>
import { txUrl } from '../config.js'
defineProps({ tx: Object })
defineEmits(['dismiss'])
</script>

<template>
  <div v-if="tx.status !== 'idle'" class="tx" :class="tx.status">
    <div v-if="tx.status === 'running'" class="tx-head"><span class="spin" />{{ tx.steps[tx.i] }} · step {{ tx.i + 1 }} of {{ tx.steps.length }}</div>
    <div v-else-if="tx.status === 'success'" class="tx-head"><span class="tick">✓</span>Done. {{ tx.steps.at(-1) }} confirmed.</div>
    <div v-else class="tx-head"><span class="cross">✕</span>Transaction failed</div>
    <ol v-if="tx.steps.length > 1 && tx.status === 'running'" class="tx-steps">
      <li v-for="(s, i) in tx.steps" :key="s" :class="{ done: i < tx.i, now: i === tx.i }">{{ s }}</li>
    </ol>
    <p v-if="tx.error" class="tx-msg">{{ tx.error }}</p>
    <div v-if="tx.status !== 'running' || tx.signature" class="tx-foot">
      <a v-if="tx.signature" :href="txUrl(tx.signature)" target="_blank" rel="noopener noreferrer">View transaction ↗</a>
      <button v-if="tx.status !== 'running'" class="tx-x" @click="$emit('dismiss')">Dismiss</button>
    </div>
  </div>
</template>

<style scoped>
.tx { margin-top: 16px; border: 1px solid var(--n-line); border-radius: 6px; padding: 13px 15px; background: var(--n-bg-2); font-size: 13px; line-height: 1.5; color: var(--n-text-2); }
.tx.success { border-color: #3ddc8459; }
.tx.error { border-color: #ff5d5d66; }
.tx-head { display: flex; align-items: center; gap: 10px; font-weight: 600; color: #fff; }
.tx-msg { margin-top: 8px; color: var(--n-red); word-break: break-word; }
.tx-steps { list-style: none; margin-top: 10px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--n-text-4); }
.tx-steps li.done { color: var(--n-green); }
.tx-steps li.done::before { content: "✓ "; }
.tx-steps li.now { color: #fff; }
.tx-steps li.now::before { content: "→ "; }
.tx-foot { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
.tx-foot a { color: var(--n-pink); font-size: 12px; }
.tx-foot a:hover { text-decoration: underline; }
.tx-x { margin-left: auto; color: var(--n-text-3); font-size: 12px; }
.tx-x:hover { color: #fff; }
.tick { color: var(--n-green); }
.cross { color: var(--n-red); }
.spin { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; border: 2px solid var(--n-line-2); border-top-color: var(--n-pink); animation: spin .7s linear infinite; }
</style>
