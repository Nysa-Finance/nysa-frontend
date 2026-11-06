// Transaction builder: the browser asks for an action, the server builds it with klend-sdk against the market cache,
// simulates it, and returns it unsigned. The wallet signs and sends it (signAndSendTransaction); the server never
// holds keys. First-time setup (Kamino user accounts) or oversized transactions come back in two steps: the client
// sends the setup transaction, waits for it, then asks again and gets the action itself (`final: true`).
import Decimal from 'decimal.js'
import { KaminoAction, KaminoVault, U64_MAX, PROGRAM_ID, obligationFarmStatePda } from '@kamino-finance/klend-sdk'
import {
  address, createNoopSigner, pipe, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables, compileTransaction, getTransactionEncoder,
  getBase64EncodedWireTransaction, getTransactionDecoder, fetchEncodedAccounts,
} from '@solana/kit'
import { createRequire } from 'node:module'
import { LIVE, marketById, vaultById, tokensOf, tok } from '../src/config.js'
import { floorTo } from '../src/logic.js'
import { rpc, NONE } from './rpc.js'
import { getLive, getVault, reserveOf, farms, refreshSoon, refreshMarketForExecution } from './market.js'
import { vaultClient } from './vault.js'
import { obligationType, pendingRewards, ataOf, vaultShares, maxWithdrawFromObligation, maxOf } from './account.js'
import { noteBuilt, noteRelayed, relayRefusal, confirmedHere } from './relay.js'
import { confirmedTokenDeltas } from './token-deltas.js'
import { assertRawWithdrawalWithinAllowance, requestedTokenBaseUnits, requestedWithdrawalBaseUnits } from './withdrawal.js'
import { relaySignedTransaction } from './send-safety.js'

const require = createRequire(import.meta.url)
const klendErrors = require('@kamino-finance/klend-sdk/dist/@codegen/klend/errors/custom.js')
const { decodeUserState } = require('@kamino-finance/farms-sdk')

const MAX_TX_BYTES = 1232
const SPLIT_ABOVE = 1100 // leave wallet headroom (Phantom adds a guard instruction)
const safeSlotNumber = (value) => typeof value === 'bigint'
  ? value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
  : Number.isSafeInteger(value) && value >= 0 ? value : null
// Setup instructions that can run in their own transaction before the lending one.
const SEPARABLE = /^(CreateUserAta(?!SOL)|CreateLiquidityUserAta|CreateCollateralUserAta|CreateAdditionalUserTokenAta|CreateAta|createAtasIxs|createUserLutIx|initUserMetadata|InitObligation(?!ForFarm))/
const BOOTSTRAP = /^(createUserLutIx|initUserMetadata|InitObligation(?!ForFarm))/
export const KINDS = ['deposit', 'withdraw', 'borrow', 'repay', 'claim', 'liquidate', 'vault-deposit', 'vault-withdraw', 'loop-open', 'loop-close', 'loop-setup']
const BUILDERS = {
  deposit: (p) => KaminoAction.buildDepositTxns(p),
  withdraw: (p) => KaminoAction.buildWithdrawTxns(p),
  borrow: (p) => KaminoAction.buildBorrowTxns(p),
  repay: (p) => KaminoAction.buildRepayTxns(p),
}

// Lookup tables only grow, so a cached copy stays valid for a while.
const lutCache = new Map() // address -> { at, addresses }
async function fetchLuts(luts) {
  const out = {}
  const missing = (luts ?? []).filter((l) => { const c = lutCache.get(String(l)); return !c || Date.now() - c.at > 600_000 })
  if (missing.length) {
    const { value } = await rpc.getMultipleAccounts(missing, { encoding: 'jsonParsed', commitment: 'confirmed' }).send()
    value.forEach((acc, i) => lutCache.set(String(missing[i]), { at: Date.now(), addresses: acc?.data?.parsed?.info?.addresses?.map(address) ?? [] }))
  }
  for (const l of luts ?? []) { const a = lutCache.get(String(l)).addresses; if (a.length) out[l] = a }
  return out
}

