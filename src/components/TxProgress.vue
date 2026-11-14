<script setup>
import { computed } from 'vue'
import { state } from '../store.js'
import { txUrl } from '../config.js'
const props = defineProps({ tx: Object, handoff: Boolean })
defineEmits(['dismiss', 'cancel'])
defineOptions({ inheritAttrs: false })

const step = computed(() => props.tx.steps[props.tx.i])
const title = computed(() => ({
  ready: `Confirm in ${props.tx.wallet}`,
  running: step.value,
  success: `${props.tx.steps.at(-1)} confirmed`,
}[props.tx.status] ?? 'Transaction failed'))
const message = computed(() => ({
  ready: `${step.value} is ready. Open ${props.tx.wallet} to review and sign it, then you'll come back here.`,
  running: props.handoff ? 'Sending and confirming…' : 'Confirm it in your wallet, then wait for the confirmation.',
  success: props.tx.note,
}[props.tx.status] ?? props.tx.error))
</script>

<template>
  <Teleport to="body">
    <!-- An iOS wallet handoff replaces the panel's own sheet: one sheet at a time. -->
    <div v-if="tx.status !== 'idle' && (handoff || !state.handoff)" class="sheet-wrap" role="dialog" aria-modal="true" :aria-label="title">
      <div class="sheet" :class="tx.status" role="status">
        <span v-if="tx.status === 'running'" class="mark spin" />
        <span v-else-if="tx.status === 'success'" class="mark tick">✓</span>
        <span v-else-if="tx.status === 'error'" class="mark cross">✕</span>
        <h2 class="title">{{ title }}</h2>
        <p v-if="message" class="msg">{{ message }}</p>
        <ol v-if="tx.steps.length > 1 && tx.status === 'running'" class="steps">
          <li v-for="(s, i) in tx.steps" :key="s" :class="{ done: i < tx.i, now: i === tx.i }">{{ s }}</li>
        </ol>
        <a v-if="tx.signature" class="link" :href="txUrl(tx.signature)" target="_blank" rel="noopener noreferrer">View transaction ↗&#xFE0E;</a>
        <template v-if="tx.status === 'ready'">
          <a class="n-btn-block" :href="tx.url">Open {{ tx.wallet }}</a>
          <button class="quiet" @click="$emit('cancel')">Cancel</button>
        </template>
        <button v-else-if="tx.status !== 'running'" class="n-btn-block" @click="$emit('dismiss')">{{ tx.status === 'success' ? 'Done' : 'Close' }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet-wrap { position: fixed; inset: 0; z-index: 110; display: flex; align-items: center; justify-content: center; padding: 16px; background: #000000b8; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.sheet { width: 100%; max-width: 420px; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 28px 24px 24px; border: 1px solid var(--n-line-2); border-radius: 20px; background: var(--n-bg-2); box-shadow: 0 20px 60px -10px #000c; text-align: center; animation: sheet-in .2s ease-out; }
.sheet.success { border-color: #3ddc8459; }
.sheet.error { border-color: #ff5d5d66; }
.title { font-size: 19px; font-weight: 600; color: #fff; }
.msg { font-size: 14px; line-height: 1.5; color: var(--n-text-2); overflow-wrap: anywhere; }
.sheet.error .msg { color: var(--n-red); }
.steps { list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--n-text-4); }
.steps li.done { color: var(--n-green); }
.steps li.done::before { content: "✓ "; }
.steps li.now { color: #fff; }
.link { color: var(--n-pink); font-size: 13px; }
.link:hover { text-decoration: underline; }
.n-btn-block { margin-top: 8px; text-align: center; }
.quiet { padding: 8px 16px; color: var(--n-text-3); font-size: 14px; }
.quiet:hover { color: #fff; }
.mark { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; font-size: 20px; }
.tick { color: var(--n-green); background: #3ddc841f; }
.cross { color: var(--n-red); background: #ff5d5d1f; }
.spin { border: 3px solid var(--n-line-2); border-top-color: var(--n-pink); animation: spin .7s linear infinite; }
@keyframes sheet-in { from { opacity: 0; transform: translateY(16px); } }
/* Phones: a bottom sheet, clear of the home indicator. */
@media (max-width: 640px) {
  .sheet-wrap { align-items: flex-end; padding: 0; }
  .sheet { max-width: none; border-radius: 20px 20px 0 0; border-width: 1px 0 0; padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: reduce) { .sheet { animation: none; } }
</style>
