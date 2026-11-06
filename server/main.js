// Nysa backend (VPS / Docker, behind Caddy and the Cloudflare Tunnel):
// - serves the Vite build (dist/) with SPA fallback;
// - JSON API under /api (market, account, transactions, analytics, points, history, market updates, liquidations, health);
// - pushes market updates to browsers over Server-Sent Events (/api/events);
// - runs the snapshot every 12 hours (00:00 and 12:00 UTC).
// The browser never calls the Solana RPC: it reads from here and only uses the wallet to sign and send.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBase58Decoder, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getTransactionDecoder, isAddress, verifySignature } from '@solana/kit'
import { RPC_URL, rpc, rpcCallsLastHour } from './rpc.js'
import { getSnapshot, onSnapshot, refreshMarket, refreshMarketForExecution } from './market.js'
import { getAccount } from './account.js'
import { readFreshWithdrawalAllowance } from './withdrawal.js'
import { buildTx, sendSigned, txStatus, liquidationInfo, KINDS, UserError } from './tx.js'
import { getFeeReceiverMetadata, getPositions, getVaultHolders } from './analytics.js'
import { marketUpdates, marketLiquidations } from './updates.js'
import { runSnapshot } from './snapshot.js'
import { isSanctioned, screeningReady, screeningStatus, startScreening } from './screening.js'
import { read, POINTS, HISTORY } from './storage.js'
import { LIVE, TOKENS, VAULTS, marketById, vaultById } from '../src/config.js'
import { evaluateLoopActionReadiness, evaluateLoopStrategy, LOOP_ALLOWED_MARKET_IDS } from './strategy.js'
import { buildLoopCloseApplication, buildLoopMetadataSetupApplication, buildLoopOpenApplication, buildReadOnlyLoopPreview, loopMetadataStatus, simulateLoopApplication, verifyLoopApplicationSimulation, verifyLoopMetadataSetupSimulation } from './loop.js'
import { buildSwap, configuredFeeAccountForMint, SwapError } from './swap.js'
import { LOOP_PREVIEW_MAX_AGE_MS, loopCarryStillCurrent, loopMarketRiskFromSnapshot, loopMarketRiskStillCurrent } from './loop-preview-validation.js'
import { createPublicSwapQuote, parseSwapQuoteRequest, SwapRouteError, swapPairAvailability, swapReadiness } from './swap-routes.js'
import { PROGRAM_EVIDENCE } from './program-policy.js'
import { runWithRequestAbortSignal } from './request-signal.js'
import { createSwapExecutionService, compileSwapTransaction, simulateSwapTransaction, createAuthorizedSwapSender, swapIntentStillAuthorized, validateProviderSwapInstructions, SwapExecutionError } from './swap-execution.js'
import { createLendingTransactionIntentStore, createSwapIntentStore, loopSetupMessageMatchesIgnoringBlockhash } from './tx-intent.js'
import { createLendingTransactionIntentService } from './lending-intents.js'
import { noteBuilt } from './relay.js'
import { DefiniteSendRefusal, SendOutcomeUnknownError } from './send-safety.js'
import { createLoopExecutionService, LoopExecutionError } from './loop-execution.js'
import { compileAtomicTransaction } from './tx.js'
import { PROGRAM_ID as KAMINO_LENDING_PROGRAM_ID } from '@kamino-finance/klend-sdk'
import { createLocalForkRouteVerifier, isLocalForkWallet, localForkExecutionEnabled, localForkTreasuryAuthority } from './local-fork-execution.js'

if (!RPC_URL) {
  console.error('SOLANA_RPC is not set (see .env.example)')
  process.exit(1)
}

const localForkDappEnabled = localForkExecutionEnabled({ rpcUrl: RPC_URL })
const verifyLocalForkRoute = createLocalForkRouteVerifier({ rpc, enabled: localForkDappEnabled })

async function validateSwapRouteForCurrentNetwork(request, built) {
  if (!localForkDappEnabled) return validateProviderSwapInstructions(request, built)
  if (!await verifyLocalForkRoute(built)) throw new SwapRouteError('The local route does not use only the approved DEX and executable programs cloned into Surfpool.')
  return validateProviderSwapInstructions(request, { ...built, programPolicy: { approved: true, unreviewed: [] } })
}

function localForkProgramEvidenceReady() {
  return localForkDappEnabled && !!localForkTreasuryAuthority()
    && !!process.env.LOCAL_FORK_FEE_ACCOUNT_USDC && !!process.env.LOCAL_FORK_FEE_ACCOUNT_USDY
}

async function localIntentAuthorized(intent) {
  if (!localForkProgramEvidenceReady() || !isLocalForkWallet(intent?.wallet, { rpcUrl: RPC_URL })) return false
  const metadata = intent?.metadata ?? {}
  const routeProgramIds = metadata.routeProgramIds ?? Object.values(metadata.routeProgramIdsByLabel ?? {}).flat()
  return verifyLocalForkRoute({ programIds: metadata.programIds, routeProgramIds })
}

const PORT = Number(process.env.PORT) || 3000
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}
const EMPTY_POINTS = 'address,cumulative_points,last_supplied_usd,last_snapshot_ts\n'

// ---- helpers ----
function send(res, status, body, { type = 'application/json', maxAge = 0 } = {}) {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', maxAge ? `public, max-age=${maxAge}` : 'no-store')
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

// Per-IP fixed-window limits on the endpoints that cost RPC calls. Only Cloudflare reaches us (tunnel), so its
// CF-Connecting-IP header is the real client.
const clientIp = (req) => req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress
const hits = new Map()
function limited(req, name, perMinute) {
  const key = `${name}:${clientIp(req)}`
  const now = Date.now()
  let e = hits.get(key)
  if (!e || now - e.start > 60_000) hits.set(key, (e = { start: now, n: 0 }))
  return ++e.n > perMinute
}
setInterval(() => { for (const [k, e] of hits) if (Date.now() - e.start > 60_000) hits.delete(k) }, 60_000).unref()

async function jsonBody(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new UserError('Expected application/json')
  let raw = ''
  for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw new UserError('Request too large') }
  try { return JSON.parse(raw) } catch { throw new UserError('Invalid JSON') }
}

