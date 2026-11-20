<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { sendLoopAction, sendLoopSetup, state, priceOf } from '../store.js'
import { LOOP_ENABLED, TOKENS } from '../config.js'
import { amt, pct, usdFull, num, floorTo, hfText, cleanAmount } from '../logic.js'
import { formatBaseUnits } from '../swap-fees.js'
import { loopPreviewRequestMatches } from '../loop-preview-request.js'
import { selectedLoopCloseReadiness } from '../loop-positions.js'
import TokenIcon from '../components/TokenIcon.vue'
import NotFound from './NotFound.vue'

const fundingAmount = ref('')
watch(fundingAmount, (v) => { fundingAmount.value = cleanAmount(v, TOKENS['svm-usdy'].decimals) })
const leverage = ref(1.49)
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
const usdc = TOKENS['svm-usdc']
const usdy = TOKENS['svm-usdy']
const strategies = computed(() => strategy.value?.strategies ?? [])
const executionMode = computed(() => preview.value?.executionMode ?? strategy.value?.executionMode ?? null)
const localForkMode = computed(() => executionMode.value === 'surfpool-local')
const networkLabel = computed(() => localForkMode.value ? 'Surfpool local'
  : executionMode.value === 'production-gated' ? 'Solana mainnet' : 'Checking network')
const fees = computed(() => preview.value?.fees ?? [])
const positions = computed(() => state.loopPositions ?? [])
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