// ---- compute budget: ours, sized from the simulation, so wallets don't replace it ----
// A transaction without a priority fee gets the wallet's own budget: some set the compute limit to exactly what their
// simulation used (e.g. 135,664 for 135,643), and a borrow that needs a little more at execution fails with
// "exceeded CUs meter". Every transaction we build carries a limit with a margin and a priority fee instead.
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const MAX_CU = 1_400_000 // Solana's per-transaction maximum: the first simulation never runs out
const cuWithMargin = (used) => Math.min(MAX_CU, Math.ceil(used * 1.3) + 20_000)
const budgetIx = (data) => ({ programAddress: address(COMPUTE_BUDGET), accounts: [], data })
function cuLimitIx(units) { const d = new Uint8Array(5); d[0] = 2; new DataView(d.buffer).setUint32(1, units, true); return budgetIx(d) }
function cuPriceIx(microLamports) { const d = new Uint8Array(9); d[0] = 3; new DataView(d.buffer).setBigUint64(1, BigInt(microLamports), true); return budgetIx(d) }

// Priority fee in micro-lamports per compute unit: the 75th percentile of what recent transactions writing our reserves
// paid, within [PRIORITY_MIN, PRIORITY_MAX]. Cached 30 s. (300k CU at 10,000 = 3,000 lamports, 0.000003 SOL.)
const PRIORITY_MIN = 10_000, PRIORITY_MAX = 1_000_000
let fee = { at: 0, value: PRIORITY_MIN }
async function priorityFee() {
  if (Date.now() - fee.at < 30_000) return fee.value
  try {
    const recent = await rpc.getRecentPrioritizationFees(LIVE.flatMap((m) => tokensOf(m).map((t) => address(t.reserve)))).send()
    const paid = recent.map((f) => Number(f.prioritizationFee)).filter((f) => f > 0).sort((a, b) => a - b)
    fee = { at: Date.now(), value: Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, paid[Math.floor(paid.length * 0.75)] ?? 0)) }
  } catch (e) { console.warn('[tx] priority fee', e?.message); fee = { at: Date.now(), value: fee.value } }
  return fee.value
}

// Any compute-budget instruction in `ixs` (klend-sdk adds one) is replaced by ours: `units` limit + priority fee.
// The result can be rebuilt with another limit (`withLimit`), which simulated() does once it knows the real usage.
async function compile(owner, ixs, luts, units = MAX_CU) {
  const body = ixs.filter((ix) => String(ix.programAddress) !== COMPUTE_BUDGET)
  const [{ context, value: blockhash }, price] = await Promise.all([rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(), priorityFee()])
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([cuLimitIx(units), cuPriceIx(price), ...body], m),
    (m) => (Object.keys(luts).length ? compressTransactionMessageUsingAddressLookupTables(m, luts) : m),
  )
  const tx = compileTransaction(msg)
  const encoded = getTransactionEncoder().encode(tx)
  return {
    size: encoded.length,
    tx: getBase64EncodedWireTransaction(tx),
    messageBytes: getTransactionDecoder().decode(encoded).messageBytes,
    minContextSlot: Number(context.slot),
    withLimit: (u) => compile(owner, ixs, luts, u),
  }
}

/** Compile a caller-provided instruction group as one bounded v0 transaction with confirmed lookup-table state. */
export async function compileAtomicTransaction({ wallet, instructions, lookupTables = [] } = {}) {
  if (typeof wallet !== 'string' || !Array.isArray(instructions) || !instructions.length || !Array.isArray(lookupTables)) {
    throw new UserError('Invalid atomic transaction inputs.')
  }
  const addresses = lookupTables.map((table) => typeof table === 'string' ? table : String(table?.address ?? ''))
  if (addresses.some((table) => !table)) throw new UserError('Atomic transaction has an invalid lookup-table address.')
  const compiled = await compile(address(wallet), instructions, await fetchLuts([...new Set(addresses)]))
  if (compiled.size > MAX_TX_BYTES) throw new UserError(`Atomic transaction is ${compiled.size} bytes, over Solana's ${MAX_TX_BYTES}-byte limit`)
  return compiled
}

