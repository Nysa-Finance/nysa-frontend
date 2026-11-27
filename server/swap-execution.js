import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  compileTransaction,
  createTransactionMessage,
  fetchEncodedAccounts,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  TRANSACTION_SIZE_LIMIT,
} from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS, getTokenDecoder } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
import { fetchAddressLookupTable } from '@solana-program/address-lookup-table'
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ComputeBudgetInstruction,
  getSetComputeUnitLimitInstructionDataDecoder,
  getSetComputeUnitPriceInstructionDataDecoder,
} from '@solana-program/compute-budget'
import { TOKENS } from '../src/config.js'
import { TOKEN_PROGRAMS, ataOf } from './account.js'
import { rpc } from './rpc.js'
import { chainError } from './errors.js'
import { parseSwapQuoteRequest, publicSwapQuote, SWAP_QUOTE_MAX_AGE_MS } from './swap-routes.js'
import { evaluateProgramPolicy, ROUTE_PROGRAM_IDS_BY_LABEL } from './program-policy.js'
import { TransactionIntentError } from './tx-intent.js'
import { FEE_BPS } from './swap.js'

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111'
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
// Token-2022 only for the mints config.js marks `token2022` (sUSDai, whose transfer hook is unset). A hook would add
// accounts to WhirlpoolSwapV2, which its fixed account count refuses.
const tokenProgramOf = (mint) =>
  Object.values(TOKENS).some((t) => t.mint === String(mint) && t.token2022)
    ? TOKEN_2022_PROGRAM_ADDRESS
    : TOKEN_PROGRAM_ADDRESS
const { SetComputeUnitLimit: SET_CU_LIMIT, SetComputeUnitPrice: SET_CU_PRICE } = ComputeBudgetInstruction
const computeUnitLimit = (data) => getSetComputeUnitLimitInstructionDataDecoder().decode(data).units
const computeUnitPrice = (data) => getSetComputeUnitPriceInstructionDataDecoder().decode(data).microLamports
const JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const JUPITER_V6_EVENT_AUTHORITY = 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf'
const JUPITER_ROUTE_V2_DISCRIMINATOR = Buffer.from('bb64facc31c4af14', 'hex')
const WHIRLPOOL_PROGRAM = ROUTE_PROGRAM_IDS_BY_LABEL.Whirlpool[0]
const SIGNER_ROLES = new Set([AccountRole.READONLY_SIGNER, AccountRole.WRITABLE_SIGNER])
const ROUTE_INSTRUCTION_MAX = 1
const MAX_COMPUTE_UNITS = 1_400_000
// What a provider route may cost the user beyond the swap itself. Raise them only after seeing real routes.
const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n // 0.001 SOL; the captured live route pays about 650 lamports
const MAX_ORACLE_LOSS_BPS = 300 // the minimum output may be worth at most 3% less than the input at oracle prices

export class SwapExecutionError extends Error {}

export function swapIntentStillAuthorized(intent, { executionEnabled, approvedPrograms } = {}) {
  if (executionEnabled !== true) return false
  const metadata = intent?.metadata ?? {}
  return evaluateProgramPolicy(
    metadata.programIds,
    metadata.routeLabels,
    metadata.routeProgramIdsByLabel,
    approvedPrograms,
  ).approved
}

function positiveRaw(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n)
    throw new SwapExecutionError(`Invalid ${label}.`)
  return BigInt(value)
}

// The fee amount a route must carry: positive with a Nysa fee, exactly 0 without one.
function feeRaw(value, label) {
  if (FEE_BPS) return positiveRaw(value, label)
  if (String(value) !== '0') throw new SwapExecutionError(`Unexpected ${label}: Nysa takes no fee.`)
  return 0n
}

export function assertSwapQuoteFresh(quoteAt, currentTime) {
  if (
    !Number.isFinite(currentTime) ||
    !Number.isFinite(quoteAt) ||
    currentTime < quoteAt ||
    currentTime - quoteAt >= SWAP_QUOTE_MAX_AGE_MS
  ) {
    throw new SwapExecutionError('Swap route expired before transaction building completed.')
  }
  return currentTime
}

export function assertSwapSimulationEffects(request, simulation) {
  const inputAmount = positiveRaw(request.inputAmountBaseUnits, 'input amount')
  const minimumOutput = positiveRaw(request.minimumOutputBaseUnits, 'minimum output')
  const feeAmount = feeRaw(request.feeAmountBaseUnits, 'fee amount')
  if (simulation?.inputDeltaBaseUnits !== String(inputAmount))
    throw new SwapExecutionError('Simulated input balance delta does not match the authorized amount.')
  if (
    !/^\d+$/.test(simulation?.outputDeltaBaseUnits ?? '') ||
    BigInt(simulation.outputDeltaBaseUnits) < minimumOutput
  ) {
    throw new SwapExecutionError('Simulated output balance delta is below the authorized minimum output.')
  }
  if (simulation?.feeDeltaBaseUnits !== String(feeAmount))
    throw new SwapExecutionError('Simulated fee balance delta does not match Nysa’s fee.')
  if (
    !Array.isArray(simulation?.additionalTokenDeltas) ||
    simulation.additionalTokenDeltas.some((item) => item?.deltaBaseUnits !== '0')
  ) {
    throw new SwapExecutionError('Simulated swap changed an unrelated wallet token account.')
  }
  return {
    inputDeltaBaseUnits: String(inputAmount),
    outputDeltaBaseUnits: simulation.outputDeltaBaseUnits,
    feeDeltaBaseUnits: String(feeAmount),
  }
}

function instructionEquals(left, right) {
  return (
    String(left?.programAddress) === String(right?.programAddress) &&
    left?.data instanceof Uint8Array &&
    right?.data instanceof Uint8Array &&
    Buffer.compare(Buffer.from(left.data), Buffer.from(right.data)) === 0 &&
    Array.isArray(left.accounts) &&
    Array.isArray(right.accounts) &&
    left.accounts.length === right.accounts.length &&
    left.accounts.every(
      (account, index) =>
        String(account.address) === String(right.accounts[index]?.address) &&
        account.role === right.accounts[index]?.role,
    )
  )
}

function validateComputeBudgetInstruction(instruction, seen) {
  if (instruction.accounts.length !== 0 || instruction.data.length === 0)
    throw new SwapExecutionError('Swap route contains malformed compute-budget instructions.')
  const [opcode] = instruction.data
  if (opcode === SET_CU_LIMIT && instruction.data.length === 5 && !seen.limit) {
    const units = computeUnitLimit(instruction.data)
    if (units <= 0 || units > MAX_COMPUTE_UNITS)
      throw new SwapExecutionError('Swap route compute-unit limit is outside Solana bounds.')
    seen.limit = true
  } else if (opcode === SET_CU_PRICE && instruction.data.length === 9 && !seen.price) {
    seen.price = true
  } else {
    throw new SwapExecutionError('Swap route contains an unsupported or duplicate compute-budget instruction.')
  }
}

const roleIs = (meta, role) => meta?.role === role

const DATA_VIEW_READERS = { 1: 'getUint8', 2: 'getUint16', 4: 'getUint32', 8: 'getBigUint64' }

// Reads the next little-endian integer of `size` bytes from the Jupiter route data and moves the cursor past it.
function readRoute(data, cursor, size, label) {
  if (cursor.offset + size > data.length)
    throw new SwapExecutionError(`Jupiter V6 route data is truncated at ${label}.`)
  const value = new DataView(data.buffer, data.byteOffset + cursor.offset, size)[DATA_VIEW_READERS[size]](0, true)
  cursor.offset += size
  return value
}

