<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { amountToBaseUnits, baseUnitsToAmount, resolveSwapFlow } from '../swap-flow.js'
import { applySwapFlowOutcome, flowContextMatches, normalizeSwapFlowDirection, pendingFlowMatches, recoverConfirmedWithdrawal, routeSwapDirection } from '../swap-flow-state.js'
import { confirmedSwapAmountFromTransaction } from '../swap-recovery.js'
import { createLatestRequestGate } from '../swap-quote-request.js'
import { loadAccount, sendKaminoAction, signAndSendSwap, state } from '../store.js'
import { TOKENS, marketById, tok } from '../config.js'
import { formatBaseUnits } from '../swap-fees.js'

const route = useRoute()
const tokens = [TOKENS['svm-usdc'], TOKENS['svm-usdy']]
const tokenById = Object.fromEntries(tokens.map((token) => [token.token_id, token]))
const FLOW_MARKET_ID = 'sol-usdy-usdc'
const initialDirection = routeSwapDirection(route.query.flow, route.query.input, route.query.output)
const inputId = ref(initialDirection.inputId)
const outputId = ref(initialDirection.outputId)
const amount = ref('100')
const slippageBps = ref(50)
const readiness = ref(null)
const quote = ref(null)
const buildIntent = ref(null)
const busy = ref(false)
const signing = ref(false)
const error = ref(null)
const primaryStatus = ref('idle')
const primaryAmountBaseUnits = ref(null)
const followUpStatus = ref(null)
const withdrawLimitBaseUnits = ref(null)
const withdrawLimitStatus = ref('unavailable')
const withdrawLimitUpdatedAt = ref(null)
const withdrawLimitSlot = ref(null)
const flowMessage = ref(null)
const timeNow = ref(Date.now())
let clockTimer
const quoteRequests = createLatestRequestGate()

const inputToken = computed(() => tokenById[inputId.value])
const outputToken = computed(() => tokenById[outputId.value])
const quoteFresh = computed(() => !!quote.value && timeNow.value >= quote.value.quoteAt && timeNow.value < quote.value.expiresAt)
const flowType = computed(() => {
  const flow = route.query.flow
  return flow === 'acquire-supply' || flow === 'withdraw-sell' ? flow : null
})
const followUpFlow = computed(() => flowType.value ? resolveSwapFlow({
  flow: flowType.value,
  primaryStatus: primaryStatus.value,
  confirmedAmountBaseUnits: primaryAmountBaseUnits.value,
  followUpStatus: followUpStatus.value,
}) : null)
const executionEnabled = computed(() => readiness.value?.executionEnabled === true && quote.value?.executable === true && quoteFresh.value && !!buildIntent.value)
const localForkMode = computed(() => readiness.value?.executionMode === 'surfpool-local')
const withdrawalDisabled = computed(() => primaryStatus.value === 'pending'
  || primaryStatus.value === 'confirmed-amount-unknown' || !state.address || withdrawLimitStatus.value !== 'ready'
  || hasPendingLendingFlow(captureFlowContext(), 'withdraw'))
const supplyPending = computed(() => followUpStatus.value === 'pending'
  || hasPendingLendingFlow(captureFlowContext(), 'supply'))
const feeAmount = computed(() => {
  const fee = quote.value?.fee
  if (!fee) return null
  const token = tokens.find((candidate) => candidate.mint === fee.mint)
  return token ? `${formatBaseUnits(BigInt(fee.amountBaseUnits), token.decimals)} ${token.name}` : null
})
const tokenBalanceLabel = (token) => {
  if (!state.address) return 'Connect wallet to see balance'
  if (state.walletError) return 'Confirmed balance unavailable'
  const balance = state.balancesBaseUnits?.[token.token_id]
  if ((typeof balance !== 'string' && typeof balance !== 'bigint') || !/^\d+$/.test(String(balance))) {
    return 'Confirmed balance unavailable'
  }
  return `Balance ${formatBaseUnits(BigInt(balance), token.decimals)} ${token.name}`
}
const costDisclosure = computed(() => buildIntent.value?.costDisclosure ?? null)
const solCost = (lamports) => lamports == null ? 'Unavailable' : `${formatBaseUnits(BigInt(lamports), 9)} SOL`
const unavailableReasons = computed(() => [
  ...(readiness.value?.unavailableReasons ?? []),
  ...(quote.value?.executionUnavailableReasons ?? []).filter((reason) => reason.code !== 'execution-not-approved'),
])

function captureFlowContext(input = inputId.value, output = outputId.value) {
  return {
    wallet: state.address,
    flow: flowType.value,
    market: marketById(FLOW_MARKET_ID)?.id ?? FLOW_MARKET_ID,
    routeFlow: route.query.flow ?? null,
    inputId: input,
    outputId: output,
  }
}

function isFlowContextCurrent(context) {
  return flowContextMatches(context, captureFlowContext())
}

function hasPendingLendingFlow(context, stage) {
  return pendingFlowMatches(state.lendingPending, { ...context, stage })
}

