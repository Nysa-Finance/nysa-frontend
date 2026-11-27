<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { state, disconnect } from '../store.js'
import { LOOP_ENABLED, explorer } from '../config.js'
import { short } from '../logic.js'
import ConnectModal from './ConnectModal.vue'
import WalletHandoff from './WalletHandoff.vue'
import BlockedWallet from './BlockedWallet.vue'

const tabs = [
  { to: '/earn', label: 'Earn', icon: '/app/icon-lend.png' },
  { to: '/borrow', label: 'Borrow', icon: '/app/icon-loans.png' },
  { to: '/portfolio', label: 'Portfolio', icon: '/app/icon-portfolio.png' },
  { to: '/loop', label: 'Loops', icon: '/app/icon-borrow.png' },
  { to: '/swap', label: 'Buy Collateral', icon: '/app/icon-swap.png' },
]
const visibleTabs = computed(() =>
  tabs.filter(
    (t) => (t.to !== '/swap' || state.swapVisible) && (t.to !== '/loop' || LOOP_ENABLED || state.loopVisible),
  ),
)
const menu = ref(false)
const sections = ref(false)
const copied = ref(false)
const route = useRoute()
watch(
  () => route.path,
  () => {
    sections.value = false
    menu.value = false
  },
)
// The account menu and the section sheet close on Esc, like every overlay.
const onKey = (e) => {
  if (e.key === 'Escape') {
    menu.value = false
    sections.value = false
  }
}
onMounted(() => addEventListener('keydown', onKey))
onBeforeUnmount(() => removeEventListener('keydown', onKey))
async function copyAddress() {
  try {
    await navigator.clipboard.writeText(state.address)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    /* clipboard refused: nothing to do */
  }
}
const active = (t) => route.path === t.to || route.path.startsWith(`${t.to}/`) // a vault or market page keeps its tab lit
</script>

<template>
  <div class="n-app">
    <div v-if="state.loading && !state.loaded" class="n-progress" />
    <header class="n-nav" :class="{ raised: menu }">
      <RouterLink to="/" class="n-brand"><img src="/app/logo.png" alt="" /><span>nysa</span></RouterLink>
      <nav class="n-tabs">
        <RouterLink v-for="t in visibleTabs" :key="t.to" :to="t.to" class="n-tab" :class="{ on: active(t) }"
          ><img :src="t.icon" alt="" />{{ t.label }}</RouterLink
        >
      </nav>
      <div class="n-nav-right">
        <span class="n-pill net"><span class="n-dot" />Solana</span>
        <button v-if="!state.address" class="n-btn-grad" @click="state.connectOpen = true">Connect wallet</button>
        <button v-else class="n-pill account" :class="{ open: menu }" :aria-expanded="menu" @click="menu = !menu">
          <span class="n-dot" />{{ short(state.address)
          }}<svg
            class="chev"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <button
          class="n-wallet-btn"
          :class="{ on: state.address, open: menu }"
          :aria-label="state.address ? `Wallet ${short(state.address)}` : 'Connect wallet'"
          :aria-expanded="state.address ? menu : undefined"
          @click="state.address ? (menu = !menu) : (state.connectOpen = true)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M17 8V5a1 1 0 0 0-1-1H6a2 2 0 0 0 0 4h12a1 1 0 0 1 1 1v3m0 4v3a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V6" />
            <path d="M20 12v4h-4a2 2 0 0 1 0-4h4" />
          </svg>
          <span v-if="state.address" class="n-dot" />
        </button>
        <template v-if="state.address">
          <div v-if="menu" class="n-menu-shade" @click="menu = false" />
          <div v-if="menu" class="n-menu" role="menu" @click="menu = false">
            <div class="n-menu-addr">
              <span>{{ short(state.address, 6) }}</span
              ><button class="copy" @click.stop="copyAddress">{{ copied ? 'Copied ✓' : 'Copy' }}</button>
            </div>
            <RouterLink to="/portfolio">Portfolio</RouterLink>
            <a :href="explorer(state.address)" target="_blank" rel="noopener noreferrer">View on Solscan ↗&#xFE0E;</a>
            <hr class="n-menu-sep" />
            <button class="danger" @click="disconnect">Disconnect</button>
          </div>
        </template>
      </div>
    </header>
    <main class="n-main">
      <div v-if="state.error" class="n-banner warn" role="status">
        Could not load market data — {{ state.error }}. Reconnecting automatically.
      </div>
      <div v-if="state.walletError" class="n-banner warn" role="status">
        Could not read your wallet balances — {{ state.walletError }}. Retrying shortly.
      </div>
      <slot />
    </main>
    <footer class="n-footer">
      <span>Nysa · the on-chain credit market for tokenized assets</span>
      <nav>
        <RouterLink to="/analytics">Analytics</RouterLink><RouterLink to="/liquidations">Liquidations</RouterLink>
      </nav>
    </footer>
    <div v-if="sections" class="n-fab-shade" @click="sections = false" />
    <nav v-if="sections" class="n-fab-menu" aria-label="Sections">
      <RouterLink v-for="t in visibleTabs" :key="t.to" :to="t.to" :class="{ on: active(t) }" @click="sections = false"
        ><img :src="t.icon" alt="" />{{ t.label }}</RouterLink
      >
    </nav>
    <button
      class="n-fab"
      :aria-expanded="sections"
      :aria-label="sections ? 'Close menu' : 'Open menu'"
      @click="sections = !sections"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
    <ConnectModal v-if="state.connectOpen" @close="state.connectOpen = false" />
    <WalletHandoff />
    <BlockedWallet />
  </div>
</template>
