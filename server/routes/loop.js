// Leveraged loops (Kamino Multiply): release gates, strategies, read-only previews, build and relay of open, close and
// the one-time Kamino metadata setup.
import { randomUUID } from 'node:crypto'
import { isAddress } from '@solana/kit'
import { PROGRAM_ID as KAMINO_LENDING_PROGRAM_ID } from '@kamino-finance/klend-sdk'
import { getSnapshot, refreshMarketForExecution } from '../market.js'
import { getAccount } from '../account.js'
import { compileAtomicTransaction, sendSigned, UserError } from '../tx.js'
import { read, HISTORY } from '../storage.js'
import { priceApy } from '../../shared/finance.js'
import { DEFAULT_LOOP_LIMITS } from '../../shared/loop-policy.js'
import { LOOP_ENABLED, LOOPS, TOKENS, loopByMarket, loopMarket, marketById } from '../../shared/config.js'
import { evaluateLoopActionReadiness, evaluateLoopStrategy, LOOP_ALLOWED_MARKET_IDS } from '../strategy.js'
import {
  LoopPreviewError,
  LOOP_PREVIEW_TTL_MS,
  LOOP_SIGNING_WINDOW_MS,
  buildLoopCloseApplication,
  buildLoopMetadataSetupApplication,
  buildLoopOpenApplication,
  buildReadOnlyLoopPreview,
  loopMetadataStatus,
  simulateLoopApplication,
  verifyLoopApplicationSimulation,
  verifyLoopMetadataSetupSimulation,
} from '../loop.js'
import { configuredFeeAccountForMint } from '../swap.js'
import {
  LOOP_PREVIEW_MAX_AGE_MS,
  loopCarryStillCurrent,
  loopMarketRiskFromSnapshot,
  loopMarketRiskStillCurrent,
} from '../loop-preview-validation.js'
import { swapReadiness } from '../swap-routes.js'
import { runWithRequestAbortSignal } from '../request-signal.js'
import { swapIntentStillAuthorized } from '../swap-execution.js'
import { createSwapIntentStore, loopSetupMessageMatchesIgnoringBlockhash } from '../tx-intent.js'
import { noteBuilt } from '../relay.js'
import { LOOP_PROGRAMS } from '../program-policy.js'
import { DefiniteSendRefusal, SendOutcomeUnknownError } from '../send-safety.js'
import { createLoopExecutionService, LoopExecutionError } from '../loop-execution.js'
import { explain, isTransient } from '../errors.js'
import { RPC_URL } from '../rpc.js'
import {
  executionMode,
  isLocalWallet,
  localForkDappEnabled,
  localForkProgramEvidenceReady,
  localIntentAuthorized,
  validateSwapRouteForCurrentNetwork,
  verifyLocalForkRoute,
} from '../execution-mode.js'
import { blocked, geoBlocked, GEO_REFUSED, jsonBody, limited, send } from '../http.js'

export const LOOP_KINDS = new Set(['loop-open', 'loop-close', 'loop-setup'])

// Private beta, while LOOP_ENABLED is off: only LOOP_WALLETS see the loop, and they can open real ones (up to
// LOOP_MAX_FUNDING dollars of collateral each, empty for no cap). Listing a wallet is the approval: it stands in for the risk owner and
// the fork-only gates, covered by the passing `npm run verify:loop-fork` run (open, close, fees, rollback). Releasing to
// everyone (LOOP_ENABLED) still needs NYSA_LOOP_RISK_OWNER / _APPROVED_AT and those gates.
export const LOOP_WALLETS = new Set(
  (process.env.LOOP_WALLETS ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean),
)
export const loopOn = LOOP_ENABLED || LOOP_WALLETS.size > 0
// A betaOnly loop (config.js) stays with LOOP_WALLETS even once loops are released to everyone.
export const loopOpenTo = (wallet, marketId) =>
  (LOOP_ENABLED && !loopByMarket(marketId)?.betaOnly) || LOOP_WALLETS.has(wallet)
const LOOP_NOT_ENABLED = { error: 'Loop is not available for this wallet yet.' }
// A loop runs under the private-beta approval (LOOP_WALLETS stand in for the risk owner and the fork-verified gates)
// while loops are off, and always for a betaOnly loop (oTFY). A loop released to everyone (LOOP_ENABLED) runs under
// the named risk approval instead: NYSA_LOOP_RISK_OWNER and NYSA_LOOP_RISK_APPROVED_AT, which also stand for its
// passed fork checks. Without them a released loop stays closed.
const loopUnderBeta = (marketId) => (!LOOP_ENABLED || !!loopByMarket(marketId)?.betaOnly) && LOOP_WALLETS.size > 0
const releaseApproved = () =>
  !!process.env.NYSA_LOOP_RISK_OWNER?.trim() &&
  Number.isFinite(Date.parse(process.env.NYSA_LOOP_RISK_APPROVED_AT ?? ''))
