<script setup>
import { ref, computed, watch } from 'vue'
import { state, rowOf, priceOf, sendKaminoAction, useTx } from '../store.js'
import { pct, amt, usdFull, num, borrowCapacity, weightedLtv, floorTo, ceilTo, coversAll } from '../logic.js'
import TxProgress from './TxProgress.vue'

const props = defineProps({ market: Object, collateralTokens: Array, loanTokens: Array, initialTab: String, initialAsset: String })
const { tx, run, reset } = useTx()

const tab = ref(props.initialTab === 'repay' ? 'repay' : 'borrow')
const loanId = ref(props.loanTokens.some((t) => t.token_id === props.initialAsset) ? props.initialAsset : props.loanTokens[0]?.token_id)
const collId = ref(props.collateralTokens[0]?.token_id)
const deposit = ref('')
const borrowAmt = ref('')
const repayAmt = ref('')

const loan = computed(() => props.loanTokens.find((t) => t.token_id === loanId.value) ?? props.loanTokens[0])
const coll = computed(() => props.collateralTokens.find((t) => t.token_id === collId.value) ?? props.collateralTokens[0])
const loanRow = computed(() => rowOf(loan.value.token_id))
const collRow = computed(() => rowOf(coll.value.token_id))
const on = computed(() => !!state.address)
const loanPrice = computed(() => priceOf(loan.value.token_id))
const liquidity = computed(() => loanRow.value?.reserve.availableLiquidity ?? 0)
const debt = computed(() => loanRow.value?.borrowed ?? 0)
const debtUsd = computed(() => debt.value * loanPrice.value)
const pairLtv = (cid) => props.market.pairs.find((p) => p.collateral === cid && p.liability === loan.value.token_id)?.maxLtv ?? 0

// Existing collateral + whatever the user is about to deposit.
const collateral = computed(() =>
  props.collateralTokens
    .map((t) => {
      const units = (rowOf(t.token_id)?.supplied ?? 0) + (t.token_id === coll.value.token_id ? num(deposit.value) : 0)
      return { token: t, usd: units * priceOf(t.token_id), ltv: pairLtv(t.token_id) }
    })
    .filter((c) => c.usd > 0),
)
const collUsd = computed(() => collateral.value.reduce((s, c) => s + c.usd, 0))
const maxLtv = computed(() => weightedLtv(collateral.value))
const capacity = computed(() => borrowCapacity(collateral.value, debtUsd.value, loanPrice.value, liquidity.value))
const borrowUsd = computed(() => num(borrowAmt.value) * loanPrice.value)
const ltv = computed(() => (collUsd.value > 0 ? ((debtUsd.value + borrowUsd.value) / collUsd.value) * 100 : 0))

function setLtv(target) {
  if (collUsd.value <= 0 || loanPrice.value <= 0) return
  const units = Math.max((collUsd.value * target) / 100 - debtUsd.value, 0) / loanPrice.value
  const v = floorTo(Math.min(units, liquidity.value), loan.value.decimals)
  borrowAmt.value = v > 0 ? String(v) : ''
}

