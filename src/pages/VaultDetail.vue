<script setup>
// An Earn vault (/earn/:id): exposure (allocation pie and markets), realized APY from the vault's share value, and
// admin changes to the vault and to every market it is exposed to. Deposit / withdraw on the right.
import { event } from '../analytics.js'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { state, loadApyHistory, loadMarketUpdates, vaultApyNote } from '../store.js'
import { vaultById, tok, explorer } from '../config.js'
import { usd, pct, amt, short } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'
import Section from '../components/Section.vue'
import ExposureChart from '../components/ExposureChart.vue'
import RealizedApy from '../components/RealizedApy.vue'
import MarketUpdates from '../components/MarketUpdates.vue'
import VaultPanel from '../components/VaultPanel.vue'
import FarmPointsModal from '../components/FarmPointsModal.vue'
import NotFound from './NotFound.vue'

const route = useRoute()
const router = useRouter()
const v = computed(() => vaultById(route.params.id))
const live = computed(() => state.vaults[v.value?.id] ?? null)
const token = computed(() => tok(live.value?.tokenId ?? 'svm-usdc'))
const pointsOpen = ref(false)

const apyHistory = ref(null)
onMounted(() => loadApyHistory().then((h) => (apyHistory.value = h)).catch((e) => console.error('[apy-history]', e)))
// Admin changes to this vault and to the markets it is allocated to (the index tags each with its source).
const allUpdates = ref(null)
const updatesError = ref(null)
onMounted(() => loadMarketUpdates().then((d) => (allUpdates.value = d.updates)).catch((e) => (updatesError.value = e.message)))
const updates = computed(() => {
  if (!allUpdates.value || !live.value) return null // loading
  const sources = new Set([v.value.address, ...live.value.allocations.map((a) => a.market)])
  return allUpdates.value.filter((u) => sources.has(u.source))
})
// Vault, its admins and the oracle(s) pricing its token in the reserves it is allocated to.
const addresses = computed(() => [
  { label: 'Vault', address: v.value.address },
  ...(live.value ? [
    { label: 'Admin', address: live.value.admin },
    { label: 'Allocation Admin', address: live.value.allocationAdmin },
    ...live.value.oracles.map((o) => ({ label: 'Oracle', note: `${token.value.name} price · Scope`, address: o })),
  ] : []),
])
const back = () => (history.state?.back ? router.back() : router.push({ name: 'earn' }))
</script>

