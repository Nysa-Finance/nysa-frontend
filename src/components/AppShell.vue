<script setup>
import { ref } from 'vue'
import { state, disconnect } from '../store.js'
import { explorer } from '../config.js'
import { short } from '../logic.js'
import ConnectModal from './ConnectModal.vue'

const tabs = [
  { to: '/', label: 'Markets', icon: '/app/icon-markets.png' },
  { to: '/lend', label: 'Lend', icon: '/app/icon-lend.png' },
  { to: '/borrow', label: 'Borrow', icon: '/app/icon-borrow.png' },
  { to: '/portfolio', label: 'Portfolio', icon: '/app/icon-portfolio.png' },
]
const menu = ref(false)
</script>

<template>
  <div class="n-app">
    <div v-if="state.loading && !state.loaded" class="n-progress" />
    <header class="n-nav">
      <RouterLink to="/" class="n-brand"><img src="/app/logo.png" alt="" /><span>nysa</span></RouterLink>
      <nav class="n-tabs">
        <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="n-tab"><img :src="t.icon" alt="" />{{ t.label }}</RouterLink>
      </nav>
      <div class="n-nav-right">
        <span class="n-pill net"><span class="n-dot" />Solana</span>
        <button v-if="!state.address" class="n-btn-grad" @click="state.connectOpen = true">Connect wallet</button>
        <template v-else>
          <button class="n-pill" @click="menu = !menu"><span class="n-dot" />{{ short(state.address) }}</button>
          <div v-if="menu" class="n-menu" @click="menu = false">
            <RouterLink to="/portfolio">Portfolio</RouterLink>
            <a :href="explorer(state.address)" target="_blank" rel="noopener noreferrer">View on Solscan ↗</a>
            <button @click="disconnect">Disconnect</button>
          </div>
        </template>
      </div>
    </header>
    <main class="n-main">
      <div v-if="state.error" class="n-banner warn" role="status">Could not load market data — {{ state.error }}. Reconnecting automatically.</div>
      <div v-if="state.walletError" class="n-banner warn" role="status">Could not read your wallet balances — {{ state.walletError }}. Retrying shortly.</div>
      <slot />
    </main>
    <footer class="n-footer">
      <span>Nysa · the on-chain credit market for tokenized assets</span>
      <nav><RouterLink to="/analytics">Analytics</RouterLink></nav>
    </footer>
    <ConnectModal v-if="state.connectOpen" @close="state.connectOpen = false" />
  </div>
</template>
