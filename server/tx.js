// Transaction builder: the browser asks for an action, the server builds it with klend-sdk against the market cache,
// simulates it, and returns it unsigned. The wallet signs and sends it (signAndSendTransaction); the server never
// holds keys. First-time setup (Kamino user accounts) or oversized transactions come back in two steps: the client
// sends the setup transaction, waits for it, then asks again and gets the action itself (`final: true`).
import Decimal from 'decimal.js'
import { KaminoAction, U64_MAX, obligationFarmStatePda } from '@kamino-finance/klend-sdk'
import {
  address, AccountRole, createNoopSigner, pipe, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables, compileTransaction, getTransactionEncoder,
  getBase64EncodedWireTransaction, fetchEncodedAccounts, getTransactionDecoder, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, verifySignature,
} from '@solana/kit'
import { createRequire } from 'node:module'
import { marketById, tokensOf, tok } from '../src/config.js'
import { rpc } from './rpc.js'
import { getLive, reserveOf, farms, refreshSoon } from './market.js'
import { obligationType, pendingRewards, ataOf } from './account.js'

const require = createRequire(import.meta.url)
const { decodeUserState } = require('@kamino-finance/farms-sdk')

const MAX_TX_BYTES = 1232
const SPLIT_ABOVE = 1100 // leave wallet headroom (Phantom adds a guard instruction)
// Setup instructions that can run in their own transaction before the lending one.
const SEPARABLE = /^(CreateUserAta(?!SOL)|CreateLiquidityUserAta|CreateCollateralUserAta|CreateAdditionalUserTokenAta|CreateAta|createAtasIxs|createUserLutIx|initUserMetadata|InitObligation(?!ForFarm))/
const BOOTSTRAP = /^(createUserLutIx|initUserMetadata|InitObligation(?!ForFarm))/
export const KINDS = ['deposit', 'withdraw', 'borrow', 'repay', 'claim', 'liquidate', 'test']
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

async function compile(owner, ixs, luts) {
  const { context, value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => (Object.keys(luts).length ? compressTransactionMessageUsingAddressLookupTables(m, luts) : m),
  )
  const tx = compileTransaction(msg)
  return { size: getTransactionEncoder().encode(tx).length, tx: getBase64EncodedWireTransaction(tx), minContextSlot: Number(context.slot) }
}

const LIQ_SLIPPAGE = 0.01 // the built liquidation must pay out at least 99% of the collateral its simulation received

// Simulate before handing it to the wallet, so a failing transaction surfaces as a readable error instead of a
// wallet warning (and is never sent).
async function simulated(compiled) {
  if (compiled.size > MAX_TX_BYTES) throw new UserError(`Transaction is ${compiled.size} bytes, over Solana's ${MAX_TX_BYTES}-byte limit`)
  const { value } = await rpc.simulateTransaction(compiled.tx, { encoding: 'base64', sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true }).send()
  if (value.err) simulationError(value.logs ?? [])
  return compiled
}
function simulationError(logs) {
  if (logs.some((l) => /ObligationHealthy|healthy and cannot be liquidated/i.test(l))) throw new UserError('This loan is healthy again (or was just liquidated), so it can\'t be liquidated right now.')
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
  if (value.err) simulationError(value.logs ?? [])
  return value.accounts.map((a) => (a ? Buffer.from(a.data[0], 'base64').readBigUInt64LE(64) : 0n))
}

// Errors safe to show the user as-is (anything else becomes a generic message).
export class UserError extends Error {}