// Sanctions screening (OFAC SDN list, server/screening.js): a sanctioned wallet gets 403 everywhere. Until a list is
// loaded, viewing still works but no transaction is built or relayed (fail closed).
const BLOCKED = { error: 'This wallet address is on a sanctions list, so it cannot use the Nysa interface.', blocked: true }
// A sanctioned borrower's loan isn't liquidated through the interface either (no `blocked`: the liquidator is fine).
const BLOCKED_LOAN = { error: 'This loan belongs to a wallet on a sanctions list, so the Nysa interface cannot liquidate it.' }
function blocked(res, wallet, { failClosed }) {
  if (isSanctioned(wallet)) return send(res, 403, BLOCKED), true
  if (failClosed && !screeningReady()) return send(res, 503, { error: 'Sanctions screening is starting up, please try again shortly.' }), true
  return false
}

// ---- Server-Sent Events: the market snapshot on connect and after every refresh ----
// Streams are capped per client IP too, so one client can't take every slot; a browser turned away polls /api/market.
const clients = new Set()
const MAX_CLIENTS = 5000
const MAX_STREAMS_PER_IP = 5
const streams = new Map() // client IP -> open streams
const event = (data) => `event: market\ndata: ${JSON.stringify(data)}\n\n`
function events(req, res) {
  const ip = clientIp(req)
  if ((streams.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) return send(res, 429, { error: 'Too many connections from this address' })
  if (clients.size >= MAX_CLIENTS) return send(res, 503, { error: 'Too many connections' })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  res.write('retry: 5000\n\n')
  const snapshot = getSnapshot()
  if (snapshot) res.write(event(snapshot))
  clients.add(res)
  streams.set(ip, (streams.get(ip) ?? 0) + 1)
  let open = true
  const drop = () => {
    if (!open) return
    open = false
    clients.delete(res)
    const n = streams.get(ip) - 1
    if (n > 0) streams.set(ip, n)
    else streams.delete(ip)
  }
  req.on('close', drop)
  res.on('close', drop)
  res.on('error', drop) // client gone mid-write
}
onSnapshot((snapshot) => { const msg = event(snapshot); for (const c of clients) c.write(msg) })
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 25_000).unref() // under Cloudflare's 100s idle cut

// ---- routes ----
function currentSwapReadiness(request = {}) {
  const snapshot = getSnapshot()
  const availability = swapPairAvailability({
    market: marketById('sol-usdy-usdc'),
    vaults: snapshot?.vaults ?? {},
    snapshotUpdatedAt: snapshot?.updatedAt ?? 0,
    inputMint: request.inputMint ?? TOKENS['svm-usdc'].mint,
    outputMint: request.outputMint ?? TOKENS['svm-usdy'].mint,
  })
  const localTestWallet = isLocalForkWallet(request.wallet, { rpcUrl: RPC_URL })
  const localExecution = localForkProgramEvidenceReady() && (!request.wallet || localTestWallet)
  const readiness = swapReadiness({
    providerConfigured: !!process.env.JUPITER_API_KEY || localExecution,
    feeAccountsConfigured: !!configuredFeeAccountForMint(TOKENS['svm-usdc'].mint)
      && !!configuredFeeAccountForMint(TOKENS['svm-usdy'].mint)
      && !!process.env.SWAP_FEE_TREASURY_AUTHORITY,
    programEvidenceApproved: PROGRAM_EVIDENCE.length > 0 || localExecution,
    feasibilityPassed: localExecution,
    walletPathsValidated: localExecution,
    transactionBuilderAvailable: true,
    marketDataAvailable: availability.available,
    marketAvailabilityReasons: availability.reasons,
  })
  return { readiness, availability }
}

// Loop exits use the same route/program/fee/fork gates as swaps, but do not depend on new-entry allocation policy.
function currentLoopRouteReadiness() {
  const snapshot = getSnapshot()
  const snapshotFresh = Number.isFinite(snapshot?.updatedAt) && snapshot.updatedAt > 0
    && Date.now() >= snapshot.updatedAt && Date.now() - snapshot.updatedAt <= 60_000
  const localExecution = localForkProgramEvidenceReady()
  const routeReadiness = swapReadiness({
    providerConfigured: !!process.env.JUPITER_API_KEY || localExecution,
    feeAccountsConfigured: !!configuredFeeAccountForMint(TOKENS['svm-usdc'].mint)
      && !!configuredFeeAccountForMint(TOKENS['svm-usdy'].mint)
      && !!process.env.SWAP_FEE_TREASURY_AUTHORITY,
    programEvidenceApproved: PROGRAM_EVIDENCE.length > 0 || localExecution,
    feasibilityPassed: localExecution,
    walletPathsValidated: localExecution,
    transactionBuilderAvailable: true,
    marketDataAvailable: snapshotFresh,
    marketAvailabilityReasons: snapshotFresh ? [] : [{ code: 'market-data-stale', message: 'Fresh market data is unavailable for a safe loop transaction.' }],
  })
  return routeReadiness
}

function loopStrategyForAction(snapshot, leverage = 1.5) {
  const localExecution = localForkProgramEvidenceReady()
  return evaluateLoopStrategy({
    market: marketById('sol-usdy-usdc'),
    allowedMarketIds: LOOP_ALLOWED_MARKET_IDS,
    vaults: snapshot?.vaults ?? {},
    reserves: snapshot?.reserves ?? {},
    snapshotUpdatedAt: snapshot?.updatedAt ?? 0,
    providerConfigured: true, // keyless access remains quote-only; route execution is separately denied below.
    productionProviderConfigured: !!process.env.JUPITER_API_KEY || localExecution,
    treasuryConfigured: !!configuredFeeAccountForMint(TOKENS['svm-usdy'].mint)
      && !!configuredFeeAccountForMint(TOKENS['svm-usdc'].mint)
      && !!process.env.SWAP_FEE_TREASURY_AUTHORITY,
    riskApproval: localExecution
      ? { owner: 'Local Surfpool disposable-wallet profile', approvedAt: new Date().toISOString() }
      : { owner: process.env.NYSA_LOOP_RISK_OWNER, approvedAt: process.env.NYSA_LOOP_RISK_APPROVED_AT },
    programEvidenceApproved: PROGRAM_EVIDENCE.length > 0 || localExecution,
    feasibilityPassed: localExecution,
    leverage,
  })
}

