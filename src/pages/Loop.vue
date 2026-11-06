<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { sendLoopAction, sendLoopSetup, state } from '../store.js'
import { TOKENS } from '../config.js'
import { amt, pct, usd } from '../logic.js'
import { formatBaseUnits } from '../swap-fees.js'
import { loopPreviewRequestMatches } from '../loop-preview-request.js'
import { selectedLoopCloseReadiness } from '../loop-positions.js'
import TokenIcon from '../components/TokenIcon.vue'

const fundingAmount = ref('100')
const leverage = ref(1.5)
const strategy = ref(null)
const preview = ref(null)
const loading = ref(false)
const acting = ref(false)
const carryAcknowledged = ref(false)
const error = ref(null)
const setupRequired = ref(false)
const setupLoading = ref(false)
const setupError = ref(null)
const previewBinding = ref(null)
let previewRequestSequence = 0
let setupStatusSequence = 0
const route = useRoute()
const router = useRouter()
const usdc = TOKENS['svm-usdc']
const usdy = TOKENS['svm-usdy']
const strategies = computed(() => strategy.value?.strategies ?? [])
const executionMode = computed(() => preview.value?.executionMode ?? strategy.value?.executionMode ?? null)
const localForkMode = computed(() => executionMode.value === 'surfpool-local')
const networkLabel = computed(() => localForkMode.value ? 'Surfpool local'
  : executionMode.value === 'production-gated' ? 'Solana mainnet' : 'Checking network')
const fees = computed(() => preview.value?.fees ?? [])
const positions = computed(() => state.loopPositions ?? [])
const selectedPosition = computed(() => positions.value.find((position) => position.id === route.query.position) ?? null)
const currentPreviewRequest = () => ({
  fundingAmount: fundingAmount.value,
  leverage: Number(leverage.value),
  wallet: state.address ?? null,
})
const previewIsCurrent = computed(() => !!preview.value && !!previewBinding.value
  && loopPreviewRequestMatches({ request: previewBinding.value, current: currentPreviewRequest(),
    requestId: previewBinding.value.requestId, currentRequestId: previewRequestSequence }))
const openReadiness = computed(() => {
  const readiness = preview.value?.actionReadiness ?? strategy.value?.actions?.open ?? null
  const unavailableReasons = (readiness?.unavailableReasons ?? []).filter((reason) => !(carryAcknowledged.value
    && ['carry-acknowledgement-required', 'preview-acknowledgement-invalid'].includes(reason.code)))
  const carryIsAcknowledged = !preview.value?.carry?.requiresAcknowledgement || carryAcknowledged.value
  return { ...readiness, unavailableReasons, executionEnabled: previewIsCurrent.value && !!preview.value?.available && carryIsAcknowledged && unavailableReasons.length === 0 }
})
const closeReadiness = computed(() => selectedLoopCloseReadiness(
  strategy.value?.actions?.fullClose ?? null, selectedPosition.value, state.address, state.loopPositionReadStatus,
))
const entryBlockers = computed(() => {
  const reasons = preview.value
    ? [...(preview.value.unavailableReasons ?? []), ...(openReadiness.value?.unavailableReasons ?? [])]
    : [...(strategies.value[0]?.unavailableReasons ?? []), ...(strategy.value?.actions?.open?.unavailableReasons ?? [])]
  const acknowledgementReasons = ['carry-acknowledgement-required', 'preview-acknowledgement-invalid']
  const visibleReasons = preview.value ? reasons : reasons.filter((reason) => !acknowledgementReasons.includes(reason.code))
  const filtered = visibleReasons.filter((reason) => !(carryAcknowledged.value && acknowledgementReasons.includes(reason.code)))
  return [...new Map(filtered.map((reason) => [reason.message, reason])).values()]
})

function invalidatePreview() {
  previewRequestSequence++
  preview.value = null
  previewBinding.value = null
  carryAcknowledged.value = false
  loading.value = false
  error.value = null
}
watch([fundingAmount, leverage], invalidatePreview)
watch(() => state.address, () => {
  invalidatePreview()
  if (state.address) loadSetupStatus()
  else { setupStatusSequence++; setupRequired.value = false; setupLoading.value = false; setupError.value = null }
})

