// Positions for the Analytics page: every obligation in each LIVE market (addresses from the market index, read in one
// batch against the market cache), riskiest first; and every holder of each vault's shares. Cached for a minute.
import { address, fetchEncodedAccounts, getAddressDecoder } from '@solana/kit'
import { LIVE, VAULTS } from '../src/config.js'
import { rpc } from './rpc.js'
import { getLive, getVault, num } from './market.js'
import { freshIndex } from './updates.js'
import { vaultShares } from './account.js'

const addrDecoder = getAddressDecoder()

async function readPositions() {
  const index = await freshIndex()
  const out = []
  for (const m of LIVE) {
    const { market, now } = getLive(m)
    const addrs = index.obligations[m.kaminoMarket] ?? []
    for (const ob of addrs.length ? await market.getMultipleObligationsByAddress(addrs.map(address), now) : []) {
      if (!ob) continue
      const s = ob.refreshedStats
      const debt = num(s.userTotalBorrow)
      const deposits = num(s.userTotalDeposit)
      if (deposits <= 0 && debt <= 0) continue
      out.push({
        owner: String(ob.state.owner),
        deposits,
        debt,
        ltv: debt > 0 ? num(s.loanToValue) * 100 : 0,
        liqLtv: num(s.liquidationLtv) * 100 || 0,
        hf: debt > 0 ? num(s.borrowLiquidationLimit) / debt : null, // null = no debt (infinite health)
      })
    }
  }
  return out.sort((a, b) => (a.hf ?? Infinity) - (b.hf ?? Infinity) || b.deposits - a.deposits)
}

// A vault's depositors: every wallet that ever deposited (vault transactions in the market index, Kamino's UI
// included) plus its 20 largest share holders (catches shares moved to another wallet), each with its shares in the
// wallet and staked in the vault farm. Alchemy refuses a getProgramAccounts scan of the Token program, so no full scan.
// -> [{ owner, wallet, staked }] in shares, largest first.
async function readHolders(v, index) {
  const live = getVault(v.id)
  const largest = (await rpc.getTokenLargestAccounts(live.state.sharesMint).send()).value
    .filter((a) => Number(a.amount) > 0 && String(a.address) !== String(live.farm?.state.farmVault)) // farm's own account: counted per staker
  const accounts = largest.length ? await fetchEncodedAccounts(rpc, largest.map((a) => a.address)) : []
  const owners = new Set(index.vaultUsers?.[v.address] ?? [])
  for (const a of accounts) if (a.exists) owners.add(addrDecoder.decode(a.data.subarray(32, 64)))
  return [...(await vaultShares(live, [...owners])).entries()]
    .map(([owner, x]) => ({ owner, ...x }))
    .filter((h) => h.wallet + h.staked > 0)
    .sort((a, b) => b.wallet + b.staked - (a.wallet + a.staked))
}

// Cached for a minute and shared between visitors; a failed read is retried on the next request.
function cachedFor(ms, read) {
  let cached = null, cachedAt = 0
  return () => {
    if (!cached || Date.now() - cachedAt > ms) {
      cachedAt = Date.now()
      cached = read().catch((e) => { cached = null; throw e })
    }
    return cached
  }
}
export const getPositions = cachedFor(60_000, readPositions)
export const getVaultHolders = cachedFor(60_000, async () => {
  const index = await freshIndex()
  return Object.fromEntries(await Promise.all(VAULTS.map(async (v) => [v.id, await readHolders(v, index)])))
})
