import { AccountRole, address, fetchEncodedAccount, getAddressDecoder, getBase58Decoder } from '@solana/kit'
import { LIVE, TOKENS } from '../src/config.js'
import { calculateSwapFeeBaseUnits } from '../src/swap-fees.js'
import { APPROVED_PROGRAMS, evaluateProgramPolicy, ROUTE_PROGRAM_IDS_BY_LABEL } from './program-policy.js'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
import { rpc } from './rpc.js'

const FEE_BPS = 10
const MAX_SLIPPAGE_BPS = 50
const MAX_ROUTE_LEGS = 32
const KEYLESS_PROVIDER_INTERVAL_MS = 2_100
const KEYLESS_PROVIDER_MAX_PENDING = 4
const KEYLESS_PROVIDER_MAX_WAIT_MS = 10_000
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS])
const addressDecoder = getAddressDecoder()

/** Enforce Jupiter's documented 0.5-RPS keyless limit across requests from this backend process. */
export function createKeylessRateLimiter({
  intervalMs = KEYLESS_PROVIDER_INTERVAL_MS,
  maxPending = KEYLESS_PROVIDER_MAX_PENDING,
  maxWaitMs = KEYLESS_PROVIDER_MAX_WAIT_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || !Number.isSafeInteger(maxPending) || maxPending <= 0
    || !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || typeof now !== 'function' || typeof sleep !== 'function') {
    throw new TypeError('Invalid keyless provider rate limiter settings.')
  }
  let nextAllowedAt = 0
  let pending = 0
  return async function waitForKeylessProvider(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    const current = now()
    if (!Number.isFinite(current)) throw new TypeError('Invalid keyless provider clock.')
    const scheduledAt = Math.max(current, nextAllowedAt)
    const waitMs = scheduledAt - current
    if (pending >= maxPending || waitMs > maxWaitMs) {
      const error = new SwapError('Swap provider is busy; try again shortly.')
      error.code = 'KEYLESS_PROVIDER_BUSY'
      throw error
    }
    nextAllowedAt = scheduledAt + intervalMs
    if (waitMs === 0) return
    pending++
    let onAbort
    try {
      if (!signal) await sleep(waitMs)
      else {
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
        })
        await Promise.race([sleep(waitMs, signal), aborted])
      }
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
      pending--
    }
  }
}
const waitForKeylessProvider = createKeylessRateLimiter()

export class SwapError extends Error {}

/** Decode the SPL token-account mint and authority from on-chain account data. */
export function inspectFeeTokenAccount(account) {
  if (!account?.exists || !account.data || account.data.length < 165 || !TOKEN_PROGRAMS.has(String(account.programAddress))) return null
  try {
    const mint = addressDecoder.decode(account.data.slice(0, 32))
    const authority = addressDecoder.decode(account.data.slice(32, 64))
    const initialized = account.data[108] === 1
    if (!initialized) return null
    return { mint, authority, tokenProgram: String(account.programAddress), initialized }
  } catch {
    return null
  }
}

async function readFeeTokenAccount(feeAccount) {
  if (!rpc) return null
  try {
    return inspectFeeTokenAccount(await fetchEncodedAccount(rpc, address(feeAccount), { commitment: 'confirmed' }))
  } catch {
    return null
  }
}

export function configuredFeeAccountForMint(mint) {
  const token = Object.values(TOKENS).find((candidate) => candidate.mint === mint)
  if (!token) return null
  const envName = token.token_id === 'svm-usdc' ? 'SWAP_FEE_ACCOUNT_USDC' : token.token_id === 'svm-usdy' ? 'SWAP_FEE_ACCOUNT_USDY' : null
  const account = envName ? process.env[envName] : null
  return account ? { account, mint } : null
}

const safeAddress = (value, label) => {
  if (typeof value !== 'string' || !value) throw new SwapError(`Invalid ${label}.`)
  try { return address(value) } catch { throw new SwapError(`Invalid ${label}.`) }
}

