<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { state, rowOf } from '../store.js'
import { LIVE, tok } from '../config.js'
import { usd, pct } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'

const router = useRouter()
const rows = computed(() => LIVE.flatMap((m) => m.loans.map((id) => ({ m, t: tok(id), r: rowOf(id)?.reserve }))))
const go = (m) => router.push({ name: 'market-detail', params: { id: m.id }, query: { mode: 'lend' } })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Lend</h1>
    <p class="n-sub">Supply assets and earn yield</p>
  </div>
  <div class="n-table">
    <div class="n-thead ln-grid"><div>Asset</div><div>Supply APY</div><div>Market</div><div>Utilization</div><div>Total Supply</div></div>
    <template v-if="state.loaded">
      <div v-for="x in rows" :key="x.m.id + x.t.token_id" class="n-tr click ln-grid" @click="go(x.m)">
        <div class="n-cell n-asset" data-label="Asset"><TokenIcon :token="x.t" /><span>{{ x.t.name }}</span></div>
        <div class="n-cell n-accent n-num" data-label="Supply APY">{{ pct(x.r?.supplyAPR) }}</div>
        <div class="n-cell n-muted" data-label="Market"><span>{{ x.m.name }} <span class="n-chip mainnet" style="margin-left: 8px">Solana</span></span></div>
        <div class="n-cell n-muted n-num" data-label="Utilization">{{ pct(x.r?.utilization, 1) }}</div>
        <div class="n-cell n-num" data-label="Total Supply">{{ usd(x.r?.supplyUsd) }}</div>
      </div>
      <div v-if="!rows.length" class="n-empty">No lending markets are live yet.</div>
    </template>
    <div v-else class="n-tr ln-grid"><span v-for="i in 5" :key="i" class="n-skel" /></div>
  </div>
</template>