function selectPosition(position) {
  router.replace({ query: { ...route.query, position: position.id } })
}

async function loadStrategies() {
  try {
    const response = await fetch('/api/loop-strategies')
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'Could not load loop strategies.')
    strategy.value = body
  } catch (cause) {
    error.value = cause.message
  }
}

async function loadSetupStatus() {
  const wallet = state.address
  const requestId = ++setupStatusSequence
  if (!wallet) { setupRequired.value = false; setupLoading.value = false; return }
  setupLoading.value = true
  setupError.value = null
  try {
    const response = await fetch(`/api/loop-setup-status?wallet=${encodeURIComponent(wallet)}`)
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'Could not check Kamino setup.')
    if (state.address === wallet && requestId === setupStatusSequence) setupRequired.value = body.required === true
  } catch (cause) {
    if (state.address === wallet && requestId === setupStatusSequence) setupError.value = cause.message
  } finally { if (requestId === setupStatusSequence) setupLoading.value = false }
}

async function initializeKaminoMetadata() {
  if (!state.address || !setupRequired.value || acting.value) return
  const wallet = state.address
  acting.value = true
  setupError.value = null
  try {
    await sendLoopSetup({ market: 'sol-usdy-usdc' })
    if (state.address === wallet) {
      setupRequired.value = false
      preview.value = null
      previewBinding.value = null
      carryAcknowledged.value = false
      await loadSetupStatus()
    }
  } catch (cause) { if (state.address === wallet) setupError.value = cause.message }
  finally { acting.value = false }
}

