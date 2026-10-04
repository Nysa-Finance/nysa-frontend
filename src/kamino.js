// Kamino Lend integration (lazy-loaded: klend-sdk is heavy).
// Mirrors the original Nysa flow: build with klend-sdk → simulate → sign & send via Wallet Standard → poll confirmation.
import './polyfills.js'
import Decimal from 'decimal.js'
import {
  KaminoAction, VanillaObligation, PROGRAM_ID, U64_MAX, getCurrentLedgerInstant,
} from '@kamino-finance/klend-sdk'
import {
  address, createNoopSigner, pipe, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables, compileTransaction, getTransactionEncoder,
  getBase64EncodedWireTransaction, getBase58Decoder, AccountRole,
} from '@solana/kit'
import { SOLANA_RPC } from './config.js'
import { loadMarket as loadMarketDirect, createRpc } from './loadMarket.js'

const CHAIN = 'solana:mainnet'
const MAX_TX_BYTES = 1232
const SPLIT_ABOVE = 1100 // leave wallet headroom (Phantom adds a guard instruction)
const CONFIRM_TIMEOUT_MS = 90_000
// Setup instructions that can run in their own transaction before the lending one.
const SEPARABLE = /^(CreateUserAta(?!SOL)|CreateLiquidityUserAta|CreateCollateralUserAta|CreateAdditionalUserTokenAta|CreateAta|createAtasIxs|createUserLutIx|initUserMetadata|InitObligation(?!ForFarm))/
const BOOTSTRAP = /^(createUserLutIx|initUserMetadata|InitObligation(?!ForFarm))/

const rpc = createRpc(SOLANA_RPC)
const obligationType = () => new VanillaObligation(PROGRAM_ID)
const loadMarket = (m) => loadMarketDirect(rpc, m) // reserves by address, no getProgramAccounts
const num = (v) => (v == null ? 0 : typeof v === 'number' ? v : v.toNumber())

function reserveOf(market, token) {
  const r = market.getReserveByAddress(address(token.reserve))
  if (!r) throw new Error(`The Kamino market has no ${token.name} reserve`)
  return r
}

// Live reserve metrics (same shape as the REST-derived ones in store.js), read at the current block.
function reserveMetrics(m, t, r, now) {
  const f = num(r.getMintFactor()) || 1
  const price = num(r.getOracleMarketPrice())
  const supplied = num(r.getTotalSupply()) / f
  const borrowed = num(r.getBorrowedAmount()) / f
  return {
    supplyAPR: r.totalSupplyAPY(now) * 100,
    borrowAPR: m.loans.includes(t.token_id) ? r.totalBorrowAPY(now) * 100 : null,
    totalSupplied: supplied,
    totalBorrowed: borrowed,
    supplyUsd: supplied * price,
    borrowUsd: borrowed * price,
    utilization: r.calculateUtilizationRatio() * 100,
    availableLiquidity: num(r.getLiquidityAvailableAmount()) / f,
    price,
    maxLtv: r.stats.loanToValue * 100,
  }
}

// Per-token position for the wallet (supplied, borrowed, maxWithdraw in token units) plus live reserve metrics.
export async function loadPositions(m, tokens, owner) {
  const [market, now] = await Promise.all([loadMarket(m), getCurrentLedgerInstant(rpc)])
  const ob = await market.getObligationByWallet(address(owner), obligationType())
  const out = {}
  const reserves = {}
  for (const t of tokens) {
    const r = reserveOf(market, t)
    reserves[t.token_id] = reserveMetrics(m, t, r, now)
    const f = num(r.getMintFactor()) || 1
    const supplied = ob ? num(ob.getDepositByReserve(r.address)?.amount) / f : 0
    const borrowed = ob ? num(ob.getBorrowByReserve(r.address)?.amount) / f : 0
    let maxWithdraw = supplied
    if (ob && supplied > 0) {
      try { maxWithdraw = Math.min(num(ob.getMaxWithdrawAmount(market, r.address, now).maxWithdrawAmount) / f, supplied) } catch { /* keep supplied */ }
    }
    out[t.token_id] = { supplied, borrowed, maxWithdraw }
  }
  return { positions: out, reserves }
}

