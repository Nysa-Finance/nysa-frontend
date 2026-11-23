<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { sendLoopAction, sendLoopSetup, state, priceOf, useTx } from '../store.js'
import { LOOP_ENABLED, LOOPS, TOKENS, loopById, loopByMarket, loopMarket, tok } from '../config.js'
import { amt, pct, usd, usdFull, num, floorTo, hfText, cleanAmount } from '../logic.js'
import { formatBaseUnits } from '../swap-fees.js'
import { loopPreviewRequestMatches } from '../loop-preview-request.js'
import { selectedLoopCloseReadiness } from '../loop-positions.js'
import TokenIcon from '../components/TokenIcon.vue'
import TxProgress from '../components/TxProgress.vue'
import NotFound from './NotFound.vue'

const route = useRoute()
const router = useRouter()
// /loop lists the loops (or your positions), /loop/<id> opens one. One component, so the progress sheet survives the move.
const asset = computed(() => route.params.asset || null)
const loop = computed(() => loopById(asset.value) ?? LOOPS[0]) // the open form's loop
const coll = computed(() => tok(loop.value.collateral))
const debt = computed(() => tok(loop.value.debt)) // also what funds the loop: with the borrowed debt it buys the collateral
const fundingAmount = ref('')
watch(fundingAmount, (v) => { fundingAmount.value = cleanAmount(v, debt.value.decimals) })
const leverage = ref(loop.value.maxLeverage)
watch(loop, (l) => { leverage.value = l.maxLeverage })
const strategy = ref(null)
const preview = ref(null)
const loading = ref(false)
const { tx, run, reset } = useTx()
const acting = computed(() => tx.status === 'running')
const carryAcknowledged = ref(false)
const error = ref(null)
const previewError = ref(null)
const quotedAt = ref(0)
const clock = ref(Date.now())
const highlight = ref(null)
const setupRequired = ref(false)
const setupLoading = ref(false)
const setupError = ref(null)
const previewBinding = ref(null)
let previewRequestSequence = 0
let setupStatusSequence = 0
const tab = ref(route.query.position ? 'positions' : 'loops')
watch(() => route.query.position, (p) => { if (p) tab.value = 'positions' })
const openAsset = (l) => router.push({ name: 'loop', params: { asset: l.id } })
const strategies = computed(() => strategy.value?.strategies ?? [])
const strategyOf = (l) => strategies.value.find((item) => item.id === l?.market)
const executionMode = computed(() => preview.value?.executionMode ?? strategy.value?.executionMode ?? null)
const localForkMode = computed(() => executionMode.value === 'surfpool-local')
const fees = computed(() => preview.value?.fees ?? [])
const feeBps = computed(() => fees.value[0]?.bps ?? state.feeBps ?? 0) // Nysa's swap fee; 0 = none
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
  const readiness = preview.value?.actionReadiness ?? strategyOf(loop.value)?.actions?.open ?? null
  const unavailableReasons = (readiness?.unavailableReasons ?? []).filter((reason) => !(carryAcknowledged.value
    && ['carry-acknowledgement-required', 'preview-acknowledgement-invalid'].includes(reason.code)))
  const carryIsAcknowledged = !preview.value?.carry?.requiresAcknowledgement || carryAcknowledged.value
  return { ...readiness, unavailableReasons, executionEnabled: previewIsCurrent.value && !!preview.value?.available && carryIsAcknowledged && unavailableReasons.length === 0 }
})
const entryBlockers = computed(() => {
  const reasons = preview.value
    ? [...(preview.value.unavailableReasons ?? []), ...(openReadiness.value?.unavailableReasons ?? [])]
    : [...(strategyOf(loop.value)?.unavailableReasons ?? []), ...(strategyOf(loop.value)?.actions?.open?.unavailableReasons ?? [])]
  const acknowledgementReasons = ['carry-acknowledgement-required', 'preview-acknowledgement-invalid']
  const visibleReasons = preview.value ? reasons : reasons.filter((reason) => !acknowledgementReasons.includes(reason.code))
  const filtered = visibleReasons.filter((reason) => !(carryAcknowledged.value && acknowledgementReasons.includes(reason.code)))
  return [...new Map(filtered.map((reason) => [reason.message, reason])).values()]
})