async function runPreview() {
  const request = currentPreviewRequest()
  const requestId = ++previewRequestSequence
  const binding = { ...request, requestId }
  loading.value = true
  carryAcknowledged.value = false
  error.value = null
  preview.value = null
  try {
    const response = await fetch('/api/loop-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketId: 'sol-usdy-usdc', fundingAmount: request.fundingAmount, leverage: request.leverage, wallet: request.wallet }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'Could not build the preview.')
    if (!loopPreviewRequestMatches({ request, current: currentPreviewRequest(), requestId, currentRequestId: previewRequestSequence })) return
    preview.value = body
    previewBinding.value = binding
  } catch (cause) {
    if (loopPreviewRequestMatches({ request, current: currentPreviewRequest(), requestId, currentRequestId: previewRequestSequence })) error.value = cause.message
  } finally {
    if (requestId === previewRequestSequence) loading.value = false
  }
}

async function openLoop() {
  const actionPreview = preview.value
  const request = currentPreviewRequest()
  if (!openReadiness.value?.executionEnabled || !previewIsCurrent.value || !actionPreview?.previewId) return
  acting.value = true
  error.value = null
  try {
    await sendLoopAction('loop-open', {
      market: 'sol-usdy-usdc', amount: request.fundingAmount, leverage: request.leverage,
      previewId: actionPreview.previewId,
      acknowledgementKey: actionPreview.carry?.requiresAcknowledgement ? actionPreview.carry.acknowledgementKey : undefined,
    })
  } catch (cause) { error.value = cause.message }
  finally { acting.value = false }
}

async function closeLoop() {
  if (!closeReadiness.value?.executionEnabled || !selectedPosition.value) return
  acting.value = true
  error.value = null
  try { await sendLoopAction('loop-close', { market: 'sol-usdy-usdc', positionId: selectedPosition.value.id }) }
  catch (cause) { error.value = cause.message }
  finally { acting.value = false }
}

const feeLabel = (fee) => `${formatBaseUnits(BigInt(fee.amountBaseUnits), fee.mint === usdc.mint ? usdc.decimals : usdy.decimals)} ${fee.mint === usdc.mint ? usdc.name : usdy.name}`
const tokenAmountLabel = (value, token) => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return 'Unavailable'
  const amount = Number(value)
  return Number.isFinite(amount) ? `${amt(amount, token.decimals)} ${token.name}` : 'Unavailable'
}
onMounted(() => { loadStrategies(); loadSetupStatus() })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Loop</h1>
    <p class="n-sub">Borrow USDC against USDY collateral, then review the full position before opening.</p>
  </div>

  <div class="n-table strategy-table">
    <div class="n-thead strategy-grid"><div>Strategy</div><div>Network</div><div>Collateral</div><div>Borrow</div><div>Max leverage</div></div>
    <div class="n-tr strategy-grid">
      <div class="n-cell strategy-name" data-label="Strategy"><b>{{ strategies[0]?.marketName ?? 'USDY Ondo Market' }}</b></div>
      <div class="n-cell" data-label="Network"><span class="n-chip" :class="localForkMode ? 'warn' : executionMode === 'production-gated' ? 'mainnet' : ''">{{ networkLabel }}</span></div>
      <div class="n-cell n-asset" data-label="Collateral"><TokenIcon :token="usdy" size="sm" />{{ usdy.name }}</div>
      <div class="n-cell n-asset" data-label="Borrow"><TokenIcon :token="usdc" size="sm" />{{ usdc.name }}</div>
      <div class="n-cell n-num" data-label="Max leverage">1.5×</div>
    </div>
  </div>

  <section class="n-panel entry-panel">
    <div class="panel-heading">
      <div><h2>Open loop</h2><p class="n-muted">Choose funding and leverage, then review the estimate before signing.</p></div>
      <span class="n-chip" :class="preview?.available ? (openReadiness.executionEnabled && !setupRequired && !setupLoading ? 'ready' : 'warn') : ''">{{ preview?.available ? (openReadiness.executionEnabled && !setupRequired && !setupLoading ? 'Ready' : 'Review required') : 'Preview required' }}</span>
    </div>

    <div class="form-grid">
      <label class="field">
        <span>Funding amount</span>
        <div class="input-with-unit"><input v-model="fundingAmount" inputmode="decimal" autocomplete="off" aria-label="Funding amount in USDC" /><span>USDC</span></div>
      </label>
      <label class="field">
        <span>Target leverage</span>
        <div class="input-with-unit"><input v-model.number="leverage" type="number" min="1.01" max="1.5" step="0.05" aria-label="Target leverage" /><span>×</span></div>
      </label>
      <button class="n-btn-grad preview-button" :disabled="loading" @click="runPreview">{{ loading ? 'Loading preview…' : 'Preview loop' }}</button>
    </div>
    <p class="helper">Leverage is capped at 1.5×. Preview uses current route quotes and market rates; final transaction values may change.</p>

    <p v-if="error" class="n-banner warn entry-error" role="status">{{ error }}</p>

    <section v-if="preview?.exposure" class="review-section" aria-labelledby="loop-review-title">
      <div class="review-heading"><h3 id="loop-review-title">Review estimate</h3><span v-if="preview.carry?.estimatedCarryPct != null" class="n-chip" :class="Number(preview.carry.estimatedCarryPct) > 0 ? 'ok' : 'warn'">{{ Number(preview.carry.estimatedCarryPct) > 0 ? '+' : '' }}{{ preview.carry.estimatedCarryPct }}% carry</span></div>
      <div class="n-stats stat-4 review-stats">
        <div class="n-stat"><div class="k">Estimated USDY supplied</div><div class="v">{{ preview.exposure.source === 'kamino-sdk-net-route' ? tokenAmountLabel(preview.exposure.collateralAmount, usdy) : 'Unavailable' }}</div></div>
        <div class="n-stat"><div class="k">USDC borrow principal</div><div class="v">{{ preview.exposure.source === 'kamino-sdk-net-route' ? tokenAmountLabel(preview.exposure.borrowAmount, usdc) : 'Unavailable' }}</div></div>
        <div class="n-stat"><div class="k">Total estimated USDC debt</div><div class="v">{{ preview.exposure.source === 'kamino-sdk-net-route' ? tokenAmountLabel(preview.exposure.debtAmount, usdc) : 'Unavailable' }}</div><div class="s">Includes borrow origination fee</div></div>
        <div class="n-stat"><div class="k">Projected LTV</div><div class="v">{{ pct(Number(preview.risk?.projectedLtvPct)) }} <span class="stat-limit">/ {{ pct(Number(preview.limits?.projectedLtvPct)) }} limit</span></div></div>
      </div>
      <p class="valuation-note">USD valuations: equity {{ usd(Number(preview.exposure.equity)) }} · collateral {{ usd(Number(preview.exposure.grossCollateral)) }} · debt {{ usd(Number(preview.exposure.debt)) }}. {{ preview.exposure.source === 'kamino-sdk-net-route' ? 'Token amounts are SDK-derived estimates.' : 'Token quantities are unavailable until a live route quote is verified.' }}</p>

      <div class="economics-row">
        <div class="economics-item"><span>Estimated leverage</span><b>{{ preview.exposure.leverage ?? preview.carry?.basedOnLeverage ?? leverage }}×</b></div>
        <div class="economics-item"><span>Estimated Nysa swap fees</span><b>{{ preview.feeTotalUsd != null ? usd(preview.feeTotalUsd) : 'Unavailable' }}</b></div>
        <div v-if="preview.knownCostsTotalUsd != null" class="economics-item"><span>Known costs incl. borrow and flash fees</span><b>{{ usd(preview.knownCostsTotalUsd) }}</b></div>
      </div>

      <div v-if="preview?.carry?.requiresAcknowledgement" class="carry-ack-block">
        <p class="carry-ack">Estimated carry is non-positive. Acknowledgement is required before opening.</p>
        <label class="carry-ack-checkbox"><input v-model="carryAcknowledged" type="checkbox" /><span>I understand the current estimated carry is non-positive and may change.</span></label>
      </div>

      <details class="review-details">
        <summary>Risk, rates and fee breakdown</summary>
        <div class="details-content">
          <p class="preview-basis">{{ preview.exposure.source === 'kamino-sdk-net-route' ? 'Amounts use Kamino SDK position calculations and fee-adjusted swap quote outputs.' : 'Amounts are target-only estimates pending live fee-adjusted route quotes.' }}</p>
          <p v-if="preview.risk?.healthFactor != null" class="detail-line">Health factor <b>{{ Number(preview.risk.healthFactor).toFixed(2) }}</b><span>Liquidation threshold {{ preview.risk.liquidationLtvPct }}% · liquidation price {{ usd(Number(preview.risk.liquidationPriceUsd)) }} per USDY</span></p>
          <p v-if="preview.carry?.assumptions" class="detail-line">Carry assumptions <b>{{ usdy.name }} supply {{ preview.carry.assumptions.collateralSupplyAprPct }}% − {{ usdc.name }} borrow {{ preview.carry.assumptions.liabilityBorrowAprPct }}%</b><span>Live reserve rates as of {{ preview.carry.asOf ?? 'unknown' }}</span></p>
          <div v-if="fees.length" class="fee-list">
            <div v-for="fee in fees" :key="fee.action" class="fee-row"><span>{{ fee.action === 'initial-acquisition' ? 'Initial USDC to USDY swap' : 'Leverage swap' }}</span><b>{{ feeLabel(fee) }}</b></div>
          </div>
          <p class="footnote">10 bps is charged once per economic swap. DEX route hops do not add Nysa fees.</p>
        </div>
      </details>
    </section>

    <section v-if="state.address && setupRequired" class="setup-inline">
      <div><h3>One-time Kamino setup</h3><p class="n-muted">Creates Kamino user metadata in a separate transaction. No deposit, borrow or Nysa swap fee; Kamino may charge network rent.</p></div>
      <p v-if="setupError" class="setup-error" role="status">{{ setupError }}</p>
      <button class="n-btn-sm ghost" :disabled="acting || setupLoading" @click="initializeKaminoMetadata">{{ acting ? 'Initializing…' : 'Initialize metadata' }}</button>
    </section>
    <p v-else-if="setupError" class="setup-error" role="status">{{ setupError }}</p>

    <div class="entry-action">
      <div class="entry-status">
        <span v-if="!state.address" class="n-muted">Connect a wallet to open a loop.</span>
        <span v-else-if="setupLoading" class="n-muted">Checking Kamino setup…</span>
        <span v-else-if="setupRequired" class="n-muted">Complete one-time Kamino setup to continue.</span>
        <span v-else-if="!preview" class="n-muted">Preview this loop to check availability and costs.</span>
        <span v-else-if="!entryBlockers.length" class="n-muted">{{ localForkMode ? 'Ready to build and simulate on local Surfpool.' : 'No current eligibility blockers.' }}</span>
        <ul v-if="entryBlockers.length" class="reason-list">
          <li v-for="reason in entryBlockers" :key="reason.code + reason.message">{{ reason.message }}</li>
        </ul>
      </div>
      <button class="n-btn-grad action-button" :disabled="acting || !openReadiness?.executionEnabled || setupRequired || setupLoading" :title="(openReadiness?.unavailableReasons ?? []).map((reason) => reason.message).join(' ')" @click="openLoop">{{ acting ? 'Preparing…' : 'Open loop' }}</button>
    </div>
  </section>

  <section v-if="positions.length" class="n-panel position-panel">
    <div class="panel-heading"><div><h2>Your positions</h2><p class="n-muted">Select a position to review its full-close readiness.</p></div><span class="n-chip">{{ positions.length }}</span></div>
    <div class="n-table">
      <div class="n-thead position-grid"><div>Position</div><div>Collateral</div><div>Debt</div><div>Health factor</div><div></div></div>
      <div v-for="position in positions" :key="position.id" class="n-tr position-grid" :class="{ selected: selectedPosition?.id === position.id }">
        <div class="n-cell" data-label="Position"><b>{{ position.market.name }}</b><span class="position-address">{{ position.obligation.address.slice(0, 8) }}…{{ position.obligation.address.slice(-4) }}</span></div>
        <div class="n-cell n-num" data-label="Collateral">{{ position.collateral.amount }} USDY</div>
        <div class="n-cell n-num" data-label="Debt">{{ position.liability.amount }} USDC</div>
        <div class="n-cell n-num" data-label="Health factor">{{ position.healthFactor == null ? '—' : position.healthFactor.toFixed(2) }}</div>
        <div class="position-select"><button class="n-btn-sm ghost" :aria-pressed="selectedPosition?.id === position.id" @click="selectPosition(position)">{{ selectedPosition?.id === position.id ? 'Selected' : 'Select' }}</button></div>
      </div>
    </div>
    <div class="position-actions">
      <button class="n-btn-grad" :disabled="acting || !closeReadiness?.executionEnabled || !selectedPosition" :title="(closeReadiness?.unavailableReasons ?? []).map((reason) => reason.message).join(' ')" @click="closeLoop">{{ acting ? 'Preparing…' : 'Close full position' }}</button>
      <p v-if="closeReadiness?.unavailableReasons?.length" class="n-muted">{{ closeReadiness.unavailableReasons.map((reason) => reason.message).join(' ') }}</p>
    </div>
  </section>

  <div class="n-banner mode-banner">{{ localForkMode ? 'Local Surfpool only: transactions use the loopback validator and have no Mainnet effect.' : 'Execution availability depends on route security, fee configuration, and wallet readiness.' }}</div>
