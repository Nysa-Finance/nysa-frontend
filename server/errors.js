// One place that turns Solana / Kamino / swap failures into a sentence a user can act on. Every simulation, relay
// refusal, on-chain failure and unexpected server error goes through here, so a new feature gets readable errors for free.
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const klend = require('@kamino-finance/klend-sdk/dist/@codegen/klend/errors/index.js')
const kvault = require('@kamino-finance/klend-sdk/dist/@codegen/kvault/errors/index.js')
const farms = require('@kamino-finance/farms-sdk/dist/@codegen/farms/errors/farms.js')

const TRY_SMALLER = 'Try a smaller amount.'
const NO_SOL =
  'This wallet needs a little SOL for Solana network fees and new account rent: add about 0.01 SOL (0.05 before a first supply or borrow) and try again.'
const PRICES = "Kamino's price feed for this market is refreshing right now. Try again in a few seconds."
const SLIPPAGE =
  'The price moved more than your slippage allows while the transaction was in flight. Try again, or raise slippage slightly.'
const BALANCE =
  "Your wallet doesn't hold enough of this token for that amount (the balance may have changed). Try a smaller amount."

// Kamino Lend errors users actually hit, worded for them; every other code falls back to Kamino's own message.
const KLEND = {
  InsufficientLiquidity: "There isn't enough liquidity in this market for that amount right now.",
  BorrowingAboveUtilizationRateDisabled: `This market is at Kamino's borrowing limit right now, so it can't lend that much. Try a smaller amount or lower leverage.`,
  BorrowLimitExceeded: `This market has reached its total borrow cap. ${TRY_SMALLER}`,
  ElevationGroupBorrowLimitExceeded: `This market has reached its total borrow cap. ${TRY_SMALLER}`,
  DepositLimitExceeded: `This market has reached its deposit cap. ${TRY_SMALLER}`,
  WithdrawTooSmall: 'That withdrawal is too small for Kamino to process. Try a larger amount.',
  BorrowTooSmall: "That borrow is too small to cover Kamino's fees. Try a larger amount.",
  RepayTooSmall: 'That repayment is too small for Kamino to process. Try a larger amount.',
  NetValueRemainingTooSmall:
    'That would leave a position too small for Kamino to keep open. Withdraw or repay in full instead.',
  WorseLtvBlocked: `That would bring your loan closer to liquidation than Kamino allows. ${TRY_SMALLER}`,
  WorseLtvThanUnhealthyLtv: `That would make your loan liquidatable. ${TRY_SMALLER}`,
  MaximumWithdrawValueZero: 'Your loan needs all of this collateral right now. Repay some debt first.',
  ObligationHealthy: "This loan is healthy again (or was just liquidated), so it can't be liquidated right now.",
  GlobalEmergencyMode: 'Kamino has paused this market for safety. Try again later.',
  ReserveEmergencyMode: 'Kamino has paused this market for safety. Try again later.',
  ElevationGroupNewLoansDisabled: "Kamino isn't accepting new loans in this market right now.",
  ReserveStale: 'Market data moved while this was being prepared. Try again.',
  ObligationStale: 'Market data moved while this was being prepared. Try again.',
  PriceTooOld: PRICES,
  PriceTooDivergentFromTwap: PRICES,
  PriceNotValid: PRICES,
  PriceIsZero: PRICES,
  PriceConfidenceTooWide: PRICES,
  PriceIsBiggerThanHeuristic: PRICES,
  PriceIsLowerThanHeuristic: PRICES,
  NoPriceFound: PRICES,
}
// Numeric overrides kept from before (6011 is the withdraw-blocked-by-loan case).
const KLEND_CODES = {
  6011: `That's more than you can withdraw right now: your loan needs this collateral. ${TRY_SMALLER}`,
  6013: "That's above your borrow limit right now (prices and interest move every block). Try a slightly smaller amount.",
}