const tokenAccountRawAmount = (data) => data instanceof Uint8Array && data.length >= 72
  ? new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true)
  : 0n

/** Simulate one already-compiled atomic instruction group and return exact requested post-state token deltas. */
export async function simulateAtomicTransaction({ compiled, accounts = [], tokenAccounts = [] } = {}) {
  if (!rpc || typeof compiled?.tx !== 'string' || !Array.isArray(accounts) || !Array.isArray(tokenAccounts)) {
    throw new UserError('Atomic transaction simulation inputs are unavailable.')
  }
  const tracked = [...new Set([...accounts, ...tokenAccounts.map((item) => item?.account)].filter(Boolean).map(String))]
  if (tracked.length > 100) throw new UserError('Atomic transaction tracks too many simulation accounts.')
  const addresses = tracked.map(address)
  const before = addresses.length ? await fetchEncodedAccounts(rpc, addresses, { commitment: 'confirmed' }) : []
  const { value } = await rpc.simulateTransaction(compiled.tx, {
    encoding: 'base64', sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true,
    ...(addresses.length ? { accounts: { addresses, encoding: 'base64' } } : {}),
  }).send()
  if (value.err) simulationError(value.logs ?? [])
  const accountData = new Map(tracked.map((key, index) => {
    const encoded = value.accounts?.[index]?.data?.[0]
    return [key, typeof encoded === 'string' ? Uint8Array.from(Buffer.from(encoded, 'base64')) : null]
  }))
  const accountOwners = new Map(tracked.map((key, index) => [key, value.accounts?.[index]?.owner ?? null]))
  const tokenDeltas = tokenAccounts.map((item) => {
    const key = String(item.account)
    const index = tracked.indexOf(key)
    const prior = before[index]?.exists ? tokenAccountRawAmount(before[index].data) : 0n
    const after = tokenAccountRawAmount(accountData.get(key))
    return { account: key, mint: String(item.mint), deltaBaseUnits: String(after - prior) }
  })
  return { ok: true, accountData, accountOwners, tokenDeltas }
}

const LIQ_SLIPPAGE = 0.01 // the built liquidation must pay out at least 99% of the collateral its simulation received

// Simulate before handing it to the wallet, so a failing transaction surfaces as a readable error instead of a
// wallet warning (and is never sent).
// Then the compute limit is set from what the simulation used, with a margin.
async function simulated(compiled) {
  if (compiled.size > MAX_TX_BYTES) throw new UserError(`Transaction is ${compiled.size} bytes, over Solana's ${MAX_TX_BYTES}-byte limit`)
  const { value } = await rpc.simulateTransaction(compiled.tx, { encoding: 'base64', sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true }).send()
  if (value.err) simulationError(value.logs ?? [], value.err)
  const used = Number(value.unitsConsumed ?? 0)
  const { withLimit, ...tuned } = used > 0 ? await compiled.withLimit(cuWithMargin(used)) : compiled
  return tuned
}
// The wallet pays network fees and new accounts' rent in SOL, even for a USDC action: without SOL the simulation fails
// before any program runs (no log to show), or when creating the first token account ("insufficient lamports").
const NO_SOL = 'This wallet needs a little SOL for Solana network fees and new account rent: add about 0.01 SOL (0.05 before a first supply or borrow) and try again.'
const NO_SOL_ERRORS = ['AccountNotFound', 'InsufficientFundsForFee', 'InsufficientFundsForRent']
// Kamino lending errors users hit, in plain words; any other klend error shows its SDK message.
const KLEND_ERRORS = {
  6008: 'There isn\'t enough liquidity in this market for that amount right now.',
  6011: 'That\'s more than you can withdraw right now: your loan needs this collateral. Try a smaller amount.',
  6013: 'That\'s above your borrow limit right now (prices and interest move every block). Try a slightly smaller amount.',
  6093: 'That would bring your loan closer to liquidation than Kamino allows. Try a smaller amount.',
  6119: 'That would make your loan liquidatable. Try a smaller amount.',
}
function simulationError(logs, err) {
  const code = typeof err === 'string' ? err : Object.keys(err ?? {})[0]
  if (NO_SOL_ERRORS.includes(code) || logs.some((l) => /insufficient lamports/i.test(l))) throw new UserError(NO_SOL)
  if (logs.some((l) => /ObligationHealthy|healthy and cannot be liquidated/i.test(l))) throw new UserError('This loan is healthy again (or was just liquidated), so it can\'t be liquidated right now.')
  const failed = [...logs].reverse().find((l) => / failed: custom program error: 0x/.test(l))
  if (failed?.startsWith(`Program ${PROGRAM_ID} `)) {
    const n = parseInt(failed.split('0x')[1], 16)
    const msg = KLEND_ERRORS[n] ?? klendErrors.fromCode(n)?.msg
    if (msg) throw new UserError(msg)
  }
  const hint = [...logs].reverse().find((l) => /Error Message|failed|insufficient/i.test(l))
  throw new UserError(`Simulation failed${hint ? ': ' + hint.replace(/^Program log: /, '') : ''}`)
}

