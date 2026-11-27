<script setup>
import { state } from '../store.js'
import { short } from '../../shared/format.js'
</script>

<template>
  <div v-if="state.blockedWallet" class="overlay bw" role="alertdialog" aria-modal="true" aria-labelledby="bw-title">
    <div class="n-dialog bw-card">
      <h2 id="bw-title" class="n-dialog-title">Access restricted</h2>
      <p class="bw-text">
        The wallet <span class="mono">{{ short(state.blockedWallet, 4, 4) }}</span> appears on the US Treasury's OFAC
        sanctions list, so it can't be used with the Nysa interface. It has been disconnected.
      </p>
      <button class="bw-btn" @click="state.blockedWallet = null">Close</button>
    </div>
  </div>
</template>

<style scoped>
.bw {
  z-index: 1200;
  background: #000000d1;
}
.bw-card {
  max-width: 420px;
  border-color: #ff5d5d66;
  text-align: center;
}
.bw-text {
  margin: 12px 0 22px;
  color: var(--n-text-2);
  font-size: 14px;
  line-height: 1.6;
}
.bw-text .mono {
  font-family: var(--mono);
  color: #fff;
}
.bw-btn {
  font-weight: 600;
  font-size: 14px;
  color: #fff;
  background: var(--n-line-2);
  padding: 11px 22px;
  border-radius: 999px;
}
</style>
