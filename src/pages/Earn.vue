<script setup>
// Earn: Nysa's Kamino vaults. Exposure = collateral of the markets a vault is allocated to; Total Supply = everything
// supplied in those markets (collateral + loan asset), both read on-chain (server/vault.js).
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { state } from '../store.js'
import { VAULTS, tok } from '../config.js'
import { usd, pct } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'
import FarmPointsModal from '../components/FarmPointsModal.vue'

const router = useRouter()
const pointsOpen = ref(false)
const rows = computed(() => VAULTS.map((v) => ({ v, live: state.vaults[v.id] })))
const go = (v) => router.push({ name: 'vault', params: { id: v.id } })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Earn</h1>
    <p class="n-sub">Deposit into curated vaults and earn yield from loans backed by tokenized real-world assets</p>
  </div>
  <div class="n-table">
    <div class="n-thead ea-grid"><div>Vault</div><div>APY</div><div>Exposure</div><div>Total Supply</div></div>
    <template v-if="state.loaded">
      <div v-for="x in rows" :key="x.v.id" class="n-tr click ea-grid" @click="go(x.v)">
        <div class="n-cell n-asset" data-label="Vault">
          <TokenIcon v-if="x.live?.tokenId" :token="tok(x.live.tokenId)" />
          <span class="name">{{ x.live?.name ?? x.v.name }}</span>
          <span class="n-chip mainnet">Solana</span>
          <button v-if="x.v.farmPoints" type="button" class="n-farm-points" title="View the Farm Points leaderboard" @click.stop="pointsOpen = true">Farm Points</button>
        </div>
        <div class="n-cell n-accent n-num" data-label="APY">{{ x.live ? pct(x.live.apy) : '—' }}</div>
        <div class="n-cell" data-label="Exposure">
          <div class="n-tok-group" :title="x.live?.exposureTokens.map((t) => tok(t).name).join(', ')">
            <TokenIcon v-for="t in x.live?.exposureTokens ?? []" :key="t" :token="tok(t)" size="sm" />
          </div>
        </div>
        <div class="n-cell n-num" data-label="Total Supply">{{ x.live ? usd(x.live.exposureSupplyUsd) : '—' }}</div>
      </div>
      <div v-if="!rows.length" class="n-empty">No vaults are live yet.</div>
    </template>
    <div v-else class="n-tr ea-grid"><span v-for="i in 4" :key="i" class="n-skel" /></div>
  </div>
  <p class="hint">Total Supply: collateral and loan asset supplied in the markets the vault is allocated to.</p>
  <FarmPointsModal v-if="pointsOpen" @close="pointsOpen = false" />
</template>

<style scoped>
.ea-grid { grid-template-columns: 2.2fr 1fr 1fr 1.2fr; }
.name { font-weight: 600; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
</style>
