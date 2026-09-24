<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { state, marketSummary } from '../store.js'
import { MARKETS, LIVE, tok } from '../config.js'
import { usd } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'
import FarmPointsModal from '../components/FarmPointsModal.vue'

const router = useRouter()
const pointsOpen = ref(false)
const soon = MARKETS.filter((m) => !m.visible)
const go = (m, mode) => router.push({ name: 'market-detail', params: { id: m.id }, query: { mode } })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Markets</h1>
    <p class="n-sub">Explore all lending markets across supported networks</p>
  </div>
  <div class="n-table">
    <div class="n-thead mk-grid">
      <div>Market</div><div>Network</div><div>Infra</div><div>Collateral</div><div>Loans</div><div>Total Supplied</div><div>Total Borrowed</div><div />
    </div>
    <div v-for="m in LIVE" :key="m.id" class="n-row-wrap">
      <div class="n-tr click mk-grid" @click="go(m, 'lend')">
        <div class="n-cell name" data-label="Market">
          <div>{{ m.name }}</div>
          <button v-if="m.farmPoints" type="button" class="n-farm-points" title="View the Farm Points leaderboard" @click.stop="pointsOpen = true">Farm Points</button>
        </div>
        <div class="n-cell" data-label="Network"><span class="n-chip mainnet">Solana</span></div>
        <div class="n-cell" data-label="Infra"><span class="n-chip">{{ m.infra }}</span></div>
        <div class="n-cell" data-label="Collateral"><div class="n-tok-group"><TokenIcon v-for="id in m.collateral" :key="id" :token="tok(id)" size="sm" stack /></div></div>
        <div class="n-cell" data-label="Loans"><div class="n-tok-group"><TokenIcon v-for="id in m.loans" :key="id" :token="tok(id)" size="sm" /></div></div>
        <div class="n-cell n-num" data-label="Total Supplied"><span v-if="state.loaded">{{ usd(marketSummary(m).totalSuppliedUsd) }}</span><span v-else class="n-skel" /></div>
        <div class="n-cell n-num" data-label="Total Borrowed"><span v-if="state.loaded">{{ usd(marketSummary(m).totalBorrowedUsd) }}</span><span v-else class="n-skel" /></div>
        <div class="n-cell n-actions">
          <button class="n-btn-sm" @click.stop="go(m, 'lend')">Lend</button>
          <button class="n-btn-sm ghost" @click.stop="go(m, 'borrow')">Borrow</button>
        </div>
      </div>
    </div>
    <div v-for="m in soon" :key="m.id" class="n-row-wrap">
      <div class="n-tr mk-grid soon">
        <div class="n-cell name">{{ m.name }}</div><div class="n-cell n-muted">—</div><div class="n-cell"><span class="n-chip">{{ m.infra }}</span></div>
        <div /><div /><div class="n-cell">—</div><div class="n-cell">—</div><div />
      </div>
      <div class="n-soon">Coming Soon</div>
    </div>
  </div>
  <p class="foot-note">{{ LIVE.length }} live {{ LIVE.length === 1 ? 'market' : 'markets' }} · {{ soon.length }} in preparation</p>
  <FarmPointsModal v-if="pointsOpen" @close="pointsOpen = false" />
</template>
