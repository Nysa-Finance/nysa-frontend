<script setup>
import { event } from '../analytics.js'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { state, rowOf, loadApyHistory, loadMarketUpdates } from '../store.js'
import { marketById, tok, tokensOf, explorer } from '../config.js'
import { usd, pct, compact, short } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'
import IrmChart from '../components/IrmChart.vue'
import LendPanel from '../components/LendPanel.vue'
import BorrowPanel from '../components/BorrowPanel.vue'
import FarmPointsModal from '../components/FarmPointsModal.vue'
import NotFound from './NotFound.vue'
import Section from '../components/Section.vue'
import RealizedApy from '../components/RealizedApy.vue'
import MarketUpdates from '../components/MarketUpdates.vue'

const route = useRoute()
const router = useRouter()
const m = computed(() => marketById(route.params.id))
const mode = computed(() => (route.query.mode === 'borrow' ? 'borrow' : 'lend'))
const tokens = computed(() => tokensOf(m.value))
const collateral = computed(() => m.value.collateral.map(tok))
const loans = computed(() => m.value.loans.map(tok))
const r = (id) => rowOf(id)?.reserve
const sum = (ids, k) => ids.reduce((s, id) => s + (r(id)?.[k] ?? 0), 0)
const pointsOpen = ref(false)
const apyHistory = ref(null)
onMounted(() => loadApyHistory().then((h) => (apyHistory.value = h)).catch((e) => console.error('[apy-history]', e)))
const updates = ref(null)
const updatesError = ref(null)
onMounted(() => loadMarketUpdates().then((d) => (updates.value = d.updates)).catch((e) => (updatesError.value = e.message)))
const back = () => (history.state?.back ? router.back() : router.push('/'))

function openDd() {
  const dd = document.getElementById('dd')
  if (!dd) return
  dd.open = true
  dd.scrollIntoView({ behavior: 'smooth' })
}
</script>