async function fetchLuts(luts) {
  if (!luts?.length) return {}
  const { value } = await rpc.getMultipleAccounts(luts, { encoding: 'jsonParsed', commitment: 'confirmed' }).send()
  const out = {}
  value.forEach((acc, i) => {
    const addrs = acc?.data?.parsed?.info?.addresses
    if (addrs?.length) out[luts[i]] = addrs.map(address)
  })
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
  return { bytes: new Uint8Array(getTransactionEncoder().encode(tx)), wire: getBase64EncodedWireTransaction(tx), slot: Number(context.slot) }
}

// Simulate first so program errors surface with a readable message instead of a wallet warning.
async function simulate(wire) {
  const { value } = await rpc.simulateTransaction(wire, { encoding: 'base64', sigVerify: false, commitment: 'confirmed', replaceRecentBlockhash: true }).send()
  if (!value.err) return
  const logs = value.logs ?? []
  console.error('[kamino] simulation failed', value.err, logs)
  const hint = [...logs].reverse().find((l) => /Error Message|failed|insufficient/i.test(l))
  throw new Error(`Simulation failed${hint ? ': ' + hint.replace(/^Program log: /, '') : ''}`)
}

async function confirm(signature) {
  const until = Date.now() + CONFIRM_TIMEOUT_MS
  while (Date.now() < until) {
    const { value } = await rpc.getSignatureStatuses([signature]).send()
    const s = value[0]
    if (s?.err) throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(s.err, (_, v) => (typeof v === 'bigint' ? String(v) : v))}`)
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return Number(s.slot)
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`Transaction ${signature} was not confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s`)
}

async function signSendConfirm(wallet, account, compiled, minContextSlot = 0) {
  await simulate(compiled.wire)
  const feature = wallet.features['solana:signAndSendTransaction']
  if (!feature) throw new Error(`${wallet.name} cannot sign Solana transactions`)
  const [{ signature }] = await feature.signAndSendTransaction({
    account, chain: CHAIN, transaction: compiled.bytes,
    options: { preflightCommitment: 'confirmed', minContextSlot: Math.max(compiled.slot, minContextSlot) },
  })
  const sig = getBase58Decoder().decode(signature)
  return { signature: sig, slot: await confirm(sig) }
}

async function send(wallet, account, owner, axn) {
  let luts = await fetchLuts(axn.luts)
  const whole = await compile(owner, KaminoAction.actionToIxs(axn), luts)
  const bootstrap = axn.setupIxsLabels.some((l) => BOOTSTRAP.test(l))
  if (!bootstrap && whole.bytes.length <= SPLIT_ABOVE) return (await signSendConfirm(wallet, account, whole)).signature

  // Too big (or first-time account setup): run separable setup in its own transaction first.
  const setup = [], mainSetup = []
  axn.setupIxs.forEach((ix, i) => (SEPARABLE.test(axn.setupIxsLabels[i] ?? '') ? setup : mainSetup).push(ix))
  if (!setup.length) {
    if (whole.bytes.length > MAX_TX_BYTES) throw new Error(`Transaction is ${whole.bytes.length} bytes, over Solana's ${MAX_TX_BYTES}-byte limit`)
    return (await signSendConfirm(wallet, account, whole)).signature
  }
  const main = [...axn.computeBudgetIxs, ...mainSetup, ...KaminoAction.actionToLendingIxs(axn), ...axn.postLendingIxs, ...axn.cleanupIxs]
  const first = await compile(owner, [...axn.computeBudgetIxs, ...setup], luts)
  if (first.bytes.length > MAX_TX_BYTES) throw new Error(`Setup transaction is ${first.bytes.length} bytes, over Solana's ${MAX_TX_BYTES}-byte limit`)
  const { slot } = await signSendConfirm(wallet, account, first)
  luts = await fetchLuts(axn.luts) // a freshly created user LUT is only readable now
  const second = await compile(owner, main, luts)
  if (second.bytes.length > MAX_TX_BYTES) throw new Error(`Transaction is ${second.bytes.length} bytes after setup, over Solana's ${MAX_TX_BYTES}-byte limit`)
  return (await signSendConfirm(wallet, account, second, slot)).signature
}

const BUILDERS = {
  deposit: (p) => KaminoAction.buildDepositTxns(p),
  withdraw: (p) => KaminoAction.buildWithdrawTxns(p),
  borrow: (p) => KaminoAction.buildBorrowTxns(p),
  repay: (p) => KaminoAction.buildRepayTxns(p),
}