function hasPendingSwapFlow(context, stage) {
  const pending = state.swapPending
  return pending?.wallet === context.wallet && pending.flow === context.flow
    && pending.stage === stage && ['awaiting-signature', 'signed-pending', 'submitted', 'relay-unknown', 'pending'].includes(pending.status)
}

async function readJson(path, init) {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `Server responded ${response.status}`)
  return body
}

async function loadReadiness() {
  try { readiness.value = await readJson('/api/swap-readiness') }
  catch (cause) { error.value = cause.message }
}

async function requestQuote() {
  if (!state.address) {
    error.value = 'Connect a Solana wallet to request a route quote.'
    return
  }
  const walletAddress = state.address
  const inputAsset = inputToken.value
  const outputAsset = outputToken.value
  const amountText = amount.value
  const slippage = slippageBps.value
  const flow = flowType.value
  const requestKey = JSON.stringify([walletAddress, inputAsset.mint, outputAsset.mint, amountText, slippage, flow])
  const request = quoteRequests.begin(requestKey)
  const currentKey = () => JSON.stringify([state.address, inputToken.value.mint, outputToken.value.mint, amount.value, slippageBps.value, flowType.value])
  busy.value = true
  quote.value = null
  buildIntent.value = null
  error.value = null
  try {
    const amountBaseUnits = amountToBaseUnits(amountText, inputAsset.decimals)
    if (flow === 'withdraw-sell') {
      if (primaryStatus.value !== 'confirmed') throw new Error('Withdraw free USDY before requesting its optional sale quote.')
      if (BigInt(amountBaseUnits) > BigInt(primaryAmountBaseUnits.value ?? '0')) throw new Error('Sale amount exceeds the confirmed free USDY withdrawal.')
    }
    const result = await readJson('/api/swap-quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: request.signal,
      body: JSON.stringify({
        wallet: walletAddress,
        inputMint: inputAsset.mint,
        outputMint: outputAsset.mint,
        amountBaseUnits,
        slippageBps: slippage,
      }),
    })
    if (!request.isCurrent(currentKey()) || state.address !== walletAddress) return
    quote.value = result
    timeNow.value = Date.now()
  } catch (cause) {
    if (request.isCurrent(currentKey())) error.value = cause.name === 'AbortError' ? null : cause.message
  } finally {
    if (request.isCurrent(currentKey())) busy.value = false
  }
}

async function buildSwapTransaction() {
  if (!quoteFresh.value || !state.address) return
  const walletAddress = state.address
  const inputAsset = inputToken.value
  const outputAsset = outputToken.value
  const amountText = amount.value
  const slippage = slippageBps.value
  const flow = flowType.value
  const requestKey = JSON.stringify([walletAddress, inputAsset.mint, outputAsset.mint, amountText, slippage, flow])
  const request = quoteRequests.begin(requestKey)
  const currentKey = () => JSON.stringify([state.address, inputToken.value.mint, outputToken.value.mint, amount.value, slippageBps.value, flowType.value])
  busy.value = true
  error.value = null
  try {
    const amountBaseUnits = amountToBaseUnits(amountText, inputAsset.decimals)
    if (flow === 'withdraw-sell' && BigInt(amountBaseUnits) > BigInt(primaryAmountBaseUnits.value ?? '0')) throw new Error('Sale amount exceeds the confirmed free USDY withdrawal.')
    const result = await readJson('/api/swap-build', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: request.signal,
      body: JSON.stringify({
        wallet: walletAddress, inputMint: inputAsset.mint, outputMint: outputAsset.mint,
        amountBaseUnits, slippageBps: slippage,
      }),
    })
    if (!request.isCurrent(currentKey()) || state.address !== walletAddress) return
    buildIntent.value = result
    quote.value = result.quote
    timeNow.value = Date.now()
  } catch (cause) {
    if (request.isCurrent(currentKey())) error.value = cause.name === 'AbortError' ? null : cause.message
  } finally {
    if (request.isCurrent(currentKey())) busy.value = false
  }
}