function routeStepMints(routePlan, request) {
  const mints = [request.inputMint, request.outputMint]
  const indexOf = (mint) => {
    let index = mints.indexOf(mint)
    if (index === -1) {
      index = mints.length
      mints.push(mint)
    }
    return index
  }
  return routePlan.map((leg) => ({
    inputIndex: indexOf(leg.swapInfo.inputMint),
    outputIndex: indexOf(leg.swapInfo.outputMint),
  }))
}

function readV2RoutePlan(data, cursor, built, request) {
  const count = readRoute(data, cursor, 4, 'V2 route-plan length')
  if (count < 1 || count > 32 || count !== built.routePlan.length) {
    throw new SwapExecutionError('Jupiter V6 route-plan length does not match the provider route.')
  }
  const indices = routeStepMints(built.routePlan, request)
  let totalBps = 0
  const routeSteps = []
  for (let index = 0; index < count; index++) {
    const variant = readRoute(data, cursor, 1, 'V2 DEX variant')
    // Only WhirlpoolSwapV2 (47, with its direction and no remaining-account metadata) and Raydium CLMM (26, no args).
    const label = built.routePlan[index]?.swapInfo?.label
    if (!(variant === 47 && label === 'Whirlpool') && !(variant === 26 && label === 'Raydium CLMM')) {
      throw new SwapExecutionError('Jupiter V6 route_v2 contains an unsupported DEX variant.')
    }
    let direction = null
    if (variant === 47) {
      direction = readRoute(data, cursor, 1, 'WhirlpoolSwapV2 direction')
      const hasRemainingAccountsInfo = readRoute(data, cursor, 1, 'WhirlpoolSwapV2 remaining-account option')
      if (direction > 1 || hasRemainingAccountsInfo !== 0) {
        throw new SwapExecutionError('Jupiter V6 route_v2 contains unsupported WhirlpoolSwapV2 account metadata.')
      }
    }
    const bps = readRoute(data, cursor, 2, 'V2 route allocation')
    const inputIndex = readRoute(data, cursor, 1, 'V2 route input index')
    const outputIndex = readRoute(data, cursor, 1, 'V2 route output index')
    const leg = built.routePlan[index]
    if (
      bps < 1 ||
      bps > 10_000 ||
      bps !== leg.bps ||
      inputIndex !== indices[index].inputIndex ||
      outputIndex !== indices[index].outputIndex
    ) {
      throw new SwapExecutionError('Jupiter V6 route_v2 step does not match provider route mints and allocation.')
    }
    routeSteps.push({ variant, aToB: direction === 1, bps, inputIndex, outputIndex })
    totalBps += bps
  }
  if (totalBps !== 10_000)
    throw new SwapExecutionError('Jupiter V6 route_v2 allocations do not total 10000 basis points.')
  return routeSteps
}

// The only layout Jupiter's V2 Build returns for this pair.
export function decodeJupiterV6RouteInstruction(instruction, request, built) {
  if (String(instruction?.programAddress) !== JUPITER_V6_PROGRAM || !(instruction?.data instanceof Uint8Array)) {
    throw new SwapExecutionError('Swap provider returned an unsupported Jupiter router program or data format.')
  }
  const data = instruction.data
  if (Buffer.compare(Buffer.from(data.subarray(0, 8)), JUPITER_ROUTE_V2_DISCRIMINATOR) !== 0) {
    throw new SwapExecutionError(
      'Jupiter V6 instruction discriminator is unsupported; only exact-input route_v2 is admitted.',
    )
  }
  const cursor = { offset: 8 }
  const inputAmount = readRoute(data, cursor, 8, 'input amount')
  const quotedOutput = readRoute(data, cursor, 8, 'quoted output amount')
  const slippageBps = readRoute(data, cursor, 2, 'slippage bps')
  const platformFeeBps = readRoute(data, cursor, 2, 'platform fee bps')
  if (readRoute(data, cursor, 2, 'positive slippage bps') !== 0)
    throw new SwapExecutionError('Jupiter V6 positive slippage is not authorized.')
  const routeSteps = readV2RoutePlan(data, cursor, built, request)
  if (cursor.offset !== data.length)
    throw new SwapExecutionError('Jupiter V6 route data has unsupported or trailing fields.')
  const requestedAmount = positiveRaw(request.amountBaseUnits, 'requested input amount')
  const builtOutput = positiveRaw(built.outputAmountBaseUnits, 'quoted output amount')
  const builtMinimumOutput = positiveRaw(built.minimumOutputBaseUnits, 'minimum output amount')
  const requestedSlippage = request.slippageBps
  if (
    inputAmount !== requestedAmount ||
    inputAmount !== positiveRaw(built.inputAmountBaseUnits, 'built input amount')
  ) {
    throw new SwapExecutionError('Jupiter V6 encoded input amount does not match the authorized request.')
  }
  if (
    quotedOutput !== builtOutput ||
    !Number.isSafeInteger(requestedSlippage) ||
    requestedSlippage < 0 ||
    requestedSlippage > 50 ||
    slippageBps !== requestedSlippage ||
    built.slippageBps !== requestedSlippage
  ) {
    throw new SwapExecutionError('Jupiter V6 encoded quote or slippage does not match the authorized output bound.')
  }
  const expectedMinimumOutput = (quotedOutput * BigInt(10_000 - slippageBps)) / 10_000n
  if (builtMinimumOutput !== expectedMinimumOutput) {
    throw new SwapExecutionError('Jupiter V6 encoded slippage does not enforce the authorized minimum output.')
  }
  if (platformFeeBps !== FEE_BPS || built.fee?.bps !== FEE_BPS) {
    throw new SwapExecutionError('Jupiter V6 encoded platform fee does not match Nysa’s fee policy.')
  }
  return {
    inputAmount: String(inputAmount),
    quotedOutput: String(quotedOutput),
    slippageBps,
    platformFeeBps,
    routeSteps,
  }
}

const JUPITER_V6_DESTINATION_TOKEN_ACCOUNT_PLACEHOLDER = JUPITER_V6_PROGRAM
const SPL_MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
// The captured Jupiter route has ten common metas (its optional destination slot included), the platform fee account
// when Nysa takes a fee, then the Orca program and WhirlpoolSwapV2's 15 accounts.
const ORCA_ROUTE_V2_ACCOUNT_COUNT = 26

function routeMeta(instruction, index, expectedAddress, expectedRole, label) {
  const meta = instruction.accounts[index]
  if (String(meta?.address) !== String(expectedAddress) || meta?.role !== expectedRole) {
    throw new SwapExecutionError(`Jupiter V6 WhirlpoolSwapV2 ${label} address or account role is invalid.`)
  }
}

