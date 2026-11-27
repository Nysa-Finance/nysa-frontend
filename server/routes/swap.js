// Token swaps through Jupiter: readiness, quote, build (simulated, oracle-bounded) and relay of the signed transaction.
import { isAddress } from '@solana/kit'
import { getSnapshot } from '../market.js'
import { sendSigned, UserError } from '../tx.js'
import { TOKENS } from '../../shared/config.js'
import { buildSwap, configuredFeeAccountForMint, FEE_BPS, swapFeeAccountsConfigured, SwapError } from '../swap.js'
import {
  createPublicSwapQuote,
  parseSwapQuoteRequest,
  SwapRouteError,
  marketForPair,
  swapPairAvailability,
  swapReadiness,
} from '../swap-routes.js'
import { runWithRequestAbortSignal } from '../request-signal.js'
import {
  createSwapExecutionService,
  compileSwapTransaction,
  simulateSwapTransaction,
  createAuthorizedSwapSender,
  swapIntentStillAuthorized,
  assertOracleFairOutput,
  SwapExecutionError,
} from '../swap-execution.js'
import { createSwapIntentStore, messageMatchesWithLighthouse } from '../tx-intent.js'
import { noteBuilt } from '../relay.js'
import { DefiniteSendRefusal, SendOutcomeUnknownError } from '../send-safety.js'
import { explain } from '../errors.js'
import {
  executionMode,
  isLocalWallet,
  localForkDappEnabled,
  localForkProgramEvidenceReady,
  localIntentAuthorized,
  verifyLocalForkRoute,
} from '../execution-mode.js'
import { blocked, jsonBody, limited, send } from '../http.js'
import { LOOP_WALLETS, loopOpenTo } from './loop.js'

// Swap stays off without the Jupiter key and fee accounts; SWAP_WALLETS limits it to those wallets (mainnet beta).
const SWAP_WALLETS = new Set(
  (process.env.SWAP_WALLETS ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean),
)
const swapOpenTo = (wallet) => SWAP_WALLETS.size === 0 || SWAP_WALLETS.has(wallet)
const SWAP_NOT_ENABLED = { error: 'Swap is not available for this wallet yet.' }

export function currentSwapReadiness(request = {}) {
  const snapshot = getSnapshot()
  const market = marketForPair(request.inputMint, request.outputMint)
  const pair = market?.pairs[0]
  const availability = swapPairAvailability({
    market,
    vaults: snapshot?.vaults ?? {},
    snapshotUpdatedAt: snapshot?.updatedAt ?? 0,
    // no pair asked: buying the first market's collateral
    inputMint: request.inputMint ?? (pair && TOKENS[pair.liability].mint),
    outputMint: request.outputMint ?? (pair && TOKENS[pair.collateral].mint),
  })
  const localTestWallet = isLocalWallet(request.wallet)
  const localExecution = localForkProgramEvidenceReady() && (!request.wallet || localTestWallet)
  const providerConfigured = !!process.env.JUPITER_API_KEY || localExecution
  const feeAccountsConfigured = swapFeeAccountsConfigured()
  const walletEnabled = swapOpenTo(request.wallet)
  const readiness = swapReadiness({
    providerConfigured,
    feeAccountsConfigured,
    walletEnabled,
    marketDataAvailable: availability.available,
    marketAvailabilityReasons: availability.reasons,
  })
  // Whether the frontend shows the swap entry points to this wallet (not the market-data state, which comes and goes).
  return { readiness, availability, visible: providerConfigured && feeAccountsConfigured && walletEnabled }
}