const loopGatesPassed = (marketId) => loopUnderBeta(marketId) || (LOOP_ENABLED && releaseApproved())
const LOOP_MAX_FUNDING = Number(process.env.LOOP_MAX_FUNDING) > 0 ? Number(process.env.LOOP_MAX_FUNDING) : null
// Loops are funded in their collateral, so the cap is its dollar value at the market's oracle price.
const overLoopCap = (amount, marketId) => {
  if (LOOP_MAX_FUNDING == null) return false
  const collateral = loopByMarket(marketId).collateral
  const price = Number(getSnapshot()?.reserves?.[marketId]?.[collateral]?.price) || TOKENS[collateral].price
  return Number(amount) * price > LOOP_MAX_FUNDING
}
// A loop is funded in its collateral, so an amount may carry up to that token's decimals (oTFY has 9), as the panel
// lets you type and as Jupiter truncates: more would not fit in base units.
const loopAmountValid = (amount, marketId) =>
  typeof amount === 'string' &&
  new RegExp(`^\\d+(?:\\.\\d{1,${TOKENS[loopByMarket(marketId).collateral].decimals}})?$`).test(amount)
const LOOP_CAP_ERROR = () => `Loops are capped at $${LOOP_MAX_FUNDING} during the beta.`

// A `priceYield` collateral (USDY) earns through its price, not Kamino's supply APR, so the loop's carry adds it: the
// annualized rise of the oracle price the snapshot records. Until a week of prices exists, <TOKEN>_APY (e.g. USDY_APY,
// the issuer's published rate) if set; otherwise it is left out of the carry.
const envApy = (loop) => {
  const value = process.env[`${TOKENS[loop.collateral].name.toUpperCase()}_APY`]
  return value && Number.isFinite(Number(value)) ? { apy: Number(value), source: 'env' } : null
}
const priceYields = new Map(LOOPS.filter((loop) => loop.priceYield).map((loop) => [loop.market, envApy(loop)]))
async function loadPriceYields() {
  try {
    const history = JSON.parse((await read(HISTORY)) ?? '{}')
    for (const loop of LOOPS.filter((item) => item.priceYield)) {
      const measured = priceApy(history.tokens?.[loopMarket(loop).reserves[loop.collateral]]?.points ?? [])
      priceYields.set(loop.market, measured != null ? { apy: measured, source: 'price' } : envApy(loop))
    }
  } catch (error) {
    console.warn('[loop] price yield unavailable', error?.message)
  }
}
if (loopOn) {
  loadPriceYields()
  setInterval(loadPriceYields, 3_600_000).unref()
}
const loopReserves = (snapshot, marketId) => {
  const reserves = snapshot?.reserves?.[marketId] ?? {}
  const { collateral } = loopByMarket(marketId)
  const yieldOf = priceYields.get(marketId)
  return reserves[collateral]
    ? {
        ...reserves,
        [collateral]: {
          ...reserves[collateral],
          nativeApy: yieldOf?.apy ?? null,
          nativeApySource: yieldOf?.source ?? null,
        },
      }
    : reserves
}
const loopFeeAccountsConfigured = (marketId) =>
  !!configuredFeeAccountForMint(TOKENS[loopByMarket(marketId).collateral].mint) &&
  !!configuredFeeAccountForMint(TOKENS[loopByMarket(marketId).debt].mint) &&
  !!process.env.SWAP_FEE_TREASURY_AUTHORITY

// Loop exits use the same route/program/fee/fork gates as swaps, but do not depend on new-entry allocation policy.
function currentLoopRouteReadiness(marketId) {
  const snapshot = getSnapshot()
  const snapshotFresh =
    Number.isFinite(snapshot?.updatedAt) &&
    snapshot.updatedAt > 0 &&
    Date.now() >= snapshot.updatedAt &&
    Date.now() - snapshot.updatedAt <= 60_000
  const localExecution = localForkProgramEvidenceReady()
  const forkProof = localExecution || loopGatesPassed(marketId)
  const routeReadiness = swapReadiness({
    providerConfigured: !!process.env.JUPITER_API_KEY || localExecution,
    feeAccountsConfigured: loopFeeAccountsConfigured(marketId),
    marketDataAvailable: snapshotFresh,
    marketAvailabilityReasons: [
      ...(snapshotFresh
        ? []
        : [{ code: 'market-data-stale', message: 'Fresh market data is unavailable for a safe loop transaction.' }]),
      // The loop is not released on mainnet yet: its transactions build only on the local fork.
      ...(forkProof
        ? []
        : [
            { code: 'fork-proof-missing', message: 'The required local-fork fee and rollback checks have not passed.' },
          ]),
    ],
  })
  return routeReadiness
}

