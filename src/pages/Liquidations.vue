<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { state, riskOf, bonusText, loadPositions, loadLiquidations } from '../store.js'
import { LIVE, tok, explorer, txUrl } from '../config.js'
import { pct, amt, compact, short, hfText, hfColor } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'
import Section from '../components/Section.vue'
import LiquidateModal from '../components/LiquidateModal.vue'

const m = LIVE[0] // ponytail: single live market; iterate LIVE here when a second one ships
const pair = m.pairs[0]
const coll = tok(pair.collateral), debt = tok(pair.liability)
const AT_RISK = 1.1 // health factor under which a loan is flagged

const loans = ref(undefined) // undefined = loading, null = unavailable
const history = ref(undefined)
const target = ref(null) // borrower whose loan is being liquidated (modal)
async function load() {
  const [p, l] = await Promise.allSettled([loadPositions(), loadLiquidations()])
  loans.value = p.status === 'fulfilled' ? p.value.filter((x) => x.debt > 0) : null
  history.value = l.status === 'fulfilled' ? l.value : null
}
let timer
onMounted(() => { load(); timer = setInterval(load, 60_000) })
onUnmounted(() => clearInterval(timer))

const risk = computed(() => riskOf(pair))
const price = computed(() => state.reserves[coll.token_id]?.price)
// The health factor scales with the collateral price, so the loan is liquidated at price / hf.
// ponytail: assumes one collateral asset and stablecoin debt (the live market); needs per-asset deposits from the
// backend once a market has several collaterals.
const liqPrice = (p) => (price.value ? price.value / p.hf : null)
const drop = (p) => Math.max((1 - 1 / p.hf) * 100, 0)
const status = (hf) => (hf < 1 ? ['Liquidatable', 'bad'] : hf < AT_RISK ? ['At risk', 'warn'] : ['Healthy', 'ok'])