// Token amounts (raw u64) of some token accounts after a simulated transaction; a missing account counts as 0.
async function simulatedBalances(compiled, accounts) {
  if (compiled.size > MAX_TX_BYTES) throw new UserError(`Transaction is ${compiled.size} bytes, over Solana's ${MAX_TX_BYTES}-byte limit`)
  const { value } = await rpc.simulateTransaction(compiled.tx, {
    encoding: 'base64', sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true,
    accounts: { addresses: accounts, encoding: 'base64' },
  }).send()
  if (value.err) simulationError(value.logs ?? [], value.err)
  return value.accounts.map((a) => (a ? Buffer.from(a.data[0], 'base64').readBigUInt64LE(64) : 0n))
}

// Errors safe to show the user as-is (anything else becomes a generic message).
export class UserError extends Error {}

async function lending(kind, owner, m, t, amount, all, amountBaseUnits) {
  const { market, now } = getLive(m)
  const reserve = reserveOf(market, t)
  const ob = await market.getObligationByWallet(owner, obligationType())
  if (kind !== 'deposit' && !ob) throw new UserError('No Kamino position found for this wallet in this market')
  if (!all && kind === 'borrow') {
    const max = maxOf('borrow', ob, market, reserve, now)
    if (max != null && amount > max) {
      const fits = `${floorTo(max, t.decimals)} ${t.name}`
      throw new UserError(`That's above your borrow limit: you can borrow up to ${fits} right now.`)
    }
  }
  let base
  if (kind === 'withdraw') {
    const suppliedScaled = String(ob.getDepositByReserve(reserve.address)?.amount ?? '0')
    const maxWithdraw = maxWithdrawFromObligation({
      obligation: ob,
      market,
      reserve,
      instant: now,
      suppliedAmountScaled: suppliedScaled,
      mintFactor: String(reserve.getMintFactor()),
      decimals: reserve.stats.decimals,
    })
    let requested
    try { requested = all ? maxWithdraw : requestedWithdrawalBaseUnits({ amountBaseUnits, amount, decimals: reserve.stats.decimals }) }
    catch (error) { throw new UserError(error.message || 'Invalid withdrawal amount.') }
    try { base = assertRawWithdrawalWithinAllowance(requested, maxWithdraw) }
    catch (error) { throw new UserError(error.message) }
  } else {
    if (all) base = U64_MAX
    else if (kind === 'deposit' && amountBaseUnits != null) {
      try { base = requestedTokenBaseUnits({ amountBaseUnits, decimals: reserve.stats.decimals }) }
      catch (error) { throw new UserError(error.message || 'Invalid deposit amount.') }
    } else base = new Decimal(String(amount)).mul(new Decimal(10).pow(reserve.stats.decimals)).floor().toFixed()
  }
  const axn = await BUILDERS[kind]({
    kaminoMarket: market, amount: base, reserveAddress: reserve.address, owner: createNoopSigner(owner),
    obligation: ob ?? obligationType(), useV2Ixs: true, scopeRefreshConfig: undefined, currentLedgerInstant: now,
    // The per-user lookup table only serves Kamino leverage flows; skipping it keeps first-time setup to plain
    // ATA + metadata + obligation init (fewer programs for wallet simulators, less rent for the user).
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
  })
  const luts = await fetchLuts(axn.luts)
  const whole = await compile(owner, KaminoAction.actionToIxs(axn), luts)
  const bootstrap = axn.setupIxsLabels.some((l) => BOOTSTRAP.test(l))
  if (!bootstrap && whole.size <= SPLIT_ABOVE) return { ...(await simulated(whole)), final: true }

  // First-time setup or too big: the separable setup goes first, on its own; the client then asks again.
  const setup = axn.setupIxs.filter((_, i) => SEPARABLE.test(axn.setupIxsLabels[i] ?? ''))
  if (!setup.length) return { ...(await simulated(whole)), final: true }
  return { ...(await simulated(await compile(owner, [...axn.computeBudgetIxs, ...setup], luts))), final: false }
}