function loopStrategyForAction(snapshot, marketId, leverage = 1.5) {
  const localExecution = localForkProgramEvidenceReady()
  return evaluateLoopStrategy({
    marketId,
    market: loopMarket(loopByMarket(marketId)),
    allowedMarketIds: LOOP_ALLOWED_MARKET_IDS,
    vaults: snapshot?.vaults ?? {},
    reserves: loopReserves(snapshot, marketId),
    snapshotUpdatedAt: snapshot?.updatedAt ?? 0,
    providerConfigured: true, // keyless access remains quote-only; route execution is separately denied below.
    productionProviderConfigured: !!process.env.JUPITER_API_KEY || localExecution,
    treasuryConfigured: loopFeeAccountsConfigured(marketId),
    riskApproval: localExecution
      ? { owner: 'Local Surfpool disposable-wallet profile', approvedAt: new Date().toISOString() }
      : loopUnderBeta(marketId)
        ? { owner: 'LOOP_WALLETS private beta', approvedAt: new Date(0).toISOString() }
        : { owner: process.env.NYSA_LOOP_RISK_OWNER, approvedAt: process.env.NYSA_LOOP_RISK_APPROVED_AT },
    feasibilityPassed: localExecution || loopGatesPassed(marketId),
    leverage,
  })
}

function currentLoopActionReadiness(body, { previewAcknowledgementValid = false, positionVerified = false } = {}) {
  if (localForkDappEnabled && !isLocalWallet(body.wallet)) {
    return {
      executionEnabled: false,
      unavailableReasons: [
        {
          code: 'local-fork-wallet-not-allowlisted',
          message: 'Connect a generated LOCAL_FORK_ACCOUNT_n wallet to execute on this local Surfpool profile.',
        },
      ],
    }
  }
  const snapshot = getSnapshot()
  return evaluateLoopActionReadiness({
    action: body.kind,
    strategy: body.kind === 'loop-open' ? loopStrategyForAction(snapshot, body.market, Number(body.leverage)) : null,
    routeReadiness: currentLoopRouteReadiness(body.market),
    positionId: body.positionId,
    positionVerified,
    builderAvailable: true,
    previewAcknowledgementValid,
  })
}