function currentLoopActionReadiness(body, { previewAcknowledgementValid = false, positionVerified = false } = {}) {
  if (localForkDappEnabled && !isLocalForkWallet(body.wallet, { rpcUrl: RPC_URL })) {
    return { executionEnabled: false, unavailableReasons: [{ code: 'local-fork-wallet-not-allowlisted', message: 'Connect a generated LOCAL_FORK_ACCOUNT_n wallet to execute on this local Surfpool profile.' }] }
  }
  const snapshot = getSnapshot()
  return evaluateLoopActionReadiness({
    action: body.kind,
    strategy: body.kind === 'loop-open' ? loopStrategyForAction(snapshot, Number(body.leverage)) : null,
    routeReadiness: currentLoopRouteReadiness(),
    positionId: body.positionId,
    positionVerified,
    builderAvailable: true,
    previewAcknowledgementValid,
  })
}

const swapIntentStore = createSwapIntentStore()
const lendingIntentStore = createLendingTransactionIntentStore({ ttlMs: 10 * 60_000 })
const lendingTransactions = createLendingTransactionIntentService({
  intentStore: lendingIntentStore,
  build: buildTx,
  relay: ({ tx, wallet, intentStore, intentId, requireIntent }) => sendSigned({ tx, wallet, intentStore, intentId, requireIntent }),
})
const swapExecution = createSwapExecutionService({
  readiness: async (request) => currentSwapReadiness(request).readiness,
  buildRoute: async (request) => {
    const localExecution = localForkProgramEvidenceReady()
    if (localExecution && !isLocalForkWallet(request.wallet, { rpcUrl: RPC_URL })) {
      throw new SwapRouteError('Only generated LOCAL_FORK_ACCOUNT_n wallets can execute on the local Surfpool Dapp profile.')
    }
    const feeAccount = configuredFeeAccountForMint(request.outputMint)
    if (!feeAccount) throw new SwapRouteError('No verified fee account is configured for the output token.')
    const built = await buildSwap({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputAmountBaseUnits: request.amountBaseUnits,
      wallet: request.wallet,
      slippageBps: request.slippageBps,
      feeAccount: feeAccount.account,
      feeAccountMint: request.outputMint,
      feeBalanceDeltaVerified: false,
    })
    if (!localExecution) return built
    if (!await verifyLocalForkRoute(built)) throw new SwapRouteError('The local route does not use only the approved DEX and executable programs cloned into Surfpool.')
    return { ...built, programPolicy: { approved: true, unreviewed: [] }, executable: true }
  },
  compile: compileSwapTransaction,
  simulate: simulateSwapTransaction,
  intentStore: swapIntentStore,
  onBuild: (wallet) => noteBuilt(wallet),
})
const sendAuthorizedSwap = createAuthorizedSwapSender({
  intentStore: swapIntentStore,
  authorize: async (intent) => {
    const metadata = intent.metadata ?? {}
    const readiness = currentSwapReadiness({
      wallet: intent.wallet,
      inputMint: metadata.inputMint,
      outputMint: metadata.outputMint,
    }).readiness.executionEnabled
    if (localForkDappEnabled) return readiness && await localIntentAuthorized(intent)
    return swapIntentStillAuthorized(intent, { executionEnabled: readiness, evidence: PROGRAM_EVIDENCE })
  },
  send: ({ tx, wallet, intent }) => sendSigned({ tx, wallet, approvedProgramIds: intent.metadata?.programIds ?? [] }),
})

const loopPreviews = new Map()
const loopIntentStore = createSwapIntentStore({ messageMatcher: loopSetupMessageMatchesIgnoringBlockhash })
function activeLoopPreview(id) {
  const preview = loopPreviews.get(id)
  if (!preview || Date.now() >= preview.expiresAt) {
    loopPreviews.delete(id)
    return null
  }
  return preview
}
const loopExecution = createLoopExecutionService({
  readiness: async ({ action, request, preview, position, previewAcknowledgementValid }) => {
    const snapshot = action === 'loop-open' ? await refreshMarketForExecution() : null
    const strategy = action === 'loop-open' ? loopStrategyForAction(snapshot, Number(preview.leverage)) : null
    const currentCarry = strategy?.carry
    const previewCarry = preview?.carry
    const now = Date.now()
    const snapshotFresh = Number.isFinite(snapshot?.updatedAt) && snapshot.updatedAt > 0
      && now >= snapshot.updatedAt && now - snapshot.updatedAt <= LOOP_PREVIEW_MAX_AGE_MS
    const currentMarketRisk = loopMarketRiskFromSnapshot(snapshot)
    if (action === 'loop-open' && (!snapshotFresh
      || !loopCarryStillCurrent(previewCarry, currentCarry, now)
      || !loopMarketRiskStillCurrent(preview?.sdk?.marketRisk, currentMarketRisk, Number(snapshot?.blockTime)))) {
      return { executionEnabled: false, unavailableReasons: [{ code: 'loop-preview-stale', message: 'Loop market, oracle, or carry assumptions changed or became stale after preview; build a fresh preview.' }] }
    }
    return currentLoopActionReadiness({
      ...request,
      kind: action,
      leverage: Number(preview?.leverage ?? request.leverage),
      positionId: position?.id ?? request.positionId,
    }, { previewAcknowledgementValid, positionVerified: !!position })
  },
  getPreview: async (id) => activeLoopPreview(id),
  getPosition: async ({ wallet, positionId }) => {
    const account = await getAccount(wallet, true)
    return account.loopPositions.find((position) => position.id === positionId) ?? null
  },
  metadataReady: async ({ wallet }) => !(await loopMetadataStatus({ wallet })).required,
  setupRequired: async ({ wallet }) => (await loopMetadataStatus({ wallet })).required,
  buildOpen: ({ wallet, request, preview }) => buildLoopOpenApplication({ wallet, amount: request.amount, leverage: request.leverage, preview, validateRoute: validateSwapRouteForCurrentNetwork }),
  buildClose: ({ wallet, position }) => buildLoopCloseApplication({ wallet, position,
    validateRoute: validateSwapRouteForCurrentNetwork,
    localForkSimulation: localForkDappEnabled,
    localForkRpcUrl: RPC_URL,
    localRouteProgramVerifier: verifyLocalForkRoute,
  }),
  buildSetup: ({ wallet }) => buildLoopMetadataSetupApplication({ wallet }),
  compile: compileAtomicTransaction,
  simulate: simulateLoopApplication,
  verifySimulation: async ({ kind, ...context }) => kind === 'loop-setup'
    ? verifyLoopMetadataSetupSimulation(context)
    : verifyLoopApplicationSimulation({ kind, ...context }),
  intentStore: loopIntentStore,
  authorize: async ({ intent }) => {
    const ready = currentLoopRouteReadiness().executionEnabled
    if (localForkDappEnabled) return ready && await localIntentAuthorized(intent)
    return swapIntentStillAuthorized(intent, { executionEnabled: ready, evidence: PROGRAM_EVIDENCE })
  },
  authorizeSetup: async ({ intent }) => intent?.metadata?.kind === 'loop-setup'
    && (!localForkDappEnabled || isLocalForkWallet(intent?.wallet, { rpcUrl: RPC_URL }))
    && intent.metadata.market === 'sol-usdy-usdc'
    && intent.metadata.programIds?.length === 1
    && String(intent.metadata.programIds[0]) === String(KAMINO_LENDING_PROGRAM_ID)
    && (intent.metadata.routeLabels ?? []).length === 0,
  send: ({ tx, wallet, intent }) => sendSigned({ tx, wallet, approvedProgramIds: intent.metadata?.programIds ?? [] }),
  onBuild: (wallet) => noteBuilt(wallet),
})