async function claim(owner, m) {
  const { market, farms: farmStates } = getLive(m)
  const ob = await market.getObligationByWallet(owner, obligationType())
  if (!ob) throw new UserError('No Kamino position found for this wallet in this market')
  const farmAddrs = [...farmStates.keys()]
  const accounts = await fetchEncodedAccounts(rpc, await Promise.all(farmAddrs.map((f) => obligationFarmStatePda(address(f), ob.obligationAddress))))
  const pending = pendingRewards(farmStates, farmAddrs.map((f, i) => [f, accounts[i].exists ? decodeUserState(accounts[i]).data : null]))
  if (!pending.length) throw new UserError('No rewards to claim yet')
  const ixs = []
  for (const p of pending) {
    const [atas, harvest] = await farms.claimForUserForFarmRewardIx(createNoopSigner(owner), address(p.farm), address(p.mint), true, p.index, [ob.obligationAddress])
    ixs.push(...atas.map(([, ix]) => ix), ...harvest)
  }
  return { ...(await simulated(await compile(owner, ixs, {}))), final: true }
}

// ---- liquidation: repay part of an unhealthy loan's debt, receive its collateral plus a bonus ----
// ponytail: one collateral/debt pair per market (the live one); pick the pair from the request with a second pair.
const pairOf = (m) => ({ debt: tok(m.pairs[0].liability), coll: tok(m.pairs[0].collateral) })

// How much of a loan can be liquidated now, following Kamino's rules (liquidation_operations.rs): up to the market's
// close factor of the debt (all of it past the insolvency-risk LTV), capped per transaction; a loan worth less than
// the full-liquidation threshold must be repaid in full.
export async function liquidationInfo(m, borrower) {
  const { market } = getLive(m)
  const { debt, coll } = pairOf(m)
  const ob = await market.getObligationByWallet(address(borrower), obligationType())
  return liquidationLimits(market, ob, reserveOf(market, debt), debt, coll)
}
function liquidationLimits(market, ob, repay, debt, coll) {
  const pos = ob?.getBorrowByReserve(repay.address)
  if (!pos || pos.amount.lte(0)) throw new UserError('This wallet has no open loan in this market')
  const s = ob.refreshedStats, ms = market.state
  const ltv = s.loanToValue.toNumber(), liqLtv = s.liquidationLtv.toNumber()
  const debtUsd = pos.marketValueRefreshed.toNumber(), borrowed = pos.amount.toNumber() / 10 ** debt.decimals
  const closeFactor = ltv * 100 > ms.insolvencyRiskUnhealthyLtvPct ? 1 : ms.liquidationMaxDebtCloseFactorPct / 100
  const maxUsd = Math.min(s.userTotalBorrow.toNumber() * closeFactor, debtUsd, Number(ms.maxLiquidatableDebtMarketValueAtOnce))
  const fullOnly = debtUsd < Number(ms.minFullLiquidationValueThreshold)
  return {
    liquidatable: ltv >= liqLtv && liqLtv > 0,
    hf: ltv > 0 ? liqLtv / ltv : null,
    debt: borrowed, debtToken: debt.name, collToken: coll.name,
    maxRepay: fullOnly ? borrowed : borrowed * (debtUsd > 0 ? maxUsd / debtUsd : 0),
    fullOnly,
  }
}

