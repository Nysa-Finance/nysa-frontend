<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { state, disconnect } from '../store.js'
import { LOOP_ENABLED, explorer } from '../config.js'
import { short } from '../logic.js'
import ConnectModal from './ConnectModal.vue'
import WalletHandoff from './WalletHandoff.vue'
import BlockedWallet from './BlockedWallet.vue'

const tabs = [
  { to: '/earn', label: 'Earn', icon: '/app/icon-lend.png' },
  { to: '/borrow', label: 'Borrow', icon: '/app/icon-borrow.png' },
  { to: '/portfolio', label: 'Portfolio', icon: '/app/icon-portfolio.png' },
  { to: '/swap', label: 'Buy Collateral', icon: '/app/icon-swap.png' },
  { to: '/loop', label: 'Loop', icon: '/app/icon-borrow.png' },
]
const visibleTabs = computed(() => tabs.filter((t) => (t.to !== '/swap' || state.swapVisible) && (t.to !== '/loop' || LOOP_ENABLED)))
const menu = ref(false)
const sections = ref(false) // phones: the sections menu opened by the button at the bottom right
const route = useRoute()
watch(() => route.path, () => { sections.value = false })
const active = (t) => route.path === t.to || route.path.startsWith(`${t.to}/`) // a vault or market page keeps its tab lit
</script>

<template>
  <div class="n-app">
    <div v-if="state.loading && !state.loaded" class="n-progress" />
    <header class="n-nav">
      <RouterLink to="/" class="n-brand"><img src="/app/logo.png" alt="" /><span>nysa</span></RouterLink>
      <nav class="n-tabs">
        <RouterLink v-for="t in visibleTabs" :key="t.to" :to="t.to" class="n-tab" :class="{ on: active(t) }"><img :src="t.icon" alt="" />{{ t.label }}</RouterLink>
      </nav>
      <div class="n-nav-right">
        <span class="n-pill net"><span class="n-dot" />Solana</span>
        <button v-if="!state.address" class="n-btn-grad" @click="state.connectOpen = true">Connect wallet</button>
        <template v-else>
          <button class="n-pill" @click="menu = !menu"><span class="n-dot" />{{ short(state.address) }}</button>
          <div v-if="menu" class="n-menu" @click="menu = false">
            <RouterLink to="/portfolio">Portfolio</RouterLink>
            <a :href="explorer(state.address)" target="_blank" rel="noopener noreferrer">View on Solscan ↗&#xFE0E;</a>
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
      <nav><RouterLink to="/analytics">Analytics</RouterLink><RouterLink to="/liquidations">Liquidations</RouterLink></nav>
    </footer>
    <!-- Phones: the tabs leave the header for a menu at the bottom right (hidden on wider screens in style.css). -->
    <div v-if="sections" class="n-fab-shade" @click="sections = false" />
    <nav v-if="sections" class="n-fab-menu" aria-label="Sections">
      <RouterLink v-for="t in visibleTabs" :key="t.to" :to="t.to" :class="{ on: active(t) }" @click="sections = false"><img :src="t.icon" alt="" />{{ t.label }}</RouterLink>
    </nav>
    <button class="n-fab" :aria-expanded="sections" :aria-label="sections ? 'Close menu' : 'Open menu'" @click="sections = !sections">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path :d="sections ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'" /></svg>
    </button>
    <ConnectModal v-if="state.connectOpen" @close="state.connectOpen = false" />
    <WalletHandoff />
    <BlockedWallet />
  </div>
</template>
