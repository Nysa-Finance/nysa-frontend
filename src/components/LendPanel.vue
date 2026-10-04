<script setup>
import { ref, computed, watch } from 'vue'
import { state, rowOf, priceOf, rewardAprOf, sendKaminoAction, useTx } from '../store.js'
import { pct, amt, usdFull, num, floorTo, coversAll } from '../logic.js'
import TxProgress from './TxProgress.vue'

const props = defineProps({ market: Object, tokens: Array, allTokens: Array, initialTab: String, initialAsset: String })
const { tx, run, reset } = useTx()

const tab = ref(props.initialTab === 'withdraw' ? 'withdraw' : 'lend')
const options = computed(() => (tab.value === 'withdraw' ? props.allTokens : props.tokens))
const assetId = ref(props.initialAsset ?? props.tokens[0]?.token_id)
const amount = ref('')
const token = computed(() => options.value.find((t) => t.token_id === assetId.value) ?? options.value[0])
const row = computed(() => rowOf(token.value.token_id))
const on = computed(() => !!state.address)

const supplied = computed(() => row.value?.supplied ?? 0)
const available = computed(() => (tab.value === 'lend' ? row.value?.walletBalance ?? 0 : row.value?.maxWithdraw ?? 0))
const value = computed(() => num(amount.value) * priceOf(token.value.token_id))
const capRoom = computed(() => {
  const cap = props.market.pairs.find((p) => p.collateral === token.value.token_id || p.liability === token.value.token_id)
  const capUnits = cap ? (cap.collateral === token.value.token_id ? cap.supplyCap : cap.borrowCap) : Infinity
  return Math.max(capUnits - (row.value?.reserve.totalSupplied ?? 0), 0)
})

const warning = computed(() => {
  if (!on.value) return 'Connect a Solana wallet to continue.'
  if (!state.loaded || !row.value) return 'Protocol data could not be read — actions are disabled until it recovers.'
  const a = num(amount.value)
  if (!a) return null
  if (a > available.value)
    return tab.value === 'lend' ? `You only hold ${amt(available.value)} ${token.value.name}.` : `You can withdraw at most ${amt(available.value)} ${token.value.name} right now.`
  if (tab.value === 'lend' && a > capRoom.value) return `This vault's supply cap leaves room for ${amt(capRoom.value)} ${token.value.name}.`
  return null
})
const canSubmit = computed(() => on.value && num(amount.value) > 0 && !warning.value && tx.status !== 'running')

const quick = (p) => {
  const v = floorTo((available.value * p) / 100, token.value.decimals)
  amount.value = v > 0 ? String(v) : ''
}
// Withdrawing (within one unit) everything supplied, with nothing holding it back, closes the deposit exactly on-chain.
const withdrawAll = computed(() =>
  tab.value === 'withdraw' && coversAll(num(amount.value), supplied.value, token.value.decimals) && coversAll(available.value, supplied.value, token.value.decimals))
watch([tab, assetId], () => { amount.value = ''; reset() })
watch(options, (o) => { if (!o.some((t) => t.token_id === assetId.value)) assetId.value = o[0]?.token_id })

async function submit() {
  const t = token.value, a = num(amount.value)
  const [label, kind] = tab.value === 'lend' ? ['Supply', 'deposit'] : ['Withdraw', 'withdraw']
  if (await run([{ label: `${label} ${t.name}`, run: () => sendKaminoAction(kind, { market: props.market, token: t, amount: a, all: withdrawAll.value }) }])) amount.value = ''
}
</script>

<template>
  <div class="n-panel">
    <div class="n-seg" style="margin-bottom: 22px">
      <button :class="{ on: tab === 'lend' }" @click="tab = 'lend'">Lend</button>
      <button :class="{ on: tab === 'withdraw' }" @click="tab = 'withdraw'">Withdraw</button>
    </div>
    <div class="n-label">{{ tab === 'withdraw' ? 'Asset to withdraw' : 'Asset to supply' }}</div>
    <select v-model="assetId" class="n-select" style="margin-bottom: 14px">
      <option v-for="t in options" :key="t.token_id" :value="t.token_id">{{ t.name }}</option>
    </select>
    <div class="n-kv" style="margin-bottom: 10px"><span class="k">Supply APY</span><span class="v accent">{{ pct(row?.reserve.supplyAPR) }}</span></div>
    <template v-if="rewardAprOf(token.token_id) > 0">
      <div class="n-kv" style="margin-bottom: 10px"><span class="k">{{ state.rewards[token.token_id].rewards.map((x) => x.symbol).join(' + ') }} rewards APR</span><span class="v" style="color: var(--n-green)">+{{ pct(rewardAprOf(token.token_id)) }}</span></div>
      <div class="n-kv" style="margin-bottom: 10px"><span class="k">⚡ Boosted APY</span><span class="v accent">{{ pct((row?.reserve.supplyAPR ?? 0) + rewardAprOf(token.token_id)) }}</span></div>
    </template>
    <div class="n-kv" style="margin-bottom: 10px"><span class="k">Your supplied</span><span class="v">{{ on ? `${amt(supplied)} ${token.name}` : '—' }}</span></div>
    <div class="n-kv" style="margin-bottom: 20px">
      <span class="k">{{ tab === 'lend' ? 'Wallet balance' : 'Available to withdraw' }}</span>
      <span class="v">{{ on ? `${amt(available)} ${token.name}` : '—' }}</span>
    </div>
    <div class="n-label">Amount</div>
    <input v-model="amount" class="n-input" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00" :disabled="!on" style="margin-bottom: 10px" />
    <div class="n-quick" style="margin-bottom: 14px">
      <button v-for="p in [25, 50, 75, 100]" :key="p" :disabled="!on" @click="quick(p)">{{ p === 100 ? 'MAX' : p + '%' }}</button>
    </div>
    <div class="n-kv" style="margin-bottom: 18px"><span class="k">Value</span><span class="v">{{ usdFull(value) }}</span></div>
    <p v-if="withdrawAll && !warning" class="n-note" style="margin-bottom: 16px">Withdrawing in full. The exact balance is settled on-chain so no dust is left behind.</p>
    <p v-if="warning" class="n-warn" style="margin-bottom: 16px">{{ warning }}</p>
    <button class="n-btn-block" :disabled="!canSubmit" @click="submit">{{ tab === 'withdraw' ? 'Withdraw' : 'Lend' }} {{ token.name }}</button>
    <TxProgress :tx="tx" @dismiss="reset" />
  </div>
</template>