// Every account that decides where the user's tokens and the fee go is pinned here. The pool's vaults, tick arrays
// and oracle are Orca's own on-chain constraints, and the amounts are proven by the simulation.
async function validateJupiterV2WhirlpoolRoute(instruction, request, built, deriveAta = ataOf) {
  const decoded = decodeJupiterV6RouteInstruction(instruction, request, built)
  if (
    decoded.routeSteps.length !== 1 ||
    built.routePlan.length !== 1 ||
    built.routePlan[0]?.swapInfo?.label !== 'Whirlpool' ||
    built.routePlan[0]?.swapInfo?.inputMint !== request.inputMint ||
    built.routePlan[0]?.swapInfo?.outputMint !== request.outputMint ||
    built.routePlan[0]?.bps !== 10_000
  ) {
    throw new SwapExecutionError('Jupiter V6 WhirlpoolSwapV2 requires one direct exact-input route_v2 step.')
  }
  const f = FEE_BPS ? 1 : 0 // the fee account slot shifts every later account by one
  if (instruction.accounts.length !== ORCA_ROUTE_V2_ACCOUNT_COUNT + f) {
    throw new SwapExecutionError(
      `Jupiter V6 WhirlpoolSwapV2 route_v2 must contain exactly ${ORCA_ROUTE_V2_ACCOUNT_COUNT + f} accounts with no trailing metadata.`,
    )
  }
  const ata = async (mint) => deriveAta(address(request.wallet), address(mint), tokenProgramOf(mint))
  routeMeta(instruction, 0, request.wallet, AccountRole.READONLY_SIGNER, 'user authority')
  routeMeta(instruction, 1, await ata(request.inputMint), AccountRole.WRITABLE, 'user source token account')
  routeMeta(instruction, 2, await ata(request.outputMint), AccountRole.WRITABLE, 'user destination token account')
  routeMeta(instruction, 3, request.inputMint, AccountRole.READONLY, 'source mint')
  routeMeta(instruction, 4, request.outputMint, AccountRole.READONLY, 'destination mint')
  routeMeta(instruction, 5, tokenProgramOf(request.inputMint), AccountRole.READONLY, 'source token program')
  routeMeta(instruction, 6, tokenProgramOf(request.outputMint), AccountRole.READONLY, 'destination token program')
  routeMeta(
    instruction,
    7,
    JUPITER_V6_DESTINATION_TOKEN_ACCOUNT_PLACEHOLDER,
    AccountRole.READONLY,
    'optional destination account placeholder',
  )
  routeMeta(instruction, 8, JUPITER_V6_EVENT_AUTHORITY, AccountRole.READONLY, 'event authority')
  routeMeta(instruction, 9, JUPITER_V6_PROGRAM, AccountRole.READONLY, 'Jupiter program account')
  if (f) routeMeta(instruction, 10, built.feeAccount, AccountRole.WRITABLE, 'platform fee account')
  routeMeta(instruction, 10 + f, WHIRLPOOL_PROGRAM, AccountRole.READONLY, 'Orca program')
  routeMeta(instruction, 13 + f, SPL_MEMO_PROGRAM, AccountRole.READONLY, 'Orca memo program')
  routeMeta(instruction, 14 + f, request.wallet, AccountRole.READONLY, 'Orca token authority')
  routeMeta(instruction, 15 + f, built.routePlan[0].swapInfo.ammKey, AccountRole.WRITABLE, 'Orca pool')
  // Orca orders a pool's mints as A/B; the swap direction must send the input mint in and the output mint out.
  const aIsInput = String(instruction.accounts[16 + f]?.address) === String(request.inputMint)
  const [mintA, mintB] = aIsInput ? [request.inputMint, request.outputMint] : [request.outputMint, request.inputMint]
  if (decoded.routeSteps[0].aToB !== aIsInput)
    throw new SwapExecutionError('WhirlpoolSwapV2 direction does not match the source and destination mints.')
  routeMeta(instruction, 16 + f, mintA, AccountRole.READONLY, 'Orca mint A')
  routeMeta(instruction, 17 + f, mintB, AccountRole.READONLY, 'Orca mint B')
  routeMeta(instruction, 11 + f, tokenProgramOf(mintA), AccountRole.READONLY, 'Orca token program A')
  routeMeta(instruction, 12 + f, tokenProgramOf(mintB), AccountRole.READONLY, 'Orca token program B')
  routeMeta(instruction, 18 + f, await ata(mintA), AccountRole.WRITABLE, 'Orca user token account A')
  routeMeta(instruction, 20 + f, await ata(mintB), AccountRole.WRITABLE, 'Orca user token account B')
  for (const [index, label] of [
    [19, 'vault A'],
    [21, 'vault B'],
    [22, 'tick array 0'],
    [23, 'tick array 1'],
    [24, 'tick array 2'],
    [25, 'oracle'],
  ]) {
    if (instruction.accounts[index + f]?.role !== AccountRole.WRITABLE)
      throw new SwapExecutionError(`Jupiter V6 WhirlpoolSwapV2 ${label} account role is invalid.`)
  }
}

// Jupiter's Raydium CLMM leg: the ten common metas, the fee account, then the Raydium program and its swap accounts
// (payer, AMM config, pool, user input and output accounts, input and output vaults, observation, token program), then
// the tick arrays and bitmap extension it may cross, closed by Jupiter's placeholder. Raydium itself checks the config,
// vaults, observation and tick arrays against the pool; the user's accounts, the pool and the fee account are pinned here.
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'
async function validateJupiterV2RaydiumClmmRoute(instruction, request, built, deriveAta = ataOf) {
  const decoded = decodeJupiterV6RouteInstruction(instruction, request, built)
  if (
    decoded.routeSteps.length !== 1 ||
    built.routePlan.length !== 1 ||
    built.routePlan[0]?.swapInfo?.label !== 'Raydium CLMM' ||
    built.routePlan[0]?.swapInfo?.inputMint !== request.inputMint ||
    built.routePlan[0]?.swapInfo?.outputMint !== request.outputMint ||
    built.routePlan[0]?.bps !== 10_000
  ) {
    throw new SwapExecutionError('Jupiter V6 Raydium CLMM requires one direct exact-input route_v2 step.')
  }
  const f = FEE_BPS ? 1 : 0
  const tail = instruction.accounts.length - (20 + f) - 1 // tick arrays and bitmap extension before the placeholder
  if (tail < 1 || tail > 6)
    throw new SwapExecutionError('Jupiter V6 Raydium CLMM route has an unsupported account count.')
  // Raydium's swap instruction moves classic SPL tokens only.
  if (
    tokenProgramOf(request.inputMint) !== TOKEN_PROGRAM_ADDRESS ||
    tokenProgramOf(request.outputMint) !== TOKEN_PROGRAM_ADDRESS
  ) {
    throw new SwapExecutionError('Jupiter V6 Raydium CLMM is admitted for classic SPL Token mints only.')
  }
  const ata = async (mint) => deriveAta(address(request.wallet), address(mint), TOKEN_PROGRAM_ADDRESS)
  const meta = (index, expected, role, text) => {
    const item = instruction.accounts[index]
    if (String(item?.address) !== String(expected) || item?.role !== role)
      throw new SwapExecutionError(`Jupiter V6 Raydium CLMM ${text} address or account role is invalid.`)
  }
  meta(0, request.wallet, AccountRole.READONLY_SIGNER, 'user authority')
  meta(1, await ata(request.inputMint), AccountRole.WRITABLE, 'user source token account')
  meta(2, await ata(request.outputMint), AccountRole.WRITABLE, 'user destination token account')
  meta(3, request.inputMint, AccountRole.READONLY, 'source mint')
  meta(4, request.outputMint, AccountRole.READONLY, 'destination mint')
  meta(5, TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY, 'source token program')
  meta(6, TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY, 'destination token program')
  meta(
    7,
    JUPITER_V6_DESTINATION_TOKEN_ACCOUNT_PLACEHOLDER,
    AccountRole.READONLY,
    'optional destination account placeholder',
  )
  meta(8, JUPITER_V6_EVENT_AUTHORITY, AccountRole.READONLY, 'event authority')
  meta(9, JUPITER_V6_PROGRAM, AccountRole.READONLY, 'Jupiter program account')
  if (f) meta(10, built.feeAccount, AccountRole.WRITABLE, 'platform fee account')
  meta(10 + f, RAYDIUM_CLMM_PROGRAM, AccountRole.READONLY, 'program')
  meta(11 + f, request.wallet, AccountRole.READONLY, 'payer')
  if (instruction.accounts[12 + f]?.role !== AccountRole.READONLY)
    throw new SwapExecutionError('Jupiter V6 Raydium CLMM AMM config account role is invalid.')
  meta(13 + f, built.routePlan[0].swapInfo.ammKey, AccountRole.WRITABLE, 'pool')
  meta(14 + f, await ata(request.inputMint), AccountRole.WRITABLE, 'user input token account')
  meta(15 + f, await ata(request.outputMint), AccountRole.WRITABLE, 'user output token account')
  for (const [index, text] of [
    [16, 'input vault'],
    [17, 'output vault'],
    [18, 'observation'],
  ]) {
    if (instruction.accounts[index + f]?.role !== AccountRole.WRITABLE)
      throw new SwapExecutionError(`Jupiter V6 Raydium CLMM ${text} account role is invalid.`)
  }
  meta(19 + f, TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY, 'token program')
  for (let index = 20 + f; index < 20 + f + tail; index++) {
    if (instruction.accounts[index]?.role !== AccountRole.WRITABLE)
      throw new SwapExecutionError('Jupiter V6 Raydium CLMM tick array account role is invalid.')
  }
  meta(instruction.accounts.length - 1, JUPITER_V6_PROGRAM, AccountRole.READONLY, 'trailing placeholder')
}