function positiveIntegerString(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n) throw new SwapError(`Invalid ${label}.`)
  return value
}

function sumRouteAmount(routePlan, field, mint) {
  const amount = routePlan.reduce((total, leg) => {
    if (leg?.swapInfo?.[field === 'inAmount' ? 'inputMint' : 'outputMint'] !== mint) return total
    const value = leg.swapInfo[field]
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new SwapError('Swap provider returned an invalid route amount.')
    return total + BigInt(value)
  }, 0n)
  if (amount <= 0n) throw new SwapError('Swap provider returned an incomplete route.')
  return amount
}

function instructionFromApi(ix) {
  if (!ix || typeof ix !== 'object' || !Array.isArray(ix.accounts) || typeof ix.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ix.data)) {
    throw new SwapError('Swap provider returned an invalid instruction.')
  }
  const programAddress = safeAddress(ix.programId, 'provider program address')
  const accounts = ix.accounts.map((account) => {
    if (typeof account?.isSigner !== 'boolean' || typeof account?.isWritable !== 'boolean') throw new SwapError('Swap provider returned invalid instruction accounts.')
    const role = account.isSigner
      ? account.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
      : account.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY
    return { address: safeAddress(account.pubkey, 'instruction account'), role }
  })
  return { programAddress, accounts, data: Uint8Array.from(Buffer.from(ix.data, 'base64')) }
}

function providerInstructions(body) {
  const groups = ['computeBudgetInstructions', 'setupInstructions', 'otherInstructions', 'addressesByLookupTableAddress']
  for (const key of groups.slice(0, 3)) if (!Array.isArray(body[key] ?? [])) throw new SwapError('Swap provider returned an invalid instruction list.')
  if (!body.swapInstruction || (body.cleanupInstruction != null && typeof body.cleanupInstruction !== 'object') || (body.tipInstruction != null && typeof body.tipInstruction !== 'object')) {
    throw new SwapError('Swap provider returned an incomplete route.')
  }
  const computeBudgetInstructions = (body.computeBudgetInstructions ?? []).map(instructionFromApi)
  const setupInstructions = (body.setupInstructions ?? []).map(instructionFromApi)
  const swapInstruction = instructionFromApi(body.swapInstruction)
  const cleanupInstruction = body.cleanupInstruction == null ? null : instructionFromApi(body.cleanupInstruction)
  const otherInstructions = (body.otherInstructions ?? []).map(instructionFromApi)
  const tipInstruction = body.tipInstruction == null ? null : instructionFromApi(body.tipInstruction)
  const raw = [...computeBudgetInstructions, ...setupInstructions, swapInstruction,
    ...(cleanupInstruction ? [cleanupInstruction] : []), ...otherInstructions, ...(tipInstruction ? [tipInstruction] : [])]
  if (raw.length > 80) throw new SwapError('Swap provider returned too many instructions.')
  const instructions = raw
  const tables = body.addressesByLookupTableAddress ?? {}
  if (typeof tables !== 'object' || Array.isArray(tables)) throw new SwapError('Swap provider returned invalid address lookup tables.')
  const addressesByLookupTableAddress = Object.fromEntries(Object.entries(tables).map(([table, keys]) => {
    if (!Array.isArray(keys)) throw new SwapError('Swap provider returned invalid address lookup tables.')
    return [safeAddress(table, 'lookup table address'), keys.map((key) => safeAddress(key, 'lookup address'))]
  }))
  return { instructions, computeBudgetInstructions, setupInstructions, swapInstruction,
    cleanupInstruction, otherInstructions, tipInstruction, addressesByLookupTableAddress }
}