// Builds the liquidation, simulates it to read what the liquidator really pays and receives, then rebuilds it with a
// minimum collateral payout (simulated amount − 1%) so a last-second price move can't pay out less.
// preview: only the quote, no transaction.
async function liquidate(liquidator, m, borrower, amount, preview) {
  const { market, now } = getLive(m)
  const { debt, coll } = pairOf(m)
  const repay = reserveOf(market, debt), withdraw = reserveOf(market, coll)
  const ob = await market.getObligationByWallet(address(borrower), obligationType())
  if (!ob?.getBorrowByReserve(repay.address)?.amount.gt(0)) throw new UserError('This wallet has no open loan in this market')
  const base = new Decimal(amount).mul(new Decimal(10).pow(debt.decimals)).floor().toFixed()
  const make = async (min) => {
    const axn = await KaminoAction.buildLiquidateTxns({
      kaminoMarket: market, amount: base, minCollateralReceiveAmount: String(min),
      repayReserveAddress: repay.address, withdrawReserveAddress: withdraw.address,
      liquidator: createNoopSigner(liquidator), obligationOwner: address(borrower), obligation: ob,
      useV2Ixs: true, currentLedgerInstant: now, initUserMetadata: { skipInitialization: true, skipLutCreation: true },
    })
    return compile(liquidator, KaminoAction.actionToIxs(axn), await fetchLuts(axn.luts))
  }
  const atas = await Promise.all([ataOf(liquidator, address(debt.mint), repay.getLiquidityTokenProgram()), ataOf(liquidator, address(coll.mint), withdraw.getLiquidityTokenProgram())])
  const accounts = await fetchEncodedAccounts(rpc, atas, { commitment: 'confirmed' }) // same commitment as the simulation
  const before = accounts.map((a) => (a.exists ? Buffer.from(a.data).readBigUInt64LE(64) : 0n))
  const after = await simulatedBalances(await make(0), atas)
  const paid = before[0] - after[0], received = after[1] - before[1]
  if (received <= 0n) throw new UserError('This liquidation would not pay out any collateral')
  const quote = { repaid: Number(paid) / 10 ** debt.decimals, received: Number(received) / 10 ** coll.decimals, debtToken: debt.name, collToken: coll.name }
  if (preview) return { quote }
  const min = (received * BigInt(Math.round((1 - LIQ_SLIPPAGE) * 1e4))) / 10_000n
  return { ...(await simulated(await make(min))), final: true, quote }
}

// Validated request -> { tx: base64 unsigned v0 transaction, minContextSlot, final }. The wallet is noted (relay.js), so
// /api/tx/send only relays for wallets that asked for a transaction.
export async function buildTx(req) {
  const built = await build(req)
  noteBuilt(req.wallet)
  return built
}

// ---- Earn vaults (kVaults): deposit the vault's token for shares, withdraw by redeeming shares ----
const VAULT_SLIPPAGE = 0.005 // a deposit must mint at least 99.5% of the shares the current share value gives

