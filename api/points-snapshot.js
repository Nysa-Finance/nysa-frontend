// Daily snapshot (Vercel Cron, see vercel.json), from one read of the Nysa Kamino market(s):
// 1. Farm Points: accrue supplied USD × days per wallet ("supplied" = USDC lent + USDY collateral).
// 2. Reserve history for Realized APY: value of one deposit share (liquidity per cToken), APYs, utilization.
// Protected by CRON_SECRET: Vercel Cron sends it as a Bearer token; manual runs must send it too.
import { put } from '@vercel/blob'
import { LIVE, tokensOf } from '../src/config.js'
import { parsePoints, snapshotPoints, pointsCsv } from '../src/logic.js'
import { POINTS_BLOB, readPoints, readBlob } from './points.js'
import { HISTORY_BLOB } from './apy-history.js'

// Unix time of an account's first transaction (a reserve's creation). Only needed once per reserve.
async function firstTxTime(rpc, addr) {
  let before, oldest
  for (;;) {
    const sigs = await rpc.getSignaturesForAddress(addr, { limit: 1000, before }).send()
    if (!sigs.length) break
    oldest = sigs.at(-1)
    before = oldest.signature
    if (sigs.length < 1000) break
  }
  return oldest ? Number(oldest.blockTime) : null
}

// klend-sdk is imported lazily so auth is checked (and a clean 401 returned) before loading it.
async function readMarkets(rpcUrl, history) {
  const { getCurrentLedgerInstant } = await import('@kamino-finance/klend-sdk')
  const { loadMarket } = await import('../src/loadMarket.js')
  const { createSolanaRpc, address } = await import('@solana/kit')
  const rpc = createSolanaRpc(rpcUrl)
  const balances = new Map()
  const now = await getCurrentLedgerInstant(rpc)
  const ts = Number(now.blockTime)
  for (const m of LIVE) {
    const market = await loadMarket(rpc, m)
    // Needs getProgramAccounts: point SOLANA_RPC at a plan that allows it (Alchemy free does not).
    for (const ob of await market.getAllObligationsForMarket(now)) {
      const owner = String(ob.state.owner)
      balances.set(owner, (balances.get(owner) ?? 0) + ob.refreshedStats.userTotalDeposit.toNumber())
    }
    for (const t of tokensOf(m)) {
      const r = market.getReserveByAddress(address(t.reserve))
      if (!r) continue
      const h = (history.tokens[t.token_id] ??= { inception: null, points: [] })
      h.inception ??= await firstTxTime(rpc, r.address) // share value starts at exactly 1 when a reserve is created
      h.points.push({
        ts,
        rate: 1 / r.getEstimatedCollateralExchangeRate(now, market.state.referralFeeBps).toNumber(),
        supplyApy: r.totalSupplyAPY(now) * 100,
        borrowApy: r.totalBorrowAPY(now) * 100,
        utilization: r.calculateUtilizationRatio() * 100,
      })
    }
  }
  return balances
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401
    return res.end('Unauthorized')
  }
  try {
    const rpcUrl = process.env.SOLANA_RPC || process.env.VITE_SOLANA_RPC
    if (!rpcUrl) throw new Error('SOLANA_RPC (or VITE_SOLANA_RPC) is not set')
    const history = JSON.parse((await readBlob(HISTORY_BLOB)) ?? '{"tokens":{}}')
    const balances = await readMarkets(rpcUrl, history)
    const rows = snapshotPoints(parsePoints((await readPoints()) ?? '').rows, balances, Math.floor(Date.now() / 1000))
    const opts = { access: 'private', addRandomSuffix: false, allowOverwrite: true }
    await put(POINTS_BLOB, pointsCsv(rows), { ...opts, contentType: 'text/csv' })
    await put(HISTORY_BLOB, JSON.stringify(history), { ...opts, contentType: 'application/json' })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, wallets: rows.length, suppliers: balances.size }))
  } catch (e) {
    console.error('[points-snapshot] failed', e)
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
  }
}
