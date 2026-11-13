<script setup>
import { event } from '../analytics.js'
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { state, rowOf, priceOf, loadPoints, myPoints, riskOf, claimRewards, useTx } from '../store.js'
import { LIVE, LOOP_ENABLED, VAULTS, tok, tokensOf } from '../config.js'
import { usd, pct, amt, amtDust, healthFactor, hfText as hfFmt, hfColor as hfTone } from '../logic.js'
import TokenIcon from '../components/TokenIcon.vue'
import FarmPointsModal from '../components/FarmPointsModal.vue'
import TxProgress from '../components/TxProgress.vue'
import { loopPortfolioTotals, portfolioHealthFactor } from '../loop-positions.js'

const router = useRouter()
const view = ref('deposits')
const on = computed(() => !!state.address)
const loopPositions = computed(() => state.loopPositions ?? [])
const LOOP_RESERVES = computed(() => state.reserves['sol-usdy-usdc'] ?? {}) // the loop runs on this market only
const loopTotals = computed(() => loopPortfolioTotals(
  loopPositions.value,
  Object.fromEntries(Object.keys(LOOP_RESERVES.value).map((id) => [id, priceOf(id)])),
  LOOP_RESERVES.value,
))

// Earn vault deposits: shares valued in the vault's token.
const vaultDeposits = computed(() =>
  VAULTS.map((v) => ({ v, live: state.vaults[v.id], value: state.vaultPositions[v.id]?.value ?? 0 }))
    .filter((d) => d.value > 0)
    .map((d) => ({ ...d, t: tok(d.live?.tokenId ?? 'svm-usdc'), usd: d.value * priceOf(d.live?.tokenId ?? 'svm-usdc'), apr: d.live?.apy ?? 0 })),
)
// Deposits held directly in a market: collateral, and loan-asset deposits made before lending moved to the vaults.
const deposits = computed(() =>
  LIVE.flatMap((m) => tokensOf(m).map((t) => ({ m, t, units: rowOf(m, t.token_id)?.supplied ?? 0 })))
    .filter((d) => d.units > 0)
    .map((d) => ({ ...d, usd: d.units * priceOf(d.t.token_id), apr: rowOf(d.m, d.t.token_id)?.reserve.supplyAPR ?? 0 })),
)
const loans = computed(() =>
  LIVE.flatMap((m) =>
    m.loans.map((id) => {
      const units = rowOf(m, id)?.borrowed ?? 0
      const debtUsd = units * priceOf(id)
      const coll = m.collateral.map((c) => ({ t: tok(c), usd: (rowOf(m, c)?.supplied ?? 0) * priceOf(c) }))
      const collUsd = coll.reduce((s, c) => s + c.usd, 0)
      const pair = m.pairs.find((p) => p.liability === id)
      const liq = pair ? riskOf(m, pair).liqLtv : 0
      return { m, t: tok(id), units, usd: debtUsd, coll, collUsd, hf: healthFactor(collUsd, liq, debtUsd), apr: rowOf(m, id)?.reserve.borrowAPR ?? 0 }
    }),
  ).filter((l) => l.units > 0),
)
const supplied = computed(() => deposits.value.reduce((s, d) => s + d.usd, 0) + vaultDeposits.value.reduce((s, d) => s + d.usd, 0) + loopTotals.value.suppliedUsd)
// USDC lent straight to a market (not through a vault): can be withdrawn, and moved into the vault.
const directLending = computed(() => deposits.value.filter((d) => d.m.loans.includes(d.t.token_id)))
const borrowed = computed(() => loans.value.reduce((s, l) => s + l.usd, 0) + loopTotals.value.borrowedUsd)
const netApy = computed(() => {
  if (!supplied.value) return null
  const earn = deposits.value.reduce((s, d) => s + d.usd * d.apr, 0) + vaultDeposits.value.reduce((s, d) => s + d.usd * d.apr, 0) - loans.value.reduce((s, l) => s + l.usd * l.apr, 0) + loopTotals.value.netAprUsd
  return earn / supplied.value
})
const hf = computed(() => portfolioHealthFactor(loans.value.map((loan) => loan.hf), loopTotals.value))
const hfText = (v) => (on.value ? v === null ? '—' : hfFmt(v) : '—')
const hfColor = (v) => (on.value && v !== null ? hfTone(v) : 'var(--n-text-3)')
const pointsOpen = ref(false)
const points = computed(myPoints)
onMounted(loadPoints)
const go = (m, mode, tab, asset) => router.push({ name: 'market-detail', params: { id: m.id }, query: { mode, tab, asset } })
const goVault = (v, tab) => router.push({ name: 'vault', params: { id: v.id }, query: { tab } })
const manageLoop = (position) => router.push({ name: 'loop', query: { position: position.id } })
// Unclaimed farm rewards from direct market deposits, per market.
const claimable = computed(() => LIVE.map((m) => {
  const by = {}
  for (const p of state.claimable[m.id] ?? []) by[p.symbol] = (by[p.symbol] ?? 0) + p.amount
  return { m, items: Object.entries(by) }
}).filter((c) => c.items.length))
const { tx: claimTx, run: runClaim, reset: resetClaim } = useTx()
const claim = (m) => runClaim([{ label: 'Claim rewards', run: () => claimRewards(m) }])
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Portfolio</h1>
    <p class="n-sub">Track your positions across all markets</p>
  </div>
  <div v-if="!on" class="n-banner">Connect a wallet to see your positions.</div>

  <div class="n-stats stat-4">
    <div class="n-stat"><div class="k">Total Supplied</div><div class="v">{{ on ? usd(supplied) : '—' }}</div></div>
    <div class="n-stat"><div class="k">Total Borrowed</div><div class="v">{{ on ? usd(borrowed) : '—' }}</div></div>
    <div class="n-stat"><div class="k">Net APY</div><div class="v accent">{{ on ? pct(netApy) : '—' }}</div></div>
    <div class="n-stat"><div class="k">Health Factor</div><div class="v" :style="{ color: hfColor(hf) }">{{ hfText(hf) }}</div></div>
  </div>

  <section v-if="on && loopPositions.length" class="n-panel loop-position-panel">
    <div class="loop-heading"><div><h2>Nysa Multiply positions</h2><p class="n-muted">Loop collateral and debt stay separate from vanilla lending positions.</p></div><span class="n-chip">{{ loopPositions.length }} identified</span></div>
    <div v-for="position in loopPositions" :key="position.id" class="loop-position-row">
      <div><div class="loop-market">{{ position.market.name }}</div><div class="n-muted">Multiply · {{ position.obligation.address.slice(0, 6) }}…{{ position.obligation.address.slice(-4) }}</div></div>
      <div><div class="loop-label">Collateral</div><div class="n-num">{{ amt(Number(position.collateral.amount), 4) }} {{ position.collateral.tokenId === 'svm-usdy' ? 'USDY' : position.collateral.tokenId }}</div><div class="n-muted">{{ usd(Number(position.collateral.amount) * priceOf(position.collateral.tokenId)) }}</div></div>
      <div><div class="loop-label">Debt</div><div class="n-num">{{ amt(Number(position.liability.amount), 4) }} {{ position.liability.tokenId === 'svm-usdc' ? 'USDC' : position.liability.tokenId }}</div><div class="n-muted">{{ usd(Number(position.liability.amount) * priceOf(position.liability.tokenId)) }}</div></div>
      <div><div class="loop-label">Health factor</div><div class="n-num">{{ position.healthFactor == null ? '—' : position.healthFactor.toFixed(2) }}</div></div>
      <div><button v-if="LOOP_ENABLED" class="n-btn-sm ghost" @click="manageLoop(position)">Manage in Loop</button></div>
    </div>
    <p v-if="LOOP_ENABLED" class="loop-unavailable">Atomic full close remains unavailable until the swap route and local fork checks pass.</p>
  </section>

  <div v-if="on" class="n-banner fp-banner">
    <span v-if="points">Farm Points: <b>#{{ points.rank }}</b> with <b>{{ amt(points.points, 2) }}</b> points.</span>
    <span v-else>Deposit in {{ VAULTS[0]?.name ?? 'an Earn vault' }} to start earning Farm Points. Points accrue as supplied balance × time, snapshotted every hour.</span>
    <button class="n-btn-sm ghost" @click="pointsOpen = true; event('Farm Points opened', { from: 'portfolio' })">View leaderboard</button>
  </div>

  <div v-for="c in claimable" :key="c.m.id" class="n-banner reward-banner">
    <span>Unclaimed rewards from {{ c.m.name }}: <b>{{ c.items.map(([name, a]) => `${amt(a, 4)} ${name}`).join(' + ') }}</b></span>
    <button class="n-btn-sm" :disabled="claimTx.status === 'running'" @click="claim(c.m)">Claim</button>
  </div>
  <TxProgress :tx="claimTx" @dismiss="resetClaim" />
  <div v-if="directLending.length && VAULTS[0]" class="n-banner">
    You have {{ directLending.map((d) => `${amtDust(d.units)} ${d.t.name}`).join(' + ') }} lent directly to a market. Lending now goes through
    <RouterLink :to="{ name: 'vault', params: { id: VAULTS[0].id } }" class="link">{{ VAULTS[0].name }}</RouterLink>: withdraw below and deposit there to earn the vault's yield.
  </div>
  <div v-if="state.swapVisible && loans.length" class="n-banner swap-portfolio-cta">
    Want USDY after borrowing USDC? <RouterLink :to="{ name: 'swap', query: { input: 'svm-usdc', output: 'svm-usdy' } }" class="link">Swap USDC to USDY</RouterLink>.
    Locked collateral is never used for a swap.
  </div>

  <div class="n-seg toggle">
    <button :class="{ on: view === 'deposits' }" @click="view = 'deposits'">Active Deposits</button>
    <button :class="{ on: view === 'loans' }" @click="view = 'loans'">Active Loans</button>
  </div>

  <div v-if="view === 'deposits'" class="n-table">
    <div class="n-thead dp-grid"><div>Vault / Market</div><div>Asset Supplied</div><div>$ Value</div><div /></div>
    <div v-if="!on" class="n-empty">Connect a wallet to see your deposits.</div>
    <div v-else-if="!deposits.length && !vaultDeposits.length" class="n-empty">No active deposits.</div>
    <template v-else><div v-for="d in vaultDeposits" :key="d.v.id" class="n-tr dp-grid">
      <div class="n-cell" data-label="Market"><span class="mk">{{ d.live?.name ?? d.v.name }}</span> <span class="n-chip">Vault</span></div>
      <div class="n-cell n-asset" data-label="Asset Supplied"><TokenIcon :token="d.t" size="sm" /><span class="n-num">{{ amtDust(d.value) }} {{ d.t.name }}</span></div>
      <div class="n-cell n-muted n-num" data-label="$ Value">{{ usd(d.usd) }}</div>
      <div class="n-cell n-actions">
        <button class="n-btn-sm" @click="goVault(d.v, 'deposit')">Deposit</button>
        <button class="n-btn-sm ghost" @click="goVault(d.v, 'withdraw')">Withdraw</button>
      </div>
    </div><div v-for="d in deposits" :key="d.m.id + d.t.token_id" class="n-tr dp-grid">
      <div class="n-cell" data-label="Market"><span class="mk">{{ d.m.name }}</span> <span class="n-chip mainnet">Solana</span></div>
      <div class="n-cell n-asset" data-label="Asset Supplied"><TokenIcon :token="d.t" size="sm" /><span class="n-num">{{ amtDust(d.units) }} {{ d.t.name }}</span></div>
      <div class="n-cell n-muted n-num" data-label="$ Value">{{ usd(d.usd) }}</div>
      <div class="n-cell n-actions">
        <button class="n-btn-sm ghost" @click="go(d.m, 'withdraw', undefined, d.t.token_id)">Withdraw</button>
      </div>
    </div></template>
  </div>

  <div v-else class="n-table">
    <div class="n-thead pl-grid"><div>Loan</div><div>Loan $ Value</div><div>Collateral</div><div>Collateral $ Value</div><div>HF</div><div /></div>
    <div v-if="!on" class="n-empty">Connect a wallet to see your loans.</div>
    <div v-else-if="!loans.length" class="n-empty">No active loans.</div>
    <template v-else><div v-for="l in loans" :key="l.m.id + l.t.token_id" class="n-tr pl-grid">
      <div class="n-cell n-asset" data-label="Loan"><TokenIcon :token="l.t" size="sm" /><span class="n-num">{{ amtDust(l.units) }} {{ l.t.name }}</span></div>
      <div class="n-cell n-muted n-num" data-label="Loan $ Value">{{ usd(l.usd) }}</div>
      <div class="n-cell" data-label="Collateral"><div class="n-tok-group"><TokenIcon v-for="c in l.coll" :key="c.t.token_id" :token="c.t" size="sm" /></div></div>
      <div class="n-cell n-muted n-num" data-label="Collateral $ Value">{{ usd(l.collUsd) }}</div>
      <div class="n-cell n-num" data-label="HF" :style="{ color: hfColor(l.hf), fontWeight: 600 }">{{ hfText(l.hf) }}</div>
      <div class="n-cell n-actions">
        <button class="n-btn-sm" @click="go(l.m, undefined, 'repay', l.t.token_id)">Repay</button>
        <button class="n-btn-sm ghost" @click="go(l.m, undefined, 'borrow', l.t.token_id)">Add collateral</button>
      </div>
    </div></template>
  </div>
  <FarmPointsModal v-if="pointsOpen" @close="pointsOpen = false" />
</template>

<style scoped>
.mk { font-weight: 600; }
.fp-banner { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.fp-banner b { color: #fff; font-weight: 600; }
.reward-banner { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-left-color: var(--n-green); }
.reward-banner b { color: #fff; font-weight: 600; }
.link { color: var(--n-pink); }
.swap-portfolio-cta { line-height: 1.6; }
.loop-position-panel { margin: 22px 0; }
.loop-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 12px; }
.loop-heading h2 { margin: 0 0 6px; font-size: 17px; }
.loop-heading p { margin: 0; }
.loop-position-row { display: grid; grid-template-columns: 1.2fr 1fr 1fr .7fr auto; gap: 16px; align-items: center; padding: 14px 0; border-top: 1px solid var(--n-border); }
.loop-market { font-weight: 600; }
.loop-label { margin-bottom: 5px; color: var(--n-text-3); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.loop-unavailable { margin: 8px 0 0; color: var(--n-text-3); font-size: 12px; }
@media (max-width: 760px) { .loop-position-row { grid-template-columns: 1fr 1fr; } .loop-position-row > :first-child { grid-column: 1 / -1; } }
</style>