// The build reuses the preview's swap quote, which must be seconds old: the preview is refreshed on click (keeping an
// acknowledgement still needed), then the transaction is built at once.
async function openLoop() {
  if (!openReadiness.value?.executionEnabled || !previewIsCurrent.value) return
  const acknowledged = carryAcknowledged.value
  await runPreview()
  if (acknowledged && preview.value?.carry?.requiresAcknowledgement) carryAcknowledged.value = true
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

async function closeLoop(position) {
  if (!positionView(position).readiness?.executionEnabled) return
  acting.value = true
  error.value = null
  try { await sendLoopAction('loop-close', { market: 'sol-usdy-usdc', positionId: position.id }) }
  catch (cause) { error.value = cause.message }
  finally { acting.value = false }
}

const feeLabel = (fee) => `${formatBaseUnits(BigInt(fee.amountBaseUnits), fee.mint === usdc.mint ? usdc.decimals : usdy.decimals)} ${fee.mint === usdc.mint ? usdc.name : usdy.name}`
const lev = (value) => `${Number(value).toFixed(2).replace(/0$/, '')}×`

// Estimates for the chosen leverage, before any quote: the summary moves with the slider; a preview replaces the token
// amounts with the quoted ones.
const rates = computed(() => {
  const a = strategies.value[0]?.carry?.assumptions ?? {}
  const supply = Number(a.collateralSupplyAprPct ?? 0), native = a.collateralNativeApyPct, borrow = a.liabilityBorrowAprPct
  return { hold: supply + Number(native ?? 0), native: native ?? null, nativeSource: a.collateralNativeApySource, borrow: borrow ?? null }
})
const liqLtv = computed(() => state.reserves['sol-usdy-usdc']?.['svm-usdy']?.liqLtv ?? 95)
const usdyPrice = computed(() => priceOf('svm-usdy'))
const amount = computed(() => num(fundingAmount.value))
const est = computed(() => {
  const L = Number(leverage.value), ltv = (L - 1) / L
  const quoted = previewIsCurrent.value && preview.value?.exposure?.source === 'kamino-sdk-net-route' ? preview.value.exposure : null
  return {
    collateral: quoted ? Number(quoted.collateralAmount) : amount.value * L,
    debt: quoted ? Number(quoted.debtAmount) : (amount.value * usdyPrice.value * (L - 1)) / priceOf('svm-usdc'),
    ltv: ltv * 100,
    hf: (liqLtv.value / 100) / ltv,
    liqPrice: (usdyPrice.value * ltv) / (liqLtv.value / 100),
    netApy: rates.value.borrow == null ? null : rates.value.hold * L - rates.value.borrow * (L - 1),
  }
})
const health = (hf) => (hf >= 1.8 ? ['ok', 'Safe'] : hf >= 1.3 ? ['warn', 'Medium'] : ['bad', 'Risky'])
const setPct = (p) => { fundingAmount.value = String(floorTo(((state.balances['svm-usdy'] ?? 0) * p) / 100, usdy.decimals)) }

const quoted = computed(() => previewIsCurrent.value && !!preview.value)
// The preview needs only an amount; opening also needs the Kamino setup and no blocker.
const status = computed(() => {
  if (!state.address) return 'Connect a wallet to open a loop.'
  if (!(amount.value > 0)) return 'Enter an amount.'
  if (amount.value > (state.balances['svm-usdy'] ?? 0)) return `You only hold ${amt(state.balances['svm-usdy'] ?? 0)} USDY.`
  if (strategy.value?.maxFunding && amount.value > strategy.value.maxFunding) return `Loops are capped at ${strategy.value.maxFunding} USDY during the beta.`
  if (!quoted.value) return null
  if (setupLoading.value) return 'Checking Kamino setup…'
  if (setupRequired.value) return 'Complete the one-time Kamino setup to open it.'
  if (entryBlockers.value.length) return localForkMode.value ? 'This loop can\'t be opened on the local fork right now.' : 'Loops aren\'t open on Nysa yet.'
  return null
})
const canAct = computed(() => !acting.value && !loading.value && !status.value && (!quoted.value || openReadiness.value?.executionEnabled))
const act = () => (quoted.value ? openLoop() : runPreview())

const positionView = (position) => {
  const coll = Number(position.collateral.amount), debt = Number(position.liability.amount)
  const collUsd = coll * usdyPrice.value, debtUsd = debt * priceOf('svm-usdc'), net = collUsd - debtUsd
  return {
    net, coll,
    leverage: net > 0 ? collUsd / net : null,
    netApy: net > 0 && rates.value.borrow != null ? (rates.value.hold * collUsd - rates.value.borrow * debtUsd) / net : null,
    liqPrice: coll > 0 ? debtUsd / (coll * (liqLtv.value / 100)) : null,
    hf: Number(position.healthFactor),
    ltv: collUsd > 0 ? (debtUsd / collUsd) * 100 : 0,
    readiness: selectedLoopCloseReadiness(strategy.value?.actions?.fullClose ?? null, position, state.address, state.loopPositionReadStatus),
  }
}
onMounted(() => { loadStrategies(); loadSetupStatus() })
</script>

<template>
  <NotFound v-if="!LOOP_ENABLED && !state.loopVisible" />
  <template v-else>
  <div class="n-page-head">
    <h1 class="n-h1">Loop</h1>
    <p class="n-sub">Multiply your USDY yield by borrowing USDC against it, in one transaction.</p>
  </div>

  <div class="loop-grid">
    <section class="n-panel">
      <div class="panel-h">
        <h2>Open loop</h2>
        <span class="pair"><TokenIcon :token="usdy" size="sm" />USDY / <TokenIcon :token="usdc" size="sm" />USDC <span class="n-chip" :class="localForkMode ? 'warn' : executionMode === 'production-gated' ? 'mainnet' : ''">{{ networkLabel }}</span></span>
      </div>

      <div class="n-label row"><span>Amount</span><span class="hint">In wallet: {{ state.address ? `${amt(state.balances['svm-usdy'] ?? 0)} USDY` : '—' }}</span></div>
      <div class="input-unit">
        <input v-model="fundingAmount" class="n-input" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="USDY amount" />
        <span class="unit"><TokenIcon :token="usdy" size="sm" />USDY</span>
      </div>
      <div class="n-quick">
        <button v-for="p in [25, 50, 75]" :key="p" :disabled="!state.address" @click="setPct(p)">{{ p }}%</button>
        <button :disabled="!state.address" @click="setPct(100)">MAX</button>
      </div>

      <div class="lev">
        <div class="n-label row"><span>Leverage</span><b>{{ lev(leverage) }}</b></div>
        <!-- 1.49: with Kamino's borrow fee a 1.5x target lands just above 1.5x, which the risk check refuses -->
        <input v-model.number="leverage" class="slider" type="range" min="1.1" max="1.49" step="0.01" aria-label="Leverage" />
        <div class="ticks"><span>1.1×</span><span>1.3×</span><span>1.49× max</span></div>
      </div>

      <div class="ba" aria-label="Position after the loop">
        <div class="ba-row"><span class="k">Collateral</span><span class="from">0 USDY</span><span class="to">{{ amt(est.collateral, 2) }} USDY</span></div>
        <div class="ba-row"><span class="k">Debt</span><span class="from">0 USDC</span><span class="to">{{ amt(est.debt, 2) }} USDC</span></div>
        <div class="ba-row"><span class="k">LTV</span><span class="from">0%</span><span class="to">{{ pct(est.ltv, 1) }}</span></div>
        <div class="ba-row"><span class="k">Leverage</span><span class="from">1.00×</span><span class="to">{{ lev(leverage) }}</span></div>
      </div>

      <section v-if="state.address && setupRequired" class="setup">
        <p>One-time Kamino setup: creates your Kamino user account. No deposit, borrow or Nysa fee; Kamino may charge network rent.</p>
        <button class="n-btn-sm ghost" :disabled="acting || setupLoading" @click="initializeKaminoMetadata">{{ acting ? 'Setting up…' : 'Set up' }}</button>
      </section>
      <p v-if="setupError" class="err" role="status">{{ setupError }}</p>

      <label v-if="quoted && preview.carry?.requiresAcknowledgement" class="ack"><input v-model="carryAcknowledged" type="checkbox" /><span>At current rates this loop earns less than it costs. I understand rates can change.</span></label>

      <button class="n-btn-block go" :disabled="!canAct" @click="act">{{ acting ? 'Preparing…' : loading ? 'Checking route…' : quoted ? `Loop ${lev(leverage)}` : `Preview loop ${lev(leverage)}` }}</button>
      <p class="why">{{ status ?? (quoted ? 'One signature: flash loan, swap and deposit in a single transaction.' : 'The preview quotes the swap; nothing is signed.') }}</p>
      <details v-if="quoted && entryBlockers.length" class="more">
        <summary>Why</summary>
        <ul><li v-for="reason in entryBlockers" :key="reason.code + reason.message">{{ reason.message }}</li></ul>
      </details>
      <p v-if="error" class="err" role="status">{{ error }}</p>
    </section>

    <section class="n-panel summary">
      <div class="apy">
        <div class="k">Net APY</div>
        <div class="v" :class="{ neg: est.netApy < 0 }">{{ est.netApy == null ? '—' : pct(est.netApy) }}</div>
        <div v-if="est.netApy != null && rates.native != null" class="vs">vs {{ pct(rates.hold) }} holding USDY · <b :class="{ neg: est.netApy < rates.hold }">{{ est.netApy >= rates.hold ? '+' : '' }}{{ pct(est.netApy - rates.hold) }}</b></div>
        <div v-else-if="rates.native == null" class="vs">USDY's own yield isn't included yet: it needs a week of recorded prices.</div>
      </div>
      <div class="rows">
        <div class="n-kv"><span class="k">USDY yield × {{ Number(leverage).toFixed(2) }}</span><span class="v">{{ pct(rates.hold * leverage) }}</span></div>
        <div class="n-kv"><span class="k">USDC borrow × {{ (leverage - 1).toFixed(2) }}</span><span class="v neg">{{ rates.borrow == null ? '—' : `−${pct(rates.borrow * (leverage - 1))}` }}</span></div>
      </div>
      <div class="rows">
        <div class="n-kv"><span class="k">Liquidation price</span><span class="v">${{ est.liqPrice.toFixed(4) }} <small>USDY −{{ ((1 - est.liqPrice / usdyPrice) * 100).toFixed(0) }}%</small></span></div>
        <div class="n-kv"><span class="k">Health</span><span class="n-chip" :class="health(est.hf)[0]">{{ health(est.hf)[1] }}</span></div>
        <div class="bar" aria-hidden="true"><span class="lim" :style="{ left: `${liqLtv}%` }"></span><span class="mark" :style="{ left: `${est.ltv}%` }"></span></div>
        <div class="bar-l"><span>LTV {{ pct(est.ltv, 1) }}</span><span>liquidation {{ pct(liqLtv, 0) }}</span></div>
      </div>
      <div class="rows last">
        <div class="n-kv"><span class="k">Swap USDC → USDY</span><span class="v">{{ amt(est.debt, 2) }} USDC</span></div>
        <div class="n-kv"><span class="k">Nysa fee (0.1% of swap)</span><span class="v">{{ quoted && preview.feeTotalUsd != null ? usdFull(preview.feeTotalUsd) : `≈ ${usdFull(est.debt * 0.001)}` }}</span></div>
        <div v-if="quoted && preview.knownCostsTotalUsd != null" class="n-kv"><span class="k">Borrow and flash loan fees</span><span class="v">{{ usdFull(Math.max(0, preview.knownCostsTotalUsd - (preview.feeTotalUsd ?? 0))) }}</span></div>
      </div>
      <details class="more">
        <summary>Details</summary>
        <div class="n-kv"><span class="k">Health factor</span><span class="v">{{ hfText(est.hf) }}</span></div>
        <div class="n-kv"><span class="k">Max slippage</span><span class="v">0.5%</span></div>
        <div v-for="fee in quoted ? fees : []" :key="fee.action" class="n-kv"><span class="k">Nysa fee</span><span class="v">{{ feeLabel(fee) }}</span></div>
        <div class="n-kv"><span class="k">USDY yield</span><span class="v">{{ rates.native == null ? '—' : `${pct(rates.native)} (${rates.nativeSource === 'env' ? 'Ondo rate' : '30-day price'})` }}</span></div>
        <div class="n-kv"><span class="k">Rates as of</span><span class="v">{{ strategies[0]?.carry?.asOf ? new Date(strategies[0].carry.asOf).toLocaleString() : '—' }}</span></div>
      </details>
    </section>
  </div>

  <section v-for="position in positions" :key="position.id" class="n-panel position" :class="{ picked: route.query.position === position.id }">
    <div class="panel-h">
      <h2>Your loop</h2>
      <span class="pair"><TokenIcon :token="usdy" size="sm" />USDY / <TokenIcon :token="usdc" size="sm" />USDC <span v-if="Number.isFinite(positionView(position).hf)" class="n-chip" :class="health(positionView(position).hf)[0]">{{ health(positionView(position).hf)[1] }}</span></span>
    </div>
    <div class="n-stats pos-stats">
      <div class="n-stat"><div class="k">Net value</div><div class="v">{{ usdFull(positionView(position).net) }}</div><div class="s">{{ amt(positionView(position).coll, 2) }} USDY collateral</div></div>
      <div class="n-stat"><div class="k">Net APY</div><div class="v accent">{{ pct(positionView(position).netApy) }}</div><div class="s">vs {{ pct(rates.hold) }} holding USDY</div></div>
      <div class="n-stat"><div class="k">Leverage</div><div class="v">{{ positionView(position).leverage ? lev(positionView(position).leverage) : '—' }}</div><div class="s">max 1.49×</div></div>
      <div class="n-stat"><div class="k">Liquidation price</div><div class="v">{{ positionView(position).liqPrice ? `$${positionView(position).liqPrice.toFixed(4)}` : '—' }}</div><div class="s">USDY at ${{ usdyPrice.toFixed(4) }}</div></div>
      <div class="n-stat"><div class="k">Health factor</div><div class="v">{{ hfText(positionView(position).hf) }}</div><div class="s">LTV {{ pct(positionView(position).ltv, 1) }}</div></div>
    </div>
    <div class="close">
      <button class="n-btn-grad" :disabled="acting || !positionView(position).readiness?.executionEnabled" @click="closeLoop(position)">{{ acting ? 'Preparing…' : 'Close loop' }}</button>
      <span class="why">{{ positionView(position).readiness?.executionEnabled ? 'Repays the debt with your collateral and returns the rest, in one transaction.' : 'Closing isn\'t available yet.' }}</span>
    </div>
  </section>

  <div v-if="localForkMode" class="n-banner mode-banner">Local Surfpool only: transactions use the loopback validator and have no Mainnet effect.</div>
  </template>
</template>

<style scoped>
.loop-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr); gap: 20px; align-items: start; }
.panel-h { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.panel-h h2 { font-size: 17px; font-weight: 600; }
.pair { display: flex; align-items: center; gap: 7px; color: var(--n-text-2); font-size: 13px; }
.pair .n-chip { margin-left: 4px; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.row b { color: var(--n-text); font-weight: 600; font-size: 15px; }
.hint { color: var(--n-text-4); }
.input-unit { position: relative; }
.input-unit .n-input { font-size: 20px; font-weight: 500; padding-right: 110px; }
.input-unit .unit { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 7px; color: var(--n-text-2); font-weight: 500; }
.n-quick { margin-top: 8px; }
.lev { margin-top: 22px; }
.slider { width: 100%; accent-color: var(--n-pink); }
.ticks { display: flex; justify-content: space-between; color: var(--n-text-4); font-size: 11.5px; font-family: var(--mono); margin-top: 2px; }
.ba { margin-top: 22px; border: 1px solid var(--n-line); border-radius: 6px; }
.ba-row { display: grid; grid-template-columns: 1fr auto auto; gap: 14px; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--n-hair); font-variant-numeric: tabular-nums; }
.ba-row:last-child { border-bottom: 0; }
.ba-row .k { color: var(--n-text-3); }
.ba-row .from { color: var(--n-text-4); }
.ba-row .from::after { content: " →"; }
.ba-row .to { font-weight: 600; text-align: right; min-width: 96px; }
.setup { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 18px; padding: 14px; border: 1px solid var(--n-line); border-radius: 6px; font-size: 12.5px; color: var(--n-text-3); }
.ack { display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; color: var(--n-amber); font-size: 12.5px; }
.ack input { margin-top: 3px; accent-color: var(--n-pink); }
.go { margin-top: 22px; }
.why { display: block; margin-top: 10px; text-align: center; color: var(--n-text-3); font-size: 12.5px; }
.err { margin-top: 10px; color: var(--n-red); font-size: 12.5px; text-align: center; }
.more { margin-top: 12px; color: var(--n-text-3); font-size: 12.5px; }
.more summary { cursor: pointer; list-style: none; }
.more summary::before { content: "+ "; color: var(--n-pink); }
.more[open] summary::before { content: "− "; }
.more ul { margin: 8px 0 0 18px; display: grid; gap: 4px; }
.more .n-kv { margin-top: 8px; }
.summary .apy { padding-bottom: 18px; border-bottom: 1px solid var(--n-line); }
.apy .k { color: var(--n-text-3); font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
.apy .v { font-size: 44px; font-weight: 600; letter-spacing: -.02em; line-height: 1.15; margin-top: 6px; background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; font-variant-numeric: tabular-nums; }
.apy .v.neg { background: none; color: var(--n-amber); }
.apy .vs { color: var(--n-text-3); font-size: 13px; margin-top: 4px; }
.apy .vs b { color: var(--n-green); font-weight: 600; }
.apy .vs b.neg { color: var(--n-amber); }
.rows { display: grid; gap: 9px; padding: 14px 0; border-bottom: 1px solid var(--n-line); }
.rows.last { border-bottom: 0; padding-bottom: 0; }
.n-kv .v.neg { color: var(--n-text-2); }
.n-kv .v small { color: var(--n-text-4); font-weight: 400; font-size: 12px; margin-left: 6px; }
.n-chip.ok { color: var(--n-green); border-color: #3ddc8459; }
.n-chip.bad { color: var(--n-red); border-color: #ff5d5d66; }
.bar { position: relative; height: 6px; border-radius: 999px; background: linear-gradient(90deg, var(--n-green) 0%, var(--n-green) 45%, var(--n-amber) 70%, var(--n-red) 100%); margin: 6px 0 0; opacity: .85; }
.bar .mark { position: absolute; top: -5px; width: 3px; height: 16px; border-radius: 2px; background: #fff; transform: translateX(-50%); transition: left .2s; }
.bar .lim { position: absolute; top: -3px; width: 1px; height: 12px; background: #fff8; }
.bar-l { display: flex; justify-content: space-between; color: var(--n-text-4); font-size: 11.5px; font-family: var(--mono); }
.position { margin-top: 22px; }
.position.picked { border-color: var(--n-line-2); }
.pos-stats { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.pos-stats .n-stat { padding: 18px 20px; }
.pos-stats .n-stat .v { font-size: 22px; }
.close { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 18px; }
.close .why { margin: 0; text-align: left; }
.close .n-btn-grad:disabled { opacity: .35; cursor: not-allowed; transform: none; box-shadow: none; }
.mode-banner { margin-top: 22px; }
@media (prefers-reduced-motion: reduce) { .bar .mark { transition: none; } }
@media (max-width: 1080px) { .pos-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .pos-stats .n-stat:last-child { grid-column: 1 / -1; } }
@media (max-width: 860px) { .loop-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 480px) { .ba-row { grid-template-columns: 1fr auto; } .ba-row .from { display: none; } .apy .v { font-size: 38px; } .setup { flex-direction: column; align-items: stretch; } }
</style>
