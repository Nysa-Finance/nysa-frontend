// Daily Farm Points snapshot (Vercel Cron, see vercel.json). Points accrue as supplied USD × days per wallet,
// where "supplied" = total deposits (USDC lent + USDY collateral) in the Nysa Kamino market(s).
// Protected by CRON_SECRET: Vercel Cron sends it as a Bearer token; manual runs must send it too.
import { put } from '@vercel/blob'
import { LIVE } from '../src/config.js'
import { parsePoints, snapshotPoints, pointsCsv } from '../src/logic.js'
import { POINTS_BLOB, readPoints } from './points.js'

// klend-sdk is imported lazily so auth is checked (and a clean 401 returned) before loading it.
async function suppliedByOwner(rpcUrl) {
  const { KaminoMarket, getCurrentLedgerInstant, DEFAULT_RECENT_SLOT_DURATION_MS } = await import('@kamino-finance/klend-sdk')
  const { createSolanaRpc, address } = await import('@solana/kit')
  const rpc = createSolanaRpc(rpcUrl)
  const out = new Map()
  const now = await getCurrentLedgerInstant(rpc)
  for (const m of LIVE) {
    const market = await KaminoMarket.load(rpc, address(m.kaminoMarket), DEFAULT_RECENT_SLOT_DURATION_MS)
    for (const ob of await market.getAllObligationsForMarket(now)) {
      const owner = String(ob.state.owner)
      out.set(owner, (out.get(owner) ?? 0) + ob.refreshedStats.userTotalDeposit.toNumber())
    }
  }
  return out
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
    const balances = await suppliedByOwner(rpcUrl)
    const rows = snapshotPoints(parsePoints((await readPoints()) ?? '').rows, balances, Math.floor(Date.now() / 1000))
    await put(POINTS_BLOB, pointsCsv(rows), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/csv' })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, wallets: rows.length, suppliers: balances.size }))
  } catch (e) {
    console.error('[points-snapshot] failed', e)
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
  }
}