async function validateAssociatedTokenCreate(request, instruction, deriveAta) {
  const data = instruction.data
  if (!(data.length === 0 || (data.length === 1 && data[0] === 1))) {
    throw new SwapExecutionError('Swap setup contains an unsupported associated-token instruction.')
  }
  const accounts = instruction.accounts
  if (![6, 7].includes(accounts.length))
    throw new SwapExecutionError('Swap setup associated-token account list is invalid.')
  const [payer, associated, owner, mint, system, tokenProgram, rent] = accounts
  if (
    String(payer.address) !== request.wallet ||
    !roleIs(payer, AccountRole.WRITABLE_SIGNER) ||
    !roleIs(associated, AccountRole.WRITABLE) ||
    String(owner.address) !== request.wallet ||
    owner.role !== AccountRole.READONLY ||
    ![request.inputMint, request.outputMint].includes(String(mint.address)) ||
    mint.role !== AccountRole.READONLY ||
    String(system.address) !== SYSTEM_PROGRAM ||
    system.role !== AccountRole.READONLY ||
    !TOKEN_PROGRAMS.has(String(tokenProgram.address)) ||
    tokenProgram.role !== AccountRole.READONLY ||
    (accounts.length === 7 && (String(rent.address) !== RENT_SYSVAR || rent.role !== AccountRole.READONLY))
  ) {
    throw new SwapExecutionError(
      'Swap setup associated-token payer, owner, mint, program, or account roles are invalid.',
    )
  }
  let expected
  try {
    expected = String(await deriveAta(address(request.wallet), address(mint.address), address(tokenProgram.address)))
  } catch {
    throw new SwapExecutionError('Swap setup associated-token address could not be derived.')
  }
  if (String(associated.address) !== expected)
    throw new SwapExecutionError('Swap setup associated-token address is not derived from its declared owner and mint.')
  return expected
}

function validateRoutePlan(built) {
  if (!Array.isArray(built.routePlan) || built.routePlan.length === 0 || built.routePlan.length > 32) {
    throw new SwapExecutionError('Swap route has an invalid DEX instruction count.')
  }
  const labels = new Set()
  const routeIds = new Set()
  let routeInput = 0n
  let routeOutput = 0n
  for (const leg of built.routePlan) {
    const info = leg?.swapInfo
    if (
      typeof info?.label !== 'string' ||
      !info.label.trim() ||
      typeof info.inputMint !== 'string' ||
      typeof info.outputMint !== 'string' ||
      info.inputMint === info.outputMint ||
      typeof info.inAmount !== 'string' ||
      !/^\d+$/.test(info.inAmount) ||
      BigInt(info.inAmount) <= 0n ||
      typeof info.outAmount !== 'string' ||
      !/^\d+$/.test(info.outAmount) ||
      BigInt(info.outAmount) <= 0n
    ) {
      throw new SwapExecutionError('Swap route contains an invalid DEX instruction or economic bound.')
    }
    labels.add(info.label)
    if (info.inputMint === built.inputMint) routeInput += BigInt(info.inAmount)
    if (info.outputMint === built.outputMint) routeOutput += BigInt(info.outAmount)
    const mapped = built.routeProgramIdsByLabel?.[info.label]
    if (!Array.isArray(mapped) || mapped.length === 0)
      throw new SwapExecutionError('Swap route DEX label does not resolve to exact program identities.')
    for (const value of mapped) {
      try {
        routeIds.add(String(address(value)))
      } catch {
        throw new SwapExecutionError('Swap route contains an invalid DEX program identity.')
      }
    }
    if (info.programId != null) {
      try {
        routeIds.add(String(address(info.programId)))
      } catch {
        throw new SwapExecutionError('Swap route contains an invalid DEX program identity.')
      }
    }
  }
  const declared = new Set((built.routeProgramIds ?? []).map(String))
  if (declared.size !== routeIds.size || [...routeIds].some((program) => !declared.has(program))) {
    throw new SwapExecutionError('Swap route DEX instruction count or program set does not match its plan.')
  }
  const mappedLabels = Object.keys(built.routeProgramIdsByLabel ?? {})
  if (labels.size !== mappedLabels.length || [...labels].some((label) => !mappedLabels.includes(label))) {
    throw new SwapExecutionError('Swap route has extra or missing DEX program mappings.')
  }
  const inputAmount = positiveRaw(built.inputAmountBaseUnits, 'route input amount')
  const netOutput = positiveRaw(built.outputAmountBaseUnits, 'route net output amount')
  const minimumOutput = positiveRaw(built.minimumOutputBaseUnits, 'route minimum output')
  const feeAmount = feeRaw(built.fee?.amountBaseUnits, 'route fee amount')
  if (
    minimumOutput > netOutput ||
    built.fee?.bps !== FEE_BPS ||
    (FEE_BPS &&
      (built.fee.mint !== built.feeAccountMint || ![built.inputMint, built.outputMint].includes(built.fee.mint)))
  ) {
    throw new SwapExecutionError('Swap route fee or net-output bounds do not match the authorized pair.')
  }
  const expectedInput = built.fee.mint === built.inputMint ? inputAmount - feeAmount : inputAmount
  const expectedOutput = built.fee.mint === built.outputMint ? netOutput + feeAmount : netOutput
  if (expectedInput <= 0n || routeInput !== expectedInput || routeOutput !== expectedOutput) {
    throw new SwapExecutionError('Swap DEX route amount effects do not match the requested input, fee, and net output.')
  }
  return labels
}