const noData = 'Protocol data could not be read — actions are disabled until it recovers.'
const borrowWarning = computed(() => {
  if (!on.value) return 'Connect a Solana wallet to continue.'
  if (!loanRow.value) return noData
  if (collUsd.value <= 0 && !num(deposit.value)) return `Supply ${props.collateralTokens.map((t) => t.name).join(' or ')} as collateral before borrowing.`
  if (num(deposit.value) > (collRow.value?.walletBalance ?? 0)) return `You only hold ${amt(collRow.value?.walletBalance ?? 0)} ${coll.value.name}.`
  const a = num(borrowAmt.value)
  if (!a) return null
  if (a > liquidity.value) return `The vault holds ${amt(liquidity.value)} ${loan.value.name} in borrowable cash.`
  if (a > capacity.value) return `That exceeds your borrow capacity of ${amt(capacity.value)} ${loan.value.name} at ${pct(maxLtv.value, 0)} max LTV.`
  return null
})
const repayWarning = computed(() => {
  if (!on.value) return 'Connect a Solana wallet to continue.'
  if (!loanRow.value) return noData
  if (debt.value <= 0) return `You have no ${loan.value.name} debt to repay.`
  const a = num(repayAmt.value)
  const wallet = loanRow.value?.walletBalance ?? 0
  if (!a) return null
  // A full repay settles the exact on-chain debt (incl. sub-unit interest), so the wallet must cover all of it.
  if (repayAll.value && wallet < debt.value)
    return `Repaying in full needs about ${amt(ceilTo(debt.value, loan.value.decimals), 6)} ${loan.value.name} (interest keeps accruing); you hold ${amt(wallet, 6)}.`
  if (a > wallet) return `You only hold ${amt(wallet)} ${loan.value.name}.`
  return null
})
const canBorrow = computed(() => on.value && num(borrowAmt.value) > 0 && !borrowWarning.value && tx.status !== 'running')
const canRepay = computed(() => on.value && num(repayAmt.value) > 0 && !repayWarning.value && tx.status !== 'running')
// Paying within one smallest unit of the debt means "repay everything": Kamino rejects leaving sub-unit dust
// (NetValueRemainingTooSmall), so such repays are sent as a full repay and settled exactly on-chain.
const repayAll = computed(() => coversAll(num(repayAmt.value), debt.value, loan.value.decimals))
const quickRepay = (p) => {
  const d = loan.value.decimals
  const v = p === 100 ? ceilTo(debt.value, d) : floorTo((debt.value * p) / 100, d)
  repayAmt.value = v > 0 ? String(v) : ''
}

watch([tab, loanId, collId], () => { deposit.value = ''; borrowAmt.value = ''; repayAmt.value = ''; reset() })

async function submitBorrow() {
  const steps = []
  if (num(deposit.value) > 0)
    steps.push({ label: `Supply ${coll.value.name} as collateral`, run: () => sendKaminoAction('deposit', { market: props.market, token: coll.value, amount: num(deposit.value) }) })
  steps.push({ label: `Borrow ${loan.value.name}`, run: () => sendKaminoAction('borrow', { market: props.market, token: loan.value, amount: num(borrowAmt.value) }) })
  if (await run(steps)) { deposit.value = ''; borrowAmt.value = '' }
}
async function submitRepay() {
  const label = repayAll.value ? `Repay all ${loan.value.name}` : `Repay ${loan.value.name}`
  if (await run([{ label, run: () => sendKaminoAction('repay', { market: props.market, token: loan.value, amount: num(repayAmt.value), all: repayAll.value }) }])) repayAmt.value = ''
}
</script>

