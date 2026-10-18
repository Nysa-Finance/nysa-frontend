// Snapshot every 12 hours (00:00 and 12:00 UTC, scheduled by server/main.js), from one fresh read of the Nysa Kamino market(s) and vaults:
// 1. Farm Points: accrue supplied USD × days per wallet ("supplied" = USDC lent + USDY collateral + Earn vault shares).
// 2. History for Realized APY: value of one deposit share, per reserve (liquidity per cToken) and per vault (tokens
//    per share), with APYs and utilization.
// Run once by hand: `docker compose exec app node server/snapshot.js`.
import { pathToFileURL } from 'node:url'
import { getCurrentLedgerInstant } from '@kamino-finance/klend-sdk'
import { address } from '@solana/kit'
import { LIVE, VAULTS, TOKENS, tokensOf } from '../src/config.js'
import { parsePoints, snapshotPoints, pointsCsv } from '../src/logic.js'
import { rpc } from './rpc.js'
import { loadMarket } from './market.js'
import { readVault } from './vault.js'
import { vaultShares } from './account.js'
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
  const markets = new Map()
  for (const m of LIVE) {
    const market = await loadMarket(rpc, m)
    markets.set(m.kaminoMarket, market)
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
  for (const v of VAULTS) await readVaultDay(v, markets, now, ts, index, history, balances)
  return balances
}

// A vault's share value for Realized APY (exactly 1 when the vault was created), and its depositors' shares in USD
// (in the wallet and staked in the vault farm) added to their Farm Points balance. Depositors come from the
// transaction index.
async function readVaultDay(v, markets, now, ts, index, history, balances) {
  const { live, view } = await readVault(v, markets, now, {})
  const h = ((history.vaults ??= {})[v.id] ??= { inception: Number(live.state.creationTimestamp), points: [] })
  h.points.push({ ts, rate: Number(live.perShare.toString()), supplyApy: view.apy })
  const token = Object.values(TOKENS).find((t) => t.mint === String(live.state.tokenMint))
  const reserve = token && markets.get(LIVE.find((m) => tokensOf(m).includes(token))?.kaminoMarket)?.getReserveByAddress(address(token.reserve))
  const price = reserve ? reserve.getOracleMarketPrice().toNumber() : 1
  const users = index.vaultUsers?.[v.address] ?? []
  for (const [u, { wallet, staked }] of await vaultShares(live, users)) {
    const shares = wallet + staked
    if (shares > 0) balances.set(u, (balances.get(u) ?? 0) + shares * Number(live.perShare.toString()) * price)
  }
}

export async function runSnapshot() {
  const history = JSON.parse((await read(HISTORY)) ?? '{"tokens":{},"vaults":{}}')
  const balances = await readMarkets(history)
  const rows = snapshotPoints(parsePoints((await read(POINTS)) ?? '').rows, balances, Math.floor(Date.now() / 1000))
  await write(POINTS, pointsCsv(rows))
  await write(HISTORY, JSON.stringify(history))
  return { wallets: rows.length, suppliers: balances.size }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runSnapshot().then((r) => console.log('[snapshot] done', r)).catch((e) => { console.error('[snapshot] failed', e); process.exit(1) })
}
