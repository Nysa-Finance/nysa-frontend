<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { state, rowOf } from '../store.js'
import { LIVE, tok } from '../config.js'
import { usd, pct } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'

const router = useRouter()
// LTV: the highest max LTV among the market's collaterals (what you can borrow per $ of collateral), read on-chain.
const rows = computed(() => LIVE.flatMap((m) => m.loans.map((id) => ({
  m, t: tok(id), r: rowOf(id)?.reserve,
  ltv: Math.max(...m.collateral.map((c) => state.reserves[c]?.maxLtv ?? NaN)),
}))))
const go = (m) => router.push({ name: 'market-detail', params: { id: m.id } })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Borrow</h1>
    <p class="n-sub">Borrow against your collateral</p>
  </div>
  <div class="n-table">
    <div class="n-thead bw-grid"><div>Asset</div><div>Collateral</div><div>Network</div><div>LTV</div><div>Borrow APY</div><div>Available Liquidity</div></div>
    <template v-if="state.loaded">
      <div v-for="x in rows" :key="x.m.id + x.t.token_id" class="n-tr click bw-grid" @click="go(x.m)">
        <div class="n-cell n-asset" data-label="Asset"><span class="asset-id"><TokenIcon :token="x.t" /><span>{{ x.t.name }}</span></span></div>
        <div class="n-cell" data-label="Collateral">
          <span class="asset-id"><span v-for="c in x.m.collateral" :key="c" class="asset-id coll"><TokenIcon :token="tok(c)" size="sm" /><span>{{ tok(c).name }}</span></span></span>
        </div>
        <div class="n-cell" data-label="Network"><span class="n-chip mainnet">Solana</span></div>
        <div class="n-cell n-num" data-label="LTV" :title="`Max LTV with ${x.m.collateral.map((c) => tok(c).name).join(', ')} as collateral`">{{ pct(x.ltv, 0) }}</div>
        <div class="n-cell n-accent n-num" data-label="Borrow APY">{{ pct(x.r?.borrowAPR) }}</div>
        <div class="n-cell n-muted n-num" data-label="Available Liquidity">{{ usd(x.r && x.r.availableLiquidity * x.r.price) }}</div>
      </div>
      <div v-if="!rows.length" class="n-empty">No borrowable markets are live yet.</div>
    </template>
    <div v-else class="n-tr bw-grid"><span v-for="i in 6" :key="i" class="n-skel" /></div>
  </div>
</template>

<style scoped>
.asset-id { display: flex; align-items: center; gap: 12px; } /* icon and name stay together on mobile */
.coll { gap: 8px; color: var(--n-text-2); }
</style>