async function signSwap() {
  if (!executionEnabled.value || !buildIntent.value) return
  signing.value = true
  error.value = null
  const authorizedBuild = buildIntent.value
  const walletAddress = state.address
  const inputAsset = inputToken.value
  const outputAsset = outputToken.value
  const amountText = amount.value
  const slippage = slippageBps.value
  const flow = flowType.value
  const context = captureFlowContext()
  const flowAmountBaseUnits = flow === 'withdraw-sell' ? primaryAmountBaseUnits.value : null
  buildIntent.value = null
  try {
    const amountBaseUnits = amountToBaseUnits(amountText, inputAsset.decimals)
    const outcome = await signAndSendSwap({
      built: authorizedBuild,
      request: { wallet: walletAddress, inputMint: inputAsset.mint, outputMint: outputAsset.mint, amountBaseUnits, slippageBps: slippage },
      outputTokenId: outputAsset.token_id,
      flow,
      flowAmountBaseUnits,
    })
    if (outcome.status === 'pending') {
      if (isFlowContextCurrent(context)) {
        if (flow === 'withdraw-sell') followUpStatus.value = 'pending'
        else if (flow === 'acquire-supply') primaryStatus.value = 'pending'
        flowMessage.value = 'Swap signature pending wallet approval. Do not build a second swap until its outcome is known.'
      }
      return
    }
    if (!isFlowContextCurrent(context)) return
    if (outcome.status === 'failed') throw new Error(`Swap failed on-chain: ${outcome.error}`)
    buildIntent.value = null
    if (flow === 'withdraw-sell') {
      followUpStatus.value = 'confirmed'
      persistFlowOutcome('sell', 'confirmed', outcome.amountBaseUnits ?? null, outcome.signature, context)
    } else if (flow === 'acquire-supply') {
      primaryStatus.value = 'confirmed'
      primaryAmountBaseUnits.value = String(outcome.amountBaseUnits)
      persistFlowOutcome('swap', 'confirmed', primaryAmountBaseUnits.value, outcome.signature, context)
    }
    flowMessage.value = null
  } catch (cause) {
    if (!isFlowContextCurrent(context)) return
    error.value = cause.message
    const stage = flow === 'withdraw-sell' ? 'sell' : 'swap'
    const pending = hasPendingSwapFlow(context, stage)
      || hasPendingLendingFlow(context, stage)
    if (pending) {
      if (stage === 'sell') followUpStatus.value = 'pending'
      else primaryStatus.value = 'pending'
    } else {
      const rejected = cause.code === 'TRANSACTION_REJECTED' || /reject|cancel/i.test(cause.message)
      if (flow === 'withdraw-sell' && primaryStatus.value === 'confirmed') {
        followUpStatus.value = rejected ? 'declined' : 'failed'
        persistFlowOutcome('sell', followUpStatus.value, primaryAmountBaseUnits.value, null, context)
      } else if (flow === 'acquire-supply') {
        primaryStatus.value = rejected ? 'rejected' : 'failed'
        persistFlowOutcome('swap', primaryStatus.value, primaryAmountBaseUnits.value, null, context)
      }
    }
  } finally { if (isFlowContextCurrent(context)) signing.value = false }
}

async function refreshWithdrawLimit() {
  const wallet = state.address
  const context = captureFlowContext()
  if (!wallet || context.flow !== 'withdraw-sell') {
    withdrawLimitBaseUnits.value = null
    withdrawLimitUpdatedAt.value = null
    withdrawLimitSlot.value = null
    withdrawLimitStatus.value = 'unavailable'
    return
  }
  withdrawLimitStatus.value = 'loading'
  try {
    const allowance = await readJson(`/api/withdrawal-allowance/${wallet}`)
    if (!isFlowContextCurrent(context)) return
    if (typeof allowance.maxWithdrawBaseUnits !== 'string' || !/^\d+$/.test(allowance.maxWithdrawBaseUnits)) {
      throw new Error('Fresh free-withdrawal allowance is unavailable.')
    }
    withdrawLimitBaseUnits.value = allowance.maxWithdrawBaseUnits
    withdrawLimitUpdatedAt.value = allowance.updatedAt
    withdrawLimitSlot.value = allowance.slot
    withdrawLimitStatus.value = 'ready'
  } catch (cause) {
    if (!isFlowContextCurrent(context)) return
    withdrawLimitBaseUnits.value = null
    withdrawLimitUpdatedAt.value = null
    withdrawLimitSlot.value = null
    withdrawLimitStatus.value = 'unavailable'
    error.value = cause.message
  }
}