export async function validateProviderSwapInstructions(request, built, { deriveAta = ataOf } = {}) {
  if (!Array.isArray(built?.instructions) || built.instructions.length === 0 || built.instructions.length > 80) {
    throw new SwapExecutionError('Swap provider returned an invalid instruction set.')
  }
  const programIds = built.programIds
  const routeProgramIds = built.routeProgramIds
  if (
    !Array.isArray(programIds) ||
    programIds.length === 0 ||
    !Array.isArray(routeProgramIds) ||
    routeProgramIds.length === 0
  ) {
    throw new SwapExecutionError('Swap route does not identify its exact programs.')
  }
  const declaredPrograms = new Set(
    programIds.map((value) => {
      try {
        return String(address(value))
      } catch {
        throw new SwapExecutionError('Swap route contains an invalid program address.')
      }
    }),
  )
  if (routeProgramIds.some((program) => !declaredPrograms.has(String(program)))) {
    throw new SwapExecutionError('Swap route DEX program is missing from its exact program set.')
  }
  validateRoutePlan(built)
  const swapInstruction = built.swapInstruction
  const routerProgram = String(built.swapInstructionProgramId ?? swapInstruction?.programAddress ?? '')
  if (
    !swapInstruction ||
    !routerProgram ||
    String(swapInstruction.programAddress) !== routerProgram ||
    !declaredPrograms.has(routerProgram) ||
    !built.programPolicy?.approved
  ) {
    throw new SwapExecutionError(
      'Swap provider router instruction is missing or not in the reviewed exact program set.',
    )
  }
  if (routerProgram !== JUPITER_V6_PROGRAM)
    throw new SwapExecutionError('Swap provider router is not the supported Jupiter V6 program.')
  if (
    built.cleanupInstruction != null ||
    built.tipInstruction != null ||
    (built.otherInstructions ?? []).length !== 0
  ) {
    throw new SwapExecutionError('Swap provider returned cleanup, tip, or extra economic instructions.')
  }
  const compute = built.computeBudgetInstructions ?? []
  const setup = built.setupInstructions ?? []
  if (!Array.isArray(compute) || !Array.isArray(setup))
    throw new SwapExecutionError('Swap provider returned invalid instruction groups.')
  if (compute.some((instruction) => String(instruction?.programAddress) !== COMPUTE_BUDGET_PROGRAM_ADDRESS)) {
    throw new SwapExecutionError('Swap compute group may contain only Compute Budget instructions.')
  }
  if (setup.some((instruction) => String(instruction?.programAddress) !== ASSOCIATED_TOKEN_PROGRAM)) {
    throw new SwapExecutionError('Swap setup group may contain only validated associated-token creates.')
  }
  const expectedInstructions = [...compute, ...setup, swapInstruction]
  if (
    built.instructions.length !== expectedInstructions.length ||
    built.instructions.some((instruction, index) => !instructionEquals(instruction, expectedInstructions[index]))
  ) {
    throw new SwapExecutionError(
      'Swap instruction count, order, data, or accounts differ from the exact provider route.',
    )
  }
  if (
    built.instructions.filter((instruction) => String(instruction.programAddress) === routerProgram).length !==
    ROUTE_INSTRUCTION_MAX
  ) {
    throw new SwapExecutionError('Swap route must contain exactly one provider router instruction.')
  }
  const seenCompute = { limit: false, price: false }
  for (const instruction of compute) validateComputeBudgetInstruction(instruction, seenCompute)
  if (FEE_BPS)
    try {
      address(built.feeAccount)
    } catch {
      throw new SwapExecutionError('Swap fee recipient is invalid.')
    }
  const pairAtas = new Set()
  const invokedPrograms = new Set([
    ...built.instructions.map((instruction) => String(instruction.programAddress)),
    ...routeProgramIds.map(String),
  ])
  if (
    invokedPrograms.size !== declaredPrograms.size ||
    [...invokedPrograms].some((program) => !declaredPrograms.has(program))
  ) {
    throw new SwapExecutionError('Swap provider program set contains an undeclared or extra economic program.')
  }
  for (const instruction of built.instructions) {
    let program
    try {
      program = String(address(instruction?.programAddress))
    } catch {
      throw new SwapExecutionError('Swap provider returned an invalid instruction program.')
    }
    if (program === SYSTEM_PROGRAM)
      throw new SwapExecutionError('Swap route contains a native System transfer or account instruction.')
    if (TOKEN_PROGRAMS.has(program))
      throw new SwapExecutionError('Swap route contains an unrelated top-level token economic instruction.')
    if (
      program !== routerProgram &&
      program !== ASSOCIATED_TOKEN_PROGRAM &&
      program !== COMPUTE_BUDGET_PROGRAM_ADDRESS
    ) {
      throw new SwapExecutionError('Swap route contains an extra DEX or other top-level economic instruction.')
    }
    if (
      !declaredPrograms.has(program) &&
      program !== ASSOCIATED_TOKEN_PROGRAM &&
      program !== COMPUTE_BUDGET_PROGRAM_ADDRESS
    ) {
      throw new SwapExecutionError('Swap route contains an unlisted instruction program.')
    }
    if (!Array.isArray(instruction.accounts) || !(instruction.data instanceof Uint8Array)) {
      throw new SwapExecutionError('Swap provider returned malformed instruction accounts or data.')
    }
    for (const meta of instruction.accounts) {
      let account
      try {
        account = String(address(meta?.address))
      } catch {
        throw new SwapExecutionError('Swap provider returned an invalid instruction account.')
      }
      if (SIGNER_ROLES.has(meta.role) && account !== request.wallet) {
        throw new SwapExecutionError('Swap route requests an unapproved additional signer.')
      }
      if (
        ![
          AccountRole.READONLY,
          AccountRole.WRITABLE,
          AccountRole.READONLY_SIGNER,
          AccountRole.WRITABLE_SIGNER,
        ].includes(meta.role)
      ) {
        throw new SwapExecutionError('Swap provider returned an invalid account role.')
      }
    }
    if (program === ASSOCIATED_TOKEN_PROGRAM) {
      if (!setup.includes(instruction))
        throw new SwapExecutionError('Associated-token instructions are allowed only as exact setup instructions.')
      const ata = await validateAssociatedTokenCreate(request, instruction, deriveAta)
      if (pairAtas.has(ata))
        throw new SwapExecutionError('Swap setup creates the same associated-token account more than once.')
      pairAtas.add(ata)
    } else if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS && !compute.includes(instruction)) {
      throw new SwapExecutionError('Compute-budget instructions are allowed only in the provider compute group.')
    }
  }
  const priorityFee = priorityFeeLamports(built.instructions)
  if (priorityFee == null || priorityFee > MAX_PRIORITY_FEE_LAMPORTS)
    throw new SwapExecutionError('Swap route priority fee exceeds Nysa’s 0.001 SOL limit.')
  if (built.routePlan?.[0]?.swapInfo?.label === 'Raydium CLMM')
    await validateJupiterV2RaydiumClmmRoute(swapInstruction, request, built, deriveAta)
  else await validateJupiterV2WhirlpoolRoute(swapInstruction, request, built, deriveAta)
}

// The provider picks the pool and reports its own output, so the result is bounded with an independent price: the
// Kamino oracle prices of the market snapshot. Floats are fine for this ratio (amounts are far below 2^53).
export function assertOracleFairOutput({ inputAmountBaseUnits, minimumOutputBaseUnits, input, output }) {
  const paid = (Number(inputAmountBaseUnits) / 10 ** input.decimals) * input.price
  const floor = (Number(minimumOutputBaseUnits) / 10 ** output.decimals) * output.price
  if (!(paid > 0) || !(floor > 0))
    throw new SwapExecutionError('Oracle prices are unavailable, so the swap price cannot be checked.')
  if (floor * 10_000 < paid * (10_000 - MAX_ORACLE_LOSS_BPS))
    throw new SwapExecutionError('The route pays out more than 3% below the oracle price, so the swap was refused.')
}