async function lending(kind, owner, m, t, amount, all) {
  const { market, now } = getLive(m)
  const reserve = reserveOf(market, t)
  const ob = await market.getObligationByWallet(owner, obligationType())
  if (kind !== 'deposit' && !ob) throw new UserError('No Kamino position found for this wallet in this market')
  const base = all ? U64_MAX : new Decimal(amount).mul(new Decimal(10).pow(reserve.stats.decimals)).floor().toFixed()
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
export function liquidationLimits(market, ob, repay, debt, coll) {
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
  const accounts = await fetchEncodedAccounts(rpc, atas)
  const before = accounts.map((a) => (a.exists ? Buffer.from(a.data).readBigUInt64LE(64) : 0n))
  const after = await simulatedBalances(await make(0), atas)
  const paid = before[0] - after[0], received = after[1] - before[1]
  if (received <= 0n) throw new UserError('This liquidation would not pay out any collateral')
  const quote = { repaid: Number(paid) / 10 ** debt.decimals, received: Number(received) / 10 ** coll.decimals, debtToken: debt.name, collToken: coll.name }
  if (preview) return { quote }
  const min = (received * BigInt(Math.round((1 - LIQ_SLIPPAGE) * 1e4))) / 10_000n
  return { ...(await simulated(await make(min))), final: true, quote }
}

// TEMPORARY (Phantom warning test, /debug-transfer): 1000 lamports to yourself, to tell a domain-level wallet warning
// from an instruction-level one. Remove with the page.
async function testTransfer(owner) {
  const data = new Uint8Array(12)
  new DataView(data.buffer).setUint32(0, 2, true) // System program instruction 2 = Transfer
  new DataView(data.buffer).setBigUint64(4, 1000n, true) // lamports
  const ix = { programAddress: address('11111111111111111111111111111111'), accounts: [{ address: owner, role: AccountRole.WRITABLE_SIGNER }, { address: owner, role: AccountRole.WRITABLE }], data }
  return { ...(await simulated(await compile(owner, [ix], {}))), final: true }
}

// Wallets that just had a transaction built, so /api/tx/send only relays transactions it was asked for.
const recentlyBuilt = new Map() // wallet -> timestamp
const RELAY_WINDOW_MS = 10 * 60_000

// Validated request -> { tx: base64 unsigned v0 transaction, minContextSlot, final }.
export async function buildTx(req) {
  const built = await build(req)
  recentlyBuilt.set(req.wallet, Date.now())
  if (recentlyBuilt.size > 10_000) for (const [w, at] of recentlyBuilt) if (Date.now() - at > RELAY_WINDOW_MS) recentlyBuilt.delete(w)
  return built
}

async function build({ kind, wallet, market: marketId, token: tokenId, amount, all, borrower, preview }) {
  const owner = address(wallet)
  if (kind === 'test') return testTransfer(owner)
  const m = marketById(marketId)
  if (!m?.kaminoMarket) throw new UserError('Unknown market')
  if (kind === 'claim') return claim(owner, m)
  if (kind === 'liquidate') {
    if (!(Number.isFinite(amount) && amount > 0)) throw new UserError('Invalid amount')
    return liquidate(owner, m, borrower, amount, preview)
  }
  const t = tokensOf(m).find((x) => x.token_id === tokenId)
  if (!t) throw new UserError('Unknown token for this market')
  if (!all && !(Number.isFinite(amount) && amount > 0)) throw new UserError('Invalid amount')
  return lending(kind, owner, m, t, amount, !!all)
}

// Wallets reached by deeplink (Phantom/Solflare on iOS) sign but don't send: relay the signed transaction, only when
// its fee payer is the wallet that just asked us to build one and it carries that wallet's valid signature.
export async function sendSigned({ tx, wallet }) {
  const at = recentlyBuilt.get(wallet)
  if (!at || Date.now() - at > RELAY_WINDOW_MS) throw new UserError('Unknown transaction, please try again')
  let messageBytes, signatures, feePayer
  try {
    ;({ messageBytes, signatures } = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64'))))
    feePayer = String(getCompiledTransactionMessageDecoder().decode(messageBytes).staticAccounts[0])
  } catch { throw new UserError('Invalid transaction') }
  const signature = signatures[wallet]
  if (feePayer !== wallet || !signature || !(await verifySignature(await getPublicKeyFromAddress(address(wallet)), signature, messageBytes))) {
    throw new UserError('The transaction is not signed by this wallet')
  }
  try {
    return { signature: await rpc.sendTransaction(tx, { encoding: 'base64', preflightCommitment: 'confirmed' }).send() }
  } catch (e) {
    console.error('[tx] send failed', e)
    throw new UserError(/blockhash/i.test(String(e?.message) + JSON.stringify(e?.context ?? {})) ? 'The transaction expired before it was sent, please try again' : 'The network rejected the transaction, please try again')
  }
}

// Confirmation status of a sent transaction. A confirmed one refreshes the market cache for everyone.
export async function txStatus(signature) {
  const { value } = await rpc.getSignatureStatuses([signature]).send()
  const s = value[0]
  if (!s) return { status: 'pending' }
  if (s.err) return { status: 'failed', error: JSON.stringify(s.err, (_, v) => (typeof v === 'bigint' ? String(v) : v)) }
  if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
    refreshSoon()
    return { status: 'confirmed', slot: Number(s.slot) }
  }
  return { status: 'pending' }
}
