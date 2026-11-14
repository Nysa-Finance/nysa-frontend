// Run once by hand: `docker compose exec app node server/snapshot.js`.
import { pathToFileURL } from 'node:url'
import { getCurrentLedgerInstant } from '@kamino-finance/klend-sdk'
import { address } from '@solana/kit'
import { LIVE, VAULTS, tokensOf } from '../src/config.js'
import { parsePoints, snapshotPoints, pointsCsv } from '../src/logic.js'
import { rpc } from './rpc.js'
import { loadMarket } from './market.js'
import { readVault } from './vault.js'
import { vaultShares } from './account.js'
import { freshIndex } from './updates.js'
import { indexedPositionSummary } from './positions.js'
import { read, write, POINTS, HISTORY } from './storage.js'

const HALF_DAY = 12 * 3600

// Only needed once per reserve.
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

export async function readMarkets(history, {
  indexReader = freshIndex,
  ledgerReader = () => getCurrentLedgerInstant(rpc),
  markets: configuredMarkets = LIVE,
  vaults: configuredVaults = VAULTS,
  marketLoader = (marketConfig) => loadMarket(rpc, marketConfig),
  firstTxTimeReader = firstTxTime,
  vaultDayReader = readVaultDay,
  summarize = indexedPositionSummary,
} = {}) {
  const balances = new Map()
  const index = await indexReader()
  const now = await ledgerReader()
  const ts = Number(now.blockTime)
  const due = (h) => !h.points.length || Math.floor(ts / HALF_DAY) > Math.floor(h.points.at(-1).ts / HALF_DAY)
  const markets = new Map()
  for (const m of configuredMarkets) {
    const market = await marketLoader(m)
    markets.set(m.kaminoMarket, market)
    // From the transaction index: no getProgramAccounts, which Alchemy free refuses.
    const addrs = index.obligations[m.kaminoMarket] ?? []
    for (const ob of addrs.length ? await market.getMultipleObligationsByAddress(addrs.map(address), now) : []) {
      if (!ob) continue
      const summary = summarize(ob)
      if (!summary) continue
      const owner = String(ob.state.owner)
      balances.set(owner, (balances.get(owner) ?? 0) + summary.deposits)
    }
    for (const t of tokensOf(m)) {
      const reserve = m.reserves[t.token_id]
      const r = market.getReserveByAddress(address(reserve))
      if (!r) continue
      // Keyed by reserve (a token has one per market). History recorded under the token id, from when there was one
      // market, moves to that market's reserve the first time this runs.
      if (history.tokens[t.token_id]) { history.tokens[reserve] = history.tokens[t.token_id]; delete history.tokens[t.token_id] }
      const h = (history.tokens[reserve] ??= { inception: null, points: [] })
      if (!due(h)) continue
      h.inception ??= await firstTxTimeReader(r.address) // share value starts at exactly 1 when a reserve is created
      h.points.push({
        ts,
        rate: 1 / r.getEstimatedCollateralExchangeRate(now, market.state.referralFeeBps).toNumber(),
        supplyApy: r.totalSupplyAPY(now) * 100,
        borrowApy: r.totalBorrowAPY(now) * 100,
        utilization: r.calculateUtilizationRatio() * 100,
      })
    }
  }
  for (const v of configuredVaults) await vaultDayReader(v, markets, now, ts, index, history, balances, due)
  return balances
}

async function readVaultDay(v, markets, now, ts, index, history, balances, due) {
  const { live, view } = await readVault(v, markets, now)
  const h = ((history.vaults ??= {})[v.id] ??= { inception: Number(live.state.creationTimestamp), points: [] })
  if (due(h)) h.points.push({ ts, rate: Number(live.perShare.toString()), supplyApy: view.apy })
  const users = index.vaultUsers?.[v.address] ?? []
  for (const [u, { wallet, staked }] of await vaultShares(live, users)) {
    const shares = wallet + staked
    if (shares > 0) balances.set(u, (balances.get(u) ?? 0) + shares * Number(live.perShare.toString()) * view.price)
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