async function vaultAction(kind, owner, v, amount, all) {
  const live = getVault(v.id)
  const { kv, state, reserves, perShare, now, farm } = live
  const signer = createNoopSigner(owner)
  const luts = await fetchLuts(String(state.vaultLookupTable) === NONE ? [] : [state.vaultLookupTable])
  const shareDp = Number(state.sharesMintDecimals)
  if (kind === 'vault-deposit') {
    // As the program prices it: share value including vested rewards, minus the crank funds taken from the deposit.
    const minShares = vaultClient.estimateSharesFromTokens(state, new Decimal(amount), now, reserves, VAULT_SLIPPAGE * 10_000).toDecimalPlaces(shareDp, Decimal.ROUND_DOWN)
    const d = await vaultClient.depositIxs(signer, kv, new Decimal(amount), reserves, null, null, undefined, undefined, minShares)
    const deposit = [...d.depositIxs, ...d.stakeInFarmIfNeededIxs]
    // Then invest what the vault holds into its reserves, so deposits earn right away: Kamino's crank does this for
    // vaults listed in its UI; until then this is the fallback. `invest` lets the program size each reserve's amount
    // on-chain, after the deposit (investAllReservesIxs sizes it from the state before, and fails). The SDK only emits
    // an invest when it sees tokens to move, so it is shown the vault as it is after the deposit: from the state
    // before, a vault already on target would get none and the deposit would sit idle. Dropped if it doesn't fit or
    // fails to simulate.
    const after = Object.assign(Object.create(Object.getPrototypeOf(state)), state, {
      tokenAvailable: state.tokenAvailable.add(new state.tokenAvailable.constructor(new Decimal(amount).mul(10 ** Number(state.tokenMintDecimals)).floor().toFixed())), // BN, as decoded
    })
    const kvAfter = KaminoVault.loadWithClientAndState(vaultClient, kv.address, after)
    const invest = []
    try {
      for (const [a, r] of reserves) invest.push(...await vaultClient.investSingleReserveIxs(signer, kvAfter, { address: a, state: r.state }, reserves))
    } catch (e) { console.warn('[vault] invest ixs', e?.message); invest.length = 0 }
    if (invest.length) {
      const both = await compile(owner, [...deposit, ...invest], luts)
      if (both.size <= SPLIT_ABOVE) {
        try { return { ...(await simulated(both)), final: true, invested: true } } catch (e) { console.warn('[vault] deposit + invest failed to simulate, deposit only:', e?.message) }
      }
    }
    return { ...(await simulated(await compile(owner, deposit, luts))), final: true, invested: false }
  }
  // Withdraw: the shares worth `amount` (or all of them), capped at what the wallet holds, in its wallet and staked in
  // the vault farm (deposits made on Kamino's UI); klend-sdk unstakes what the wallet lacks in the same transaction.
  const { wallet, staked } = (await vaultShares(live, [String(owner)], { commitment: 'confirmed' })).get(String(owner))
  const held = new Decimal(wallet).add(staked).toDecimalPlaces(shareDp, Decimal.ROUND_DOWN)
  if (held.lte(0)) throw new UserError('You have no shares in this vault')
  const wanted = all ? held : Decimal.min(held, new Decimal(amount).div(perShare.toString()).toDecimalPlaces(shareDp, Decimal.ROUND_UP))
  const w = await vaultClient.withdrawIxs(signer, kv, wanted, now, reserves, staked > 0 ? farm?.state ?? null : null, null)
  return { ...(await simulated(await compile(owner, [...w.unstakeFromFarmIfNeededIxs, ...w.withdrawIxs, ...w.postWithdrawIxs], luts))), final: true }
}

async function build({ kind, wallet, market: marketId, token: tokenId, amount, amountBaseUnits, all, borrower, preview, vault: vaultId }) {
  if (kind === 'loop-open' || kind === 'loop-close') {
    throw new UserError('Loop transaction building is unavailable until atomic route, fee, fork and wallet evidence passes.')
  }
  const owner = address(wallet)
  const validAmount = (value) => {
    try { const decimal = new Decimal(String(value)); return decimal.isFinite() && decimal.gt(0) }
    catch { return false }
  }
  if (kind.startsWith('vault-')) {
    const v = vaultById(vaultId)
    if (!v) throw new UserError('Unknown vault')
    if (!all && !validAmount(amount)) throw new UserError('Invalid amount')
    if (kind === 'vault-deposit' && all) throw new UserError('Invalid amount')
    return vaultAction(kind, owner, v, amount, !!all)
  }
  const m = marketById(marketId)
  if (!m?.kaminoMarket) throw new UserError('Unknown market')
  if (kind === 'claim') return claim(owner, m)
  if (kind === 'liquidate') {
    if (!validAmount(amount)) throw new UserError('Invalid amount')
    return liquidate(owner, m, borrower, amount, preview)
  }
  const t = tokensOf(m).find((x) => x.token_id === tokenId)
  if (!t) throw new UserError('Unknown token for this market')
  if (!all && !(kind === 'withdraw' && amountBaseUnits != null)
    && !(kind === 'deposit' && amountBaseUnits != null) && !validAmount(amount)) throw new UserError('Invalid amount')
  if (kind === 'withdraw') await refreshMarketForExecution()
  return lending(kind, owner, m, t, amount, !!all, amountBaseUnits)
}