async function withdrawFreeUsdY() {
  if (flowType.value !== 'withdraw-sell' || !state.address) return
  const context = captureFlowContext()
  const walletAddress = context.wallet
  const flow = context.flow
  const amountText = amount.value
  const withdrawMarket = marketById('sol-usdy-usdc')
  const withdrawToken = tok('svm-usdy')
  if (hasPendingLendingFlow(context, 'withdraw')) {
    primaryStatus.value = 'pending'
    return
  }
  primaryStatus.value = 'pending'
  error.value = null
  let requestedBaseUnits = null
  try {
    withdrawLimitStatus.value = 'loading'
    const allowance = await readJson(`/api/withdrawal-allowance/${walletAddress}`)
    if (!isFlowContextCurrent(context)) return
    if (typeof allowance.maxWithdrawBaseUnits !== 'string' || !/^\d+$/.test(allowance.maxWithdrawBaseUnits)) {
      throw new Error('Fresh free-withdrawal allowance is unavailable.')
    }
    withdrawLimitBaseUnits.value = allowance.maxWithdrawBaseUnits
    withdrawLimitUpdatedAt.value = allowance.updatedAt
    withdrawLimitSlot.value = allowance.slot
    withdrawLimitStatus.value = 'ready'
    requestedBaseUnits = amountToBaseUnits(amountText, tok('svm-usdy').decimals)
    const limit = BigInt(allowance.maxWithdrawBaseUnits)
    const requested = BigInt(requestedBaseUnits)
    if (requested > limit) throw new Error('Requested amount exceeds Kamino’s fresh free-withdrawal allowance.')
    if (requested <= 0n) throw new Error('Enter a positive free USDY withdrawal amount.')
    const signature = await sendKaminoAction('withdraw', {
      market: withdrawMarket, token: withdrawToken, amountBaseUnits: requestedBaseUnits, all: false,
      swapFlow: 'withdraw-sell', swapFlowStage: 'withdraw', flowAmountBaseUnits: String(requested),
    })
    if (!isFlowContextCurrent(context) || !signature) return
    const transaction = await readJson(`/api/tx/${signature}`)
    if (!isFlowContextCurrent(context)) return
    const received = BigInt(confirmedSwapAmountFromTransaction(transaction, walletAddress, tok('svm-usdy').mint))
    if (received <= 0n || received > requested) throw new Error('Confirmed withdrawal amount could not be verified from fresh wallet balances.')
    primaryStatus.value = 'confirmed'
    primaryAmountBaseUnits.value = String(received)
    const direction = normalizeSwapFlowDirection('withdraw-sell')
    inputId.value = direction.inputId
    outputId.value = direction.outputId
    amount.value = baseUnitsToAmount(String(received), tok('svm-usdy').decimals)
    quote.value = null
    buildIntent.value = null
    flowMessage.value = `Withdrawal confirmed${signature ? ` (${signature.slice(0, 8)}…)` : ''}. Only ${amount.value} USDY is available for this optional sale.`
    persistFlowOutcome('withdraw', 'confirmed', String(received), signature, captureFlowContext())
    await loadAccount(true)
  } catch (cause) {
    if (!isFlowContextCurrent(context)) return
    const recovered = recoverConfirmedWithdrawal(state.swapOutcome, {
      wallet: walletAddress, flow, market: FLOW_MARKET_ID, requestedBaseUnits,
    })
    if (recovered?.status === 'confirmed') {
      primaryStatus.value = 'confirmed'
      primaryAmountBaseUnits.value = recovered.amountBaseUnits
      const direction = normalizeSwapFlowDirection('withdraw-sell')
      inputId.value = direction.inputId
      outputId.value = direction.outputId
      amount.value = baseUnitsToAmount(recovered.amountBaseUnits, tok('svm-usdy').decimals)
      quote.value = null
      buildIntent.value = null
      flowMessage.value = `Withdrawal confirmed. ${amount.value} USDY is available for an optional sale.`
      error.value = null
      await loadAccount(true)
      return
    }
    if (recovered?.status === 'confirmed-amount-unknown') {
      primaryStatus.value = 'confirmed-amount-unknown'
      flowMessage.value = 'Withdrawal confirmed. Nysa is still checking the transaction amount; the optional sale stays disabled until it can be verified.'
      error.value = null
      return
    }
    const pending = hasPendingLendingFlow(context, 'withdraw')
    if (pending) {
      primaryStatus.value = 'pending'
      flowMessage.value = 'Withdrawal signature outcome is still unknown. Keep this page open while Nysa checks it before allowing another withdrawal.'
    } else if (state.swapOutcome?.wallet === walletAddress && state.swapOutcome?.flow === flow
      && state.swapOutcome?.stage === 'withdraw' && state.swapOutcome?.status === 'confirmed-amount-unknown') {
      primaryStatus.value = 'confirmed-amount-unknown'
    } else {
      primaryStatus.value = cause.code === 'TRANSACTION_REJECTED' || /reject|cancel/i.test(cause.message) ? 'rejected' : 'failed'
    }
    if (!pending && withdrawLimitStatus.value === 'loading') withdrawLimitStatus.value = 'unavailable'
    error.value = cause.message
  }
}

async function supplyConfirmedUsdY() {
  if (flowType.value !== 'acquire-supply' || !state.address || !primaryAmountBaseUnits.value) return
  const context = captureFlowContext()
  const walletAddress = context.wallet
  const flow = context.flow
  const amountBaseUnits = primaryAmountBaseUnits.value
  const supplyMarket = marketById('sol-usdy-usdc')
  const supplyToken = tok('svm-usdy')
  if (hasPendingLendingFlow(context, 'supply')) {
    followUpStatus.value = 'pending'
    return
  }
  followUpStatus.value = 'pending'
  try {
    await sendKaminoAction('deposit', {
      market: supplyMarket, token: supplyToken, amountBaseUnits: String(amountBaseUnits), all: false,
      swapFlow: flow, swapFlowStage: 'supply', flowAmountBaseUnits: amountBaseUnits,
    })
    if (!isFlowContextCurrent(context)) return
    followUpStatus.value = 'confirmed'
    flowMessage.value = 'The confirmed USDY amount was supplied.'
    persistFlowOutcome('supply', 'confirmed', amountBaseUnits, null, context)
    await loadAccount(true)
  } catch (cause) {
    if (!isFlowContextCurrent(context)) return
    if (hasPendingLendingFlow(context, 'supply')) {
      followUpStatus.value = 'pending'
      flowMessage.value = 'Supply signature outcome is still unknown. The confirmed USDY remains reserved from another supply attempt until reconciliation finishes.'
      return
    }
    followUpStatus.value = cause.code === 'TRANSACTION_REJECTED' || /reject|cancel/i.test(cause.message) ? 'declined' : 'failed'
    flowMessage.value = 'USDY remains in your wallet. You can supply it later from the market page.'
    persistFlowOutcome('supply', followUpStatus.value, amountBaseUnits, null, context)
  }
}