function routePrograms(routePlan, mapping) {
  if (!Array.isArray(routePlan) || routePlan.length === 0 || routePlan.length > MAX_ROUTE_LEGS) throw new SwapError('Swap provider returned an invalid route.')
  const labels = new Set()
  const ids = new Set()
  const byLabel = {}
  for (const leg of routePlan) {
    const info = leg?.swapInfo
    if (typeof info?.label !== 'string' || !info.label.trim()) throw new SwapError('Swap provider returned an unidentified DEX route.')
    labels.add(info.label)
    byLabel[info.label] ??= new Set()
    if (info.programId != null) {
      const id = safeAddress(info.programId, 'DEX program address')
      ids.add(id)
      byLabel[info.label].add(id)
    }
    const mapped = mapping?.[info.label]
    if (mapped != null) {
      if (!Array.isArray(mapped)) throw new SwapError('Invalid DEX program mapping.')
      for (const programId of mapped) {
        const id = safeAddress(programId, 'DEX program address')
        ids.add(id)
        byLabel[info.label].add(id)
      }
    }
  }
  return { labels: [...labels], ids: [...ids], byLabel: Object.fromEntries(Object.entries(byLabel).map(([label, values]) => [label, [...values]])) }
}

function verifiedBlockhash(body) {
  const value = body.blockhashWithMetadata
  if (value == null) return null
  if (!Array.isArray(value.blockhash) || value.blockhash.length !== 32 || value.blockhash.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    || !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight <= 0) throw new SwapError('Swap provider returned invalid blockhash metadata.')
  return { blockhash: getBase58Decoder().decode(Uint8Array.from(value.blockhash)), lastValidBlockHeight: value.lastValidBlockHeight }
}

function validateFee(body, { inputMint, outputMint, inputAmount, feeAccountMint, routePlan }) {
  const basisAmount = feeAccountMint === inputMint
    ? BigInt(inputAmount)
    : sumRouteAmount(routePlan, 'outAmount', outputMint)
  const expectedAmount = calculateSwapFeeBaseUnits(basisAmount, FEE_BPS)
  if (expectedAmount <= 0n) throw new SwapError('Swap amount is too small to collect the 10-bps fee in base units.')

  const routeInput = sumRouteAmount(routePlan, 'inAmount', inputMint)
  const routeOutput = sumRouteAmount(routePlan, 'outAmount', outputMint)
  const input = BigInt(inputAmount)
  const reportedOutput = positiveIntegerString(body.outAmount, 'provider output amount')
  const routeDelta = feeAccountMint === inputMint ? input - routeInput : routeOutput - BigInt(reportedOutput)
  if (routeDelta !== expectedAmount) throw new SwapError('Swap provider route amounts do not match the expected 10-bps fee.')
  if (feeAccountMint === inputMint && routeOutput !== BigInt(reportedOutput)) throw new SwapError('Swap provider net output does not match the route output.')
  const fee = body.platformFee
  const providerMetadata = fee != null
  if (providerMetadata) {
    if (typeof fee !== 'object' || fee.feeBps !== FEE_BPS || fee.feeMint !== feeAccountMint
      || positiveIntegerString(fee.amount, 'provider fee amount') !== String(expectedAmount)) {
      throw new SwapError('Swap provider fee does not match Nysa’s 10-bps policy or configured fee-account mint.')
    }
  }
  return {
    fee: {
      bps: FEE_BPS,
      mint: feeAccountMint,
      basisMint: feeAccountMint,
      basisAmountBaseUnits: String(basisAmount),
      amountBaseUnits: String(expectedAmount),
      providerReported: providerMetadata,
      routeDeltaVerified: true,
    },
    providerReported: providerMetadata,
  }
}

/**
 * Request an exact-input Jupiter V2 Build quote. V2's `platformFeeBps` and fee account are provider-native
 * parameters, so this adapter never inserts a separate Nysa SPL transfer. The returned object is execution-ready
 * only after fee-account ownership, simulated fee balance deltas and the approved router/DEX program list all pass.
 */
