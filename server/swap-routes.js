import { isAddress } from '@solana/kit'
import { LIVE, TOKENS } from '../src/config.js'
import { buildSwap, configuredFeeAccountForMint } from './swap.js'

export const SWAP_QUOTE_MAX_AGE_MS = 15_000
const U64_MAX = (1n << 64n) - 1n

export class SwapRouteError extends Error {}

const positiveBaseUnits = (value) => typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n && BigInt(value) <= U64_MAX
const marketIsActive = (market) => !!market && market.visible !== false && LIVE.some((candidate) => candidate.id === market.id)

export function parseSwapQuoteRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SwapRouteError('Invalid swap quote request.')
  if (typeof body.wallet !== 'string' || !isAddress(body.wallet)) throw new SwapRouteError('Invalid wallet address.')
  const pair = LIVE.some((market) => market.pairs?.some(({ collateral, liability }) => {
    const mints = [TOKENS[collateral]?.mint, TOKENS[liability]?.mint]
    return mints.includes(body.inputMint) && mints.includes(body.outputMint) && body.inputMint !== body.outputMint
  }))
  if (!pair) throw new SwapRouteError('Unsupported swap pair.')
  if (!positiveBaseUnits(body.amountBaseUnits)) throw new SwapRouteError('Swap amount must be a positive integer in token base units.')
  const slippageBps = body.slippageBps ?? 50
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 50) throw new SwapRouteError('Slippage exceeds Nysa’s 50-bps limit.')
  return {
    wallet: body.wallet,
    inputMint: body.inputMint,
    outputMint: body.outputMint,
    amountBaseUnits: body.amountBaseUnits,
    slippageBps,
  }
}

export function swapPairAvailability({ market, vaults = {}, snapshotUpdatedAt = 0, inputMint, outputMint, now = Date.now() } = {}) {
  const reasons = []
  const active = marketIsActive(market)
  if (!active) reasons.push({ code: 'market-inactive', message: 'The Nysa market is not active.' })
  const pair = market?.pairs?.find(({ collateral, liability }) => {
    const mints = [TOKENS[collateral]?.mint, TOKENS[liability]?.mint]
    return mints.includes(inputMint) && mints.includes(outputMint) && inputMint !== outputMint
  })
  if (!pair) reasons.push({ code: 'pair-not-allowlisted', message: 'The selected mint pair is not enabled by an active Nysa market.' })
  if (pair && active) {
    const collateral = TOKENS[pair.collateral]
    const liability = TOKENS[pair.liability]
    const allocated = Object.values(vaults ?? {}).some((vault) => (vault?.allocations ?? []).some((allocation) =>
      allocation.market === market.kaminoMarket
        && allocation.reserve === liability.reserve
        && (allocation.collateral ?? []).includes(collateral.token_id)
        && Number.isFinite(allocation.invested)
        && allocation.invested > 0))
    if (!allocated) reasons.push({ code: 'no-actual-allocation', message: 'No Nysa vault has a nonzero actual allocation to this collateral market.' })
  }
  if (!Number.isFinite(snapshotUpdatedAt) || snapshotUpdatedAt <= 0 || !Number.isFinite(now) || now < snapshotUpdatedAt || now - snapshotUpdatedAt > 60_000) {
    reasons.push({ code: 'market-data-stale', message: 'Fresh market allocation data is unavailable.' })
  }
  return { available: reasons.length === 0, reasons }
}

function publicRoutePlan(routePlan) {
  if (!Array.isArray(routePlan)) return []
  return routePlan.slice(0, 32).map((leg) => ({
    label: typeof leg?.swapInfo?.label === 'string' ? leg.swapInfo.label : 'Unknown route',
    inputMint: typeof leg?.swapInfo?.inputMint === 'string' ? leg.swapInfo.inputMint : null,
    outputMint: typeof leg?.swapInfo?.outputMint === 'string' ? leg.swapInfo.outputMint : null,
    inputAmountBaseUnits: typeof leg?.swapInfo?.inAmount === 'string' ? leg.swapInfo.inAmount : null,
    outputAmountBaseUnits: typeof leg?.swapInfo?.outAmount === 'string' ? leg.swapInfo.outAmount : null,
    percent: Number.isFinite(leg?.percent) ? leg.percent : null,
    bps: Number.isFinite(leg?.bps) ? leg.bps : null,
  }))
}