function validateCompiledSwapMessage(
  messageBytes,
  request,
  built,
  resolvedLookupTables = built.addressesByLookupTableAddress ?? {},
) {
  let message
  try {
    message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  } catch {
    throw new SwapExecutionError('Compiled swap transaction message is invalid.')
  }
  const staticAccounts = (message.staticAccounts ?? []).map(String)
  if (staticAccounts[0] !== request.wallet || message.header?.numSignerAccounts !== 1) {
    throw new SwapExecutionError('Compiled swap transaction has an unapproved payer or signer.')
  }
  const allowedPrograms = new Set(built.programIds.map(String))
  for (const instruction of message.instructions ?? []) {
    const program = staticAccounts[instruction.programAddressIndex]
    if (!program) throw new SwapExecutionError('Compiled swap transaction contains an unresolved program address.')
    if (program === SYSTEM_PROGRAM || TOKEN_PROGRAMS.has(program)) {
      throw new SwapExecutionError('Compiled swap transaction contains native transfer or unrelated token economics.')
    }
    if (
      !allowedPrograms.has(program) &&
      program !== ASSOCIATED_TOKEN_PROGRAM &&
      program !== COMPUTE_BUDGET_PROGRAM_ADDRESS
    ) {
      throw new SwapExecutionError('Compiled swap transaction contains an unapproved instruction program.')
    }
  }
  const loadedWritable = []
  const loadedReadonly = []
  for (const lookup of message.addressTableLookups ?? []) {
    const table = String(lookup.lookupTableAddress)
    const addresses = resolvedLookupTables[table]
    if (!Array.isArray(addresses))
      throw new SwapExecutionError('Compiled swap transaction contains an unresolved address lookup table.')
    for (const index of lookup.writableIndexes ?? []) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= addresses.length)
        throw new SwapExecutionError('Compiled swap transaction writable lookup index is unresolved.')
      loadedWritable.push(String(addresses[index]))
    }
    for (const index of lookup.readonlyIndexes ?? []) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= addresses.length)
        throw new SwapExecutionError('Compiled swap transaction readonly lookup index is unresolved.')
      loadedReadonly.push(String(addresses[index]))
    }
  }
  const resolvedAccounts = [...staticAccounts, ...loadedWritable, ...loadedReadonly]
  const allResolvedAccounts = new Set(resolvedAccounts)
  for (const instruction of message.instructions ?? []) {
    if (
      (instruction.accountIndices ?? []).some(
        (index) => !Number.isSafeInteger(index) || index < 0 || index >= resolvedAccounts.length,
      )
    ) {
      throw new SwapExecutionError('Compiled swap transaction contains an unresolved account index.')
    }
  }
  const expectedInstructions = built.instructions ?? []
  if ((message.instructions ?? []).length !== expectedInstructions.length) {
    throw new SwapExecutionError('Compiled swap instruction count differs from the exact provider route.')
  }
  for (let index = 0; index < expectedInstructions.length; index++) {
    const actual = message.instructions[index]
    const expected = expectedInstructions[index]
    const program = staticAccounts[actual.programAddressIndex]
    const accounts = (actual.accountIndices ?? []).map((accountIndex) => resolvedAccounts[accountIndex])
    const expectedAccounts = expected.accounts.map((meta) => String(meta.address))
    if (
      program !== String(expected.programAddress) ||
      Buffer.compare(Buffer.from(actual.data), Buffer.from(expected.data)) !== 0 ||
      accounts.length !== expectedAccounts.length ||
      accounts.some((account, accountIndex) => account !== expectedAccounts[accountIndex])
    ) {
      throw new SwapExecutionError(
        'Compiled swap instruction data, account order, or program differs from the authorized provider route.',
      )
    }
  }
  if (FEE_BPS && !allResolvedAccounts.has(String(built.feeAccount))) {
    throw new SwapExecutionError('Compiled swap transaction does not resolve the configured treasury recipient.')
  }
}

function slotBigInt(value, label) {
  try {
    if (typeof value === 'bigint' && value >= 0n) return value
    if (Number.isSafeInteger(value) && value >= 0) return BigInt(value)
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  } catch {
    /* report one stable resolution error */
  }
  throw new SwapExecutionError(`Lookup table ${label} is invalid.`)
}

export function validateLookupTableResolution(expectedAddresses, tableData, currentSlot) {
  if (!Array.isArray(expectedAddresses) || !Array.isArray(tableData?.addresses)) {
    throw new SwapExecutionError('Swap provider lookup table contents are invalid.')
  }
  const slot = slotBigInt(currentSlot, 'current slot')
  const lastExtendedSlot =
    tableData.lastExtendedSlot == null ? 0n : slotBigInt(tableData.lastExtendedSlot, 'extension slot')
  const deactivationSlot =
    tableData.deactivationSlot == null ? (1n << 64n) - 1n : slotBigInt(tableData.deactivationSlot, 'deactivation slot')
  const startIndex = tableData.lastExtendedSlotStartIndex == null ? 0 : tableData.lastExtendedSlotStartIndex
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    startIndex > tableData.addresses.length ||
    deactivationSlot <= slot ||
    lastExtendedSlot > slot
  ) {
    throw new SwapExecutionError('Swap provider lookup table is inactive or its active-address range is unresolved.')
  }
  const activeCount = lastExtendedSlot === slot ? startIndex : tableData.addresses.length
  const activeAddresses = tableData.addresses.slice(0, activeCount).map(String)
  if (
    activeAddresses.length !== expectedAddresses.length ||
    activeAddresses.some((item, index) => item !== String(expectedAddresses[index]))
  ) {
    throw new SwapExecutionError(
      'Swap provider lookup table indexed addresses changed or do not match chain state exactly.',
    )
  }
  return activeAddresses
}

async function resolveLookupTables(built, rpcClient, resolver) {
  const expected = built.addressesByLookupTableAddress ?? {}
  const tables = Object.keys(expected)
  if (!tables.length) return expected
  let fetched, currentSlot
  try {
    fetched =
      typeof resolver === 'function'
        ? await resolver(tables, expected)
        : await Promise.all(
            tables.map((table) => fetchAddressLookupTable(rpcClient, address(table), { commitment: 'confirmed' })),
          )
    currentSlot = await rpcClient.getSlot({ commitment: 'confirmed' }).send()
  } catch {
    throw new SwapExecutionError('Swap provider lookup table could not be resolved from confirmed chain state.')
  }
  if (!Array.isArray(fetched) || fetched.length !== tables.length)
    throw new SwapExecutionError('Swap provider lookup table resolution is incomplete.')
  const resolved = {}
  for (let index = 0; index < tables.length; index++) {
    const account = fetched[index]
    const table = tables[index]
    if (!account?.exists || !Array.isArray(account.data?.addresses)) {
      throw new SwapExecutionError('Swap provider lookup table addresses changed or could not be resolved.')
    }
    resolved[table] = validateLookupTableResolution(expected[table], account.data, currentSlot)
  }
  return resolved
}

const rawLamports = (value) => {
  if (typeof value === 'bigint' && value >= 0n) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  return null
}

// Decimal strings, so lamport values never pass through floating point.
export function swapCostDisclosure({ totalNetworkFeeLamports, priorityFeeLamports, accountRentLamports } = {}) {
  const total = rawLamports(totalNetworkFeeLamports)
  const priority = rawLamports(priorityFeeLamports)
  const rent = rawLamports(accountRentLamports)
  const base =
    total != null && priority != null && BigInt(total) >= BigInt(priority)
      ? String(BigInt(total) - BigInt(priority))
      : null
  const unavailable = []
  if (base == null) unavailable.push('network-fee')
  if (priority == null || (total != null && BigInt(priority) > BigInt(total))) unavailable.push('priority-fee')
  if (rent == null) unavailable.push('account-rent')
  return {
    status: unavailable.length ? 'unavailable' : 'known',
    totalNetworkFeeLamports: total,
    baseNetworkFeeLamports: base,
    priorityFeeLamports: priority != null && (total == null || BigInt(priority) <= BigInt(total)) ? priority : null,
    accountRentLamports: rent,
    accountRentEstimateKind: rent == null ? 'unavailable' : BigInt(rent) === 0n ? 'none' : 'upper-bound',
    unavailable,
  }
}