function keepConfirmedUsdY() {
  if (followUpFlow.value?.status === 'offer-next') {
    followUpStatus.value = 'declined'
    flowMessage.value = 'USDY remains in your wallet; no further transaction was sent.'
    persistFlowOutcome('supply', 'declined', primaryAmountBaseUnits.value)
  }
}

function skipUsdYSale() {
  followUpStatus.value = 'declined'
  flowMessage.value = 'USDY remains in your wallet; no sale transaction was sent.'
  persistFlowOutcome('sell', 'declined', primaryAmountBaseUnits.value)
}

function persistFlowOutcome(stage, status, amountBaseUnits, signature = null, context = captureFlowContext()) {
  if (!context.flow || !context.wallet || !isFlowContextCurrent(context)) return false
  state.swapOutcome = {
    wallet: context.wallet, market: context.market, flow: context.flow, stage, status,
    amountBaseUnits: amountBaseUnits == null ? null : String(amountBaseUnits),
    primaryAmountBaseUnits: primaryAmountBaseUnits.value == null ? null : String(primaryAmountBaseUnits.value),
    signature, inputId: context.inputId, outputId: context.outputId,
  }
  try { localStorage.setItem('nysaSwapFlowOutcome', JSON.stringify(state.swapOutcome)) } catch { /* storage may be unavailable */ }
  return true
}

function flipPair() {
  const previous = inputId.value
  inputId.value = outputId.value
  outputId.value = previous
}

watch([inputId, outputId, amount, slippageBps, () => state.address], () => {
  quoteRequests.invalidate()
  quote.value = null
  buildIntent.value = null
  busy.value = false
  if (flowType.value === 'withdraw-sell' && primaryStatus.value === 'confirmed' && primaryAmountBaseUnits.value && state.address) {
    amount.value = baseUnitsToAmount(primaryAmountBaseUnits.value, tok('svm-usdy').decimals)
  }
})
watch(() => state.address, (wallet, previous) => {
  if (wallet === previous) return
  signing.value = false
  primaryStatus.value = 'idle'
  primaryAmountBaseUnits.value = null
  followUpStatus.value = null
  flowMessage.value = null
  withdrawLimitBaseUnits.value = null
  withdrawLimitUpdatedAt.value = null
  withdrawLimitSlot.value = null
  if (wallet) {
    restoreSavedFlowOutcome()
    if (flowType.value === 'withdraw-sell') refreshWithdrawLimit()
  } else withdrawLimitStatus.value = 'unavailable'
})
watch(() => route.query.flow, () => {
  signing.value = false
  primaryStatus.value = 'idle'
  primaryAmountBaseUnits.value = null
  followUpStatus.value = null
  flowMessage.value = null
  quote.value = null
  buildIntent.value = null
  const direction = routeSwapDirection(flowType.value, route.query.input, route.query.output)
  inputId.value = direction.inputId
  outputId.value = direction.outputId
  restoreSavedFlowOutcome()
  if (flowType.value === 'withdraw-sell') refreshWithdrawLimit()
})
function restoreSavedFlowOutcome() {
  const saved = state.swapOutcome
  const updated = applySwapFlowOutcome({
    primaryStatus: primaryStatus.value,
    primaryAmountBaseUnits: primaryAmountBaseUnits.value,
    followUpStatus: followUpStatus.value,
    inputId: inputId.value,
    outputId: outputId.value,
  }, saved, state.address, flowType.value)
  primaryStatus.value = updated.primaryStatus
  primaryAmountBaseUnits.value = updated.primaryAmountBaseUnits
  followUpStatus.value = updated.followUpStatus
  inputId.value = updated.inputId
  outputId.value = updated.outputId
  if (flowType.value === 'withdraw-sell' && primaryAmountBaseUnits.value) {
    amount.value = baseUnitsToAmount(primaryAmountBaseUnits.value, tok('svm-usdy').decimals)
  }
}
watch(() => state.swapOutcome, (outcome) => {
  if (!outcome || outcome.wallet !== state.address || outcome.flow !== flowType.value
    || outcome.market != null && outcome.market !== FLOW_MARKET_ID
    || outcome.inputId != null && (outcome.inputId !== inputId.value || outcome.outputId !== outputId.value)) return
  if (outcome?.stage === 'withdraw' && outcome.status === 'confirmed-amount-unknown') {
    primaryStatus.value = 'confirmed-amount-unknown'
    flowMessage.value = 'Withdrawal confirmed. Nysa is still checking the transaction amount; the optional sale stays disabled until it can be verified.'
    return
  }
  restoreSavedFlowOutcome()
})
onMounted(() => {
  loadReadiness()
  restoreSavedFlowOutcome()
  if (flowType.value === 'withdraw-sell') refreshWithdrawLimit()
  clockTimer = setInterval(() => { timeNow.value = Date.now() }, 1000)
})
onUnmounted(() => { clearInterval(clockTimer); quoteRequests.invalidate() })
</script>