const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`)
const PROGRAMS = {
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: (n) => {
    const e = klend.fromCode(n)
    return KLEND_CODES[n] ?? KLEND[e?.name] ?? (e && `Kamino refused this transaction: ${sentence(e.msg)}`)
  },
  KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd: (n) => {
    const e = kvault.fromCode(n)
    return e && `The Kamino vault refused this transaction: ${sentence(e.msg)}`
  },
  FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr: (n) => {
    const m = farms.getFarmsErrorMessage(n)
    return m && `Kamino rewards refused this transaction: ${sentence(m)}`
  },
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: (n) =>
    ({ 6001: SLIPPAGE, 6017: SLIPPAGE, 6000: 'No swap route is available for this pair right now. Try again.' })[n],
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: (n) => (n === 1 ? BALANCE : null),
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: (n) => (n === 1 ? BALANCE : null),
}

// Runtime-level errors (no program ran, or the runtime stopped it).
const RUNTIME = {
  AccountNotFound: NO_SOL,
  InsufficientFundsForFee: NO_SOL,
  InsufficientFundsForRent: NO_SOL,
  BlockhashNotFound: 'The transaction expired before it reached the network. Try again.',
  AlreadyProcessed: 'This transaction was already processed.',
  AccountInUse: 'The network was busy with this account. Try again.',
  ComputationalBudgetExceeded: 'The transaction ran out of compute on the network. Try again.',
  ProgramFailedToComplete: 'The transaction ran out of compute on the network. Try again.',
  WouldExceedMaxAccountCostLimit: 'The network is congested right now. Try again in a few seconds.',
  WouldExceedMaxBlockCostLimit: 'The network is congested right now. Try again in a few seconds.',
}

const runtimeName = (err) => {
  if (typeof err === 'string') return err
  const ix = err?.InstructionError?.[1]
  return typeof ix === 'string' ? ix : Object.keys(err ?? {})[0]
}

// A failed Solana transaction or simulation → a user sentence, or null when nothing is recognized.
// The innermost failing program owns the error code: a failed CPI aborts the whole transaction, so outer programs
// only repeat it.
export function chainError(logs = [], err = null) {
  logs = Array.isArray(logs) ? logs : []
  if (logs.some((l) => /insufficient lamports/i.test(l))) return NO_SOL
  if (logs.some((l) => /exceeded CUs meter|computational budget exceeded/i.test(l)))
    return RUNTIME.ComputationalBudgetExceeded
  for (const line of logs) {
    const m = /^Program (\w+) failed: custom program error: 0x([0-9a-f]+)/i.exec(line)
    if (!m) continue
    const known = PROGRAMS[m[1]]?.(parseInt(m[2], 16))
    if (known) return known
    break
  }
  // Any Anchor program (Orca, Raydium, ...) logs its error name and message.
  const anchor = logs.find((l) => /AnchorError/.test(l))
  if (anchor) {
    if (/slippage|TooLittle|Subceeded|MinimumOut|minimum.*out|exceeds desired slippage/i.test(anchor)) return SLIPPAGE
    const msg = /Error Message: (.+?)\.?$/.exec(anchor)?.[1]
    if (msg) return `The transaction was refused on-chain: ${sentence(msg)}`
  }
  if (logs.some((l) => /Error: insufficient funds/i.test(l))) return BALANCE
  const custom = err?.InstructionError?.[1]?.Custom
  if (custom === 1 && logs.length === 0) return BALANCE // ponytail: no logs means no program id, assumes the token program
  return RUNTIME[runtimeName(err)] ?? null
}

// RPC / network hiccups: worth a "try again in a few seconds", never a scary error.
const TRANSIENT =
  /-3200[4579]|Block not available|\b429\b|Too Many Requests|rate.?limit|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|\b50[234]\b|Bad Gateway|Service Unavailable|blockhash not found|node is behind|Unable to complete request|temporarily unavailable|provider is busy/i
export const isTransient = (error) =>
  TRANSIENT.test(`${error?.message ?? ''} ${error?.context?.__code ?? ''} ${error?.cause?.message ?? ''}`)

// The last stop for an unexpected error: a readable reason when one is recognizable, otherwise a short reference the
// logs can be searched for. Details stay in the logs (RPC errors can carry provider info).
export function explain(
  error,
  scope,
  fallback,
  busy = 'The Solana network connection is busy right now. Try again in a few seconds.',
) {
  const chain = chainError(error?.context?.logs ?? error?.logs, error?.context?.err ?? error?.err)
  if (chain) return { status: 409, error: chain }
  if (isTransient(error)) {
    console.warn(`[${scope}] transient`, error?.message)
    return { status: 503, error: busy }
  }
  const ref = randomBytes(3).toString('hex').toUpperCase()
  console.error(`[${scope}] ref ${ref}`, error)
  return { status: 502, error: `${fallback} (ref ${ref})`, ref }
}