<template>
  <NotFound v-if="!m" />
  <template v-else>
    <button class="n-back" @click="back">← Back</button>
    <div class="n-detail-grid">
      <div class="col">
        <div>
          <div class="title-row">
            <div class="n-tok-group"><TokenIcon v-for="t in tokens" :key="t.token_id" :token="t" size="sm" /></div>
            <h1 class="n-h1" style="margin: 0">{{ m.name }}</h1>
            <span class="n-chip mainnet">Solana</span>
            <button class="n-pill" @click="openDd"><span class="n-dot" />Safety Score {{ m.dueDiligence.safetyScore }}/10</button>
          </div>
          <p class="n-sub blurb">{{ m.blurb }}</p>
          <div v-if="m.farmPoints" class="farm-cta">
            <div>
              <div class="farm-cta-t">This market is eligible for farming Nysa Points.</div>
              <div class="farm-cta-s">Lend out tokens and earn points.</div>
            </div>
            <button class="n-btn-sm ghost" @click="pointsOpen = true; event('Farm Points opened', { from: 'market' })">Check your points →</button>
          </div>
          <div class="n-stats stat-2 head-stats">
            <div class="n-stat"><div class="k">Collateral deposited</div><div class="v"><span v-if="state.loaded">{{ usd(sum(m.collateral, 'supplyUsd')) }}</span><span v-else class="n-skel" /></div></div>
            <div class="n-stat"><div class="k">Global borrowed</div><div class="v"><span v-if="state.loaded">{{ usd(sum(m.loans, 'borrowUsd')) }}</span><span v-else class="n-skel" /></div></div>
          </div>
        </div>

        <Section title="Asset data">
          <div class="n-table">
            <div class="n-thead ad-grid"><div>Asset</div><div>Deposits</div><div>Borrowed</div><div>Utilization</div><div>Supply APY</div><div>Borrow APY</div></div>
            <div v-for="t in tokens" :key="t.token_id" class="n-tr sm ad-grid">
              <div class="n-cell n-asset" data-label="Asset"><TokenIcon :token="t" size="sm" />{{ t.name }}</div>
              <div class="n-cell n-num" data-label="Deposits">{{ usd(r(t.token_id)?.supplyUsd) }}</div>
              <div class="n-cell n-num" data-label="Borrowed">{{ m.loans.includes(t.token_id) ? usd(r(t.token_id)?.borrowUsd) : '—' }}</div>
              <div class="n-cell n-num" data-label="Utilization">{{ pct(r(t.token_id)?.utilization, 1) }}</div>
              <div class="n-cell n-accent n-num" data-label="Supply APY">{{ pct(r(t.token_id)?.supplyAPR) }}</div>
              <div class="n-cell n-accent n-num" data-label="Borrow APY">{{ pct(r(t.token_id)?.borrowAPR) }}</div>
            </div>
          </div>
        </Section>

        <Section v-for="t in loans" :key="'ra' + t.token_id" :title="loans.length > 1 ? `Realized APY · ${t.name}` : 'Realized APY'">
          <template #meta>Current {{ pct(r(t.token_id)?.supplyAPR) }}</template>
          <RealizedApy :token="t" :history="apyHistory?.tokens?.[t.token_id]" :current-apy="r(t.token_id)?.supplyAPR" />
        </Section>

        <Section title="Interest rate model">
          <div class="n-table">
            <div class="n-thead irm-grid"><div>Asset</div><div>Base rate</div><div>Rate at kink</div><div>Max rate</div><div>Kink</div></div>
            <div v-for="t in tokens" :key="t.token_id" class="n-tr sm irm-grid">
              <div class="n-cell n-asset" data-label="Asset"><TokenIcon :token="t" size="sm" />{{ t.name }}</div>
              <template v-if="t.irm">
                <div class="n-cell n-num" data-label="Base rate">{{ pct(t.irm.points[0][1]) }}</div>
                <div class="n-cell n-num" data-label="Rate at kink">{{ pct(t.irm.points.at(-2)[1]) }}</div>
                <div class="n-cell n-num" data-label="Max rate">{{ pct(t.irm.points.at(-1)[1], 1) }}</div>
                <div class="n-cell n-num" data-label="Kink">{{ t.irm.points.at(-2)[0] }}%</div>
              </template>
              <div v-else class="n-cell n-muted collateral-only" style="grid-column: span 4">Collateral only — this reserve has no interest rate model</div>
            </div>
          </div>
          <p class="hint">Rates are annualised from the vault's per-second borrow rate. Suppliers receive the borrow rate scaled by utilisation, net of the reserve fee.</p>
          <div class="irm-charts">
            <div v-for="t in tokens.filter((t) => t.irm)" :key="t.token_id" class="irm-card">
              <div class="n-asset irm-card-head"><TokenIcon :token="t" size="sm" />{{ t.name }}</div>
              <IrmChart :irm="t.irm" :utilization="r(t.token_id)?.utilization" />
            </div>
          </div>
        </Section>

        <Section title="Risk parameters">
          <div class="n-table">
            <div class="n-thead rp-grid"><div>Collateral</div><div>Liability</div><div>Max LTV</div><div>Liquidation LTV</div><div>Max discount</div><div>Supply cap</div><div>Borrow cap</div></div>
            <div v-for="p in m.pairs" :key="p.collateral + p.liability" class="n-tr sm rp-grid">
              <div class="n-cell n-asset" data-label="Collateral"><TokenIcon :token="tok(p.collateral)" size="sm" />{{ tok(p.collateral).name }}</div>
              <div class="n-cell n-asset" data-label="Liability"><TokenIcon :token="tok(p.liability)" size="sm" />{{ tok(p.liability).name }}</div>
              <div class="n-cell n-num" data-label="Max LTV">{{ p.maxLtv }}%</div>
              <div class="n-cell n-num" data-label="Liquidation LTV">{{ p.liqLtv }}%</div>
              <div class="n-cell n-num" data-label="Max discount">{{ pct(p.maxDiscount, 1) }}</div>
              <div class="n-cell n-num" data-label="Supply cap">{{ compact(p.supplyCap, tok(p.collateral).name) }}</div>
              <div class="n-cell n-num" data-label="Borrow cap">{{ compact(p.borrowCap, tok(p.liability).name) }}</div>
            </div>
          </div>
          <p class="hint">An LTV belongs to a (collateral, liability) pair, not to an asset on its own — the same collateral can carry a different limit against a different loan.</p>
        </Section>

        <Section title="Market Updates">
          <template #meta>{{ updates ? `${updates.length} changes` : '' }}</template>
          <MarketUpdates :updates="updates" :error="updatesError" />
        </Section>

        <Section title="Addresses">
          <div class="n-table">
            <div class="addr-row">
              <span class="addr-k">Vault ID</span>
              <a class="addr-link" :href="explorer(m.kaminoMarket)" target="_blank" rel="noopener noreferrer"><span class="addr-full">{{ m.kaminoMarket }}</span><span class="addr-short">{{ short(m.kaminoMarket, 6, 6) }}</span><span class="ext">↗</span></a>
            </div>
            <template v-for="t in [...loans, ...collateral]" :key="t.token_id">
              <div class="addr-row">
                <span class="addr-k">{{ t.name }} Address</span>
                <a class="addr-link" :href="explorer(t.mint)" target="_blank" rel="noopener noreferrer"><span class="addr-full">{{ t.mint }}</span><span class="addr-short">{{ short(t.mint, 6, 6) }}</span><span class="ext">↗</span></a>
              </div>
              <div class="addr-row">
                <span class="addr-k">{{ t.name }} Price Feed<span class="addr-note">{{ t.feedNote }}</span></span>
                <a class="addr-link" :href="explorer(t.priceFeed)" target="_blank" rel="noopener noreferrer"><span class="addr-full">{{ t.priceFeed }}</span><span class="addr-short">{{ short(t.priceFeed, 6, 6) }}</span><span class="ext">↗</span></a>
              </div>
            </template>
          </div>
        </Section>

        <Section id="dd" title="Due Diligence" class="dd-section">
          <template #meta><span class="dd-score"><span class="dd-dot" />Safety Score {{ m.dueDiligence.safetyScore }}/10</span></template>
          <div class="dd-title">{{ m.dueDiligence.subject }}</div>
          <dl class="dd-list">
            <template v-for="row in m.dueDiligence.rows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd><a v-if="row.href" class="addr-link" :href="row.href" target="_blank" rel="noopener noreferrer">{{ row.value }} <span class="ext">↗</span></a><template v-else>{{ row.value }}</template></dd>
            </template>
          </dl>
        </Section>
      </div>

      <aside class="side">
        <LendPanel
          v-if="mode === 'lend'" :key="'l' + route.fullPath" :market="m" :tokens="loans" :all-tokens="tokens"
          :initial-tab="route.query.tab" :initial-asset="route.query.asset"
        />
        <BorrowPanel
          v-else :key="'b' + route.fullPath" :market="m" :collateral-tokens="collateral" :loan-tokens="loans"
          :initial-tab="route.query.tab" :initial-asset="route.query.asset"
        />
      </aside>
    </div>
    <FarmPointsModal v-if="pointsOpen" @close="pointsOpen = false" />
  </template>