const swapIntentStore = createSwapIntentStore({ messageMatcher: messageMatchesWithLighthouse }) // Phantom adds a Lighthouse guard instruction
const swapExecution = createSwapExecutionService({
  readiness: async (request) => currentSwapReadiness(request).readiness,
  buildRoute: async (request) => {
    const localExecution = localForkProgramEvidenceReady()
    if (localExecution && !isLocalWallet(request.wallet)) {
      throw new SwapRouteError(
        'Only generated LOCAL_FORK_ACCOUNT_n wallets can execute on the local Surfpool Dapp profile.',
      )
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
    // Independent price bound: Jupiter chooses the pool, so the result must agree with the Kamino oracle prices.
    const reserves = Object.values(getSnapshot()?.reserves ?? {})
    const side = (mint) => {
      const token = Object.values(TOKENS).find((t) => t.mint === mint)
      return { decimals: token.decimals, price: reserves.find((r) => r[token.token_id])?.[token.token_id].price }
    }
    assertOracleFairOutput({
      inputAmountBaseUnits: request.amountBaseUnits,
      minimumOutputBaseUnits: built.minimumOutputBaseUnits,
      input: side(request.inputMint),
      output: side(request.outputMint),
    })
    if (!localExecution) return built
    if (!(await verifyLocalForkRoute(built)))
      throw new SwapRouteError(
        'The local route does not use only the approved DEX and executable programs cloned into Surfpool.',
      )
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
    if (localForkDappEnabled) return readiness && (await localIntentAuthorized(intent))
    return swapIntentStillAuthorized(intent, { executionEnabled: readiness })
  },
  send: ({ tx, wallet, intent }) => sendSigned({ tx, wallet, approvedProgramIds: intent.metadata?.programIds ?? [] }),
})

export const swapRoutes = [
  [
    'GET',
    /^\/api\/swap-readiness$/,
    (req, res) => {
      const wallet = new URL(req.url, 'http://localhost').searchParams.get('wallet')
      if (wallet && !isAddress(wallet)) return send(res, 400, { error: 'Invalid wallet address' })
      const { readiness, availability, visible } = currentSwapReadiness({ wallet: wallet ?? undefined })
      return send(res, 200, {
        ...readiness,
        visible,
        loopVisible: loopOpenTo(wallet),
        loopBeta: LOOP_WALLETS.has(wallet),
        feeBps: FEE_BPS,
        marketAvailability: availability,
        executionMode: executionMode,
      })
    },
  ],
  [
    'POST',
    /^\/api\/swap-quote$/,
    async (req, res) => {
      if (limited(req, 'swap-quote', 20)) return send(res, 429, { error: 'Too many requests' })
      const body = await jsonBody(req)
      let request
      try {
        request = parseSwapQuoteRequest(body)
      } catch (error) {
        if (error instanceof SwapRouteError) return send(res, 400, { error: error.message })
        throw error
      }
      if (blocked(res, request.wallet, { failClosed: true })) return
      if (!swapOpenTo(request.wallet)) return send(res, 403, SWAP_NOT_ENABLED)
      const { availability } = currentSwapReadiness(request)
      if (!availability.available)
        return send(res, 503, { error: availability.reasons.map((reason) => reason.message).join(' ') })
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
            const { status, error: message } = explain(
              error,
              'swap quote',
              'Could not load a swap quote, please try again.',
            )
            return send(res, status, { error: message })
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
    /^\/api\/swap-build$/,
    async (req, res) => {
      if (limited(req, 'swap-build', 8)) return send(res, 429, { error: 'Too many requests' })
      const body = await jsonBody(req)
      let request
      try {
        request = parseSwapQuoteRequest(body)
      } catch (error) {
        if (error instanceof SwapRouteError) return send(res, 400, { error: error.message })
        throw error
      }
      if (blocked(res, request.wallet, { failClosed: true })) return
      const { readiness, availability } = currentSwapReadiness(request)
      if (!availability.available)
        return send(res, 503, { error: availability.reasons.map((reason) => reason.message).join(' ') })
      if (!readiness.executionEnabled)
        return send(res, 503, {
          error: readiness.unavailableReasons.map((reason) => reason.message).join(' '),
          unavailableReasons: readiness.unavailableReasons,
        })
      try {
        return send(res, 200, await swapExecution.build(body))
      } catch (error) {
        if (error instanceof SwapExecutionError) return send(res, 503, { error: error.message })
        if (error instanceof SwapRouteError) return send(res, 503, { error: error.message })
        if (error instanceof SwapError) return send(res, 502, { error: error.message })
        const { status, error: message } = explain(
          error,
          'swap build',
          'Could not build a swap transaction, please try again.',
        )
        return send(res, status, { error: message })
      }
    },
  ],
  [
    'POST',
    /^\/api\/swap-send$/,
    async (req, res) => {
      if (limited(req, 'swap-send', 8)) return send(res, 429, { error: 'Too many requests' })
      const body = await jsonBody(req)
      if (!isAddress(String(body.wallet)) || typeof body.tx !== 'string' || typeof body.intentId !== 'string')
        throw new UserError('Invalid swap relay request.')
      if (blocked(res, body.wallet, { failClosed: true })) return
      try {
        return send(res, 200, await sendAuthorizedSwap({ tx: body.tx, wallet: body.wallet, intentId: body.intentId }))
      } catch (error) {
        if (error instanceof DefiniteSendRefusal) return send(res, 400, { error: error.message, outcome: 'rejected' })
        if (error instanceof SendOutcomeUnknownError)
          return send(res, 502, { error: error.message, signature: error.signature, outcome: 'unknown' })
        if (error instanceof SwapExecutionError) return send(res, 400, { error: error.message })
        if (error instanceof UserError) throw error
        const { error: message } = explain(
          error,
          'swap relay',
          'Could not relay the signed swap, please rebuild it and try again.',
          'The Solana network connection is busy right now, so nothing was sent. Rebuild it and try again.',
        )
        return send(res, 502, { error: message })
      }
    },
  ],
]
