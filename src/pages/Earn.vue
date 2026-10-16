<script setup>
// Earn: Nysa's Kamino vaults. Exposure = collateral of the markets a vault is allocated to; Total Supply = everything
// supplied in those markets (collateral + loan asset), both read on-chain (server/vault.js).
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { state, vaultApyNote } from '../store.js'
import { VAULTS, tok } from '../config.js'
import { usd, pct } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'
import FarmPointsModal from '../components/FarmPointsModal.vue'

const router = useRouter()
const pointsOpen = ref(false)
const rows = computed(() => VAULTS.map((v) => ({ v, live: state.vaults[v.id] })))
const go = (v, tab) => router.push({ name: 'vault', params: { id: v.id }, query: tab ? { tab } : {} })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Earn</h1>
    <p class="n-sub">Deposit into curated vaults and earn yield from loans backed by tokenized real-world assets</p>
  </div>
  <div class="n-table">
    <div class="n-thead ea-grid"><div>Vault</div><div>Network</div><div>Infra</div><div>APY</div><div>Exposure</div><div>Total Supply</div><div /></div>
    <template v-if="state.loaded">
      <div v-for="x in rows" :key="x.v.id" class="n-tr click ea-grid" @click="go(x.v)">
        <div class="n-cell n-asset" data-label="Vault">
          <div class="vault-id">
            <TokenIcon v-if="x.live?.tokenId" :token="tok(x.live.tokenId)" />
            <div class="name-col">
              <span class="name">{{ x.live?.name ?? x.v.name }}</span>
              <button v-if="x.v.farmPoints" type="button" class="n-farm-points" title="View the Farm Points leaderboard" @click.stop="pointsOpen = true">Farm Points</button>
            </div>
          </div>
        </div>
        <div class="n-cell" data-label="Network"><span class="n-chip mainnet">Solana</span></div>
        <div class="n-cell" data-label="Infra"><span class="n-chip">Kamino</span></div>
        <div class="n-cell n-accent n-num" data-label="APY"><span>{{ x.live ? pct(x.live.apy) : '—' }}<span v-if="x.live?.rewardsApy" class="n-boost" :title="vaultApyNote(x.live)" :aria-label="vaultApyNote(x.live)">⚡</span></span></div>
        <div class="n-cell" data-label="Exposure">
          <div class="n-tok-group" :title="x.live?.exposureTokens.map((t) => tok(t).name).join(', ')">
            <TokenIcon v-for="t in x.live?.exposureTokens ?? []" :key="t" :token="tok(t)" size="sm" />
          </div>
        </div>
        <div class="n-cell n-num" data-label="Total Supply">{{ x.live ? usd(x.live.exposureSupplyUsd) : '—' }}</div>
        <div class="n-cell act"><button type="button" class="n-btn-sm" @click.stop="go(x.v, 'deposit')">Deposit</button></div>
      </div>
      <div v-if="!rows.length" class="n-empty">No vaults are live yet.</div>
    </template>
    <div v-else class="n-tr ea-grid"><span v-for="i in 7" :key="i" class="n-skel" /></div>
  </div>
  <p class="hint">Total Supply: collateral and loan asset supplied in the markets the vault is allocated to.</p>
  <FarmPointsModal v-if="pointsOpen" @close="pointsOpen = false" />
</template>

<style scoped>
.ea-grid { grid-template-columns: 1.8fr 1fr 1fr 1.1fr 1fr 1.1fr auto; }
.vault-id { display: flex; align-items: center; gap: 12px; }
.name-col { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.act { justify-content: flex-end; }
/* Mobile: the whole card opens the vault, so no Deposit button; a little more air between rows. */
@media (max-width: 860px) {
  .act { display: none; }
  .n-tr.ea-grid { gap: 12px; }
}
.name { font-weight: 600; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
</style>
