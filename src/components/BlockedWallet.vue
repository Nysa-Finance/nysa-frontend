<script setup>
// Shown when the connected wallet is refused by sanctions screening (OFAC SDN list, enforced by the backend).
import { state } from '../store.js'
import { short } from '../logic.js'
</script>

<template>
  <div v-if="state.blockedWallet" class="bw" role="alertdialog" aria-modal="true" aria-labelledby="bw-title">
    <div class="bw-card">
      <h2 id="bw-title" class="bw-title">Access restricted</h2>
      <p class="bw-text">
        The wallet <span class="mono">{{ short(state.blockedWallet, 4, 4) }}</span> appears on the US Treasury's OFAC sanctions
        list, so it can't be used with the Nysa interface. It has been disconnected.
      </p>
      <button class="bw-btn" @click="state.blockedWallet = null">Close</button>
    </div>
  </div>
</template>

<style scoped>
.bw { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 16px; background: #000000cc; backdrop-filter: blur(6px); }
.bw-card { max-width: 420px; width: 100%; background: var(--n-bg-2); border: 1px solid #ff5d5d66; border-radius: 16px; padding: 28px 24px; text-align: center; }
.bw-title { font-weight: 600; font-size: 20px; color: #fff; }
.bw-text { margin: 12px 0 22px; color: var(--n-text-2); font-size: 14px; line-height: 1.6; }
.bw-text .mono { font-family: var(--mono); color: #fff; }
.bw-btn { font-weight: 600; font-size: 14px; color: #fff; background: var(--n-line-2); padding: 11px 22px; border-radius: 999px; }
</style>