const atRisk = computed(() => loans.value?.filter((p) => p.hf < AT_RISK).length)
const lowest = computed(() => (loans.value?.length ? Math.min(...loans.value.map((p) => p.hf)) : null))
const repaid = computed(() => history.value?.reduce((s, l) => s + (l.repaid ?? 0), 0))
const when = (ts) => new Date(ts * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Liquidations</h1>
    <p class="n-sub">Loans close to liquidation and every liquidation in the market, read on-chain from Kamino Lend</p>
  </div>

  <div class="n-stats stat-4">
    <div class="n-stat">
      <div class="k">Liquidations</div>
      <div class="v"><span v-if="history">{{ history.length }}</span><span v-else-if="history === null">—</span><span v-else class="n-skel" /></div>
      <div class="s">since the market launched</div>
    </div>
    <div class="n-stat">
      <div class="k">Debt repaid by liquidators</div>
      <div class="v"><span v-if="history">{{ compact(repaid, debt.name) }}</span><span v-else-if="history === null">—</span><span v-else class="n-skel" /></div>
      <div class="s">all time</div>
    </div>
    <div class="n-stat">
      <div class="k">Loans at risk</div>
      <div class="v" :class="{ warn: atRisk }"><span v-if="loans">{{ atRisk }}</span><span v-else-if="loans === null">—</span><span v-else class="n-skel" /></div>
      <div class="s">health factor below {{ AT_RISK }}</div>
    </div>
    <div class="n-stat">
      <div class="k">Lowest health factor</div>
      <div class="v"><span v-if="loans" :style="lowest != null && { color: hfColor(lowest) }">{{ lowest == null ? '—' : hfText(lowest) }}</span><span v-else-if="loans === null">—</span><span v-else class="n-skel" /></div>
      <div class="s">{{ loans ? `across ${loans.length} open ${loans.length === 1 ? 'loan' : 'loans'}` : 'open loans' }}</div>
    </div>
  </div>

  <div class="sections">
    <Section title="Loans by health" open>
      <template #meta>{{ loans ? `${loans.length} open · riskiest first` : '' }}</template>
      <div class="n-table">
        <div class="n-thead lo-grid"><div>Wallet</div><div>Collateral</div><div>Debt</div><div>Health factor</div><div>{{ coll.name }} liq. price</div><div>Price drop to liq.</div><div>Status</div></div>
        <div v-if="loans === undefined" class="n-empty">Reading on-chain data…</div>
        <div v-else-if="loans === null" class="n-empty">Open loans are temporarily unavailable.</div>
        <div v-else-if="!loans.length" class="n-empty">No open loans in this market right now.</div>
        <div v-for="p in loans ?? []" :key="p.owner" class="n-tr sm lo-grid">
          <div class="n-cell" data-label="Wallet"><a class="sub-link mono" :href="explorer(p.owner)" target="_blank" rel="noopener noreferrer">{{ short(p.owner, 6) }} ↗</a></div>
          <div class="n-cell n-num" data-label="Collateral">${{ amt(p.deposits, 2) }}</div>
          <div class="n-cell n-num" data-label="Debt">${{ amt(p.debt, 2) }}</div>
          <div class="n-cell n-num" data-label="Health factor" :style="{ color: hfColor(p.hf), fontWeight: 600 }">{{ hfText(p.hf) }}</div>
          <div class="n-cell n-num" :data-label="`${coll.name} liq. price`">{{ liqPrice(p) ? `$${amt(liqPrice(p), 4)}` : '—' }}</div>
          <div class="n-cell n-num" data-label="Price drop to liq.">{{ pct(drop(p), 1) }}</div>
          <div class="n-cell st-cell" data-label="Status">
            <span class="n-chip" :class="status(p.hf)[1]">{{ status(p.hf)[0] }}</span>
            <button v-if="p.hf < 1 && p.owner !== state.address" class="n-btn-sm" @click="target = p.owner">Liquidate</button>
          </div>
        </div>
      </div>
      <p class="hint">Anyone can liquidate a loan once its health factor is below 1, from this page or with their own tools. Current {{ coll.name }} price: {{ price ? `$${amt(price, 4)}` : '—' }}. A loan is liquidated if {{ coll.name }} falls to its liquidation price.</p>
    </Section>

    <Section title="Liquidation history" open>
      <template #meta>{{ history ? `${history.length} ${history.length === 1 ? 'liquidation' : 'liquidations'}` : '' }}</template>
      <div class="n-table">
        <div class="n-thead lh-grid"><div>Date</div><div>Wallet</div><div>Debt repaid</div><div>Collateral seized</div><div>Liquidator</div><div>Transaction</div></div>
        <div v-if="history === undefined" class="n-empty">Reading on-chain history…</div>
        <div v-else-if="history === null" class="n-empty">The liquidation history is temporarily unavailable.</div>
        <div v-else-if="!history.length" class="n-empty">No liquidations so far. Every liquidation in this market will appear here, with its transaction.</div>
        <div v-for="l in history ?? []" :key="l.id" class="n-tr sm lh-grid">
          <div class="n-cell n-muted n-num" data-label="Date">{{ when(l.ts) }}</div>
          <div class="n-cell" data-label="Wallet"><a class="sub-link mono" :href="explorer(l.owner ?? l.obligation)" target="_blank" rel="noopener noreferrer">{{ short(l.owner ?? l.obligation, 6) }} ↗</a></div>
          <div class="n-cell n-num" data-label="Debt repaid">{{ l.repaid == null ? '—' : `${amt(l.repaid, 2)} ${l.repaidToken}` }}</div>
          <div class="n-cell n-num" data-label="Collateral seized">{{ l.seized == null ? '—' : `${amt(l.seized, 2)} ${l.seizedToken}` }}</div>
          <div class="n-cell" data-label="Liquidator"><a class="sub-link mono" :href="explorer(l.liquidator)" target="_blank" rel="noopener noreferrer">{{ short(l.liquidator, 4) }} ↗</a></div>
          <div class="n-cell" data-label="Transaction"><a class="sub-link mono" :href="txUrl(l.sig)" target="_blank" rel="noopener noreferrer">{{ short(l.sig, 4) }} ↗</a></div>
        </div>
      </div>
      <p class="hint">Decoded from Kamino Lend liquidation transactions on Solana.</p>
    </Section>

    <Section title="How liquidations work">
      <template #meta>{{ coll.name }} → {{ debt.name }}</template>
      <div class="how">
        <div class="pair"><TokenIcon :token="coll" size="sm" /><TokenIcon :token="debt" size="sm" /><span>{{ coll.name }} collateral, {{ debt.name }} loans</span></div>
        <div class="n-stats params">
          <div class="n-stat"><div class="k">Max LTV</div><div class="v sm">{{ pct(risk.maxLtv, 0) }}</div><div class="s">borrowing limit</div></div>
          <div class="n-stat"><div class="k">Liquidation LTV</div><div class="v sm">{{ pct(risk.liqLtv, 0) }}</div><div class="s">health factor 1</div></div>
          <div class="n-stat"><div class="k">Liquidation bonus</div><div class="v sm">{{ bonusText(pair) }}</div><div class="s">paid to the liquidator · configured max {{ pct(risk.maxDiscount, 0) }}</div></div>
        </div>
        <p>
          The health factor is your collateral, weighted by the liquidation LTV, divided by your debt. If it falls below 1,
          because the collateral price dropped or interest grew the debt, the loan can be liquidated: anyone can repay part of
          the debt and receive collateral of the same value plus a bonus of {{ bonusText(pair) }}. The bonus grows with how far
          the loan is past its liquidation LTV, but it is also capped so the loan stays solvent, which is why the configured
          {{ pct(risk.maxDiscount, 0) }} maximum can't be reached with these settings.
        </p>
        <p>
          Liquidations are executed on-chain by Kamino Lend's smart contracts, and each one is listed above with its
          transaction. To stay safe, keep your health factor well above 1: repay part of the loan or add collateral.
        </p>
      </div>
    </Section>
  </div>
  <LiquidateModal v-if="target" :market="m" :borrower="target" @close="target = null" @done="load" />
</template>

<style scoped>
.sections { display: flex; flex-direction: column; gap: 16px; }
.n-thead { font-size: 11px; padding: 14px 20px; }
.n-tr.sm { padding: 15px 20px; font-size: 14px; }
.lo-grid { grid-template-columns: 1.3fr .9fr .9fr .9fr 1fr 1fr 1.5fr; }
.st-cell { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.st-cell .n-btn-sm { padding: 6px 14px; font-size: 12px; }
.lh-grid { grid-template-columns: 1.3fr 1.2fr 1fr 1.1fr .9fr .8fr; }
.sub-link { color: var(--n-text-3); font-size: 12px; font-weight: 400; }
.sub-link:hover { color: var(--n-pink); }
.sub-link.mono { font-family: var(--mono); font-size: 13px; color: var(--n-text-2); }
.n-chip.bad { border-color: #ff5d5d59; color: var(--n-red); }
.n-stat .v.warn { color: var(--n-amber); }
.n-stat .v.sm { font-size: 22px; }
.hint { margin-top: 12px; color: var(--n-text-4); font-size: 12px; line-height: 1.6; }
.how { display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 1.7; color: var(--n-text-2); }
.pair { display: flex; align-items: center; gap: 8px; color: var(--n-text); font-weight: 500; }
.params { grid-template-columns: repeat(3, 1fr); }
@media (max-width: 1180px) { .n-table { overflow-x: auto; } }
</style>