const routes = [
  ['GET', /^\/api\/swap-readiness$/, (req, res) => {
    const { readiness, availability } = currentSwapReadiness()
    return send(res, 200, { ...readiness, marketAvailability: availability,
      executionMode: localForkDappEnabled ? 'surfpool-local' : 'production-gated' })
  }],
  ['POST', /^\/api\/swap-quote$/, async (req, res) => {
    if (limited(req, 'swap-quote', 20)) return send(res, 429, { error: 'Too many requests' })
    const body = await jsonBody(req)
    let request
    try { request = parseSwapQuoteRequest(body) }
    catch (error) {
      if (error instanceof SwapRouteError) return send(res, 400, { error: error.message })
      throw error
    }
    if (blocked(res, request.wallet, { failClosed: true })) return
    const { availability } = currentSwapReadiness(request)
    if (!availability.available) return send(res, 503, { error: availability.reasons.map((reason) => reason.message).join(' ') })
    try {
      return await runWithRequestAbortSignal(req, res, async (signal) => {
        try {
          const quote = await createPublicSwapQuote(body, { signal })
          if (signal.aborted || res.destroyed) return
          return send(res, 200, quote)
        } catch (error) {
          if (signal.aborted || res.destroyed) return
          if (error instanceof SwapRouteError) {
            const status = /fee account is configured/i.test(error.message) ? 503 : 400
            return send(res, status, { error: error.message })
          }
          if (error instanceof SwapError) return send(res, 502, { error: error.message })
          console.error('[swap] quote failed', error?.message)
          return send(res, 502, { error: 'Could not load a swap quote, please try again.' })
        }
      })
    } catch (error) {
      if (res.destroyed) return
      throw error
    }
  }],
  ['POST', /^\/api\/swap-build$/, async (req, res) => {
    if (limited(req, 'swap-build', 8)) return send(res, 429, { error: 'Too many requests' })
    const body = await jsonBody(req)
    let request
    try { request = parseSwapQuoteRequest(body) }
    catch (error) {
      if (error instanceof SwapRouteError) return send(res, 400, { error: error.message })
      throw error
    }
    if (blocked(res, request.wallet, { failClosed: true })) return
    const { readiness, availability } = currentSwapReadiness(request)
    if (!availability.available) return send(res, 503, { error: availability.reasons.map((reason) => reason.message).join(' ') })
    if (!readiness.executionEnabled) return send(res, 503, { error: readiness.unavailableReasons.map((reason) => reason.message).join(' '), unavailableReasons: readiness.unavailableReasons })
    try { return send(res, 200, await swapExecution.build(body)) }
    catch (error) {
      if (error instanceof SwapExecutionError) return send(res, 503, { error: error.message })
      if (error instanceof SwapRouteError) return send(res, 503, { error: error.message })
      if (error instanceof SwapError) return send(res, 502, { error: error.message })
      console.error('[swap] build failed', error?.message)
      return send(res, 502, { error: 'Could not build a swap transaction, please try again.' })
    }
  }],
  ['POST', /^\/api\/swap-send$/, async (req, res) => {
    if (limited(req, 'swap-send', 8)) return send(res, 429, { error: 'Too many requests' })
    const body = await jsonBody(req)
    if (!isAddress(String(body.wallet)) || typeof body.tx !== 'string' || typeof body.intentId !== 'string') throw new UserError('Invalid swap relay request.')
    if (blocked(res, body.wallet, { failClosed: true })) return
    try { return send(res, 200, await sendAuthorizedSwap({ tx: body.tx, wallet: body.wallet, intentId: body.intentId })) }
    catch (error) {
      if (error instanceof DefiniteSendRefusal) return send(res, 400, { error: error.message, outcome: 'rejected' })
      if (error instanceof SendOutcomeUnknownError) return send(res, 502, { error: error.message, signature: error.signature, outcome: 'unknown' })
      if (error instanceof SwapExecutionError) return send(res, 400, { error: error.message })
      if (error instanceof UserError) throw error
      console.error('[swap] relay failed', error?.message)
      return send(res, 502, { error: 'Could not relay the signed swap, please rebuild it and try again.' })
    }
  }],
  ['GET', /^\/api\/loop-strategies$/, (req, res) => {
    const snapshot = getSnapshot()
    const market = marketById('sol-usdy-usdc')
    const strategy = evaluateLoopStrategy({
      market,
      allowedMarketIds: LOOP_ALLOWED_MARKET_IDS,
      vaults: snapshot?.vaults ?? {},
      reserves: snapshot?.reserves ?? {},
      snapshotUpdatedAt: snapshot?.updatedAt ?? 0,
      providerConfigured: true, // Jupiter permits keyless prototype requests, rate-limited to 0.5 RPS.
      productionProviderConfigured: !!process.env.JUPITER_API_KEY || localForkProgramEvidenceReady(),
      treasuryConfigured: !!configuredFeeAccountForMint(TOKENS['svm-usdy'].mint)
        && !!configuredFeeAccountForMint(TOKENS['svm-usdc'].mint)
        && !!process.env.SWAP_FEE_TREASURY_AUTHORITY,
      riskApproval: localForkProgramEvidenceReady()
        ? { owner: 'Local Surfpool disposable-wallet profile', approvedAt: new Date().toISOString() }
        : { owner: process.env.NYSA_LOOP_RISK_OWNER, approvedAt: process.env.NYSA_LOOP_RISK_APPROVED_AT },
      programEvidenceApproved: PROGRAM_EVIDENCE.length > 0 || localForkProgramEvidenceReady(),
      feasibilityPassed: localForkProgramEvidenceReady(),
    })
    const routeReadiness = currentLoopRouteReadiness()
    const actions = {
      open: evaluateLoopActionReadiness({ action: 'loop-open', strategy, routeReadiness, builderAvailable: true }),
      fullClose: evaluateLoopActionReadiness({ action: 'loop-close', routeReadiness, builderAvailable: true }),
    }
    return send(res, 200, { strategies: [strategy], actions, readOnly: true,
      executionMode: localForkDappEnabled ? 'surfpool-local' : 'production-gated' })
  }],
  ['GET', /^\/api\/loop-setup-status$/, async (req, res) => {
    if (limited(req, 'loop-setup-status', 10)) return send(res, 429, { error: 'Too many requests' })
    const wallet = new URL(req.url, 'http://localhost').searchParams.get('wallet')
    if (!wallet || !isAddress(wallet)) return send(res, 400, { error: 'Invalid wallet address' })
    if (blocked(res, wallet, { failClosed: true })) return
    try { return send(res, 200, { ...(await loopMetadataStatus({ wallet })), readOnly: true }) }
    catch (error) {
      console.warn('[loop] metadata status unavailable', error?.message)
      return send(res, 503, { error: 'Kamino metadata setup status is unavailable.' })
    }
  }],
  ['POST', /^\/api\/loop-preview$/, async (req, res) => {
    if (limited(req, 'loop-preview', 20)) return send(res, 429, { error: 'Too many requests' })
    const body = await jsonBody(req)
    if ((body.marketId ?? 'sol-usdy-usdc') !== 'sol-usdy-usdc') throw new UserError('Unknown loop strategy')
    if (body.wallet != null && !isAddress(String(body.wallet))) throw new UserError('Invalid wallet address')
    if (typeof body.fundingAmount !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(body.fundingAmount)) throw new UserError('Invalid funding amount')
    if (!Number.isFinite(Number(body.fundingAmount)) || !(Number(body.fundingAmount) > 0) || !Number.isFinite(Number(body.leverage)) || Number(body.leverage) <= 1 || Number(body.leverage) > 1.5) throw new UserError('Funding amount or leverage is outside the preview range')
    const snapshot = getSnapshot()
    const strategy = evaluateLoopStrategy({
      market: marketById('sol-usdy-usdc'),
      allowedMarketIds: LOOP_ALLOWED_MARKET_IDS,
      vaults: snapshot?.vaults ?? {},
      reserves: snapshot?.reserves ?? {},
      snapshotUpdatedAt: snapshot?.updatedAt ?? 0,
      providerConfigured: true, // Keyless requests remain usable for read-only prototype quotes.
      productionProviderConfigured: !!process.env.JUPITER_API_KEY || localForkProgramEvidenceReady(),
      treasuryConfigured: !!configuredFeeAccountForMint(TOKENS['svm-usdy'].mint)
        && !!configuredFeeAccountForMint(TOKENS['svm-usdc'].mint)
        && !!process.env.SWAP_FEE_TREASURY_AUTHORITY,
      riskApproval: localForkProgramEvidenceReady()
        ? { owner: 'Local Surfpool disposable-wallet profile', approvedAt: new Date().toISOString() }
        : { owner: process.env.NYSA_LOOP_RISK_OWNER, approvedAt: process.env.NYSA_LOOP_RISK_APPROVED_AT },
      programEvidenceApproved: PROGRAM_EVIDENCE.length > 0 || localForkProgramEvidenceReady(),
      feasibilityPassed: localForkProgramEvidenceReady(),
      leverage: Number(body.leverage),
    })
    const previewId = randomUUID()
    let applicationContext = null
    try {
      return await runWithRequestAbortSignal(req, res, async (signal) => {
        try {
          const preview = await buildReadOnlyLoopPreview({
            wallet: body.wallet, fundingAmount: body.fundingAmount, leverage: Number(body.leverage), snapshot, strategy, signal,
            localForkSimulation: localForkDappEnabled && isLocalForkWallet(body.wallet, { rpcUrl: RPC_URL }),
            localForkRpcUrl: RPC_URL,
            localRouteProgramVerifier: verifyLocalForkRoute,
            onApplicationContext: (context) => { applicationContext = context },
          })
          if (signal.aborted || res.destroyed) return
          const actionReadiness = evaluateLoopActionReadiness({
            action: 'loop-open', strategy, routeReadiness: currentLoopRouteReadiness(), builderAvailable: true,
            previewAcknowledgementValid: false,
          })
          if (localForkDappEnabled && !isLocalForkWallet(body.wallet, { rpcUrl: RPC_URL })) {
            actionReadiness.executionEnabled = false
            actionReadiness.unavailableReasons.push({ code: 'local-fork-wallet-not-allowlisted', message: 'Connect a generated LOCAL_FORK_ACCOUNT_n wallet to execute on this local Surfpool profile.' })
          }
          const metadataStatus = body.wallet ? await loopMetadataStatus({ wallet: body.wallet }) : { required: false }
          if (metadataStatus.required) {
            actionReadiness.executionEnabled = false
            actionReadiness.unavailableReasons.push({ code: 'kamino-metadata-setup-required', message: 'Initialize the one-time Kamino UserMetadata account before opening a loop.' })
          }
          const expiresAt = Math.min(Date.now() + 15_000, Number.isFinite(preview.quoteAt) ? preview.quoteAt + 15_000 : Date.now() + 15_000)
          if (body.wallet && applicationContext) {
            const record = {
              ...preview,
              id: previewId,
              wallet: body.wallet,
              marketId: 'sol-usdy-usdc',
              fundingAmount: body.fundingAmount,
              leverage: Number(body.leverage),
              expiresAt,
              applicationContext,
            }
            loopPreviews.set(previewId, record)
            for (const [id, item] of loopPreviews) if (Date.now() >= item.expiresAt) loopPreviews.delete(id)
          }
          return send(res, 200, { ...preview, previewId, actionReadiness, metadataSetupRequired: metadataStatus.required,
            strategyId: 'sol-usdy-usdc', readOnly: true,
            executionMode: localForkDappEnabled ? 'surfpool-local' : 'production-gated' })
        } catch (error) {
          if (signal.aborted || res.destroyed) return
          console.warn('[loop] preview unavailable', error?.message)
          return send(res, 200, {
            previewId,
            strategyId: 'sol-usdy-usdc',
            readOnly: true,
            executionEnabled: false,
            available: false,
            unavailableReasons: [...strategy.unavailableReasons, { code: 'quote-unavailable', message: 'Live fee-aware route or Kamino preview is unavailable.' }],
          })
        }
      })
    } catch (error) {
      if (res.destroyed) return
      throw error
    }
  }],
  ['GET', /^\/api\/market$/, (req, res) => {
    const s = getSnapshot()
    return s ? send(res, 200, s) : send(res, 503, { error: 'Market data is still loading' })
  }],
  ['GET', /^\/api\/events$/, events],
  ['GET', /^\/api\/account\/(\w+)$/, async (req, res, [wallet]) => {
    if (!isAddress(wallet)) return send(res, 400, { error: 'Invalid wallet address' })
    if (limited(req, 'account', 60)) return send(res, 429, { error: 'Too many requests' })
    if (blocked(res, wallet, { failClosed: false })) return
    const fresh = new URL(req.url, 'http://x').searchParams.has('fresh')
    send(res, 200, await getAccount(wallet, fresh))
  }],
  ['GET', /^\/api\/withdrawal-allowance\/(\w+)$/, async (req, res, [wallet]) => {
    if (!isAddress(wallet)) return send(res, 400, { error: 'Invalid wallet address' })
    if (limited(req, 'withdrawal-allowance', 20)) return send(res, 429, { error: 'Too many requests' })
    if (blocked(res, wallet, { failClosed: true })) return
    try {
      const allowance = await readFreshWithdrawalAllowance({ wallet, refreshMarket: refreshMarketForExecution, getAccount })
      return send(res, 200, { market: 'sol-usdy-usdc', token: 'svm-usdy', ...allowance })
    } catch (error) {
      console.warn('[withdrawal] fresh allowance unavailable', error?.message)
      return send(res, 503, { error: 'Fresh free-withdrawal allowance is unavailable. Retry after market data refreshes.' })
    }
  }],
  ['POST', /^\/api\/tx$/, async (req, res) => {
    if (limited(req, 'tx', 20)) return send(res, 429, { error: 'Too many requests' })
    const b = await jsonBody(req)
    if (!KINDS.includes(b.kind)) throw new UserError('Unknown action')
    if (!isAddress(String(b.wallet))) throw new UserError('Invalid wallet address')
    if (b.kind === 'loop-open' || b.kind === 'loop-close' || b.kind === 'loop-setup') {
      if (localForkDappEnabled && !isLocalForkWallet(b.wallet, { rpcUrl: RPC_URL })) {
        return send(res, 503, { error: 'Only generated LOCAL_FORK_ACCOUNT_n wallets can execute on the local Surfpool Dapp profile.' })
      }
      if (b.market !== 'sol-usdy-usdc') throw new UserError('Unknown loop strategy')
      if (b.kind === 'loop-open' && (typeof b.amount !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(b.amount)
        || !Number.isFinite(Number(b.amount)) || Number(b.amount) <= 0
        || !Number.isFinite(Number(b.leverage)) || Number(b.leverage) <= 1 || Number(b.leverage) > 1.5)) {
        throw new UserError('Funding amount or leverage is outside the loop range')
      }
      if (b.kind === 'loop-close' && (typeof b.positionId !== 'string' || !/^multiply:[a-f0-9]{64}$/.test(b.positionId))) {
        throw new UserError('An identified Multiply position is required for full close')
      }
    }
    if (b.kind === 'liquidate' && !isAddress(String(b.borrower))) throw new UserError('Invalid borrower address')
    if (blocked(res, b.wallet, { failClosed: true })) return
    if (b.kind === 'liquidate' && isSanctioned(b.borrower)) return send(res, 403, BLOCKED_LOAN)
    if (b.kind === 'loop-open' || b.kind === 'loop-close' || b.kind === 'loop-setup') {
      try { return send(res, 200, await loopExecution.build(b)) }
      catch (error) {
        if (error instanceof LoopExecutionError) {
          return send(res, error.status, { error: error.message, ...(error.unavailableReasons.length ? { unavailableReasons: error.unavailableReasons } : {}) })
        }
        console.error('[loop] atomic build failed', error?.message)
        return send(res, 503, { error: 'Atomic loop transaction building is unavailable; no transaction was handed to the wallet.' })
      }
    }
    try {
      send(res, 200, await lendingTransactions.build({
        kind: b.kind, wallet: b.wallet, market: b.market, token: b.token, amount: b.amount,
        amountBaseUnits: b.amountBaseUnits, all: !!b.all, borrower: b.borrower, preview: !!b.preview, vault: b.vault,
        swapFlow: b.swapFlow, swapFlowStage: b.swapFlowStage, flowAmountBaseUnits: b.flowAmountBaseUnits,
        beforeBalanceBaseUnits: b.beforeBalanceBaseUnits,
      }))
    } catch (e) {
      if (e instanceof UserError) throw e
      console.error('[tx] build failed', b.kind, e) // details stay in the logs (RPC errors can carry provider info)
      send(res, 502, { error: 'Could not build the transaction, please try again.' })
    }
  }],
  ['POST', /^\/api\/loop-send$/, async (req, res) => {
    if (limited(req, 'loop-send', 20)) return send(res, 429, { error: 'Too many requests' })
    const b = await jsonBody(req)
    if (!isAddress(String(b.wallet)) || typeof b.tx !== 'string' || b.tx.length > 100_000 || typeof b.intentId !== 'string') {
      throw new UserError('Invalid loop relay request')
    }
    if (blocked(res, b.wallet, { failClosed: true })) return
    try { return send(res, 200, await loopExecution.send({ tx: b.tx, wallet: b.wallet, intentId: b.intentId })) }
    catch (error) {
      if (error instanceof DefiniteSendRefusal) return send(res, 400, { error: error.message, outcome: 'rejected' })
      if (error instanceof SendOutcomeUnknownError) return send(res, 502, { error: error.message, signature: error.signature, outcome: 'unknown' })
      if (error instanceof LoopExecutionError) return send(res, error.status, { error: error.message, ...(error.unavailableReasons.length ? { unavailableReasons: error.unavailableReasons } : {}) })
      console.error('[loop] authorized relay failed', error?.message)
      return send(res, 502, { error: 'Could not relay the authorized loop transaction; its outcome may be unknown.' })
    }
  }],
  ['POST', /^\/api\/tx\/send$/, async (req, res) => {
    if (limited(req, 'send', 20)) return send(res, 429, { error: 'Too many requests' })
    const b = await jsonBody(req)
    if (!isAddress(String(b.wallet)) || typeof b.tx !== 'string' || b.tx.length > 2000 || typeof b.intentId !== 'string' || !b.intentId) throw new UserError('Invalid request')
    if (blocked(res, b.wallet, { failClosed: true })) return
    try { return send(res, 200, await lendingTransactions.send({ tx: b.tx, wallet: b.wallet, intentId: b.intentId })) }
    catch (error) {
      if (error instanceof DefiniteSendRefusal) return send(res, 400, { error: error.message, outcome: 'rejected' })
      if (error instanceof SendOutcomeUnknownError) return send(res, 502, { error: error.message, signature: error.signature, outcome: 'unknown' })
      throw error
    }
  }],
  ['POST', /^\/api\/tx\/reconcile-local$/, async (req, res) => {
    if (limited(req, 'tx-reconcile-local', 10)) return send(res, 429, { error: 'Too many reconciliation checks.' })
    const body = await jsonBody(req)
    if (!localForkDappEnabled || !isLocalForkWallet(body.wallet, { rpcUrl: RPC_URL })) {
      return send(res, 403, { error: 'Local dropped-transaction reconciliation is available only for generated Surfpool wallets.' })
    }
    if (typeof body.signature !== 'string' || typeof body.tx !== 'string' || body.tx.length > 100_000) {
      return send(res, 400, { error: 'Invalid local transaction reconciliation request.' })
    }
    try {
      const wire = Uint8Array.from(Buffer.from(body.tx, 'base64'))
      const transaction = getTransactionDecoder().decode(wire)
      const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
      const wallet = String(body.wallet)
      const signatureBytes = transaction.signatures?.[wallet]
      if (String(message.staticAccounts?.[0]) !== wallet || !(signatureBytes instanceof Uint8Array)
        || signatureBytes.length !== 64 || getBase58Decoder().decode(signatureBytes) !== body.signature
        || !await verifySignature(await getPublicKeyFromAddress(wallet), signatureBytes, transaction.messageBytes)) {
        return send(res, 400, { error: 'The saved transaction signature or fee payer does not match the connected local wallet.' })
      }
      const recent = await rpc.getSignatureStatuses([body.signature], { searchTransactionHistory: true }).send()
      if (recent?.value?.[0]) return send(res, 200, await txStatus(body.signature))
      const historical = await rpc.getTransaction(body.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 }).send()
      if (historical) return send(res, 200, await txStatus(body.signature))
      const blockhash = String(message.lifetimeToken ?? '')
      if (!blockhash) return send(res, 400, { error: 'The saved local transaction has no recent blockhash.' })
      const blockhashStatus = await rpc.isBlockhashValid(blockhash, { commitment: 'confirmed' }).send()
      return send(res, 200, blockhashStatus?.value === true
        ? { status: 'pending' }
        : { status: 'failed', error: 'Surfpool found no landed transaction for this signature and its recent blockhash expired; it can no longer be submitted.' })
    } catch (error) {
      console.warn('[tx] local reconciliation unavailable', error?.message)
      return send(res, 503, { error: 'Surfpool could not conclusively reconcile this signed transaction.' })
    }
  }],
  ['GET', /^\/api\/liquidation\/([\w-]+)\/(\w+)$/, async (req, res, [marketId, borrower]) => {
    const m = marketById(marketId)
    if (!m || !isAddress(borrower)) return send(res, 400, { error: 'Invalid market or wallet' })
    if (limited(req, 'liquidation', 60)) return send(res, 429, { error: 'Too many requests' })
    if (isSanctioned(borrower)) return send(res, 403, BLOCKED_LOAN)
    send(res, 200, await liquidationInfo(m, borrower))
  }],
  ['GET', /^\/api\/tx\/(\w{64,90})$/, async (req, res, [signature]) => {
    if (limited(req, 'status', 120)) return send(res, 429, { error: 'Too many requests' })
    send(res, 200, await txStatus(signature))
  }],
  ['GET', /^\/api\/analytics$/, async (req, res) => {
    // On-chain analytics are optional; configured public fee receivers remain available if either read fails.
    const [positions, vaults] = await Promise.all([
      getPositions().catch((e) => { console.error('[analytics] positions', e?.message); return null }),
      getVaultHolders().catch((e) => { console.error('[analytics] vault holders', e?.message); return null }),
    ])
    send(res, 200, { positions, vaults, feeReceivers: getFeeReceiverMetadata() }, { maxAge: 30 })
  }],
  ['GET', /^\/api\/market-updates$/, async (req, res) => send(res, 200, await marketUpdates(), { maxAge: 60 })],
  ['GET', /^\/api\/liquidations$/, async (req, res) => send(res, 200, await marketLiquidations(), { maxAge: 60 })],
  ['GET', /^\/api\/points$/, async (req, res) => send(res, 200, (await read(POINTS)) ?? EMPTY_POINTS, { type: 'text/csv; charset=utf-8', maxAge: 300 })],
  ['GET', /^\/api\/apy-history$/, async (req, res) => send(res, 200, (await read(HISTORY)) ?? '{"tokens":{}}', { maxAge: 300 })],
  ['GET', /^\/api\/health$/, (req, res) => {
    const s = getSnapshot()
    const age = s ? Math.round((Date.now() - s.updatedAt) / 1000) : null
    send(res, s && age < 300 ? 200 : 503, { ok: !!s && age < 300, marketAgeSec: age, sseClients: clients.size, rpcCallsLastHour: rpcCallsLastHour(), sanctionsScreening: screeningStatus() })
  }],
]