// kind: deposit | withdraw | borrow | repay. amount in token units (number); all=true repays the full debt.
export async function execute(kind, { wallet, account, market: m, token, amount, all = false }) {
  const owner = address(account.address)
  const [market, now] = await Promise.all([loadMarket(m), getCurrentLedgerInstant(rpc)])
  if (!market) throw new Error(`Kamino market ${m.kaminoMarket} not found`)
  const reserve = reserveOf(market, token)
  const ob = await market.getObligationByWallet(owner, obligationType())
  if (kind !== 'deposit' && !ob) throw new Error('No Kamino position found for this wallet in this market')
  const base = all ? U64_MAX : new Decimal(amount).mul(new Decimal(10).pow(reserve.stats.decimals)).floor().toFixed()
  const axn = await BUILDERS[kind]({
    kaminoMarket: market, amount: base, reserveAddress: reserve.address, owner: createNoopSigner(owner),
    obligation: ob ?? obligationType(), useV2Ixs: true, scopeRefreshConfig: undefined, currentLedgerInstant: now,
    // The per-user lookup table only serves Kamino leverage flows; skipping it keeps first-time setup to plain
    // ATA + metadata + obligation init (fewer programs for wallet simulators, less rent for the user).
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
  })
  return send(wallet, account, owner, axn)
}

// TEMPORARY (Phantom warning test, /debug-transfer): 1000 lamports to yourself through the same simulate → signAndSend
// path as Kamino actions, to tell a domain-level warning from an instruction-level one. Remove after the test.
export async function testTransfer({ wallet, account }) {
  const owner = address(account.address)
  const data = new Uint8Array(12)
  new DataView(data.buffer).setUint32(0, 2, true) // System program instruction 2 = Transfer
  new DataView(data.buffer).setBigUint64(4, 1000n, true) // lamports
  const ix = { programAddress: address('11111111111111111111111111111111'), accounts: [{ address: owner, role: AccountRole.WRITABLE_SIGNER }, { address: owner, role: AccountRole.WRITABLE }], data }
  return (await signSendConfirm(wallet, account, await compile(owner, [ix], {}))).signature
}

// Everything the Analytics page shows, read live from chain: reserves (incl. Scope oracle freshness) and positions.
export async function loadAnalytics(m, tokens, obligationAddrs) {
  const now = await getCurrentLedgerInstant(rpc)
  const market = await loadMarket(m)
  const reserves = tokens.map((t) => {
    const r = reserveOf(market, t)
    const f = num(r.getMintFactor()) || 1
    const price = num(r.getOracleMarketPrice())
    const supplied = num(r.getTotalSupply()) / f
    const borrowed = num(r.getBorrowedAmount()) / f
    return {
      token: t, price, supplied, borrowed,
      supplyUsd: supplied * price, borrowUsd: borrowed * price,
      utilization: r.calculateUtilizationRatio() * 100,
      supplyApy: r.totalSupplyAPY(now) * 100,
      borrowApy: r.totalBorrowAPY(now) * 100,
      supplyCap: num(r.stats.reserveDepositLimit) / f,
      borrowCap: num(r.stats.reserveBorrowLimit) / f,
      maxLtv: r.stats.loanToValue * 100,
      oracleTs: Number(r.tokenOraclePrice?.timestamp ?? 0),
      maxAge: Number(r.state.config.tokenInfo.maxAgePriceSeconds),
    }
  })
  // Positions come from the server's transaction index (no getProgramAccounts, which Alchemy free refuses).
  let obligations = null
  if (obligationAddrs) {
    try { obligations = (obligationAddrs.length ? await market.getMultipleObligationsByAddress(obligationAddrs.map(address), now) : []).filter(Boolean) } catch (e) { console.warn('[analytics] positions unavailable', e) }
  }
  const positions = obligations?.map((ob) => {
    const s = ob.refreshedStats
    const debt = num(s.userTotalBorrow)
    return {
      owner: String(ob.state.owner),
      deposits: num(s.userTotalDeposit),
      debt,
      ltv: num(s.loanToValue) * 100,
      liqLtv: num(s.liquidationLtv) * 100,
      hf: debt > 0 ? num(s.borrowLiquidationLimit) / debt : Infinity,
    }
  }).filter((p) => p.deposits > 0 || p.debt > 0).sort((a, b) => a.hf - b.hf || b.deposits - a.deposits) ?? null
  return { reserves, positions, blockTime: Number(now.blockTime) }
}
