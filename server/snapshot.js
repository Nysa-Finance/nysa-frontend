// Daily snapshot (00:00 UTC, scheduled by server/main.js), from one fresh read of the Nysa Kamino market(s):
// 1. Farm Points: accrue supplied USD × days per wallet ("supplied" = USDC lent + USDY collateral).
// 2. Reserve history for Realized APY: value of one deposit share (liquidity per cToken), APYs, utilization.
// Run once by hand: `docker compose exec app node server/snapshot.js`.
import { pathToFileURL } from 'node:url'
import { getCurrentLedgerInstant } from '@kamino-finance/klend-sdk'
import { address } from '@solana/kit'
import { LIVE, tokensOf } from '../src/config.js'
import { parsePoints, snapshotPoints, pointsCsv } from '../src/logic.js'
import { rpc } from './rpc.js'
import { loadMarket } from './market.js'
import { refreshIndex } from './updates.js'
import { read, write, POINTS, HISTORY } from './storage.js'

// Unix time of an account's first transaction (a reserve's creation). Only needed once per reserve.
async function firstTxTime(addr) {
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

async function readMarkets(history) {
  const balances = new Map()
  const index = await refreshIndex(rpc)
  const now = await getCurrentLedgerInstant(rpc)
  const ts = Number(now.blockTime)
  for (const m of LIVE) {
    const market = await loadMarket(rpc, m)
    // Every position, from the transaction index (no getProgramAccounts, which Alchemy free refuses).
    const addrs = index.obligations[m.kaminoMarket] ?? []
    for (const ob of addrs.length ? await market.getMultipleObligationsByAddress(addrs.map(address), now) : []) {
      if (!ob) continue
      const owner = String(ob.state.owner)
      balances.set(owner, (balances.get(owner) ?? 0) + ob.refreshedStats.userTotalDeposit.toNumber())
    }
    for (const t of tokensOf(m)) {
      const r = market.getReserveByAddress(address(t.reserve))
      if (!r) continue
      const h = (history.tokens[t.token_id] ??= { inception: null, points: [] })
      h.inception ??= await firstTxTime(r.address) // share value starts at exactly 1 when a reserve is created
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

export async function runSnapshot() {
  const history = JSON.parse((await read(HISTORY)) ?? '{"tokens":{}}')
  const balances = await readMarkets(history)
  const rows = snapshotPoints(parsePoints((await read(POINTS)) ?? '').rows, balances, Math.floor(Date.now() / 1000))
  await write(POINTS, pointsCsv(rows))
  await write(HISTORY, JSON.stringify(history))
  return { wallets: rows.length, suppliers: balances.size }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runSnapshot().then((r) => console.log('[snapshot] done', r)).catch((e) => { console.error('[snapshot] failed', e); process.exit(1) })
}
