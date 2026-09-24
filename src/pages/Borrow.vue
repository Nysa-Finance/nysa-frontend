<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { state, rowOf } from '../store.js'
import { LIVE, tok } from '../config.js'
import { usd, pct } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'

const router = useRouter()
const rows = computed(() => LIVE.flatMap((m) => m.loans.map((id) => ({ m, t: tok(id), r: rowOf(id)?.reserve }))))
const go = (m) => router.push({ name: 'market-detail', params: { id: m.id }, query: { mode: 'borrow' } })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Borrow</h1>
    <p class="n-sub">Borrow against your collateral</p>
  </div>
  <div class="n-table">
    <div class="n-thead bw-grid"><div>Asset</div><div>Borrow APY</div><div>Available Liquidity</div><div>Collaterals</div></div>
    <template v-if="state.loaded">
      <div v-for="x in rows" :key="x.m.id + x.t.token_id" class="n-tr click bw-grid" @click="go(x.m)">
        <div class="n-cell n-asset" data-label="Asset"><TokenIcon :token="x.t" /><span>{{ x.t.name }}</span></div>
        <div class="n-cell n-accent n-num" data-label="Borrow APY">{{ pct(x.r?.borrowAPR) }}</div>
        <div class="n-cell n-muted n-num" data-label="Available Liquidity">{{ usd(x.r && x.r.availableLiquidity * x.r.price) }}</div>
        <div class="n-cell" data-label="Collaterals">
          <div class="n-tok-group">
            <TokenIcon v-for="id in x.m.collateral" :key="id" :token="tok(id)" size="sm" />
            <span class="n-chip mainnet" style="margin-left: 10px">Solana</span>
          </div>
        </div>
      </div>
      <div v-if="!rows.length" class="n-empty">No borrowable markets are live yet.</div>
    </template>
    <div v-else class="n-tr bw-grid"><span v-for="i in 4" :key="i" class="n-skel" /></div>
  </div>
</template>
