<script setup>
// The quote is the backend's simulation of the real transaction: exactly what the program would pay out.
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { state, priceOf, loadLiquidationInfo, previewLiquidation, liquidate, useTx } from '../store.js'
import { tok } from '../config.js'
import { amt, usdFull, num, cleanAmount, floorTo, short, hfText, hfColor } from '../logic.js'
import TxProgress from './TxProgress.vue'

// collateral, debt: the token ids of the loan's largest deposit and largest borrow (from /api/analytics).
const props = defineProps({ market: Object, borrower: String, collateral: String, debt: String })
const emit = defineEmits(['close', 'done'])
const { tx, run, reset } = useTx()

const debt = tok(props.debt)
const coll = tok(props.collateral)
const info = ref(null)
const infoError = ref(null)
const amount = ref('')
watch(amount, (v) => {
  amount.value = cleanAmount(v, debt.decimals)
})
const quote = ref(null)
const quoting = ref(false)
const quoteError = ref(null)
const on = computed(() => !!state.address)
const balance = computed(() => state.balances[debt.token_id] ?? 0)
const max = computed(() =>
  info.value
    ? floorTo(info.value.fullOnly ? info.value.debt : Math.min(info.value.maxRepay, balance.value), debt.decimals)
    : 0,
)

async function loadInfo() {
  try {
    info.value = await loadLiquidationInfo(props.market, props.borrower)
    // The list behind was older than this read (it refreshes every minute): have it reload.
    if (!info.value.liquidatable) return emit('done')
    // Interest keeps growing until the transaction lands; Kamino only takes what is owed, so leave some headroom.
    if (info.value.fullOnly)
      amount.value = String(floorTo(info.value.debt * 1.001 + 10 ** -debt.decimals, debt.decimals))
  } catch (e) {
    infoError.value = e.message
  }
}
onMounted(loadInfo)

const warning = computed(() => {
  if (!on.value) return 'Connect a Solana wallet to continue.'
  if (!info.value) return null
  const a = num(amount.value)
  if (!a) return null
  if (a > balance.value) return `You only hold ${amt(balance.value)} ${debt.name}.`
  if (!info.value.fullOnly && a > info.value.maxRepay + 10 ** -debt.decimals)
    return `At most ${amt(info.value.maxRepay, 2)} ${debt.name} of this loan can be repaid in one liquidation.`
  return null
})

// an older answer arriving late is ignored
let timer
let seq = 0
watch([amount, info, on], () => {
  clearTimeout(timer)
  quote.value = null
  quoteError.value = null
  const a = num(amount.value)
  if (!a || warning.value || !info.value?.liquidatable) return
  timer = setTimeout(async () => {
    const id = ++seq
    quoting.value = true
    try {
      const q = await previewLiquidation(props.market, props.borrower, a)
      if (id === seq) quote.value = q
    } catch (e) {
      if (id === seq) quoteError.value = e.message
    } finally {
      if (id === seq) quoting.value = false
    }
  }, 600)
})

const receivedUsd = computed(() => (quote.value ? quote.value.received * priceOf(coll.token_id) : 0))
const profit = computed(() => (quote.value ? receivedUsd.value - quote.value.repaid * priceOf(debt.token_id) : 0))
const canSubmit = computed(
  () => on.value && !!quote.value && !warning.value && !quoting.value && tx.status !== 'running',
)

async function submit() {
  if (
    !(await run([
      {
        label: `Liquidate ${short(props.borrower, 4)}`,
        run: () => liquidate(props.market, props.borrower, num(amount.value)),
      },
    ]))
  )
    return
  await loadInfo() // the loan as it is now (often no longer liquidatable), which also refreshes the server's list
  emit('done')
}
const onKey = (e) => e.key === 'Escape' && tx.status !== 'running' && emit('close')
onMounted(() => addEventListener('keydown', onKey))
onUnmounted(() => removeEventListener('keydown', onKey))
</script>