export async function buildSwap({
  inputMint,
  outputMint,
  inputAmountBaseUnits,
  wallet,
  feeAccount,
  feeAccountMint,
  slippageBps = MAX_SLIPPAGE_BPS,
  providerApiKey = process.env.JUPITER_API_KEY,
  keylessRateLimiter = waitForKeylessProvider,
  signal,
  apiBaseUrl = 'https://api.jup.ag',
  fetcher = fetch,
  approvedPrograms = APPROVED_PROGRAMS,
  routeProgramIdsByLabel = ROUTE_PROGRAM_IDS_BY_LABEL,
  feeAccountAuthority = process.env.SWAP_FEE_TREASURY_AUTHORITY,
  feeAccountVerifier = readFeeTokenAccount,
  feeBalanceDeltaVerified = false,
  now = Date.now,
} = {}) {
  safeAddress(inputMint, 'input mint')
  safeAddress(outputMint, 'output mint')
  safeAddress(wallet, 'wallet address')
  safeAddress(feeAccount, 'fee account')
  if (inputMint === outputMint) throw new SwapError('Swap input and output mints must be different.')
  const supportedPair = LIVE.some((market) => market.pairs?.some((pair) =>
    new Set([TOKENS[pair.collateral]?.mint, TOKENS[pair.liability]?.mint]).has(inputMint)
      && new Set([TOKENS[pair.collateral]?.mint, TOKENS[pair.liability]?.mint]).has(outputMint)))
  if (!supportedPair) throw new SwapError('Unsupported swap mint pair.')
  if (feeAccountMint !== inputMint && feeAccountMint !== outputMint) throw new SwapError('Fee account mint must match the input or output mint.')
  const inputAmount = positiveIntegerString(inputAmountBaseUnits, 'input amount')
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw new SwapError('Slippage exceeds Nysa’s 50-bps limit.')
  if (typeof fetcher !== 'function') throw new SwapError('Swap provider is not configured.')

  const endpoint = new URL('/swap/v2/build', apiBaseUrl)
  endpoint.search = new URLSearchParams({
    inputMint, outputMint, amount: inputAmount, taker: wallet,
    platformFeeBps: String(FEE_BPS), feeAccount, slippageBps: String(slippageBps), transactionVersion: '0',
  }).toString()
  const headers = providerApiKey ? { 'x-api-key': providerApiKey } : {}
  const timeoutSignal = AbortSignal.timeout(10_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  let response
  try {
    if (!providerApiKey) await keylessRateLimiter(requestSignal)
    response = await fetcher(endpoint, { headers, signal: requestSignal })
  } catch (error) {
    if (error?.code === 'KEYLESS_PROVIDER_BUSY') throw new SwapError('Swap provider is busy; try again shortly.')
    if (requestSignal.aborted) throw new SwapError('Swap provider request was cancelled or timed out.')
    throw new SwapError('Swap provider is temporarily unavailable.')
  }
  if (!response?.ok) throw new SwapError('Swap provider is temporarily unavailable.')
  let body
  try { body = await response.json() } catch { throw new SwapError('Swap provider returned an invalid response.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SwapError('Swap provider returned an invalid response.')
  if (body.inputMint !== inputMint || body.outputMint !== outputMint || body.inAmount !== inputAmount) throw new SwapError('Swap provider returned a mismatched mint or input amount.')
  if (body.swapMode && body.swapMode !== 'ExactIn') throw new SwapError('Swap provider returned an unsupported swap mode.')
  if (body.slippageBps != null && body.slippageBps !== slippageBps) throw new SwapError('Swap provider returned mismatched slippage settings.')

  const outAmount = positiveIntegerString(body.outAmount, 'provider output amount')
  const providerMinimumOutput = BigInt(positiveIntegerString(body.otherAmountThreshold, 'minimum output amount'))
  const slippageOutputNumerator = BigInt(outAmount) * BigInt(10_000 - slippageBps)
  const minimumOutput = slippageOutputNumerator / 10_000n
  const roundedMinimumOutput = (slippageOutputNumerator + 9_999n) / 10_000n
  if (providerMinimumOutput > BigInt(outAmount)
    || providerMinimumOutput !== minimumOutput && providerMinimumOutput !== roundedMinimumOutput) {
    throw new SwapError('Swap provider returned a minimum output inconsistent with encoded Jupiter slippage.')
  }
  const routePlan = body.routePlan
  const fee = validateFee(body, { inputMint, outputMint, inputAmount, feeAccountMint, routePlan })
  const route = routePrograms(routePlan, routeProgramIdsByLabel)
  let feeAccountInfo = null
  if (typeof feeAccountVerifier === 'function') {
    try { feeAccountInfo = await feeAccountVerifier(feeAccount) } catch { feeAccountInfo = null }
  }
  if (feeAccountInfo && (!TOKEN_PROGRAMS.has(String(feeAccountInfo.tokenProgram)) || feeAccountInfo.initialized !== true
    || feeAccountInfo.mint !== feeAccountMint || (feeAccountAuthority && feeAccountInfo.authority !== feeAccountAuthority))) {
    throw new SwapError('Configured fee account does not match its token mint or treasury authority.')
  }
  const feeAccountMintVerified = !!feeAccountInfo && feeAccountInfo.mint === feeAccountMint
    && !!feeAccountAuthority && feeAccountInfo.authority === feeAccountAuthority
    && feeAccountInfo.initialized === true && TOKEN_PROGRAMS.has(String(feeAccountInfo.tokenProgram))
  const provider = providerInstructions(body)
  const { instructions, addressesByLookupTableAddress } = provider
  const programIds = [...new Set([...instructions.map((ix) => String(ix.programAddress)), ...route.ids])]
  const programPolicy = evaluateProgramPolicy(programIds, route.labels, route.byLabel, approvedPrograms)
  const impact = Number(body.priceImpactPct)
  if (!Number.isFinite(impact) || impact < 0 || impact > 1) throw new SwapError('Swap provider returned an invalid price impact.')
  const builtAt = now()
  if (!Number.isFinite(builtAt)) throw new SwapError('Invalid quote timestamp.')
  const blockhashWithMetadata = verifiedBlockhash(body)
  const feeVerified = fee.fee.routeDeltaVerified && feeAccountMintVerified && feeBalanceDeltaVerified
  const executable = feeVerified && programPolicy.approved
  return {
    provider: 'jupiter-v2-build',
    providerVersion: 'swap-v2-build',
    quoteAt: builtAt,
    inputMint,
    outputMint,
    inputAmountBaseUnits: inputAmount,
    outputAmountBaseUnits: outAmount,
    minimumOutputBaseUnits: String(minimumOutput),
    slippageBps,
    priceImpactPct: impact * 100,
    fee: fee.fee,
    feeAccount,
    feeAccountMint,
    feeVerified,
    feeAccountMintVerified,
    feeBalanceDeltaVerified,
    feeVerificationReason: !feeAccountMintVerified
        ? 'Configured fee-account mint has not been verified from the token account.'
        : !feeBalanceDeltaVerified
          ? 'Atomic fee-account balance delta has not been verified by transaction simulation.'
          : fee.providerReported ? null : 'Jupiter V2 Build omits normalized fee metadata; the amount is derived from its route input/output delta and checked against the simulated fee-account balance.',
    routePlan,
    routeProgramIds: route.ids,
    routeLabels: route.labels,
    routeProgramIdsByLabel: route.byLabel,
    programIds,
    programPolicy,
    swapInstructionProgramId: String(provider.swapInstruction.programAddress),
    computeBudgetInstructions: provider.computeBudgetInstructions,
    setupInstructions: provider.setupInstructions,
    swapInstruction: provider.swapInstruction,
    cleanupInstruction: provider.cleanupInstruction,
    otherInstructions: provider.otherInstructions,
    tipInstruction: provider.tipInstruction,
    executable,
    instructions,
    addressesByLookupTableAddress,
    blockhashWithMetadata,
  }
}
