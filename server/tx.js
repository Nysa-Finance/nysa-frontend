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
  getBase64EncodedWireTransaction, fetchEncodedAccounts,
} from '@solana/kit'
import { createRequire } from 'node:module'
import { marketById, tokensOf } from '../src/config.js'
import { rpc } from './rpc.js'
import { getLive, reserveOf, farms, refreshSoon } from './market.js'
import { obligationType, pendingRewards } from './account.js'

const require = createRequire(import.meta.url)
const { decodeUserState } = require('@kamino-finance/farms-sdk')

const MAX_TX_BYTES = 1232
const SPLIT_ABOVE = 1100 // leave wallet headroom (Phantom adds a guard instruction)
// Setup instructions that can run in their own transaction before the lending one.
const SEPARABLE = /^(CreateUserAta(?!SOL)|CreateLiquidityUserAta|CreateCollateralUserAta|CreateAdditionalUserTokenAta|CreateAta|createAtasIxs|createUserLutIx|initUserMetadata|InitObligation(?!ForFarm))/
const BOOTSTRAP = /^(createUserLutIx|initUserMetadata|InitObligation(?!ForFarm))/
export const KINDS = ['deposit', 'withdraw', 'borrow', 'repay', 'claim', 'test']
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

// Simulate before handing it to the wallet, so a failing transaction surfaces as a readable error instead of a
// wallet warning (and is never sent).
async function simulated(compiled) {
  if (compiled.size > MAX_TX_BYTES) throw new UserError(`Transaction is ${compiled.size} bytes, over Solana's ${MAX_TX_BYTES}-byte limit`)
  const { value } = await rpc.simulateTransaction(compiled.tx, { encoding: 'base64', sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true }).send()
  if (value.err) {
    const logs = value.logs ?? []
    const hint = [...logs].reverse().find((l) => /Error Message|failed|insufficient/i.test(l))
    throw new UserError(`Simulation failed${hint ? ': ' + hint.replace(/^Program log: /, '') : ''}`)
  }
  return compiled
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

// TEMPORARY (Phantom warning test, /debug-transfer): 1000 lamports to yourself, to tell a domain-level wallet warning
// from an instruction-level one. Remove with the page.
async function testTransfer(owner) {
  const data = new Uint8Array(12)
  new DataView(data.buffer).setUint32(0, 2, true) // System program instruction 2 = Transfer
  new DataView(data.buffer).setBigUint64(4, 1000n, true) // lamports
  const ix = { programAddress: address('11111111111111111111111111111111'), accounts: [{ address: owner, role: AccountRole.WRITABLE_SIGNER }, { address: owner, role: AccountRole.WRITABLE }], data }
  return { ...(await simulated(await compile(owner, [ix], {}))), final: true }
}

// Validated request -> { tx: base64 unsigned v0 transaction, minContextSlot, final }.
export async function buildTx({ kind, wallet, market: marketId, token: tokenId, amount, all }) {
  const owner = address(wallet)
  if (kind === 'test') return testTransfer(owner)
  const m = marketById(marketId)
  if (!m?.kaminoMarket) throw new UserError('Unknown market')
  if (kind === 'claim') return claim(owner, m)
  const t = tokensOf(m).find((x) => x.token_id === tokenId)
  if (!t) throw new UserError('Unknown token for this market')
  if (!all && !(Number.isFinite(amount) && amount > 0)) throw new UserError('Invalid amount')
  return lending(kind, owner, m, t, amount, !!all)
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