const loopPreviews = new Map()
// Time to review and approve in the wallet; the transaction's own minimum swap output and Kamino's checks still bind.
const loopIntentStore = createSwapIntentStore({
  ttlMs: LOOP_SIGNING_WINDOW_MS,
  messageMatcher: loopSetupMessageMatchesIgnoringBlockhash,
})
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
    const strategy =
      action === 'loop-open' ? loopStrategyForAction(snapshot, request.market, Number(preview.leverage)) : null
    const currentCarry = strategy?.carry
    const previewCarry = preview?.carry
    const now = Date.now()
    const snapshotFresh =
      Number.isFinite(snapshot?.updatedAt) &&
      snapshot.updatedAt > 0 &&
      now >= snapshot.updatedAt &&
      now - snapshot.updatedAt <= LOOP_PREVIEW_MAX_AGE_MS
    const currentMarketRisk = loopMarketRiskFromSnapshot(snapshot, request.market)
    if (
      action === 'loop-open' &&
      (!snapshotFresh ||
        !loopCarryStillCurrent(previewCarry, currentCarry, now) ||
        !loopMarketRiskStillCurrent(preview?.sdk?.marketRisk, currentMarketRisk, Number(snapshot?.blockTime)))
    ) {
      return {
        executionEnabled: false,
        unavailableReasons: [
          {
            code: 'loop-preview-stale',
            message:
              'Loop market, oracle, or carry assumptions changed or became stale after preview; build a fresh preview.',
          },
        ],
      }
    }
    return currentLoopActionReadiness(
      {
        ...request,
        kind: action,
        leverage: Number(preview?.leverage ?? request.leverage),
        positionId: position?.id ?? request.positionId,
      },
      { previewAcknowledgementValid, positionVerified: !!position },
    )
  },
  getPreview: async (id) => activeLoopPreview(id),
  getPosition: async ({ wallet, positionId }) => {
    const account = await getAccount(wallet, true)
    return account.loopPositions.find((position) => position.id === positionId) ?? null
  },
  metadataReady: async ({ wallet, market }) => !(await loopMetadataStatus({ wallet, market })).required,
  setupRequired: async ({ wallet, market }) => (await loopMetadataStatus({ wallet, market })).required,
  buildOpen: ({ wallet, request, preview }) =>
    buildLoopOpenApplication({
      wallet,
      amount: request.amount,
      leverage: request.leverage,
      preview,
      validateRoute: validateSwapRouteForCurrentNetwork,
    }),
  buildClose: ({ wallet, position }) =>
    buildLoopCloseApplication({
      wallet,
      position,
      validateRoute: validateSwapRouteForCurrentNetwork,
      localForkSimulation: localForkDappEnabled,
      localForkRpcUrl: RPC_URL,
      localRouteProgramVerifier: verifyLocalForkRoute,
    }),
  buildSetup: ({ wallet, market }) => buildLoopMetadataSetupApplication({ wallet, market }),
  compile: ({ lookupTables = [], market, ...rest }) =>
    compileAtomicTransaction({
      ...rest,
      lookupTables: [...lookupTables, loopByMarket(market).lookupTable].filter(Boolean),
    }),
  simulate: simulateLoopApplication,
  verifySimulation: async ({ kind, ...context }) =>
    kind === 'loop-setup'
      ? verifyLoopMetadataSetupSimulation(context)
      : verifyLoopApplicationSimulation({ kind, ...context }),
  intentStore: loopIntentStore,
  authorize: async ({ intent }) => {
    const ready = currentLoopRouteReadiness(intent?.metadata?.market).executionEnabled
    if (localForkDappEnabled) return ready && (await localIntentAuthorized(intent))
    return swapIntentStillAuthorized(intent, { executionEnabled: ready, approvedPrograms: LOOP_PROGRAMS })
  },
  authorizeSetup: async ({ intent }) =>
    intent?.metadata?.kind === 'loop-setup' &&
    (!localForkDappEnabled || isLocalWallet(intent?.wallet)) &&
    !!loopByMarket(intent.metadata.market) &&
    intent.metadata.programIds?.length === 1 &&
    String(intent.metadata.programIds[0]) === String(KAMINO_LENDING_PROGRAM_ID) &&
    (intent.metadata.routeLabels ?? []).length === 0,
  send: ({ tx, wallet, intent }) => sendSigned({ tx, wallet, approvedProgramIds: intent.metadata?.programIds ?? [] }),
  onBuild: (wallet) => noteBuilt(wallet),
})

// The loop part of POST /api/tx (lending.js): its own validation, then the build. Returns true once it has answered.
export function loopTxRefused(res, b) {
  if (!loopOpenTo(b.wallet, b.market)) return (send(res, 403, LOOP_NOT_ENABLED), true)
  if (localForkDappEnabled && !isLocalWallet(b.wallet)) {
    send(res, 503, {
      error: 'Only generated LOCAL_FORK_ACCOUNT_n wallets can execute on the local Surfpool Dapp profile.',
    })
    return true
  }
  if (!loopByMarket(b.market)) throw new UserError('Unknown loop strategy')
  if (
    b.kind === 'loop-open' &&
    (!loopAmountValid(b.amount, b.market) ||
      !Number.isFinite(Number(b.amount)) ||
      Number(b.amount) <= 0 ||
      !Number.isFinite(Number(b.leverage)) ||
      Number(b.leverage) <= 1 ||
      Number(b.leverage) > DEFAULT_LOOP_LIMITS.maxLeverage)
  ) {
    throw new UserError('Funding amount or leverage is outside the loop range')
  }
  if (b.kind === 'loop-open' && overLoopCap(b.amount, b.market)) throw new UserError(LOOP_CAP_ERROR())
  if (b.kind === 'loop-close' && (typeof b.positionId !== 'string' || !/^multiply:[a-f0-9]{64}$/.test(b.positionId))) {
    throw new UserError('An identified Multiply position is required for full close')
  }
  return false
}