// Client-side routes of the SPA (keep in sync with src/main.js).
// '/', '/lend' and '/market/:id' are old links the SPA redirects (to Earn, a vault or a borrow market page).
const APP_ROUTES = new Set(['/', '/earn', '/lend', '/borrow', '/portfolio', '/swap', '/loop', '/analytics', '/liquidations', '/dashboard'])
const isAppRoute = (p) => APP_ROUTES.has(p.replace(/\/$/, '') || '/')
  || !!vaultById(p.match(/^\/earn\/([\w-]+)\/?$/)?.[1])
  || !!marketById(p.match(/^\/(?:borrow|market)\/([\w-]+)\/?$/)?.[1])

// Public pages for search engines; markets come from config.js, so a new live market is listed automatically.
const SITE = 'https://app.nysa.finance'
const sitemap = () => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['/earn', ...VAULTS.map((v) => `/earn/${v.id}`), '/borrow', ...LIVE.map((m) => `/borrow/${m.id}`), '/swap', '/loop', '/analytics', '/liquidations'].map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join('\n')}
</urlset>
`

async function serveStatic(pathname, res) {
  const file = normalize(join(DIST, decodeURIComponent(pathname)))
  if (!file.startsWith(DIST)) return send(res, 400, 'Bad request', { type: 'text/plain' }) // no ../ escapes
  let body, served = file
  try {
    body = await readFile(file)
  } catch {
    // A missing file (/favicon.ico, /x.png) is a plain 404. Other paths get the SPA, with a real 404 status when they
    // aren't one of its routes (so search engines don't index "soft 404s"; the SPA shows its Not Found page).
    if (extname(pathname)) return send(res, 404, 'Not found', { type: 'text/plain' })
    if (!isAppRoute(pathname)) res.statusCode = 404
    served = join(DIST, 'index.html')
    body = await readFile(served)
  }
  const type = TYPES[extname(served)] ?? 'application/octet-stream'
  res.setHeader('content-type', type)
  // Public images (favicon, app icon, logos) readable from any origin: wallets like Phantom load the app icon for their
  // dialogs from their own origin, and fall back to a generic icon when the browser blocks the read.
  if (type.startsWith('image/')) res.setHeader('access-control-allow-origin', '*')
  // Hashed build assets never change; everything else is revalidated so new deploys show up.
  res.setHeader('cache-control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  res.end(body)
}

http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname.startsWith('/api/')) {
      for (const [method, re, handler] of routes) {
        const match = pathname.match(re)
        if (!match) continue
        if (req.method !== method) return send(res, 405, { error: 'Method not allowed' })
        return await handler(req, res, match.slice(1))
      }
      return send(res, 404, { error: 'Not found' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { type: 'text/plain' })
    if (pathname === '/sitemap.xml') return send(res, 200, sitemap(), { type: 'application/xml; charset=utf-8', maxAge: 3600 })
    await serveStatic(pathname === '/' ? '/index.html' : pathname, res)
  } catch (e) {
    if (e instanceof UserError) return send(res, 400, { error: e.message })
    console.error('[server]', req.method, req.url, e)
    if (!res.headersSent) send(res, 500, { error: 'Internal error' })
    else res.end()
  }
}).listen(PORT, () => console.log(`nysa listening on :${PORT}`))

refreshMarket() // first read now, then every REFRESH_MS (market.js)
startScreening() // OFAC sanctions list: saved copy now, fresh download daily

// Snapshot every 12 hours, at 00:00 and 12:00 UTC (epoch multiples of 12 h). A missed run (e.g. a restart at that
// minute) is harmless: the next one accrues the whole gap.
const SNAPSHOT_EVERY_MS = 12 * 3_600_000
function scheduleSnapshot() {
  const now = Date.now()
  const next = (Math.floor(now / SNAPSHOT_EVERY_MS) + 1) * SNAPSHOT_EVERY_MS
  setTimeout(() => runSnapshot()
    .then((r) => console.log('[snapshot] done', r))
    .catch((e) => console.error('[snapshot] failed', e))
    .finally(scheduleSnapshot), next - now)
}
scheduleSnapshot()