</template>

<style scoped>
.strategy-table { margin-bottom: 20px; }
.strategy-grid { grid-template-columns: 1.6fr .8fr 1fr 1fr .7fr; }
.strategy-name { font-weight: 600; }
.entry-panel { margin-bottom: 22px; }
.entry-panel .panel-heading { align-items: flex-start; }
.entry-panel .panel-heading h2 { margin: 0 0 6px; font-size: 18px; }
.entry-panel .panel-heading p { margin: 0; font-size: 13px; }
.setup-error { color: var(--n-red); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr auto; gap: 16px; align-items: end; }
.field { display: grid; gap: 8px; color: var(--n-text-2); font-size: 13px; }
.input-with-unit { display: flex; align-items: center; border: 1px solid var(--n-line-2); border-radius: 12px; background: var(--n-bg-2); padding: 0 13px; }
.input-with-unit:focus-within { border-color: var(--n-pink); box-shadow: 0 0 0 2px #ec008c33; }
.input-with-unit input { min-width: 0; width: 100%; padding: 13px 0; border: 0; outline: 0; color: var(--n-text); background: transparent; font: inherit; font-size: 16px; }
.input-with-unit span { color: var(--n-text-3); font-size: 12px; }
.preview-button { min-height: 46px; white-space: nowrap; }
.review-section { margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--n-line); }
.review-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
.review-heading h3,.setup-inline h3 { margin: 0; font-size: 15px; }
.review-stats { margin: 0; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.review-stats .n-stat { padding: 17px 18px; }
.review-stats .n-stat .k { margin-bottom: 6px; font-size: 10px; }
.review-stats .n-stat .v { font-size: 20px; overflow-wrap: anywhere; }
.stat-limit { color: var(--n-text-3); font-size: 12px; font-weight: 400; letter-spacing: 0; }
.economics-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 14px; }
.economics-item { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid var(--n-line); border-radius: 6px; color: var(--n-text-3); font-size: 12px; }
.economics-item b { color: var(--n-text); text-align: right; font-variant-numeric: tabular-nums; }
.carry-ack-block { margin-top: 14px; padding: 13px 14px; border: 1px solid #e8b33966; border-radius: 6px; background: #e8b3390c; }
.carry-ack { margin: 0; color: var(--n-amber); font-size: 12px; }
.carry-ack-checkbox { display: flex; align-items: flex-start; gap: 8px; margin-top: 10px; color: var(--n-text-2); font-size: 12px; }
.carry-ack-checkbox input { margin-top: 2px; accent-color: var(--n-pink); }
.review-details { margin-top: 14px; border: 1px solid var(--n-line); border-radius: 6px; }
.review-details summary { padding: 12px 14px; color: var(--n-text-2); font-size: 12px; cursor: pointer; }
.review-details summary:focus-visible { outline: 2px solid var(--n-pink); outline-offset: 2px; }
.details-content { padding: 0 14px 14px; }
.preview-basis { margin: 0 0 12px; color: var(--n-text-3); font-size: 12px; line-height: 1.5; }
.detail-line { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 10px 0; color: var(--n-text-3); font-size: 12px; }
.detail-line b { color: var(--n-text-2); }
.detail-line span { flex-basis: 100%; }
.fee-list { display: grid; gap: 10px; margin-top: 14px; }
.fee-row { display: flex; justify-content: space-between; gap: 12px; color: var(--n-text-2); font-size: 12px; }
.fee-row b { color: var(--n-text); font-variant-numeric: tabular-nums; }
.footnote,.helper { margin: 12px 0 0; color: var(--n-text-3); font-size: 12px; line-height: 1.6; }
.setup-inline { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px 16px; margin-top: 18px; padding: 15px; border: 1px solid var(--n-line); border-radius: 6px; }
.setup-inline p { margin: 5px 0 0; font-size: 12px; line-height: 1.5; }
.setup-inline .setup-error { grid-column: 1 / -1; }
.entry-error { margin: 16px 0 0; }
.entry-action { display: flex; justify-content: space-between; align-items: center; gap: 18px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--n-line); }
.entry-status { min-width: 0; }
.entry-status .n-muted { font-size: 12px; }
.position-panel { margin: 22px 0; }
.position-panel .panel-heading { align-items: flex-start; }
.position-panel h2 { margin: 0 0 6px; font-size: 17px; }
.position-panel .panel-heading p { margin: 0; }
.position-grid { grid-template-columns: 1.3fr .9fr .9fr .8fr auto; }
.position-grid.selected { color: var(--n-text); }
.position-address { display: block; margin-top: 4px; color: var(--n-text-3); font-family: var(--mono); font-size: 11px; }
.position-empty { margin: 0; }
.position-select { display: flex; justify-content: flex-end; }
.position-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--n-line); }
.position-actions p { margin: 0; font-size: 12px; line-height: 1.5; }
.action-button { margin-top: 18px; }
.reason-list { display: grid; gap: 6px; margin: 0; padding-left: 18px; color: var(--n-text-2); font-size: 12px; line-height: 1.5; }
.panel-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.panel-heading h2 { margin: 0; font-size: 17px; }
.n-chip.ready,.n-chip.ok { color: var(--n-green); }
.mode-banner { margin-top: 18px; }
@media (max-width: 860px) {
  .strategy-grid { grid-template-columns: 1fr; }
  .strategy-grid .n-cell { justify-content: flex-start; }
  .position-grid { grid-template-columns: 1fr; }
  .position-select { justify-content: flex-start; }
  .review-stats { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
}
@media (max-width: 600px) {
  .form-grid { grid-template-columns: 1fr; }
  .preview-button { width: 100%; }
  .review-stats { grid-template-columns: 1fr !important; }
  .entry-action { align-items: stretch; flex-direction: column; }
  .entry-action > .n-btn-grad { width: 100%; }
  .setup-inline { grid-template-columns: 1fr; }
  .setup-inline > button { width: 100%; }
}
</style>