<template>
  <div class="overlay" @click.self="tx.status !== 'running' && emit('close')">
    <div class="n-dialog lq-modal" role="dialog" aria-modal="true" aria-labelledby="lq-title">
      <div class="n-dialog-head">
        <div>
          <h3 id="lq-title" class="n-dialog-title">Liquidate loan</h3>
          <p class="n-dialog-sub">
            Repay part of this loan's {{ debt.name }} debt and receive its {{ coll.name }} collateral plus a bonus.
          </p>
        </div>
        <button class="x-btn" aria-label="Close" :disabled="tx.status === 'running'" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path stroke-linecap="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="lq-box">
        <div class="n-kv">
          <span class="k">Borrower</span><span class="v mono">{{ short(borrower, 6) }}</span>
        </div>
        <div class="n-kv">
          <span class="k">Debt</span><span class="v">{{ info ? `${amt(info.debt, 2)} ${debt.name}` : '—' }}</span>
        </div>
        <div class="n-kv">
          <span class="k">Health factor</span
          ><span class="v" :style="info && { color: hfColor(info.hf) }">{{ info ? hfText(info.hf) : '—' }}</span>
        </div>
        <div class="n-kv">
          <span class="k">Repayable now</span
          ><span class="v">{{
            info?.liquidatable ? `${amt(info.fullOnly ? info.debt : info.maxRepay, 2)} ${debt.name}` : '—'
          }}</span>
        </div>
      </div>
      <p v-if="infoError" class="n-warn">{{ infoError }}</p>

      <template v-if="info && !info.liquidatable">
        <p class="n-note">
          This loan can't be liquidated anymore: its health factor is {{ hfText(info.hf) }}, above 1. It was probably
          just liquidated, or prices moved.
        </p>
        <button class="n-btn-block" @click="emit('close')">Close</button>
      </template>
      <template v-else>
        <div class="n-label">Repay ({{ debt.name }})</div>
        <input
          v-model="amount"
          class="n-input"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0.00"
          :disabled="!on || !info?.liquidatable || info?.fullOnly"
        />
        <div class="lq-row">
          <span>Wallet: {{ on ? `${amt(balance, 2)} ${debt.name}` : '—' }}</span>
          <span v-if="info && !info.fullOnly" class="n-quick"
            ><button :disabled="!on || !info.liquidatable || max <= 0" @click="amount = String(max)">Max</button></span
          >
        </div>
        <p v-if="info?.fullOnly" class="n-note">
          This loan is small, so Kamino requires it to be repaid in full in one liquidation.
        </p>

        <div class="lq-box">
          <div class="n-kv">
            <span class="k">You repay</span
            ><span class="v">{{ quote ? `${amt(quote.repaid, 2)} ${debt.name}` : '—' }}</span>
          </div>
          <div class="n-kv">
            <span class="k">You receive</span
            ><span class="v">{{
              quote ? `${amt(quote.received, 4)} ${coll.name}` : quoting ? 'Simulating…' : '—'
            }}</span>
          </div>
          <div class="n-kv">
            <span class="k">Value received</span><span class="v">{{ quote ? usdFull(receivedUsd) : '—' }}</span>
          </div>
          <div class="n-kv">
            <span class="k">Estimated profit</span
            ><span class="v" :style="quote && { color: profit >= 0 ? 'var(--n-green)' : 'var(--n-red)' }">{{
              quote ? usdFull(profit) : '—'
            }}</span>
          </div>
        </div>
        <p class="lq-hint">
          Quote from a simulation of the real transaction. It will pay out at least 99% of it, or fail without being
          executed. Bots often liquidate first: if this loan is liquidated before you, the transaction is never sent.
        </p>

        <p v-if="warning || quoteError" class="n-warn">{{ warning || quoteError }}</p>
        <button class="n-btn-block" :disabled="!canSubmit" @click="submit">Liquidate</button>
      </template>
      <TxProgress :tx="tx" @dismiss="reset" />
    </div>
  </div>
</template>

<style scoped>
.lq-modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.lq-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--n-line);
  border-radius: 4px;
  background: #000;
}
.n-label {
  margin-bottom: -6px;
}
.lq-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--n-text-3);
  margin-top: -4px;
}
.lq-row .n-quick button {
  padding: 3px 12px;
}
.lq-hint {
  font-size: 12px;
  color: var(--n-text-4);
  line-height: 1.6;
}
.mono {
  font-family: var(--mono);
}
</style>
