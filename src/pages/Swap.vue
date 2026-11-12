<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { amountToBaseUnits } from '../swap-flow.js'
import { routeSwapDirection } from '../swap-flow-state.js'
import { createLatestRequestGate } from '../swap-quote-request.js'
import { loadAccount, signAndSendSwap, state } from '../store.js'
import { TOKENS, txUrl } from '../config.js'
import TokenIcon from '../components/TokenIcon.vue'
import { formatBaseUnits } from '../swap-fees.js'

const SLIPPAGES = [10, 30, 50] // bps; the server refuses more than 50
const route = useRoute()
const start = routeSwapDirection(null, route.query.input, route.query.output)
const inputId = ref(start.inputId)
const outputId = ref(start.outputId)
const amount = ref('')
const slippageBps = ref(50)
const readiness = ref(null)
const quote = ref(null)
const quoting = ref(false)
const stage = ref(null) // 'building' | 'signing' while a swap is in flight
const error = ref(null)
const done = ref(null) // last confirmed swap signature
const requests = createLatestRequestGate()
let debounce, refresh

const input = computed(() => TOKENS[inputId.value])
const output = computed(() => TOKENS[outputId.value])
const fmt = (token, baseUnits) => formatBaseUnits(BigInt(baseUnits), token.decimals)
const balanceOf = (token) => {
  const balance = String(state.balancesBaseUnits?.[token.token_id] ?? '')
  return /^\d+$/.test(balance) ? BigInt(balance) : null
}
const amountBaseUnits = computed(() => { try { return amountToBaseUnits(amount.value, input.value.decimals) } catch { return null } })
const insufficient = computed(() => amountBaseUnits.value != null && balanceOf(input.value) != null
  && BigInt(amountBaseUnits.value) > balanceOf(input.value))
const blockedReasons = computed(() => state.address && readiness.value?.executionEnabled === false ? readiness.value.unavailableReasons ?? [] : [])
const request = () => ({ wallet: state.address, inputMint: input.value.mint, outputMint: output.value.mint,
  amountBaseUnits: amountBaseUnits.value, slippageBps: slippageBps.value })
// Display only: floats are fine for a rate label, never for amounts sent on-chain.
const rate = computed(() => quote.value && (Number(quote.value.outputAmountBaseUnits) / 10 ** output.value.decimals)
  / (Number(quote.value.amountBaseUnits) / 10 ** input.value.decimals))
const action = computed(() => {
  if (!state.address) return { label: 'Connect wallet', run: () => { state.connectOpen = true } }
  if (state.swapPending) return { label: 'Previous swap pending…' }
  if (blockedReasons.value.length) return { label: 'Swap unavailable' }
  if (stage.value === 'building') return { label: 'Preparing swap…' }
  if (stage.value === 'signing') return { label: 'Confirm in your wallet…' }
  if (!amountBaseUnits.value) return { label: 'Enter an amount' }
  if (insufficient.value) return { label: `Insufficient ${input.value.name}` }
  if (!quote.value) return { label: quoting.value ? 'Finding the best route…' : 'No route available' }
  return { label: 'Swap', run: swap }
})

async function readJson(path, init) {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `Server responded ${response.status}`)
  return body
}
const post = (path, body, signal) => readJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })

async function loadReadiness() {
  const wallet = state.address
  try {
    const result = await readJson(`/api/swap-readiness${wallet ? `?wallet=${wallet}` : ''}`)
    if (state.address === wallet) readiness.value = result
  } catch (cause) { error.value = cause.message }
}

async function fetchQuote() {
  clearTimeout(refresh)
  if (!state.address || !amountBaseUnits.value || stage.value || blockedReasons.value.length) return void (quoting.value = false)
  const body = request()
  const req = requests.begin(JSON.stringify(body))
  const current = () => req.isCurrent(JSON.stringify(request()))
  quoting.value = true
  try {
    const result = await post('/api/swap-quote', body, req.signal)
    if (!current()) return
    quote.value = { ...result, amountBaseUnits: body.amountBaseUnits }
    // ponytail: re-quote on expiry only while the tab is visible; a hidden tab keeps the stale quote until it is used.
    refresh = setTimeout(() => { if (!document.hidden) fetchQuote() }, Math.max(1000, result.expiresAt - Date.now()))
  } catch (cause) {
    if (current() && cause.name !== 'AbortError') error.value = cause.message
  } finally { if (current()) quoting.value = false }
}

// One click: build a fresh route (the server simulates it and authorizes that exact message), then sign it.
async function swap() {
  const body = request()
  const outputToken = output.value
  clearTimeout(refresh)
  requests.invalidate()
  stage.value = 'building'
  error.value = null
  done.value = null
  try {
    const built = await post('/api/swap-build', body)
    stage.value = 'signing'
    const outcome = await signAndSendSwap({ built, request: body, outputTokenId: outputToken.token_id })
    if (outcome.status === 'confirmed') {
      done.value = { signature: outcome.signature, amount: outcome.amountBaseUnits ? `${fmt(outputToken, outcome.amountBaseUnits)} ${outputToken.name}` : null }
      amount.value = ''
    }
    loadAccount(true)
  } catch (cause) { error.value = cause.message }
  finally {
    stage.value = null
    fetchQuote()
  }
}

function flip() { [inputId.value, outputId.value] = [outputId.value, inputId.value] }
function fill(divisor) {
  const balance = balanceOf(input.value)
  if (balance != null) amount.value = fmt(input.value, balance / divisor)
}