function priorityFeeLamports(instructions) {
  let price = null
  let limit = null
  for (const instruction of instructions) {
    if (String(instruction.programAddress) !== COMPUTE_BUDGET_PROGRAM_ADDRESS) continue
    const data = instruction.data
    if (!(data instanceof Uint8Array) || data.length === 0) return null
    const [opcode] = data
    if (opcode === SET_CU_LIMIT && data.length === 5 && limit == null) limit = computeUnitLimit(data)
    else if (opcode === SET_CU_PRICE && data.length === 9 && price == null) price = computeUnitPrice(data)
    else if (opcode === SET_CU_LIMIT || opcode === SET_CU_PRICE) return null
  }
  if (price == null) return 0n
  // Without an explicit limit Solana requests 200k compute units per non-compute-budget instruction, up to 1.4M.
  limit ??= Math.min(
    200_000 * instructions.filter((ix) => String(ix.programAddress) !== COMPUTE_BUDGET_PROGRAM_ADDRESS).length,
    MAX_COMPUTE_UNITS,
  )
  if (limit <= 0) return null
  const product = BigInt(limit) * price
  return (product + 999_999n) / 1_000_000n
}

export async function estimateSwapCosts(built, compiled, rpcClient) {
  let totalNetworkFeeLamports = null
  let accountRentLamports = null
  try {
    if (typeof rpcClient.getFeeForMessage === 'function') {
      const response = await rpcClient
        .getFeeForMessage(Buffer.from(compiled.messageBytes).toString('base64'), { commitment: 'confirmed' })
        .send()
      if (response?.value != null) totalNetworkFeeLamports = String(response.value)
    }
  } catch {
    /* surfaced as unavailable before signing */
  }
  const priorityFee = priorityFeeLamports(built.instructions)
  const ataCreations = built.instructions.filter(
    (instruction) =>
      String(instruction.programAddress) === ASSOCIATED_TOKEN_PROGRAM &&
      (instruction.data.length === 0 || (instruction.data.length === 1 && instruction.data[0] === 1)),
  )
  if (ataCreations.length === 0) accountRentLamports = '0'
  else {
    const standardTokenOnly = ataCreations.every(
      (instruction) => String(instruction.accounts?.[5]?.address) === String(TOKEN_PROGRAM_ADDRESS),
    )
    try {
      if (standardTokenOnly && typeof rpcClient.getMinimumBalanceForRentExemption === 'function') {
        const response = await rpcClient.getMinimumBalanceForRentExemption(165, { commitment: 'confirmed' }).send()
        const rent = response?.value ?? response
        if (rent != null) accountRentLamports = String(BigInt(String(rent)) * BigInt(ataCreations.length))
      }
    } catch {
      /* surfaced as unavailable before signing */
    }
  }
  return swapCostDisclosure({
    totalNetworkFeeLamports,
    priorityFeeLamports: priorityFee,
    accountRentLamports,
  })
}

function tokenAccountDetails(account) {
  if (
    !account?.exists ||
    !TOKEN_PROGRAMS.has(String(account.programAddress)) ||
    !(account.data instanceof Uint8Array) ||
    account.data.length < 165
  )
    return null
  try {
    const { mint, owner, amount } = getTokenDecoder().decode(account.data)
    return { mint, owner, amount }
  } catch {
    return null
  }
}

export async function compileSwapTransaction({ request, built, rpcClient = rpc, lookupTableResolver } = {}) {
  if (!rpcClient) throw new SwapExecutionError('Solana RPC is unavailable.')
  const { context, value: blockhash } = await rpcClient.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const addressesByLookupTableAddress = await resolveLookupTables(built, rpcClient, lookupTableResolver)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(address(request.wallet), tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => appendTransactionMessageInstructions(built.instructions, tx),
    (tx) =>
      Object.keys(addressesByLookupTableAddress).length
        ? compressTransactionMessageUsingAddressLookupTables(tx, addressesByLookupTableAddress)
        : tx,
  )
  const transaction = compileTransaction(message)
  const encoded = getTransactionEncoder().encode(transaction)
  const size = encoded.length
  if (size > TRANSACTION_SIZE_LIMIT)
    throw new SwapExecutionError(
      `Swap transaction is ${size} bytes, over Solana’s ${TRANSACTION_SIZE_LIMIT}-byte limit.`,
    )
  const compiled = {
    tx: getBase64EncodedWireTransaction(transaction),
    messageBytes: getTransactionDecoder().decode(encoded).messageBytes,
    size,
    minContextSlot: Number(context.slot),
  }
  return {
    ...compiled,
    resolvedLookupTables: addressesByLookupTableAddress,
    costDisclosure: await estimateSwapCosts(built, compiled, rpcClient),
  }
}

export async function simulateSwapTransaction({ request, built, compiled, rpcClient = rpc } = {}) {
  if (!rpcClient) throw new SwapExecutionError('Solana RPC is unavailable.')
  const owner = address(request.wallet)
  const inputAta = await ataOf(owner, address(request.inputMint), tokenProgramOf(request.inputMint))
  const outputAta = await ataOf(owner, address(request.outputMint), tokenProgramOf(request.outputMint))
  const feeAta = FEE_BPS ? address(built.feeAccount) : null
  const writableRouteAccounts = built.instructions.flatMap((instruction) =>
    instruction.accounts
      .filter((meta) => meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER)
      .map((meta) => address(meta.address)),
  )
  const accounts = [
    ...new Set([inputAta, outputAta, ...(feeAta ? [feeAta] : []), ...writableRouteAccounts].map(String)),
  ].map(address)
  const before = await fetchEncodedAccounts(rpcClient, accounts, { commitment: 'confirmed' })
  const tracked = new Map()
  for (let index = 0; index < accounts.length; index++) {
    const account = before[index]
    const details = tokenAccountDetails(account)
    const accountAddress = String(accounts[index])
    if (accountAddress === String(inputAta) || accountAddress === String(outputAta)) {
      tracked.set(
        accountAddress,
        details ?? {
          owner: String(owner),
          mint: accountAddress === String(inputAta) ? String(request.inputMint) : String(request.outputMint),
          amount: 0n,
        },
      )
    } else if (accountAddress === String(feeAta) || details?.owner === String(owner)) {
      if (details) tracked.set(accountAddress, details)
      else if (accountAddress === String(feeAta))
        throw new SwapExecutionError('Configured fee account is not a readable token account during simulation.')
    }
  }
  if (!tracked.has(String(inputAta)) || !tracked.has(String(outputAta)) || (feeAta && !tracked.has(String(feeAta)))) {
    throw new SwapExecutionError('Swap simulation could not identify the authorized user and treasury token accounts.')
  }
  const trackedAddresses = [...tracked.keys()].map(address)
  const simulationAccounts = trackedAddresses
  const response = await rpcClient
    .simulateTransaction(compiled.tx, {
      encoding: 'base64',
      sigVerify: false,
      commitment: 'confirmed',
      replaceRecentBlockhash: true,
      accounts: { addresses: simulationAccounts.map(String), encoding: 'base64' },
    })
    .send()
  const simulation = response?.value
  if (!simulation || simulation.err) {
    const hint = (simulation?.logs ?? []).find((line) => /error|failed/i.test(line))
    throw new SwapExecutionError(
      chainError(simulation?.logs, simulation?.err) ??
        `Swap simulation failed${hint ? `: ${hint.replace(/^Program log: /, '')}` : '.'}`,
    )
  }
  if (!Array.isArray(simulation.accounts) || simulation.accounts.length !== simulationAccounts.length) {
    throw new SwapExecutionError('Swap simulation returned incomplete token-account balances.')
  }
  const after = simulation.accounts.map((accountInfo) =>
    accountInfo?.data?.[0]
      ? {
          exists: true,
          programAddress: accountInfo.owner,
          data: Uint8Array.from(Buffer.from(accountInfo.data[0], 'base64')),
        }
      : null,
  )
  const balanceAfter = (accountInfo) => tokenAccountDetails(accountInfo)?.amount ?? 0n
  // No fee account: its delta reads 0 (index -1 finds no account).
  const beforeRaw = [String(inputAta), String(outputAta), String(feeAta)].map((key) => tracked.get(key)?.amount ?? 0n)
  const afterRaw = [String(inputAta), String(outputAta), String(feeAta)].map((key) => {
    const index = trackedAddresses.findIndex((item) => String(item) === key)
    return index < 0 ? 0n : balanceAfter(after[index])
  })
  const additionalTokenDeltas = []
  for (const [index, key] of trackedAddresses.entries()) {
    const accountAddress = String(key)
    if ([String(inputAta), String(outputAta), String(feeAta)].includes(accountAddress)) continue
    additionalTokenDeltas.push({
      mint: tracked.get(accountAddress).mint,
      deltaBaseUnits: String(balanceAfter(after[index]) - tracked.get(accountAddress).amount),
    })
  }
  return {
    inputDeltaBaseUnits: String(beforeRaw[0] - afterRaw[0]),
    outputDeltaBaseUnits: String(afterRaw[1] - beforeRaw[1]),
    feeDeltaBaseUnits: String(afterRaw[2] - beforeRaw[2]),
    additionalTokenDeltas,
    logs: (simulation.logs ?? []).slice(0, 100),
  }
}