<template>
  <div class="n-panel">
    <div class="n-seg" style="margin-bottom: 22px">
      <button :class="{ on: tab === 'borrow' }" @click="tab = 'borrow'">Borrow</button>
      <button :class="{ on: tab === 'repay' }" @click="tab = 'repay'">Repay</button>
    </div>

    <template v-if="tab === 'borrow'">
      <div class="n-label">Deposit collateral <span class="opt">(optional)</span></div>
      <select v-model="collId" class="n-select" style="margin-bottom: 10px">
        <option v-for="t in collateralTokens" :key="t.token_id" :value="t.token_id">{{ t.name }}</option>
      </select>
      <input v-model="deposit" class="n-input" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00" :disabled="!on" style="margin-bottom: 8px" />
      <div class="n-kv" style="margin-bottom: 22px"><span class="k">In wallet</span><span class="v">{{ on ? `${amt(collRow?.walletBalance ?? 0)} ${coll.name}` : '—' }}</span></div>

      <div class="n-rule" style="padding-top: 20px">
        <div class="n-kv" style="margin-bottom: 12px"><span class="k">Collateral value</span><span class="v">{{ usdFull(collUsd) }}</span></div>
        <div class="n-kv" style="margin-bottom: 10px"><span class="k">Loan-to-Value</span><span class="v accent">{{ pct(ltv, 1) }}</span></div>
        <input class="slider" type="range" min="0" :max="Math.max(maxLtv, 1)" step="0.5" :value="Math.min(ltv, maxLtv)" :disabled="collUsd <= 0" @input="setLtv(+$event.target.value)" />
        <div class="scale"><span>0%</span><span>Max {{ pct(maxLtv, 0) }}</span></div>
      </div>

      <div class="n-rule" style="padding-top: 20px; margin-top: 22px">
        <div class="n-label">Borrow asset</div>
        <select v-model="loanId" class="n-select" style="margin-bottom: 14px">
          <option v-for="t in loanTokens" :key="t.token_id" :value="t.token_id">{{ t.name }}</option>
        </select>
        <div class="n-kv" style="margin-bottom: 10px"><span class="k">Borrow APY</span><span class="v accent">{{ pct(loanRow?.reserve.borrowAPR) }}</span></div>
        <div class="n-kv" style="margin-bottom: 10px"><span class="k">Available liquidity</span><span class="v">{{ amt(liquidity) }} {{ loan.name }}</span></div>
        <div class="n-kv" style="margin-bottom: 18px"><span class="k">Max you can borrow</span><span class="v">{{ on ? `${amt(capacity)} ${loan.name}` : '—' }}</span></div>
        <div class="n-label">Amount</div>
        <input v-model="borrowAmt" class="n-input" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00" :disabled="!on" style="margin-bottom: 14px" />
        <div class="n-kv" style="margin-bottom: 18px"><span class="k">Value</span><span class="v">{{ usdFull(borrowUsd) }}</span></div>
        <p v-if="borrowWarning" class="n-warn" style="margin-bottom: 16px">{{ borrowWarning }}</p>
        <button class="n-btn-block" :disabled="!canBorrow" @click="submitBorrow">{{ num(deposit) > 0 ? 'Supply & borrow' : 'Borrow' }} {{ loan.name }}</button>
      </div>
    </template>

    <template v-else>
      <div class="n-label">Asset to repay</div>
      <select v-model="loanId" class="n-select" style="margin-bottom: 14px">
        <option v-for="t in loanTokens" :key="t.token_id" :value="t.token_id">{{ t.name }}</option>
      </select>
      <div class="n-kv" style="margin-bottom: 10px"><span class="k">Borrow APY (current)</span><span class="v accent">{{ pct(loanRow?.reserve.borrowAPR) }}</span></div>
      <div class="n-kv" style="margin-bottom: 10px"><span class="k">Outstanding debt</span><span class="v">{{ on ? `${amt(debt)} ${loan.name}` : '—' }}</span></div>
      <div class="n-kv" style="margin-bottom: 20px"><span class="k">In wallet</span><span class="v">{{ on ? `${amt(loanRow?.walletBalance ?? 0)} ${loan.name}` : '—' }}</span></div>
      <div class="n-label">Amount</div>
      <input v-model="repayAmt" class="n-input" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00" :disabled="!on" style="margin-bottom: 10px" />
      <div class="n-quick" style="margin-bottom: 18px">
        <button v-for="p in [25, 50, 75, 100]" :key="p" :disabled="!on || debt <= 0" @click="quickRepay(p)">{{ p === 100 ? 'MAX' : p + '%' }}</button>
      </div>
      <div class="n-kv" style="margin-bottom: 18px"><span class="k">Value</span><span class="v">{{ usdFull(num(repayAmt) * loanPrice) }}</span></div>
      <p v-if="repayAll && canRepay" class="n-note" style="margin-bottom: 16px">Repaying in full. The exact debt is settled on-chain so no dust is left behind.</p>
      <p v-if="repayWarning" class="n-warn" style="margin-bottom: 16px">{{ repayWarning }}</p>
      <button class="n-btn-block" :disabled="!canRepay" @click="submitRepay">Repay {{ loan.name }}</button>
    </template>

    <TxProgress :tx="tx" @dismiss="reset" />
  </div>
</template>

<style scoped>
.slider { width: 100%; accent-color: var(--n-pink); }
.slider:disabled { opacity: .4; }
.scale { display: flex; justify-content: space-between; color: var(--n-text-4); font-size: 11px; margin-top: 4px; }
</style>