// Quotes come by themselves, like a swap app's: once typing settles, then every ~15s while the page is visible. A failed
// refresh keeps the last good quote. Opening always takes a fresh one (openLoop).
let quoteTimer = null
const scheduleQuote = (ms = 600) => { clearTimeout(quoteTimer); quoteTimer = setTimeout(runPreview, ms) }
function invalidatePreview() {
  previewRequestSequence++
  preview.value = null
  previewBinding.value = null
  carryAcknowledged.value = false
  loading.value = false
  previewError.value = null
  scheduleQuote()
}
watch([fundingAmount, leverage, loop], invalidatePreview)
const ticker = setInterval(() => {
  clock.value = Date.now()
  if (asset.value && document.visibilityState === 'visible' && !acting.value && !loading.value && previewIsCurrent.value
    && clock.value - quotedAt.value > 15_000) runPreview()
}, 1000)
onBeforeUnmount(() => { clearInterval(ticker); clearTimeout(quoteTimer) })
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
  setupError.value = null
  if (await run([{ label: 'Set up Kamino account', run: () => sendLoopSetup({ market: loop.value.market }) }]) && state.address === wallet) {
    setupRequired.value = false
    await loadSetupStatus()
    invalidatePreview()
  }
}

async function runPreview() {
  if (!state.address || !(num(fundingAmount.value) > 0)) return
  const request = currentPreviewRequest()
  const requestId = ++previewRequestSequence
  const binding = { ...request, requestId }
  loading.value = true
  try {
    const response = await fetch('/api/loop-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketId: loop.value.market, fundingAmount: request.fundingAmount, leverage: request.leverage, wallet: request.wallet }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'Could not build the preview.')
    if (!loopPreviewRequestMatches({ request, current: currentPreviewRequest(), requestId, currentRequestId: previewRequestSequence })) return
    // A refresh keeps the user's acknowledgement while the new quote still needs one.
    carryAcknowledged.value = carryAcknowledged.value && body.carry?.requiresAcknowledgement === true
    preview.value = body
    previewBinding.value = binding
    quotedAt.value = Date.now()
    previewError.value = null
  } catch (cause) {
    if (loopPreviewRequestMatches({ request, current: currentPreviewRequest(), requestId, currentRequestId: previewRequestSequence })) previewError.value = friendly(cause)
  } finally {
    if (requestId === previewRequestSequence) loading.value = false
  }
}

// Server answers that only mean "time or prices moved": nothing was sent, so the action is rebuilt once with a fresh
// quote and the wallet asked again. Anything else (a rejection in the wallet, a balance, a failed transaction) is shown.
const MOVED = /intent|expired|preview|stale|changed after|authorization changed|quote|oracle|carry|simulation effects/i
const retriable = (e) => (e?.code === 'TRANSACTION_REJECTED' || [400, 503].includes(e?.status)) && MOVED.test(e?.message ?? '')
function friendly(e) {
  const message = e?.message ?? String(e ?? '')
  if (/reject|cancel/i.test(message) || e?.code === 'PENDING_TRANSACTION') return message
  if (MOVED.test(message)) return 'Prices moved while this was being prepared. Try again.'
  if (/failed on-chain/i.test(message)) return 'The transaction failed on-chain, so nothing changed (only the network fee was spent). Try again.'
  return message
}
// Runs a loop action in the shared progress sheet; once, a "prices moved" answer rebuilds it with a fresh quote.
async function loopAction(label, attempt) {
  return run([{ label, run: async () => {
    for (let tries = 0; ; tries++) {
      try {
        const signature = await attempt()
        tx.steps[0] = label
        return signature
      } catch (e) {
        if (tries === 0 && retriable(e)) { tx.steps[0] = 'Quote refreshed: approve the updated transaction'; continue }
        throw new Error(friendly(e), { cause: e })
      }
    }
  } }])
}

// The build reuses the preview's swap quote, which must be seconds old: a fresh quote first, then the build at once.
async function openLoop() {
  if (!openReadiness.value?.executionEnabled) return
  const l = loop.value, c = coll.value, d = debt.value
  const before = new Set(positions.value.map((p) => p.id))
  const ok = await loopAction('Open loop', async () => {
    await runPreview()
    const actionPreview = preview.value
    const request = currentPreviewRequest()
    if (!openReadiness.value?.executionEnabled || !previewIsCurrent.value || !actionPreview?.previewId) {
      throw new Error(previewError.value ?? 'This loop can\'t be opened right now. Try again in a moment.')
    }
    return sendLoopAction('loop-open', {
      market: l.market, amount: request.fundingAmount, leverage: request.leverage,
      previewId: actionPreview.previewId,
      acknowledgementKey: actionPreview.carry?.requiresAcknowledgement ? actionPreview.carry.acknowledgementKey : undefined,
    })
  })
  if (!ok) return
  const opened = positions.value.find((p) => !before.has(p.id)) ?? positions.value[0]
  if (opened) {
    const v = positionView(opened)
    highlight.value = opened.id
    tx.note = `${amt(v.coll, 2)} ${c.name} collateral, ${amt(Number(opened.liability.amount), 2)} ${d.name} debt, ${v.leverage ? lev(v.leverage) : ''} leverage. Liquidation if ${c.name} falls to $${v.liqPrice?.toFixed(4)}.`
  }
  fundingAmount.value = ''
  tab.value = 'positions'
  router.push({ name: 'loop' })
}

async function closeLoop(position) {
  if (!positionView(position).readiness?.executionEnabled) return
  const d = tok(position.liability.tokenId)
  const before = state.balances[d.token_id] ?? 0
  const ok = await loopAction('Close loop', () => sendLoopAction('loop-close', { market: position.market.id, positionId: position.id }))
  if (ok) tx.note = `${amt(Math.max(0, (state.balances[d.token_id] ?? 0) - before), 2)} ${d.name} returned to your wallet.`
}

const feeLabel = (fee) => { const t = Object.values(TOKENS).find((x) => x.mint === fee.mint); return `${formatBaseUnits(BigInt(fee.amountBaseUnits), t.decimals)} ${t.name}` }
const lev = (value) => `${Number(value).toFixed(2).replace(/0$/, '')}×`

// Estimates for the chosen leverage, before any quote: the summary moves with the slider; a preview replaces the token
// amounts with the quoted ones.
const ratesOf = (l) => {
  const a = strategyOf(l)?.carry?.assumptions ?? {}
  const supply = Number(a.collateralSupplyAprPct ?? 0), native = a.collateralNativeApyPct, borrow = a.liabilityBorrowAprPct
  return { hold: supply + Number(native ?? 0), native: native ?? null, nativeSource: a.collateralNativeApySource, borrow: borrow ?? null }
}
const rates = computed(() => ratesOf(loop.value))
const netApyOf = (l, L) => { const r = ratesOf(l); return r.borrow == null ? null : r.hold * L - r.borrow * (L - 1) }
const netApyAt = (L) => netApyOf(loop.value, L)
const reserve = (l, id) => state.reserves[l.market]?.[id]
const marketOf = (l) => ({
  deposited: reserve(l, l.collateral)?.supplyUsd,
  liquidity: reserve(l, l.debt) ? reserve(l, l.debt).availableLiquidity * reserve(l, l.debt).price : undefined,
})
const market = computed(() => marketOf(loop.value))
const liqLtvOf = (l) => reserve(l, l.collateral)?.liqLtv ?? loopMarket(l).pairs.find((p) => p.collateral === l.collateral)?.liqLtv
const liqLtv = computed(() => liqLtvOf(loop.value))
const collPrice = computed(() => priceOf(loop.value.collateral))
const amount = computed(() => num(fundingAmount.value))
// Your funding is the equity: with the borrowed debt it buys `leverage` times its value in collateral.
const est = computed(() => {
  const L = Number(leverage.value), ltv = (L - 1) / L
  const quoted = previewIsCurrent.value && preview.value?.exposure?.source === 'kamino-sdk-net-route' ? preview.value.exposure : null
  const debtPrice = priceOf(loop.value.debt)
  const equityUsd = amount.value * debtPrice
  const debtAmount = quoted ? Number(quoted.debtAmount) : (equityUsd * (L - 1)) / debtPrice
  return {
    collateral: quoted ? Number(quoted.collateralAmount) : (equityUsd * L) / collPrice.value,
    debt: debtAmount,
    swap: amount.value + debtAmount,
    ltv: ltv * 100,
    hf: (liqLtv.value / 100) / ltv,
    liqPrice: (collPrice.value * ltv) / (liqLtv.value / 100),
    netApy: netApyAt(L),
  }
})
const health = (hf) => (hf >= 1.8 ? ['ok', 'Safe'] : hf >= 1.3 ? ['warn', 'Medium'] : ['bad', 'Risky'])
const setPct = (p) => { fundingAmount.value = String(floorTo(((state.balances[debt.value.token_id] ?? 0) * p) / 100, debt.value.decimals)) }

const quoted = computed(() => previewIsCurrent.value && !!preview.value)
// The preview needs only an amount; opening also needs the Kamino setup and no blocker.
const status = computed(() => {
  if (!state.address) return 'Connect a wallet to open a loop.'
  // Kamino keeps one Multiply position per wallet and pair
  if (positions.value.some((p) => p.market.id === loop.value.market)) return 'You already have an open loop. Close it to open a new one.'
  if (!(amount.value > 0)) return 'Enter an amount.'
  if (amount.value > (state.balances[debt.value.token_id] ?? 0)) return `You only hold ${amt(state.balances[debt.value.token_id] ?? 0)} ${debt.value.name}.`
  if (strategy.value?.maxFunding && amount.value > strategy.value.maxFunding) return `Loops are capped at ${strategy.value.maxFunding} USDC during the beta.`
  if (setupLoading.value) return 'Checking Kamino setup…'
  if (setupRequired.value) return 'Complete the one-time Kamino setup to open it.'
  if (!quoted.value) return previewError.value ?? 'Getting a quote…'
  if (entryBlockers.value.length) return localForkMode.value ? 'This loop can\'t be opened on the local fork right now.' : 'Loops aren\'t open on Nysa yet.'
  return null
})
const canAct = computed(() => !acting.value && !status.value && !!openReadiness.value?.executionEnabled)
const quoteAge = computed(() => (quotedAt.value && quoted.value ? Math.max(0, Math.round((clock.value - quotedAt.value) / 1000)) : null))

const positionView = (position) => {
  const l = loopByMarket(position.market.id), r = ratesOf(l)
  const coll = Number(position.collateral.amount), debt = Number(position.liability.amount)
  const collUsd = coll * priceOf(position.collateral.tokenId), debtUsd = debt * priceOf(position.liability.tokenId), net = collUsd - debtUsd
  return {
    net, coll,
    leverage: net > 0 ? collUsd / net : null,
    netApy: net > 0 && r.borrow != null ? (r.hold * collUsd - r.borrow * debtUsd) / net : null,
    liqPrice: coll > 0 ? debtUsd / (coll * (liqLtvOf(l) / 100)) : null,
    hf: Number(position.healthFactor),
    ltv: collUsd > 0 ? (debtUsd / collUsd) * 100 : 0,
    readiness: selectedLoopCloseReadiness(strategyOf(l)?.actions?.fullClose ?? null, position, state.address, state.loopPositionReadStatus),
  }
}
onMounted(() => { loadStrategies(); loadSetupStatus() })
</script>

<template>
  <NotFound v-if="!LOOP_ENABLED && !state.loopVisible" />

  <template v-else-if="!asset">
    <div class="n-page-head head-center">
      <h1 class="n-h1">Loops</h1>
      <p class="n-sub">Multiply your yield by borrowing against it, in one transaction.</p>
    </div>
    <div class="n-seg toggle seg-center">
      <button :class="{ on: tab === 'loops' }" @click="tab = 'loops'">Loops</button>
      <button :class="{ on: tab === 'positions' }" @click="tab = 'positions'">Manage Positions</button>
    </div>

    <div v-if="tab === 'loops'" class="loops">
      <div class="n-thead lp-grid"><div>Asset</div><div>Max Net APY</div><div>Max leverage</div><div>Liq. available</div><div>Deposited</div><div>Borrow</div></div>
      <div v-for="l in LOOPS" :key="l.id" class="n-tr click lp-grid lp-row" role="link" tabindex="0" @click="openAsset(l)" @keydown.enter="openAsset(l)">
        <div class="n-cell n-asset" data-label="Asset"><TokenIcon :token="tok(l.collateral)" /><span class="asset-name"><b>{{ tok(l.collateral).name }}</b><small>{{ l.fullName }}</small></span></div>
        <div class="n-cell n-num up" data-label="Max Net APY">{{ netApyOf(l, l.maxLeverage) == null ? '—' : pct(netApyOf(l, l.maxLeverage)) }}</div>
        <div class="n-cell n-num" data-label="Max leverage">{{ lev(l.maxLeverage) }}</div>
        <div class="n-cell n-num" data-label="Liq. available">{{ usd(marketOf(l).liquidity) }}</div>
        <div class="n-cell n-num" data-label="Deposited">{{ usd(marketOf(l).deposited) }}</div>
        <div class="n-cell" data-label="Borrow"><TokenIcon :token="tok(l.debt)" size="sm" /></div>
      </div>
    </div>

    <template v-else>
      <div v-if="!positions.length" class="n-table"><div class="n-empty">No open loops yet. <button class="link" @click="tab = 'loops'">Explore loops</button></div></div>
      <section v-for="position in positions" :key="position.id" class="n-panel position" :class="{ picked: route.query.position === position.id || highlight === position.id }">
        <div class="panel-h">
          <span class="pair"><TokenIcon :token="tok(position.collateral.tokenId)" size="sm" />{{ tok(position.collateral.tokenId).name }} / <TokenIcon :token="tok(position.liability.tokenId)" size="sm" />{{ tok(position.liability.tokenId).name }}</span>
        </div>
        <div class="n-stats pos-stats">
          <div class="n-stat"><div class="k">Net value</div><div class="v">{{ usdFull(positionView(position).net) }}</div></div>
          <div class="n-stat"><div class="k">Net APY</div><div class="v accent">{{ pct(positionView(position).netApy) }}</div></div>
          <div class="n-stat"><div class="k">Leverage</div><div class="v">{{ positionView(position).leverage ? lev(positionView(position).leverage) : '—' }}</div></div>
          <div class="n-stat"><div class="k">Liquidation price</div><div class="v">{{ positionView(position).liqPrice ? `$${positionView(position).liqPrice.toFixed(4)}` : '—' }}</div></div>
          <div class="n-stat"><div class="k">Health factor</div><div class="v">{{ hfText(positionView(position).hf) }} <span v-if="Number.isFinite(positionView(position).hf)" class="n-chip" :class="health(positionView(position).hf)[0]">{{ health(positionView(position).hf)[1] }}</span></div></div>
        </div>
        <div class="close">
          <button class="n-btn-grad" :disabled="acting || !positionView(position).readiness?.executionEnabled" @click="closeLoop(position)">{{ acting ? 'Preparing…' : 'Close loop' }}</button>
          <span v-if="!positionView(position).readiness?.executionEnabled" class="why">Closing isn't available yet.</span>
        </div>
      </section>
    </template>
  </template>

  <template v-else>
    <button class="n-back" @click="router.push({ name: 'loop' })">← Loops</button>
    <div class="detail">
      <div class="d-head">
        <div class="title-row">
          <TokenIcon :token="coll" />
          <h1 class="n-h1">{{ coll.name }} Loop</h1>
          <span v-if="coll.rwa" class="n-chip">RWA Loop</span>
          <span class="n-chip">{{ loopMarket(loop).name }}</span>
          <span class="oracle">{{ coll.name }} oracle price <b>${{ collPrice.toFixed(4) }}</b></span>
        </div>
        <p class="n-sub blurb">{{ loop.blurb }} A loop turns your {{ debt.name }} into {{ coll.name }} on Kamino and borrows {{ debt.name }} against it to buy more, in one transaction.</p>
        <div class="n-stats d-stats">
          <div class="n-stat"><div class="k">Max Net APY</div><div class="v up">{{ netApyAt(loop.maxLeverage) == null ? '—' : pct(netApyAt(loop.maxLeverage)) }}</div></div>
          <div class="n-stat"><div class="k">Max leverage</div><div class="v">{{ lev(loop.maxLeverage) }}</div></div>
          <div class="n-stat"><div class="k">Total supplied</div><div class="v">{{ usd(market.deposited) }}</div></div>
          <div class="n-stat"><div class="k">Liquidity available</div><div class="v">{{ usd(market.liquidity) }}</div></div>
        </div>
      </div>

      <aside class="n-panel d-side">
        <h2 class="side-h">Open position</h2>
        <div class="n-label row"><span>Deposit</span><span class="hint">In wallet: {{ state.address ? `${amt(state.balances[debt.token_id] ?? 0)} ${debt.name}` : '—' }}</span></div>
        <div class="input-unit">
          <input v-model="fundingAmount" class="n-input" inputmode="decimal" autocomplete="off" placeholder="0.00" :aria-label="`${debt.name} amount`" />
          <span class="unit"><TokenIcon :token="debt" size="sm" />{{ debt.name }}</span>
        </div>
        <div class="n-quick">
          <button v-for="p in [25, 50, 75]" :key="p" :disabled="!state.address" @click="setPct(p)">{{ p }}%</button>
          <button :disabled="!state.address" @click="setPct(100)">Max</button>
        </div>

        <div class="n-label borrow-l">Borrow asset</div>
        <div class="borrow-asset"><span class="pair"><TokenIcon :token="debt" size="sm" />{{ debt.name }}</span><span class="rate">{{ rates.borrow == null ? '—' : `${pct(rates.borrow)} APY` }}</span></div>

        <div class="lev">
          <div class="n-label row"><span>Leverage</span><b>{{ lev(leverage) }}</b></div>
          <input v-model.number="leverage" class="slider" type="range" min="1.1" :max="loop.maxLeverage" step="0.01" aria-label="Leverage" />
          <div class="ticks"><span>1.1×</span><span>{{ lev(loop.maxLeverage) }}</span></div>
        </div>

        <div class="ba" aria-label="Position after the loop">
          <div class="ba-row"><span class="k">Collateral</span><span class="to">{{ amt(est.collateral, 2) }} {{ coll.name }}</span></div>
          <div class="ba-row"><span class="k">Debt</span><span class="to">{{ amt(est.debt, 2) }} {{ debt.name }}</span></div>
          <div class="ba-row"><span class="k">Net APY</span><span class="to" :class="{ neg: est.netApy < 0 }">{{ est.netApy == null ? '—' : pct(est.netApy) }}</span></div>
          <div class="ba-row"><span class="k">Liquidation price</span><span class="to">${{ est.liqPrice.toFixed(4) }}</span></div>
        </div>

        <section v-if="state.address && setupRequired" class="setup">
          <p>One-time Kamino setup: creates your Kamino user account. No deposit, borrow or Nysa fee; Kamino may charge network rent.</p>
          <button class="n-btn-sm ghost" :disabled="acting || setupLoading" @click="initializeKaminoMetadata">{{ acting ? 'Setting up…' : 'Set up' }}</button>
        </section>
        <p v-if="setupError" class="err" role="status">{{ setupError }}</p>

        <label v-if="quoted && preview.carry?.requiresAcknowledgement" class="ack"><input v-model="carryAcknowledged" type="checkbox" /><span>At current rates this loop earns less than it costs. I understand rates can change.</span></label>

        <button class="n-btn-block go" :disabled="!canAct" @click="openLoop">{{ acting ? 'Opening…' : `Loop ${lev(leverage)}` }}</button>
        <p v-if="status" class="why">{{ status }}</p>
        <p v-if="state.address && amount > 0" class="fresh" aria-live="polite">{{ loading ? 'Updating quote…' : quoteAge != null ? `Quote updated ${quoteAge}s ago` : '' }}</p>
        <details v-if="quoted && entryBlockers.length" class="more">
          <summary>Why</summary>
          <ul><li v-for="reason in entryBlockers" :key="reason.code + reason.message">{{ reason.message }}</li></ul>
        </details>
        <p v-if="error" class="err" role="status">{{ error }}</p>
      </aside>

      <section class="n-panel d-body">
        <h2 class="side-h">How this loop earns</h2>
        <div class="rows first">
          <div class="n-kv"><span class="k">{{ coll.name }} yield × {{ Number(leverage).toFixed(2) }}</span><span class="v">{{ pct(rates.hold * leverage) }}</span></div>
          <div class="n-kv"><span class="k">{{ debt.name }} borrow × {{ (leverage - 1).toFixed(2) }}</span><span class="v neg">{{ rates.borrow == null ? '—' : `−${pct(rates.borrow * (leverage - 1))}` }}</span></div>
          <div class="n-kv total"><span class="k">Net APY</span><span class="v" :class="est.netApy < 0 ? 'neg' : 'up'">{{ est.netApy == null ? '—' : pct(est.netApy) }}</span></div>
          <p v-if="est.netApy != null && (rates.native != null || !loop.priceYield)" class="vs">vs {{ pct(rates.hold) }} holding {{ coll.name }}</p>
          <p v-else-if="loop.priceYield && rates.native == null" class="vs">{{ coll.name }}'s own yield isn't included yet: it needs a week of recorded prices.</p>
        </div>
        <div class="rows">
          <div class="n-kv"><span class="k">Liquidation price</span><span class="v">${{ est.liqPrice.toFixed(4) }} <small>{{ coll.name }} −{{ ((1 - est.liqPrice / collPrice) * 100).toFixed(0) }}%</small></span></div>
          <div class="n-kv"><span class="k">Health</span><span class="n-chip" :class="health(est.hf)[0]">{{ health(est.hf)[1] }}</span></div>
          <div class="bar" aria-hidden="true"><span class="lim" :style="{ left: `${liqLtv}%` }"></span><span class="mark" :style="{ left: `${est.ltv}%` }"></span></div>
          <div class="bar-l"><span>LTV {{ pct(est.ltv, 1) }}</span><span>liquidation {{ pct(liqLtv, 0) }}</span></div>
        </div>
        <div class="rows last">
          <div v-if="feeBps" class="n-kv"><span class="k">Nysa fee ({{ feeBps / 100 }}% of swap)</span><span class="v">{{ quoted && preview.feeTotalUsd != null ? usdFull(preview.feeTotalUsd) : `≈ ${usdFull(est.swap * feeBps / 10000)}` }}</span></div>
          <p v-else class="fee-note">Nysa charges 0% fees. Standard slippage and routing fees apply.</p>
          <div v-if="quoted && preview.knownCostsTotalUsd != null" class="n-kv"><span class="k">Borrow and flash loan fees</span><span class="v">{{ usdFull(Math.max(0, preview.knownCostsTotalUsd - (preview.feeTotalUsd ?? 0))) }}</span></div>
        </div>
        <details class="more">
          <summary>Details</summary>
          <div class="n-kv"><span class="k">Health factor</span><span class="v">{{ hfText(est.hf) }}</span></div>
          <div class="n-kv"><span class="k">Max slippage</span><span class="v">0.5%</span></div>
          <div v-for="fee in quoted ? fees.filter((f) => f.bps) : []" :key="fee.action" class="n-kv"><span class="k">Nysa fee</span><span class="v">{{ feeLabel(fee) }}</span></div>
          <div v-if="loop.priceYield" class="n-kv"><span class="k">{{ coll.name }} yield</span><span class="v">{{ rates.native == null ? '—' : `${pct(rates.native)} (${rates.nativeSource === 'env' ? 'published rate' : '30-day price'})` }}</span></div>
          <div class="n-kv"><span class="k">Closing</span><span class="v">returns {{ debt.name }}</span></div>
          <div class="n-kv"><span class="k">Rates as of</span><span class="v">{{ strategyOf(loop)?.carry?.asOf ? new Date(strategyOf(loop).carry.asOf).toLocaleString() : '—' }}</span></div>
        </details>
      </section>
    </div>
  </template>

  <template v-if="LOOP_ENABLED || state.loopVisible">
    <TxProgress :tx="tx" @dismiss="reset" />
    <div v-if="localForkMode" class="n-banner mode-banner">Local Surfpool only: transactions use the loopback validator and have no Mainnet effect.</div>
  </template>
</template>

<style scoped>
.head-center { text-align: center; }
.seg-center { margin: 0 auto 26px; }
/* Loops table: rows as cards, numbers right-aligned */
.loops { border: 1px solid var(--n-line); border-radius: 10px; background: var(--n-bg-2); padding: 0 10px 10px; }
.loops .n-thead { border-bottom: 0; padding: 14px 18px 6px; }
.lp-grid { grid-template-columns: minmax(0, 1.6fr) 1fr .9fr 1fr 1fr .6fr; }
.lp-grid > :not(:first-child) { justify-self: end; text-align: right; }
.lp-row { background: #000; border: 1px solid var(--n-line); border-radius: 8px; padding: 16px 18px; margin-top: 8px; }
.lp-row:last-child { border-bottom: 1px solid var(--n-line); }
.lp-row:hover, .lp-row:focus-visible { border-color: var(--n-line-2); outline: none; }
.asset-name { display: grid; line-height: 1.25; }
.asset-name small { color: var(--n-text-3); font-weight: 400; font-size: 12.5px; }
.up { color: var(--n-green); font-weight: 600; }
.link { color: var(--n-pink); font-weight: 500; }
/* Detail: header and breakdown on the left, the panel sticky on the right; on phones the panel follows the header */
.detail { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); grid-template-areas: "head side" "body side"; gap: 24px 40px; align-items: start; }
.d-head { grid-area: head; }
.d-side { grid-area: side; position: sticky; top: 96px; }
.d-body { grid-area: body; }
.title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.title-row .n-h1 { margin: 0; }
.oracle { margin-left: auto; color: var(--n-text-3); font-size: 13px; }
.oracle b { color: var(--n-text); font-weight: 600; }
.blurb { max-width: 640px; line-height: 1.6; font-size: 14px; margin-bottom: 22px; }
.d-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.d-stats .n-stat { padding: 18px 20px; }
.d-stats .n-stat .v { font-size: 22px; }
.side-h { font-size: 17px; font-weight: 600; margin-bottom: 16px; }
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
.borrow-l { margin-top: 20px; }
.borrow-asset { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border: 1px solid var(--n-line); border-radius: 6px; }
.borrow-asset .pair { color: var(--n-text); font-size: 14px; font-weight: 500; }
.borrow-asset .rate { color: var(--n-text-3); font-size: 13px; font-variant-numeric: tabular-nums; }
.lev { margin-top: 20px; }
.slider { width: 100%; accent-color: var(--n-pink); }
.ticks { display: flex; justify-content: space-between; color: var(--n-text-4); font-size: 11.5px; margin-top: 2px; }
.ba { margin-top: 20px; border: 1px solid var(--n-line); border-radius: 6px; }
.ba-row { display: flex; justify-content: space-between; gap: 14px; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--n-hair); font-variant-numeric: tabular-nums; }
.ba-row:last-child { border-bottom: 0; }
.ba-row .k { color: var(--n-text-3); }
.ba-row .to { font-weight: 600; text-align: right; }
.ba-row .to.neg { color: var(--n-amber); }
.setup { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 18px; padding: 14px; border: 1px solid var(--n-line); border-radius: 6px; font-size: 12.5px; color: var(--n-text-3); }
.ack { display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; color: var(--n-amber); font-size: 12.5px; }
.ack input { margin-top: 3px; accent-color: var(--n-pink); }
.go { margin-top: 20px; }
.why { display: block; margin-top: 10px; text-align: center; color: var(--n-text-3); font-size: 12.5px; }
.fresh { margin-top: 6px; text-align: center; color: var(--n-text-4); font-size: 12px; }
.err { margin-top: 10px; color: var(--n-red); font-size: 12.5px; text-align: center; }
.more { margin-top: 12px; color: var(--n-text-3); font-size: 12.5px; }
.more summary { cursor: pointer; list-style: none; }
.more summary::before { content: "+ "; color: var(--n-pink); }
.more[open] summary::before { content: "− "; }
.more ul { margin: 8px 0 0 18px; display: grid; gap: 4px; }
.more .n-kv { margin-top: 8px; }
.rows { display: grid; gap: 9px; padding: 14px 0; border-bottom: 1px solid var(--n-line); }
.rows.first { padding-top: 0; }
.rows.last { border-bottom: 0; padding-bottom: 0; }
.n-kv.total { padding-top: 6px; border-top: 1px solid var(--n-hair); font-weight: 600; }
.n-kv.total .v { font-size: 18px; }
.n-kv .v.up { color: var(--n-green); }
.n-kv .v.neg { color: var(--n-text-2); }
.n-kv.total .v.neg { color: var(--n-amber); }
.n-kv .v small { color: var(--n-text-4); font-weight: 400; font-size: 12px; margin-left: 6px; }
.vs { color: var(--n-text-4); font-size: 12px; }
.n-chip.ok { color: var(--n-green); border-color: #3ddc8459; }
.n-chip.bad { color: var(--n-red); border-color: #ff5d5d66; }
.bar { position: relative; height: 6px; border-radius: 999px; background: linear-gradient(90deg, var(--n-green) 0%, var(--n-green) 45%, var(--n-amber) 70%, var(--n-red) 100%); margin: 6px 0 0; opacity: .85; }
.bar .mark { position: absolute; top: -5px; width: 3px; height: 16px; border-radius: 2px; background: #fff; transform: translateX(-50%); transition: left .2s; }
.bar .lim { position: absolute; top: -3px; width: 1px; height: 12px; background: #fff8; }
.bar-l { display: flex; justify-content: space-between; color: var(--n-text-4); font-size: 11.5px; }
.position + .position, .position { margin-top: 0; margin-bottom: 18px; }
.pos-stats { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.pos-stats .n-stat { padding: 18px 20px; }
.pos-stats .n-stat .v { font-size: 22px; }
.pos-stats .n-chip { vertical-align: middle; margin-left: 6px; }
.close { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 18px; }
.close .why { margin: 0; text-align: left; }
.fee-note { margin: 0; padding: 6px 0; color: var(--n-text-3); font-size: 12px; font-weight: 300; }
.close .n-btn-grad:disabled { opacity: .4; cursor: not-allowed; filter: none; box-shadow: none; }
.mode-banner { margin-top: 22px; }
.position.picked { border-color: var(--n-pink); }
@media (prefers-reduced-motion: reduce) { .bar .mark { transition: none; } }
@media (max-width: 1080px) {
  .pos-stats, .d-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pos-stats .n-stat:last-child { grid-column: 1 / -1; }
}
@media (max-width: 860px) {
  .detail { grid-template-columns: minmax(0, 1fr); grid-template-areas: "head" "side" "body"; }
  .d-side { position: static; }
  .d-stats { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } /* the global phone rule stacks every stat */
  .d-stats .n-stat { padding: 14px 16px; }
  .d-stats .n-stat .v { font-size: 19px; }
  .oracle { margin-left: 0; width: 100%; }
  .loops { padding: 0 8px 8px; }
  .lp-grid > :not(:first-child) { justify-self: stretch; text-align: left; }
}
@media (max-width: 480px) { .setup { flex-direction: column; align-items: stretch; } }
</style>