/** Return quote facts only. Provider instructions, lookup tables and unsigned transactions stay server-side. */
export function publicSwapQuote(built, { now = Date.now } = {}) {
  if (!built || typeof built !== 'object' || !Number.isFinite(built.quoteAt)) throw new SwapRouteError('Swap provider returned an invalid quote.')
  const currentTime = now()
  if (!Number.isFinite(currentTime)) throw new SwapRouteError('Invalid quote clock.')
  const expiresAt = built.quoteAt + SWAP_QUOTE_MAX_AGE_MS
  const quoteFresh = currentTime >= built.quoteAt && currentTime < expiresAt
  const programPolicy = built.programPolicy ?? { approved: false, unreviewed: [{ programId: null, reason: 'Program review is unavailable.' }] }
  const unavailableReasons = [
    ...(!programPolicy.approved ? (programPolicy.unreviewed ?? []).map(({ programId, routeLabel, reason }) => ({
      code: 'program-unreviewed', programId, routeLabel, message: reason,
    })) : []),
    ...(!built.feeAccountMintVerified ? [{ code: 'fee-account-unverified', message: 'Fee-account mint and authority have not been verified.' }] : []),
    ...(!built.feeBalanceDeltaVerified ? [{ code: 'fee-delta-unverified', message: 'Atomic fee balance delta has not been verified by transaction simulation.' }] : []),
    ...(!built.executable ? [{ code: 'execution-not-approved', message: 'This quote is for review only; transaction execution is not approved.' }] : []),
    ...(!quoteFresh ? [{ code: 'quote-expired', message: 'Quote is older than the 15-second transaction freshness limit.' }] : []),
  ]
  return {
    provider: built.provider,
    providerVersion: built.providerVersion,
    quoteAt: built.quoteAt,
    expiresAt,
    quoteFresh,
    inputMint: built.inputMint,
    outputMint: built.outputMint,
    inputAmountBaseUnits: built.inputAmountBaseUnits,
    outputAmountBaseUnits: built.outputAmountBaseUnits,
    minimumOutputBaseUnits: built.minimumOutputBaseUnits,
    slippageBps: built.slippageBps,
    priceImpactPct: built.priceImpactPct,
    fee: built.fee ? { ...built.fee } : null,
    feeAccountMintVerified: built.feeAccountMintVerified === true,
    feeBalanceDeltaVerified: built.feeBalanceDeltaVerified === true,
    feeVerificationReason: built.feeVerificationReason ?? null,
    routePlan: publicRoutePlan(built.routePlan),
    routeProgramIds: Array.isArray(built.routeProgramIds) ? [...built.routeProgramIds] : [],
    programPolicy,
    executable: built.executable === true && quoteFresh,
    executionUnavailableReasons: unavailableReasons,
  }
}

export async function createPublicSwapQuote(body, {
  buildSwapFn = buildSwap,
  feeAccountResolver = configuredFeeAccountForMint,
  now = Date.now,
  signal,
} = {}) {
  const request = parseSwapQuoteRequest(body)
  const feeAccount = feeAccountResolver(request.outputMint)
  if (!feeAccount?.account || feeAccount.mint !== request.outputMint) {
    throw new SwapRouteError('No verified fee account is configured for the output token.')
  }
  const built = await buildSwapFn({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountBaseUnits: request.amountBaseUnits,
    wallet: request.wallet,
    feeAccount: feeAccount.account,
    feeAccountMint: request.outputMint,
    slippageBps: request.slippageBps,
    feeBalanceDeltaVerified: false,
    now,
    signal,
  })
  return publicSwapQuote(built, { now })
}

export function swapReadiness({
  providerConfigured = false,
  feeAccountsConfigured = false,
  walletEnabled = true,
  marketDataAvailable = false,
  marketAvailabilityReasons = [],
} = {}) {
  const unavailableReasons = [
    ...(!providerConfigured ? [{ code: 'provider-unconfigured', message: 'Production swap-provider configuration is missing.' }] : []),
    ...(!feeAccountsConfigured ? [{ code: 'fee-accounts-unconfigured', message: 'Verified USDY and USDC fee accounts are required.' }] : []),
    ...(!walletEnabled ? [{ code: 'swap-wallet-not-enabled', message: 'Swap is not available for this wallet yet.' }] : []),
    ...(!marketDataAvailable ? [{ code: 'market-allocation-missing', message: 'No fresh nonzero allocation is available for the supported collateral market.' }] : []),
    ...(marketAvailabilityReasons ?? []),
  ]
  return {
    quoteEnabled: marketDataAvailable,
    executionEnabled: unavailableReasons.length === 0,
    supportedMints: ['svm-usdc', 'svm-usdy'].map((id) => ({ id, mint: TOKENS[id].mint, name: TOKENS[id].name, decimals: TOKENS[id].decimals })),
    unavailableReasons,
  }
}
