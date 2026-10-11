<script setup>
// Liquidate someone else's unhealthy loan: repay part of the debt, receive collateral plus a bonus. The quote is the
// backend's simulation of the real transaction, so it shows exactly what the program would pay out.
import { ref, computed, watch, onMounted } from 'vue'
import { state, priceOf, loadLiquidationInfo, previewLiquidation, liquidate, useTx } from '../store.js'
import { tok } from '../config.js'
import { amt, usdFull, num, floorTo, short, hfText, hfColor } from '../logic.js'
import TxProgress from './TxProgress.vue'

const props = defineProps({ market: Object, borrower: String })
const emit = defineEmits(['close', 'done'])
const { tx, run, reset } = useTx()

const debt = tok(props.market.pairs[0].liability), coll = tok(props.market.pairs[0].collateral)
const info = ref(null), infoError = ref(null)
const amount = ref('')
const quote = ref(null), quoting = ref(false), quoteError = ref(null)
const on = computed(() => !!state.address)
const balance = computed(() => state.balances[debt.token_id] ?? 0)
const max = computed(() => (info.value ? floorTo(info.value.fullOnly ? info.value.debt : Math.min(info.value.maxRepay, balance.value), debt.decimals) : 0))

async function loadInfo() {
  try {
    info.value = await loadLiquidationInfo(props.market, props.borrower)
    // Interest keeps growing until the transaction lands; Kamino only takes what is owed, so leave some headroom.
    if (info.value.fullOnly) amount.value = String(floorTo(info.value.debt * 1.001 + 10 ** -debt.decimals, debt.decimals))
  } catch (e) { infoError.value = e.message }
}
onMounted(loadInfo)

const warning = computed(() => {
  if (!on.value) return 'Connect a Solana wallet to continue.'
  if (!info.value) return null
  if (!info.value.liquidatable) return `This loan is healthy (health factor ${hfText(info.value.hf)}), so it can't be liquidated right now.`
  const a = num(amount.value)
  if (!a) return null
  if (a > balance.value) return `You only hold ${amt(balance.value)} ${debt.name}.`
  if (!info.value.fullOnly && a > info.value.maxRepay + 10 ** -debt.decimals) return `At most ${amt(info.value.maxRepay, 2)} ${debt.name} of this loan can be repaid in one liquidation.`
  return null
})

// Quote after typing stops; an older answer arriving late is ignored.
let timer, seq = 0
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
const canSubmit = computed(() => on.value && !!quote.value && !warning.value && !quoting.value && tx.status !== 'running')

async function submit() {
  if (await run([{ label: `Liquidate ${short(props.borrower, 4)}`, run: () => liquidate(props.market, props.borrower, num(amount.value)) }])) emit('done')
}
</script>

<template>
  <div class="overlay" @click.self="tx.status !== 'running' && emit('close')">
    <div class="lq-modal" role="dialog" aria-modal="true" aria-labelledby="lq-title">
      <div class="lq-head">
        <div>
          <h3 id="lq-title" class="lq-title">Liquidate loan</h3>
          <p class="lq-sub">Repay part of this loan's {{ debt.name }} debt and receive its {{ coll.name }} collateral plus a bonus.</p>
        </div>
        <button class="x-btn" aria-label="Close" :disabled="tx.status === 'running'" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <div class="lq-box">
        <div class="n-kv"><span class="k">Borrower</span><span class="v mono">{{ short(borrower, 6) }}</span></div>
        <div class="n-kv"><span class="k">Debt</span><span class="v">{{ info ? `${amt(info.debt, 2)} ${debt.name}` : '—' }}</span></div>
        <div class="n-kv"><span class="k">Health factor</span><span class="v" :style="info && { color: hfColor(info.hf) }">{{ info ? hfText(info.hf) : '—' }}</span></div>
        <div class="n-kv"><span class="k">Repayable now</span><span class="v">{{ info ? `${amt(info.fullOnly ? info.debt : info.maxRepay, 2)} ${debt.name}` : '—' }}</span></div>
      </div>
      <p v-if="infoError" class="n-warn">{{ infoError }}</p>

      <div class="n-label">Repay ({{ debt.name }})</div>
      <input v-model="amount" class="n-input" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00"
        :disabled="!on || !info?.liquidatable || info?.fullOnly" />
      <div class="lq-row">
        <span>Wallet: {{ on ? `${amt(balance, 2)} ${debt.name}` : '—' }}</span>
        <button v-if="info && !info.fullOnly" class="lq-max" :disabled="!on || !info.liquidatable || max <= 0" @click="amount = String(max)">MAX</button>
      </div>
      <p v-if="info?.fullOnly" class="n-note">This loan is small, so Kamino requires it to be repaid in full in one liquidation.</p>

      <div class="lq-box">
        <div class="n-kv"><span class="k">You repay</span><span class="v">{{ quote ? `${amt(quote.repaid, 2)} ${debt.name}` : '—' }}</span></div>
        <div class="n-kv"><span class="k">You receive</span><span class="v">{{ quote ? `${amt(quote.received, 4)} ${coll.name}` : quoting ? 'Simulating…' : '—' }}</span></div>
        <div class="n-kv"><span class="k">Value received</span><span class="v">{{ quote ? usdFull(receivedUsd) : '—' }}</span></div>
        <div class="n-kv"><span class="k">Estimated profit</span><span class="v" :style="quote && { color: profit >= 0 ? 'var(--n-green)' : 'var(--n-red)' }">{{ quote ? usdFull(profit) : '—' }}</span></div>
      </div>
      <p class="lq-hint">Quote from a simulation of the real transaction. It will pay out at least 99% of it, or fail without being executed. Bots often liquidate first: if this loan is liquidated before you, the transaction is never sent.</p>

      <p v-if="warning || quoteError" class="n-warn">{{ warning || quoteError }}</p>
      <button class="n-btn-block" :disabled="!canSubmit" @click="submit">Liquidate</button>
      <TxProgress :tx="tx" @dismiss="reset" />
    </div>
  </div>
</template>

<style scoped>
.overlay { animation: lq-fade .2s ease-out; }
.lq-modal { animation: lq-rise .24s ease-out; }
@keyframes lq-fade { from { opacity: 0; } }
@keyframes lq-rise { from { opacity: 0; transform: translateY(10px) scale(.98); } }
@media (prefers-reduced-motion: reduce) { .overlay, .lq-modal { animation: none; } }
.lq-modal { width: 100%; max-width: 480px; max-height: calc(100vh - 32px); overflow-y: auto; background: var(--n-bg-2); border: 1px solid var(--n-line); border-radius: 6px; padding: 24px; box-shadow: 0 40px 100px -20px #000c; display: flex; flex-direction: column; gap: 14px; }
.lq-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.lq-title { font-family: var(--serif); font-style: italic; font-weight: 400; font-size: 28px; line-height: 1.1; }
.lq-sub { color: var(--n-text-3); font-size: 13px; margin-top: 6px; line-height: 1.5; }
.lq-box { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border: 1px solid var(--n-line); border-radius: 4px; background: #000; }
.n-label { margin-bottom: -6px; }
.lq-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--n-text-3); margin-top: -4px; }
.lq-max { font-size: 11.5px; font-weight: 600; color: var(--n-pink); }
.lq-max:disabled { opacity: .35; cursor: not-allowed; }
.lq-hint { font-size: 12px; color: var(--n-text-4); line-height: 1.6; }
.mono { font-family: var(--mono); }
</style>