</template>

<style scoped>
.n-detail-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 40px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.head-stats { margin-bottom: 22px; }
.side { position: sticky; top: 96px; }
.title-row { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; flex-wrap: wrap; }
.blurb { max-width: 620px; margin-bottom: 22px; line-height: 1.6; font-size: 14px; }
.farm-cta { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; padding: 16px 20px; border: 1px solid #ec008c59; border-radius: 8px; background: #ec008c0f; }
.farm-cta-t { font-size: 14px; font-weight: 500; }
.farm-cta-s { margin-top: 2px; font-size: 13px; color: var(--n-text-3); }
.farm-cta .n-btn-sm { flex-shrink: 0; }
.n-thead { font-size: 11px; padding: 14px 20px; }
.n-tr.sm { padding: 15px 20px; font-size: 14px; }
.ad-grid { grid-template-columns: 1.4fr 1fr 1fr 1fr 1fr 1fr; }
.irm-grid { grid-template-columns: 1.4fr 1fr 1fr 1fr 1fr; }
.rp-grid { grid-template-columns: 1.2fr 1.2fr .9fr 1.1fr 1fr 1.1fr 1.1fr; }
.collateral-only { font-size: 12.5px; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
.irm-charts { display: grid; gap: 16px; margin-top: 18px; }
.irm-card { border: 1px solid var(--n-line); border-radius: 4px; padding: 18px 20px 14px; min-width: 0; }
.irm-card-head { margin-bottom: 14px; font-size: 14px; }
.addr-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 15px 20px; border-bottom: 1px solid var(--n-hair); font-size: 14px; }
.addr-row:last-child { border-bottom: none; }
.addr-k { color: var(--n-text-3); white-space: nowrap; }
.addr-note { margin-left: 10px; color: var(--n-text-4); font-size: 12px; }
.addr-link { display: inline-flex; align-items: center; gap: 8px; min-width: 0; transition: color .15s; }
.addr-link:hover { color: var(--n-pink); }
.ext { color: var(--n-text-3); font-size: 12px; }
.addr-link:hover .ext { color: inherit; }
.addr-full, .addr-short { font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
.addr-short { display: none; }
.dd-section { scroll-margin-top: 96px; }
.dd-score { display: inline-flex; align-items: center; gap: 9px; font-weight: 500; color: var(--n-green); }
.dd-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--n-green); box-shadow: 0 0 0 4px #3ddc8429; }
.dd-title { font-size: 15px; font-weight: 500; margin-bottom: 16px; color: var(--n-text-2); }
.dd-list { display: grid; grid-template-columns: max-content 1fr; gap: 12px 32px; font-size: 14px; }
.dd-list dt { color: var(--n-text-3); }
@media (max-width: 1320px) { .addr-full { display: none; } .addr-short { display: inline; } }
@media (max-width: 1180px) { .n-table { overflow-x: auto; } }
@media (max-width: 860px) {
  .farm-cta { flex-direction: column; align-items: stretch; }
  .n-detail-grid { grid-template-columns: 1fr; gap: 30px; }
  .side { position: static; }
  .addr-row { padding: 14px 18px; gap: 12px; }
  .addr-k { white-space: normal; }
  .addr-note { display: block; margin: 2px 0 0; }
  .dd-list { grid-template-columns: 1fr; gap: 4px; }
  .dd-list dd { margin-bottom: 10px; }
  .n-tr.sm { padding: 16px 18px; }
}
</style>