<template>
  <div class="n-page-head">
    <h1 class="n-h1">Swap</h1>
    <p class="n-sub">Review a Jupiter route between assets in Nysa’s active USDY market.</p>
  </div>

  <div v-if="error" class="n-banner warn page-alert" role="status">{{ error }}</div>
  <div v-if="!state.address" class="n-banner page-alert">Connect a wallet to request a route quote.</div>
  <div v-if="state.swapPending" class="n-banner warn page-alert" role="status">A swap signature is pending or its balance outcome is unknown. Check the signature before retrying.</div>

  <div class="swap-workspace">
    <section class="n-panel swap-panel">
      <div class="panel-heading"><h2>Swap details</h2></div>
      <label class="field">
        <span>{{ flowType === 'withdraw-sell' && primaryStatus !== 'confirmed' ? 'USDY to withdraw' : 'You pay' }}</span>
        <div class="asset-input">
          <input v-model="amount" :readonly="flowType === 'withdraw-sell' && primaryStatus === 'confirmed'" inputmode="decimal" autocomplete="off" aria-label="Swap amount" />
          <select v-model="inputId" :disabled="!!flowType" aria-label="Input asset">
            <option v-for="token in tokens" :key="token.token_id" :value="token.token_id">{{ token.name }}</option>
          </select>
        </div>
        <span class="balance-label" aria-live="polite">{{ tokenBalanceLabel(inputToken) }}</span>
      </label>
      <button class="flip" :disabled="!!flowType" aria-label="Switch swap assets" @click="flipPair">↕</button>
      <label class="field">
        <span>You receive</span>
        <div class="asset-input">
          <input :value="quoteFresh ? formatBaseUnits(BigInt(quote.outputAmountBaseUnits), outputToken.decimals) : '—'" readonly aria-label="Estimated output" />
          <select v-model="outputId" :disabled="!!flowType" aria-label="Output asset">
            <option v-for="token in tokens" :key="token.token_id" :value="token.token_id">{{ token.name }}</option>
          </select>
        </div>
        <span class="balance-label" aria-live="polite">{{ tokenBalanceLabel(outputToken) }}</span>
      </label>
      <label class="field slippage-field">
        <span>Slippage limit</span>
        <div class="slippage">{{ (slippageBps / 100).toFixed(2) }}%</div>
        <input v-model.number="slippageBps" type="range" min="0" max="50" step="1" aria-label="Slippage limit in basis points" />
      </label>
      <button v-if="flowType === 'withdraw-sell' && primaryStatus !== 'confirmed'" class="n-btn-grad quote-button" :disabled="withdrawalDisabled" @click="withdrawFreeUsdY">
        {{ primaryStatus === 'pending' ? 'Confirming withdrawal…' : primaryStatus === 'confirmed-amount-unknown' ? 'Verifying confirmed amount…' : 'Withdraw free USDY' }}
      </button>
      <button v-else class="n-btn-grad quote-button" :disabled="busy || inputId === outputId || !state.address || readiness?.quoteEnabled === false" @click="requestQuote">
        {{ busy && !quote ? 'Getting route…' : 'Get quote' }}
      </button>
      <p class="helper">Quotes expire after 15 seconds. One Nysa fee of 10 bps applies per swap, regardless of route hops.</p>
      <p v-if="flowType === 'withdraw-sell' && primaryStatus !== 'confirmed'" class="helper follow-up">
        <template v-if="withdrawLimitStatus === 'ready'">Fresh free-withdrawal allowance: {{ formatBaseUnits(BigInt(withdrawLimitBaseUnits), tokenById['svm-usdy'].decimals) }} USDY, updated {{ new Date(withdrawLimitUpdatedAt).toLocaleString() }} at slot {{ withdrawLimitSlot }}.</template>
        <template v-else-if="withdrawLimitStatus === 'loading'">Refreshing the free-withdrawal allowance…</template>
        <template v-else>Fresh free-withdrawal allowance is unavailable. Withdrawals stay disabled until the market and obligation refresh succeeds.</template>
        Locked collateral cannot be withdrawn through this flow.
        <button v-if="withdrawLimitStatus === 'unavailable' && state.address" class="n-btn-sm ghost" @click="refreshWithdrawLimit">Refresh allowance</button>
      </p>
      <p v-if="flowType === 'acquire-supply'" class="helper follow-up">After a swap confirms, you may optionally supply the confirmed USDY amount. The app will not use locked collateral.</p>
      <p v-if="flowMessage" class="helper follow-up">{{ flowMessage }}</p>
    </section>

    <section class="n-panel route-panel">
      <div class="panel-heading">
        <h2>Route review</h2>
        <span v-if="quote" class="n-chip" :class="quoteFresh ? 'fresh' : 'stale'">{{ quoteFresh ? 'Quote active' : 'Quote expired' }}</span>
        <span v-else class="n-chip">Awaiting quote</span>
      </div>
      <template v-if="quote">
        <div class="route-summary">
          <div><span>Minimum received</span><b>{{ formatBaseUnits(BigInt(quote.minimumOutputBaseUnits), outputToken.decimals) }} {{ outputToken.name }}</b></div>
          <div><span>Nysa fee · 10 bps</span><b>{{ feeAmount ?? 'Unavailable' }}</b></div>
          <div><span>Price impact</span><b>{{ Number(quote.priceImpactPct).toFixed(3) }}%</b></div>
          <div><span>Slippage limit</span><b>{{ (quote.slippageBps / 100).toFixed(2) }}%</b></div>
        </div>
        <div v-if="quote.routePlan.length" class="route-legs">
          <div v-for="(leg, index) in quote.routePlan" :key="`${leg.label}-${index}`" class="route-leg">
            <span>{{ leg.label }}</span><span>{{ leg.percent == null ? '—' : `${leg.percent}%` }}</span>
          </div>
        </div>
        <p class="footnote">Provider route: {{ quote.provider }}. {{ localForkMode ? 'Surfpool-local mode checks cloned executable programs and simulated fee deltas before allowing a disposable wallet to sign.' : 'Route quote is shown for review; unverified programs and fee-account balance deltas cannot be signed.' }}</p>
        <p v-if="!quoteFresh" class="review-state" role="status">This quote expired. Get a fresh quote from the swap panel before building a transaction.</p>
        <button v-if="!buildIntent && quoteFresh" class="n-btn-grad quote-button" :disabled="busy || !state.address || readiness?.executionEnabled !== true" @click="buildSwapTransaction">
          {{ busy ? 'Building and simulating…' : 'Build transaction' }}
        </button>
      </template>
      <p v-else-if="busy" class="review-state">{{ buildIntent ? 'Building and simulating the transaction…' : 'Getting a route quote…' }}</p>
      <p v-else class="review-state">Enter an amount and request a quote to review route, fees, and minimum received.</p>

      <div class="execution-review">
        <div class="panel-heading"><h3>Execution readiness</h3><span class="n-chip" :class="executionEnabled ? 'ready' : 'blocked'">{{ executionEnabled ? 'Ready' : 'Not ready' }}</span></div>
        <div v-if="costDisclosure" class="cost-disclosure" aria-label="Estimated swap costs">
          <p><span>Base network fee</span><b>{{ solCost(costDisclosure.baseNetworkFeeLamports) }}</b></p>
          <p><span>Priority fee</span><b>{{ solCost(costDisclosure.priorityFeeLamports) }}</b></p>
          <p><span>New token account rent (upper bound)</span><b>{{ solCost(costDisclosure.accountRentLamports) }}</b></p>
          <p v-if="costDisclosure.accountRentEstimateKind === 'upper-bound'" class="cost-unavailable">Assumes each route setup account is new; existing token accounts may lower the rent charged.</p>
          <p v-if="costDisclosure.status !== 'known'" class="cost-unavailable">One or more cost estimates are unavailable. Review the wallet’s final transaction cost before approval.</p>
        </div>
        <p v-if="executionEnabled" class="n-muted">{{ localForkMode ? 'The server simulated this exact route on local Surfpool and verified its fee delta. Review the route before signing with a disposable wallet.' : 'The server simulated this exact route and authorized its transaction message. Confirm the route details above before signing.' }}</p>
        <ul v-else-if="unavailableReasons.length" class="reason-list">
          <li v-for="(reason, index) in unavailableReasons" :key="`${reason.code}-${index}`">{{ reason.message }}</li>
        </ul>
        <p v-else class="n-muted">Swap execution is disabled until route, fee, and wallet checks pass.</p>
        <button v-if="buildIntent && quoteFresh && quote?.executable" class="n-btn-grad sign-button" :disabled="!executionEnabled || signing || !!state.swapPending" :title="executionEnabled ? 'Sign the reviewed route' : 'Swap execution is not approved'" @click="signSwap">
          {{ signing ? 'Waiting for wallet…' : 'Sign swap' }}
        </button>
      </div>
    </section>
  </div>

  <section v-if="followUpFlow?.status === 'offer-next' && flowType === 'acquire-supply'" class="n-panel status-panel">
    <h2>Swap confirmed</h2>
    <p>{{ formatBaseUnits(BigInt(primaryAmountBaseUnits), tokenById['svm-usdy'].decimals) }} USDY received. You can supply this confirmed amount or keep it in your wallet.</p>
    <button class="n-btn-grad" :disabled="supplyPending" @click="supplyConfirmedUsdY">{{ supplyPending ? 'Confirming supply…' : 'Supply USDY' }}</button>
    <button class="n-btn-sm ghost" :disabled="supplyPending" @click="keepConfirmedUsdY">Keep in wallet</button>
  </section>
  <section v-if="flowType === 'withdraw-sell' && primaryStatus === 'confirmed'" class="n-panel status-panel">
    <h2>Free withdrawal confirmed</h2>
    <p>{{ formatBaseUnits(BigInt(primaryAmountBaseUnits), tokenById['svm-usdy'].decimals) }} USDY received. You may review an optional sale route. If you decline or the sale fails, USDY stays in your wallet.</p>
    <p v-if="followUpFlow?.status === 'complete'" class="n-muted">Optional sale confirmed.</p>
    <button v-if="followUpFlow?.status === 'offer-next'" class="n-btn-sm ghost" @click="skipUsdYSale">Keep USDY and skip sale</button>
  </section>