// Wallets reached by deeplink (Phantom/Solflare on iOS) sign but don't send: relay the signed transaction, only when
// it is that wallet's own, with screened signers and allowed programs (relay.js).
export async function sendSigned({ tx, wallet, approvedProgramIds = [], intentStore, intentId, requireIntent = false }) {
  return relaySignedTransaction({
    tx,
    wallet,
    refuse: (signed, owner) => relayRefusal(signed, owner, { approvedProgramIds, intentStore, intentId, requireIntent }),
    send: async (signed) => {
      try { return await rpc.sendTransaction(signed, { encoding: 'base64', preflightCommitment: 'confirmed' }).send() }
      catch (error) { console.error('[tx] send outcome unknown', error); throw error }
    },
    onSuccess: noteRelayed,
  })
}

/** Resolve a signature from the recent status cache, then durable transaction history after a cache miss. */
export async function resolveTransactionStatus(signature, {
  getSignatureStatuses,
  getTransaction,
  onConfirmed = async () => {},
} = {}) {
  if (typeof signature !== 'string' || !signature
    || typeof getSignatureStatuses !== 'function' || typeof getTransaction !== 'function' || typeof onConfirmed !== 'function') {
    throw new TypeError('Transaction status reconciliation requires a signature and RPC functions.')
  }
  const recent = await getSignatureStatuses([signature])
  let s = recent?.value?.[0] ?? null
  if (!s) {
    let historical
    try { historical = await getSignatureStatuses([signature], { searchTransactionHistory: true }) }
    catch { return { status: 'pending' } }
    s = historical?.value?.[0] ?? null
  }
  if (!s) return { status: 'pending' }
  if (s.err) return { status: 'failed', error: JSON.stringify(s.err, (_, v) => (typeof v === 'bigint' ? String(v) : v)) }
  if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
    Promise.resolve().then(() => onConfirmed(signature)).catch((e) => console.error('[tx] confirmation lookup failed', e?.message))
    let tokenDeltas = null
    let transactionSlot = null
    try {
      const transaction = await getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
      if (transaction?.meta) tokenDeltas = confirmedTokenDeltas(transaction.meta)
      transactionSlot = safeSlotNumber(transaction?.slot)
    } catch { /* confirmation remains visible; token-derived follow-up stays disabled until the transaction is readable */ }
    return { status: 'confirmed', slot: safeSlotNumber(s.slot), transactionSlot, tokenDeltas }
  }
  return { status: 'pending' }
}

// Confirmation status of a sent transaction. A confirmed one built or relayed here refreshes the market cache for
// everyone (checked in the background, so the status answer doesn't wait for it). Once a signature leaves the
// recent cache, the RPC is asked to search its transaction history before an unknown result is returned.
export async function txStatus(signature) {
  return resolveTransactionStatus(signature, {
    getSignatureStatuses: (signatures, config) => rpc.getSignatureStatuses(signatures, config).send(),
    getTransaction: (sig, config) => rpc.getTransaction(sig, config).send(),
    onConfirmed: async (sig) => { if (await confirmedHere(sig, landed)) refreshSoon() },
  })
}

// Fee payer and block time of a landed transaction; null while this RPC node doesn't have it yet.
async function landed(signature) {
  // Version 1 is Solana's newer transaction format; asking for 0 would make the lookup fail on those.
  const tx = await rpc.getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 }).send()
  return tx && { feePayer: String(tx.transaction.message.accountKeys[0]), blockTime: tx.blockTime == null ? null : Number(tx.blockTime) }
}