// Refuses before any provider work unless every release gate is open.
export function createSwapExecutionService({
  readiness,
  buildRoute,
  compile,
  simulate,
  intentStore,
  onBuild = () => {},
  now = Date.now,
} = {}) {
  if (typeof readiness !== 'function' || !intentStore) {
    throw new TypeError('Swap execution service dependencies are required.')
  }
  return {
    async build(body) {
      const request = parseSwapQuoteRequest(body)
      const gate = await readiness(request)
      if (gate?.executionEnabled !== true) {
        const reason = (gate?.unavailableReasons ?? [])
          .map((item) => item.message)
          .filter(Boolean)
          .join(' ')
        throw new SwapExecutionError(reason || 'Swap execution is not approved.')
      }
      if ([buildRoute, compile, simulate].some((dependency) => typeof dependency !== 'function')) {
        throw new TypeError('Enabled swap execution requires route, compiler, and simulation functions.')
      }
      const built = await buildRoute(request)
      await validateProviderSwapInstructions(request, built)
      if (Number(built.priceImpactPct) > 1) throw new SwapExecutionError('Price impact exceeds Nysa’s 1% limit.')
      if (!built.programPolicy?.approved) throw new SwapExecutionError('Swap route contains an unreviewed program.')
      if (
        FEE_BPS &&
        (built.feeAccountMintVerified !== true ||
          (built.feeAccountMint !== request.outputMint && built.feeAccountMint !== request.inputMint))
      ) {
        throw new SwapExecutionError('Swap fee account is not verified for the configured fee mint.')
      }
      const compiled = await compile({ request, built })
      if (
        !compiled ||
        typeof compiled.tx !== 'string' ||
        !(compiled.messageBytes instanceof Uint8Array) ||
        !Number.isSafeInteger(compiled.size) ||
        compiled.size <= 0 ||
        compiled.size > TRANSACTION_SIZE_LIMIT
      ) {
        throw new SwapExecutionError('Swap transaction exceeds Solana’s supported transaction size.')
      }
      let compiledWire
      try {
        compiledWire = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(compiled.tx, 'base64')))
      } catch {
        throw new SwapExecutionError('Compiled swap transaction is invalid.')
      }
      if (Buffer.compare(Buffer.from(compiledWire.messageBytes), Buffer.from(compiled.messageBytes)) !== 0) {
        throw new SwapExecutionError('Compiled swap transaction message does not match its signed bytes.')
      }
      validateCompiledSwapMessage(
        compiled.messageBytes,
        request,
        built,
        compiled.resolvedLookupTables ?? built.addressesByLookupTableAddress ?? {},
      )
      const effects = assertSwapSimulationEffects(
        {
          inputAmountBaseUnits: request.amountBaseUnits,
          minimumOutputBaseUnits: built.minimumOutputBaseUnits,
          feeAmountBaseUnits: built.fee?.amountBaseUnits,
        },
        await simulate({ request, built, compiled }),
      )
      const currentTime = now()
      assertSwapQuoteFresh(built.quoteAt, currentTime)
      const verifiedBuilt = { ...built, feeBalanceDeltaVerified: true, feeVerificationReason: null, executable: true }
      const quote = publicSwapQuote(verifiedBuilt, { now: () => currentTime })
      if (!quote.executable) throw new SwapExecutionError('Validated swap quote expired before it could be authorized.')
      const metadata = {
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        inputAmountBaseUnits: request.amountBaseUnits,
        minimumOutputBaseUnits: built.minimumOutputBaseUnits,
        slippageBps: request.slippageBps,
        feeMint: built.fee.mint,
        feeAmountBaseUnits: built.fee.amountBaseUnits,
        feeAccount: built.feeAccount,
        feeAccountMint: built.feeAccountMint,
        routeProgramIds: [...built.routeProgramIds],
        routeLabels: [...(built.routeLabels ?? [])],
        routeProgramIdsByLabel: structuredClone(built.routeProgramIdsByLabel ?? {}),
        programIds: [...built.programIds],
      }
      const intent = intentStore.issue({
        wallet: request.wallet,
        messageBytes: compiled.messageBytes,
        expiresAt: quote.expiresAt,
        metadata,
      })
      onBuild(request.wallet, intent)
      return {
        tx: compiled.tx,
        size: compiled.size,
        minContextSlot: compiled.minContextSlot ?? null,
        intentId: intent.id,
        expiresAt: intent.expiresAt,
        quote,
        simulation: effects,
        costDisclosure: compiled.costDisclosure ?? swapCostDisclosure({}),
      }
    },
  }
}

export function createAuthorizedSwapSender({ intentStore, send, authorize = async () => true } = {}) {
  if (!intentStore || typeof send !== 'function' || typeof authorize !== 'function')
    throw new TypeError('Authorized swap sender dependencies are required.')
  return async function sendAuthorizedSwap({ tx, wallet, intentId } = {}) {
    if (typeof tx !== 'string' || tx.length > 100_000 || typeof wallet !== 'string' || typeof intentId !== 'string') {
      throw new SwapExecutionError('Invalid signed swap request.')
    }
    let messageBytes
    try {
      const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64')))
      messageBytes = decoded.messageBytes
    } catch {
      throw new SwapExecutionError('Invalid signed swap transaction.')
    }
    let intent
    try {
      intent = intentStore.assertAndConsume(intentId, wallet, messageBytes)
    } catch (error) {
      if (error instanceof TransactionIntentError) throw new SwapExecutionError(error.message)
      throw error
    }
    if ((await authorize(intent)) !== true)
      throw new SwapExecutionError('Swap route readiness changed after signing; rebuild after checks pass.')
    return send({ tx, wallet, intent })
  }
}