</template>

<style scoped>
.swap-workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: stretch; gap: 20px; }
.swap-panel { display: flex; flex-direction: column; align-items: stretch; gap: 16px; }
.swap-panel .panel-heading { margin: 0; }
.swap-panel .panel-heading h2 { margin: 0; font-size: 17px; }
.field { display: grid; gap: 8px; color: var(--n-text-2); font-size: 13px; }
.asset-input { display: flex; align-items: center; gap: 10px; border: 1px solid var(--n-line); border-radius: 12px; background: var(--n-bg-2); padding: 0 10px 0 14px; }
.asset-input:focus-within { border-color: var(--n-pink); box-shadow: 0 0 0 2px #ec008c33; }
.asset-input input { min-width: 0; width: 100%; padding: 14px 0; border: 0; outline: 0; color: var(--n-text); background: transparent; font: inherit; font-size: 18px; font-variant-numeric: tabular-nums; }
.asset-input select { border: 0; color: var(--n-text); background: var(--n-bg-2); font: inherit; font-weight: 600; padding: 10px 6px; }
.balance-label { color: var(--n-text-3); font-size: 12px; }
.flip { height: 42px; border: 1px solid var(--n-line); border-radius: 50%; color: var(--n-text-2); background: var(--n-bg-2); font-size: 20px; cursor: pointer; }
.flip:focus-visible { outline: 2px solid var(--n-pink); outline-offset: 2px; }
.slippage-field { grid-template-columns: 1fr auto; align-items: center; }
.slippage-field > span { grid-column: 1; }
.slippage-field > input { grid-column: 1 / -1; width: 100%; accent-color: var(--n-pink); }
.slippage { color: var(--n-text); font-variant-numeric: tabular-nums; }
.quote-button { min-height: 44px; }
.helper,.footnote { margin: 0; color: var(--n-text-3); font-size: 12px; line-height: 1.6; }
.page-alert { margin-bottom: 14px; }
.route-panel { margin-top: 0; }
.status-panel { margin-top: 20px; }
.execution-review { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--n-line); }
.execution-review .panel-heading h3 { margin: 0; font-size: 15px; }
.review-state { min-height: 72px; margin: 0; display: flex; align-items: center; color: var(--n-text-3); font-size: 13px; line-height: 1.55; }
.panel-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
.panel-heading h2 { margin: 0; font-size: 17px; }
.n-chip.fresh { color: var(--n-green); }
.n-chip.stale,.n-chip.blocked { color: var(--n-amber); }
.route-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; }
.route-summary > div { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--n-text-3); }
.route-summary b { color: var(--n-text); text-align: right; font-variant-numeric: tabular-nums; }
.route-legs { display: grid; gap: 8px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--n-line); }
.route-leg { display: flex; justify-content: space-between; color: var(--n-text-2); font-size: 13px; }
.footnote { margin-top: 16px; }
.reason-list { display: grid; gap: 8px; margin: 0 0 18px; padding-left: 18px; color: var(--n-text-2); font-size: 13px; line-height: 1.5; }
.cost-disclosure { display: grid; gap: 7px; margin: 0 0 16px; padding: 12px; border: 1px solid var(--n-line); border-radius: 10px; color: var(--n-text-3); font-size: 12px; }
.cost-disclosure p { display: flex; justify-content: space-between; gap: 12px; margin: 0; }
.cost-disclosure b { color: var(--n-text); font-variant-numeric: tabular-nums; }
.cost-disclosure .cost-unavailable { display: block; line-height: 1.5; }
@media (max-width: 860px) { .swap-workspace { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 620px) {
  .swap-panel { gap: 14px; }
  .asset-input { padding-left: 10px; gap: 4px; }
  .asset-input input { font-size: 16px; }
  .asset-input select { max-width: 88px; font-size: 12px; }
  .route-summary { grid-template-columns: 1fr; }
}
</style>
