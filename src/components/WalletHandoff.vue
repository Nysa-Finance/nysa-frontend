<script setup>
// Deeplink wallets (Phantom / Solflare on iOS): the transaction to approve in the wallet app, then its outcome.
import { state, cancelHandoff, dismissHandoff } from '../store.js'
import { txUrl } from '../config.js'
</script>

<template>
  <div v-if="state.handoff" class="ho" :class="state.handoff.status" role="status">
    <div class="ho-label">{{ state.handoff.label }}</div>
    <template v-if="state.handoff.status === 'ready'">
      <div class="ho-msg">Approve it in {{ state.handoff.wallet }}, then you'll come back here.</div>
      <div class="ho-actions">
        <a class="ho-btn" :href="state.handoff.url">Open {{ state.handoff.wallet }}</a>
        <button class="ho-link" @click="cancelHandoff">Cancel</button>
      </div>
    </template>
    <div v-else-if="state.handoff.status === 'sending'" class="ho-msg"><span class="ho-spin" />Sending and confirming…</div>
    <template v-else>
      <div class="ho-msg">{{ state.handoff.status === 'success' ? 'Confirmed.' : state.handoff.error }}</div>
      <div class="ho-actions">
        <a v-if="state.handoff.signature" class="ho-link" :href="txUrl(state.handoff.signature)" target="_blank" rel="noopener noreferrer">View transaction ↗</a>
        <button class="ho-link" @click="dismissHandoff">Dismiss</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ho { position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 90; max-width: 440px; margin: 0 auto; padding: 16px 18px; border: 1px solid var(--n-line-2); border-radius: 12px; background: var(--n-bg-2); box-shadow: 0 20px 60px -10px #000c; font-size: 13px; color: var(--n-text-2); }
.ho.success { border-color: #3ddc8466; }
.ho.error { border-color: #ff5d5d66; }
.ho-label { font-weight: 600; font-size: 14px; color: #fff; }
.ho-msg { margin-top: 4px; display: flex; align-items: center; gap: 8px; }
.ho.error .ho-msg { color: var(--n-red); }
.ho-actions { margin-top: 12px; display: flex; align-items: center; gap: 16px; }
.ho-btn { font-weight: 600; color: #fff; background: var(--grad); padding: 10px 18px; border-radius: 999px; }
.ho-link { color: var(--n-text-3); font-size: 13px; background: none; border: 0; padding: 0; cursor: pointer; }
.ho-spin { width: 14px; height: 14px; border: 2px solid var(--n-line-2); border-top-color: var(--n-pink); border-radius: 50%; animation: spin .7s linear infinite; }
</style>