export async function buildLoopTx(res, b) {
  try {
    return send(res, 200, await loopExecution.build(b))
  } catch (error) {
    if (error instanceof LoopExecutionError) {
      return send(res, error.status, {
        error: error.message,
        ...(error.unavailableReasons.length ? { unavailableReasons: error.unavailableReasons } : {}),
      })
    }
    if (error instanceof LoopPreviewError) return send(res, 409, { error: error.message }) // e.g. a loop is already open
    // The simulation's own reason, already worded for the user (e.g. the market's liquidity or borrowing limit).
    if (error instanceof UserError) return send(res, 409, { error: error.message })
    const { status, error: message } = explain(
      error,
      'loop build',
      'Could not prepare the loop transaction; nothing was sent to your wallet.',
    )
    return send(res, status, { error: message })
  }
}

export const loopRoutes = [
  [
    'GET',
    /^\/api\/loop-strategies$/,
    (req, res) => {
      const snapshot = getSnapshot()
      const strategies = LOOPS.map(({ market }) => {
        const strategy = loopStrategyForAction(snapshot, market)
        const routeReadiness = currentLoopRouteReadiness(market)
        return {
          ...strategy,
          actions: {
            open: evaluateLoopActionReadiness({
              action: 'loop-open',
              strategy,
              routeReadiness,
              builderAvailable: true,
            }),
            fullClose: evaluateLoopActionReadiness({ action: 'loop-close', routeReadiness, builderAvailable: true }),
          },
        }
      })
      return send(res, 200, {
        strategies,
        readOnly: true,
        maxFunding: LOOP_MAX_FUNDING,
        executionMode: executionMode,
      })
    },
  ],
  [
    'GET',
    /^\/api\/loop-setup-status$/,
    async (req, res) => {
      if (limited(req, 'loop-setup-status', 10)) return send(res, 429, { error: 'Too many requests' })
      const wallet = new URL(req.url, 'http://localhost').searchParams.get('wallet')
      if (!wallet || !isAddress(wallet)) return send(res, 400, { error: 'Invalid wallet address' })
      if (!loopOpenTo(wallet)) return send(res, 403, LOOP_NOT_ENABLED)
      if (blocked(res, wallet, { failClosed: true })) return
      // Kamino's UserMetadata is one per wallet, whichever market reads it.
      try {
        return send(res, 200, { ...(await loopMetadataStatus({ wallet, market: LOOPS[0].market })), readOnly: true })
      } catch (error) {
        console.warn('[loop] metadata status unavailable', error?.message)
        return send(res, 503, { error: 'Kamino metadata setup status is unavailable.' })
      }
    },
  ],
  [
    'POST',
    /^\/api\/loop-preview$/,
    async (req, res) => {
      if (limited(req, 'loop-preview', 20)) return send(res, 429, { error: 'Too many requests' })
      const body = await jsonBody(req)
      if (!loopByMarket(body.marketId)) throw new UserError('Unknown loop strategy')
      if (body.wallet != null && !isAddress(String(body.wallet))) throw new UserError('Invalid wallet address')
      if (!loopOpenTo(body.wallet, body.marketId)) return send(res, 403, LOOP_NOT_ENABLED)
      if (marketById(body.marketId)?.geoBlocked && geoBlocked(req)) return send(res, 403, GEO_REFUSED)
      if (overLoopCap(body.fundingAmount, body.marketId)) throw new UserError(LOOP_CAP_ERROR())
      if (!loopAmountValid(body.fundingAmount, body.marketId)) throw new UserError('Invalid funding amount')
      const fundingAmount = Number(body.fundingAmount)
      const leverage = Number(body.leverage)
      const amountInRange = Number.isFinite(fundingAmount) && fundingAmount > 0
      const leverageInRange = leverage > 1 && leverage <= DEFAULT_LOOP_LIMITS.maxLeverage
      if (!amountInRange || !leverageInRange)
        throw new UserError('Funding amount or leverage is outside the preview range')
      const snapshot = getSnapshot()
      const strategy = loopStrategyForAction(snapshot, body.marketId, leverage)
      const previewId = randomUUID()
      let applicationContext = null
      try {
        return await runWithRequestAbortSignal(req, res, async (signal) => {
          try {
            const previewOnce = () =>
              buildReadOnlyLoopPreview({
                marketId: body.marketId,
                wallet: body.wallet,
                fundingAmount: body.fundingAmount,
                leverage,
                snapshot,
                strategy,
                signal,
                localForkSimulation: localForkDappEnabled && isLocalWallet(body.wallet),
                localForkRpcUrl: RPC_URL,
                localRouteProgramVerifier: verifyLocalForkRoute,
                onApplicationContext: (context) => {
                  applicationContext = context
                },
              })
            // Back-to-back quotes (the auto-refresh, then the fresh one taken on click) can hit the provider's rate limit:
            // a read-only preview is safe to ask once more.
            const preview = await previewOnce().catch(async (error) => {
              if (!isTransient(error) || signal.aborted) throw error
              await new Promise((resolve) => setTimeout(resolve, 1500))
              return previewOnce()
            })
            if (signal.aborted || res.destroyed) return
            const actionReadiness = evaluateLoopActionReadiness({
              action: 'loop-open',
              strategy,
              routeReadiness: currentLoopRouteReadiness(body.marketId),
              builderAvailable: true,
              previewAcknowledgementValid: false,
            })
            if (localForkDappEnabled && !isLocalWallet(body.wallet)) {
              actionReadiness.executionEnabled = false
              actionReadiness.unavailableReasons.push({
                code: 'local-fork-wallet-not-allowlisted',
                message: 'Connect a generated LOCAL_FORK_ACCOUNT_n wallet to execute on this local Surfpool profile.',
              })
            }
            const metadataStatus = body.wallet
              ? await loopMetadataStatus({ wallet: body.wallet, market: body.marketId })
              : { required: false }
            if (metadataStatus.required) {
              actionReadiness.executionEnabled = false
              actionReadiness.unavailableReasons.push({
                code: 'kamino-metadata-setup-required',
                message: 'Initialize the one-time Kamino UserMetadata account before opening a loop.',
              })
            }
            // The preview only binds amount, leverage and acknowledgement: the build quotes again and rechecks prices and
            // limits, so it can outlive its quote long enough to read it and click (it bounded preview → signed send to 15s).
            const expiresAt = Date.now() + LOOP_PREVIEW_TTL_MS
            if (body.wallet && applicationContext) {
              const record = {
                ...preview,
                id: previewId,
                wallet: body.wallet,
                marketId: body.marketId,
                fundingAmount: body.fundingAmount,
                leverage,
                expiresAt,
                applicationContext,
              }
              loopPreviews.set(previewId, record)
              for (const [id, item] of loopPreviews) if (Date.now() >= item.expiresAt) loopPreviews.delete(id)
            }
            return send(res, 200, {
              ...preview,
              previewId,
              actionReadiness,
              metadataSetupRequired: metadataStatus.required,
              strategyId: body.marketId,
              readOnly: true,
              executionMode: executionMode,
            })
          } catch (error) {
            if (signal.aborted || res.destroyed) return
            console.warn('[loop] preview unavailable', error?.message)
            return send(res, 200, {
              previewId,
              strategyId: body.marketId,
              readOnly: true,
              executionEnabled: false,
              available: false,
              unavailableReasons: [
                ...strategy.unavailableReasons,
                {
                  code: 'quote-unavailable',
                  message: "Couldn't get a live swap quote right now. Try again in a moment.",
                },
              ],
            })
          }
        })
      } catch (error) {
        if (res.destroyed) return
        throw error
      }
    },
  ],
  [
    'POST',
    /^\/api\/loop-send$/,
    async (req, res) => {
      if (limited(req, 'loop-send', 20)) return send(res, 429, { error: 'Too many requests' })
      const b = await jsonBody(req)
      if (
        !isAddress(String(b.wallet)) ||
        typeof b.tx !== 'string' ||
        b.tx.length > 100_000 ||
        typeof b.intentId !== 'string'
      ) {
        throw new UserError('Invalid loop relay request')
      }
      if (!loopOpenTo(b.wallet)) return send(res, 403, LOOP_NOT_ENABLED)
      if (blocked(res, b.wallet, { failClosed: true })) return
      try {
        return send(res, 200, await loopExecution.send({ tx: b.tx, wallet: b.wallet, intentId: b.intentId }))
      } catch (error) {
        if (error instanceof DefiniteSendRefusal) return send(res, 400, { error: error.message, outcome: 'rejected' })
        if (error instanceof SendOutcomeUnknownError)
          return send(res, 502, { error: error.message, signature: error.signature, outcome: 'unknown' })
        if (error instanceof LoopExecutionError)
          return send(res, error.status, {
            error: error.message,
            ...(error.unavailableReasons.length ? { unavailableReasons: error.unavailableReasons } : {}),
          })
        const { error: message } = explain(
          error,
          'loop relay',
          'Could not relay the authorized loop transaction; its outcome may be unknown.',
          'The Solana network connection is busy right now, so nothing was sent. Rebuild it and try again.',
        )
        return send(res, 502, { error: message })
      }
    },
  ],
]
