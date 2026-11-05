<script setup>
import { computed, onMounted, ref } from 'vue'
import { state } from '../store.js'
import { TOKENS } from '../config.js'
import { pct, usd } from '../logic.js'
import { formatBaseUnits } from '../swap-fees.js'

const fundingAmount = ref('100')
const leverage = ref(1.5)
const strategy = ref(null)
const preview = ref(null)
const loading = ref(false)
const error = ref(null)
const usdc = TOKENS['svm-usdc']
const usdy = TOKENS['svm-usdy']
const strategies = computed(() => strategy.value?.strategies ?? [])
const fees = computed(() => preview.value?.fees ?? [])

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

async function runPreview() {
  loading.value = true
  error.value = null
  preview.value = null
  try {
    const response = await fetch('/api/loop-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketId: 'sol-usdy-usdc', fundingAmount: fundingAmount.value, leverage: leverage.value, wallet: state.address }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'Could not build the preview.')
    preview.value = body
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
}

const feeLabel = (fee) => `${formatBaseUnits(BigInt(fee.amountBaseUnits), fee.mint === usdc.mint ? usdc.decimals : usdy.decimals)} ${fee.mint === usdc.mint ? usdc.name : usdy.name}`
onMounted(loadStrategies)
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Loop</h1>
    <p class="n-sub">Preview a USDY and USDC Multiply strategy before any transaction flow is enabled.</p>
  </div>

  <section class="n-panel form-panel">
    <div class="form-grid">
      <label class="field">
        <span>USDC funding amount</span>
        <div class="input-with-unit"><input v-model="fundingAmount" inputmode="decimal" autocomplete="off" /><span>USDC</span></div>
      </label>
      <label class="field">
        <span>Target leverage</span>
        <div class="input-with-unit"><input v-model.number="leverage" type="number" min="1.01" max="1.5" step="0.05" /><span>x</span></div>
      </label>
      <button class="n-btn-grad preview-button" :disabled="loading" @click="runPreview">{{ loading ? 'Loading preview…' : 'Preview loop' }}</button>
    </div>
    <p class="helper">Available pair: USDY collateral / USDC debt. Leverage is capped at 1.5× and execution is disabled in this phase.</p>
  </section>

  <div v-if="error" class="n-banner warn" role="status">{{ error }}</div>

  <section v-if="preview?.exposure" class="n-stats stat-4">
    <div class="n-stat"><div class="k">{{ preview.exposure.source === 'kamino-sdk-net-route' ? 'Estimated net equity' : 'Target net equity' }}</div><div class="v">{{ preview.exposure.equity }} USDC</div></div>
    <div class="n-stat"><div class="k">Projected collateral</div><div class="v">{{ preview.exposure.grossCollateral }} USDC equivalent</div></div>
    <div class="n-stat"><div class="k">Projected debt</div><div class="v">{{ preview.exposure.debt }} USDC equivalent</div></div>
    <div class="n-stat"><div class="k">Projected LTV / limit</div><div class="v">{{ pct(Number(preview.risk?.projectedLtvPct) / 100) }} / {{ pct(Number(preview.limits?.projectedLtvPct) / 100) }}</div></div>
  </section>
  <p v-if="preview?.exposure" class="preview-basis">
    {{ preview.exposure.source === 'kamino-sdk-net-route' ? 'Amounts use Kamino SDK position calculations and fee-adjusted swap quote outputs.' : 'Amounts are target-only estimates pending live fee-adjusted route quotes.' }}
    <template v-if="preview.exposure.source === 'kamino-sdk-net-route'"> Health factor {{ Number(preview.risk?.healthFactor).toFixed(2) }} · liquidation threshold {{ preview.risk?.liquidationLtvPct }}% · liquidation collateral price {{ usd(Number(preview.risk?.liquidationPriceUsd)) }} per USDY.</template>
  </p>

  <div class="content-grid">
    <section class="n-panel">
      <div class="panel-heading"><h2>Strategy availability</h2><span class="n-chip" :class="preview?.available ? 'ready' : 'blocked'">{{ preview?.available ? 'Available' : 'Preview only' }}</span></div>
      <p class="n-muted">{{ strategies[0]?.marketName ?? 'USDY Ondo Market' }} · {{ usdy.name }} collateral / {{ usdc.name }} debt</p>
      <div v-if="preview?.carry?.estimatedCarryPct != null" class="carry">
        Estimated carry at {{ preview.carry.basedOnLeverage }}× <b>{{ preview.carry.estimatedCarryPct }}%</b>
        <div class="carry-assumptions">{{ usdy.name }} supply APR {{ preview.carry.assumptions?.collateralSupplyAprPct }}% − {{ usdc.name }} borrow APR {{ preview.carry.assumptions?.liabilityBorrowAprPct }}%; live reserve rates as of {{ preview.carry.asOf ?? 'unknown' }}.</div>
        <div v-if="preview.carry.requiresAcknowledgement" class="carry-ack">Current estimate is non-positive; acknowledgement is required before entry.</div>
      </div>
      <div v-else class="carry">Estimated carry <b>Unavailable</b> until live supply yield and borrow cost are verified.</div>
      <ul v-if="preview?.unavailableReasons?.length || strategies[0]?.unavailableReasons?.length" class="reason-list">
        <li v-for="reason in (preview?.unavailableReasons ?? strategies[0]?.unavailableReasons ?? [])" :key="reason.code">{{ reason.message }}</li>
      </ul>
      <p v-else class="n-muted">No current eligibility blockers were reported. Transaction execution remains disabled pending route and local-fork validation.</p>
    </section>

    <section class="n-panel">
      <div class="panel-heading"><h2>Swap fees</h2><span class="n-chip">10 bps each</span></div>
      <div v-if="fees.length" class="fee-list">
        <div v-for="fee in fees" :key="fee.action" class="fee-row"><span>{{ fee.action === 'initial-acquisition' ? 'USDC → USDY acquisition' : 'Leverage swap' }}</span><b>{{ feeLabel(fee) }}</b></div>
      </div>
      <p v-else class="n-muted">Fee totals appear when both fee-aware route quotes and token-account configuration are available.</p>
      <div v-if="preview?.feeTotalUsd != null" class="fee-total">Estimated fees <b>{{ usd(preview.feeTotalUsd) }}</b></div>
      <div v-if="preview?.knownCostsTotalUsd != null" class="fee-total">Known costs including borrow and flash fees <b>{{ usd(preview.knownCostsTotalUsd) }}</b></div>
      <p class="footnote">Each 10-bps fee is counted once per economic swap. DEX hops do not create additional Nysa fees.</p>
    </section>
  </div>

  <div class="n-banner">Read-only preview. This page does not build, sign, or send economic transactions.</div>
</template>

<style scoped>
.form-panel { margin-bottom: 20px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr auto; gap: 16px; align-items: end; }
.field { display: grid; gap: 8px; color: var(--n-text-2); font-size: 13px; }
.input-with-unit { display: flex; align-items: center; border: 1px solid var(--n-border); border-radius: 12px; background: var(--n-bg-2); padding: 0 13px; }
.input-with-unit input { min-width: 0; width: 100%; padding: 13px 0; border: 0; outline: 0; color: var(--n-text); background: transparent; font: inherit; font-size: 16px; }
.input-with-unit span { color: var(--n-text-3); font-size: 12px; }
.preview-button { min-height: 46px; white-space: nowrap; }
.helper,.footnote { margin: 14px 0 0; color: var(--n-text-3); font-size: 12px; line-height: 1.6; }
.content-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 22px 0; }
.panel-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.panel-heading h2 { margin: 0; font-size: 17px; }
.n-chip.ready { color: var(--n-green); }
.n-chip.blocked { color: var(--n-yellow); }
.carry { margin-top: 20px; color: var(--n-text-2); font-size: 14px; line-height: 1.6; }
.carry b { color: var(--n-text); }
.carry-assumptions,.carry-ack { margin-top: 7px; color: var(--n-text-3); font-size: 12px; }
.carry-ack { color: var(--n-yellow); }
.preview-basis { margin: -8px 0 20px; color: var(--n-text-3); font-size: 12px; line-height: 1.6; }
.reason-list { display: grid; gap: 9px; margin: 18px 0 0; padding-left: 18px; color: var(--n-text-2); font-size: 13px; line-height: 1.5; }
.fee-list { display: grid; gap: 12px; margin-top: 18px; }
.fee-row,.fee-total { display: flex; justify-content: space-between; gap: 12px; color: var(--n-text-2); font-size: 13px; }
.fee-row b,.fee-total b { color: var(--n-text); font-variant-numeric: tabular-nums; }
.fee-total { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--n-border); }
@media (max-width: 760px) { .form-grid,.content-grid { grid-template-columns: 1fr; } .preview-button { width: 100%; } }
</style>