watch([inputId, outputId, amount, slippageBps, () => state.address], () => {
  requests.invalidate()
  clearTimeout(debounce)
  clearTimeout(refresh)
  quote.value = null
  error.value = null
  quoting.value = !!amountBaseUnits.value
  debounce = setTimeout(fetchQuote, 400)
})
watch(() => state.address, loadReadiness)
onMounted(loadReadiness)
onUnmounted(() => { clearTimeout(debounce); clearTimeout(refresh); requests.invalidate() })
</script>

<template>
  <div class="swap">
    <div class="head">
      <h1 class="n-h1">Swap</h1>
      <p class="n-sub">Swap USDC and USDY on Solana at the best Jupiter route.</p>
    </div>

    <div class="box">
      <div class="row"><span>Sell</span></div>
      <div class="row">
        <span class="token"><TokenIcon :token="input" size="sm" />{{ input.name }}</span>
        <input v-model="amount" :disabled="!!stage" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="Amount to sell" />
      </div>
      <div class="row small">
        <span>Available: {{ balanceOf(input) == null ? '-' : fmt(input, balanceOf(input)) }}</span>
        <span class="n-quick">
          <button :disabled="!!stage || balanceOf(input) == null" @click="fill(2n)">Half</button>
          <button :disabled="!!stage || balanceOf(input) == null" @click="fill(1n)">Max</button>
        </span>
      </div>
    </div>

    <button class="flip" :disabled="!!stage" aria-label="Switch sell and buy tokens" @click="flip">⇅</button>

    <div class="box">
      <div class="row"><span>Buy</span></div>
      <div class="row">
        <span class="token"><TokenIcon :token="output" size="sm" />{{ output.name }}</span>
        <output :class="{ dim: !quote }" aria-label="Estimated amount to buy">{{ quote ? fmt(output, quote.outputAmountBaseUnits) : quoting ? '…' : '0' }}</output>
      </div>
      <div class="row small"><span>Available: {{ balanceOf(output) == null ? '-' : fmt(output, balanceOf(output)) }}</span></div>
    </div>

    <div class="row bar">
      <span v-if="quote" class="chip">1 {{ input.name }} ≈ {{ rate.toFixed(4) }} {{ output.name }}</span><span v-else />
      <label class="chip">Slippage
        <select v-model.number="slippageBps" :disabled="!!stage" aria-label="Maximum slippage">
          <option v-for="bps in SLIPPAGES" :key="bps" :value="bps">{{ (bps / 100).toFixed(2) }}%</option>
        </select>
      </label>
    </div>

    <button class="n-btn-block" :disabled="!action.run" @click="action.run?.()">{{ action.label }}</button>

    <p v-if="error" class="n-warn" role="status">{{ error }}</p>
    <p v-if="state.swapPending" class="n-warn" role="status">A previous swap is still being confirmed. Nysa checks it automatically; wait before swapping again.</p>
    <ul v-if="blockedReasons.length" class="n-warn reasons"><li v-for="reason in blockedReasons" :key="reason.code">{{ reason.message }}</li></ul>
    <p v-if="done" class="n-note" role="status">Swap confirmed{{ done.amount ? `: received ${done.amount}` : '' }}. <a :href="txUrl(done.signature)" target="_blank" rel="noopener" class="link">View on Solscan</a></p>

    <div v-if="quote" class="details">
      <div class="n-kv"><span class="k">Minimum received</span><span class="v">{{ fmt(output, quote.minimumOutputBaseUnits) }} {{ output.name }}</span></div>
      <div class="n-kv"><span class="k">Price impact</span><span class="v">{{ Number(quote.priceImpactPct).toFixed(3) }}%</span></div>
      <div class="n-kv"><span class="k">Nysa fee (0.1%)</span><span class="v">{{ quote.fee ? `${fmt(output, quote.fee.amountBaseUnits)} ${output.name}` : '-' }}</span></div>
      <div class="n-kv"><span class="k">Route</span><span class="v">{{ quote.routePlan.map((leg) => leg.label).join(' → ') || '-' }}</span></div>
    </div>
  </div>
</template>

<style scoped>
.swap { max-width: 470px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
.head { text-align: center; margin-bottom: 14px; }
.box { display: grid; gap: 8px; padding: 14px 16px; border: 1px solid var(--n-line); border-radius: 12px; background: var(--n-bg-2); }
.box:focus-within { border-color: var(--n-pink); }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--n-text-3); font-size: 12px; }
.row.small .n-quick button { padding: 3px 10px; }
.token { display: inline-flex; align-items: center; gap: 8px; color: var(--n-text); font-size: 17px; font-weight: 600; }
.box input, .box output { min-width: 0; width: 100%; text-align: right; color: var(--n-text); font-size: 26px; font-variant-numeric: tabular-nums; outline: 0; }
.box output.dim { color: var(--n-text-4); }
.flip { align-self: center; margin: -18px 0; z-index: 1; width: 36px; height: 36px; border: 1px solid var(--n-line-2); border-radius: 10px; background: var(--n-bg-3); color: var(--n-text-2); font-size: 18px; }
.flip:hover:not(:disabled) { color: var(--n-pink); border-color: var(--n-pink); }
.bar { margin: 4px 0; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border: 1px solid var(--n-line-2); border-radius: 999px; color: var(--n-text-2); font-size: 12px; }
.chip select { color: var(--n-text); background: var(--n-bg-2); cursor: pointer; }
.reasons { padding-left: 18px; }
.details { display: grid; gap: 8px; margin-top: 8px; padding: 14px 16px; border: 1px solid var(--n-line); border-radius: 12px; }
.link { color: var(--n-pink); }
</style>