<template>
  <NotFound v-if="!v" />
  <template v-else>
    <button class="n-back" @click="back">← Back</button>
    <div class="n-detail-grid">
      <div class="col">
        <div>
          <div class="title-row">
            <TokenIcon :token="token" />
            <h1 class="n-h1" style="margin: 0">{{ live?.name ?? v.name }}</h1>
            <span class="n-chip mainnet">Solana</span>
            <span class="n-chip">Kamino vault</span>
          </div>
          <p class="n-sub blurb">{{ v.description }}</p>
          <div v-if="live?.rewards" class="farm-cta reward-cta">
            <div>
              <div class="farm-cta-t">⚡ Boosted: +{{ pct(live.rewardsApy) }} APY in {{ live.rewards.symbol }} rewards, auto-compounded into your deposit.</div>
              <div class="farm-cta-s">{{ amt(live.rewards.perWeek, 2) }} {{ live.rewards.symbol }} a week, shared by all depositors · {{ amt(live.rewards.left, 2) }} {{ live.rewards.symbol }} left, about {{ live.rewards.daysLeft < 1 ? `${Math.max(Math.round(live.rewards.daysLeft * 24), 1)} h` : `${Math.round(live.rewards.daysLeft)} d` }} at this rate.</div>
            </div>
          </div>
          <div v-if="v.farmPoints" class="farm-cta">
            <div>
              <div class="farm-cta-t">This vault is eligible for farming Nysa Points.</div>
              <div class="farm-cta-s">Deposit and earn points on your balance, every day.</div>
            </div>
            <button class="n-btn-sm ghost" @click="pointsOpen = true; event('Farm Points opened', { from: 'vault' })">Check your points →</button>
          </div>
          <div class="n-stats stat-3 head-stats">
            <div class="n-stat"><div class="k">Total deposits</div><div class="v"><span v-if="live">{{ usd(live.totalUsd) }}</span><span v-else class="n-skel" /></div></div>
            <div class="n-stat"><div class="k">APY</div><div class="v accent"><span v-if="live">{{ pct(live.apy) }}<span v-if="live.rewardsApy" class="n-boost" :title="vaultApyNote(live)" :aria-label="vaultApyNote(live)">⚡</span></span><span v-else class="n-skel" /></div></div>
            <div class="n-stat"><div class="k">Utilization</div><div class="v"><span v-if="live">{{ pct(live.utilization) }}</span><span v-else class="n-skel" /></div><div class="s">of the vault's deposits are lent out</div></div>
          </div>
        </div>

        <Section title="Exposure" open>
          <template #meta>{{ live ? `${live.allocations.length} ${live.allocations.length === 1 ? 'market' : 'markets'}` : '' }}</template>
          <ExposureChart v-if="live" :vault="live" :price="state.reserves[token.token_id]?.price" />
          <div v-else class="n-empty">Reading the vault on-chain…</div>
        </Section>

        <Section title="Realized APY">
          <template #meta>Current {{ pct(live?.apy) }}</template>
          <RealizedApy :token="token" :history="apyHistory?.vaults?.[v.id]" :current-apy="live?.apy" />
        </Section>

        <Section title="Market Updates">
          <template #meta>{{ updates ? `${updates.length} changes · vault and its markets` : '' }}</template>
          <MarketUpdates :updates="updates" :error="updatesError" />
        </Section>

        <Section title="Fees">
          <template #meta>set on-chain by the curator</template>
          <div class="n-table">
            <div class="addr-row"><span class="addr-k">Management fee</span><span class="n-num">{{ live ? pct(live.managementFee) : '—' }}</span></div>
            <div class="addr-row"><span class="addr-k">Performance fee</span><span class="n-num">{{ live ? pct(live.performanceFee) : '—' }}</span></div>
            <div class="addr-row">
              <span class="addr-k">Withdrawal fee</span>
              <span class="n-num">{{ live ? pct(live.withdrawPenaltyPct) : '—' }}<!-- a fixed part of 1 base unit (0.000001 USDC) is dust: shown as 0% like Kamino does -->
                <template v-if="live?.withdrawPenaltyFixed > 10 ** -token.decimals"> + {{ live.withdrawPenaltyFixed }} {{ token.name }}</template></span>
            </div>
          </div>
          <p class="hint">Management fee: yearly, on the vault's assets. Performance fee: on the interest earned. Withdrawal fee: charged when withdrawing and left in the vault.</p>
        </Section>

        <Section title="Addresses">
          <div class="n-table">
            <div v-for="row in addresses" :key="row.label" class="addr-row">
              <span class="addr-k">{{ row.label }}<span v-if="row.note" class="addr-note">{{ row.note }}</span></span>
              <a class="addr-link" :href="explorer(row.address)" target="_blank" rel="noopener noreferrer"><span class="addr-full">{{ row.address }}</span><span class="addr-short">{{ short(row.address, 6, 6) }}</span><span class="ext">↗</span></a>
            </div>
          </div>
        </Section>
      </div>

      <aside class="side">
        <VaultPanel :key="route.fullPath" :vault="v" :live="live" :initial-tab="route.query.tab" />
      </aside>
    </div>
    <FarmPointsModal v-if="pointsOpen" @close="pointsOpen = false" />
  </template>
</template>

<style scoped>
.n-detail-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 40px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.head-stats { margin-bottom: 22px; }
.stat-3 { grid-template-columns: repeat(3, 1fr); }
.side { position: sticky; top: 96px; }
.title-row { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; flex-wrap: wrap; }
.blurb { max-width: 620px; margin-bottom: 22px; line-height: 1.6; font-size: 14px; }
.farm-cta { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; padding: 16px 20px; border: 1px solid #ec008c59; border-radius: 8px; background: #ec008c0f; }
.farm-cta-t { font-size: 14px; font-weight: 500; }
.farm-cta-s { margin-top: 2px; font-size: 13px; color: var(--n-text-3); }
.farm-cta .n-btn-sm { flex-shrink: 0; }
.reward-cta { border-color: #3ddc8459; background: #3ddc840f; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
.addr-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 15px 20px; border-bottom: 1px solid var(--n-hair); font-size: 14px; }
.addr-row:last-child { border-bottom: none; }
.addr-k { color: var(--n-text-3); white-space: nowrap; }
.addr-note { margin-left: 10px; color: var(--n-text-4); font-size: 12px; }
.addr-link { display: inline-flex; align-items: center; gap: 8px; min-width: 0; transition: color .15s; }
.addr-link:hover { color: var(--n-pink); }
.ext { color: var(--n-text-3); font-size: 12px; }
.addr-full, .addr-short { font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
.addr-short { display: none; }
@media (max-width: 1320px) { .addr-full { display: none; } .addr-short { display: inline; } }
@media (max-width: 860px) {
  .farm-cta { flex-direction: column; align-items: stretch; }
  .n-detail-grid { grid-template-columns: 1fr; gap: 30px; }
  .side { position: static; }
}
</style>
