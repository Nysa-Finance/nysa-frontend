// A wallet's view of the markets: token balances, Kamino positions and unclaimed farm rewards.
// Two RPC calls per read (the obligation, then token accounts + farm user states in one getMultipleAccounts), computed
// against the shared market cache, and cached per wallet for TTL_MS.
import { createRequire } from 'node:module'
import { VanillaObligation, PROGRAM_ID, obligationFarmStatePda } from '@kamino-finance/klend-sdk'
import { address, fetchEncodedAccounts, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit'
import Decimal from 'decimal.js'
import { LIVE, tokensOf } from '../src/config.js'
import { rpc } from './rpc.js'
import { getLive, reserveOf, farms, num } from './market.js'

const require = createRequire(import.meta.url)
const { decodeUserState } = require('@kamino-finance/farms-sdk')

const TTL_MS = 15_000
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const enc = getAddressEncoder()
export const obligationType = () => new VanillaObligation(PROGRAM_ID)

export async function ataOf(owner, mint, tokenProgram) {
  const [ata] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(owner), enc.encode(tokenProgram), enc.encode(mint)] })
  return ata
}

// SPL token account amount (u64 at byte 64; same layout for Token-2022 accounts).
const tokenAmount = (acc) => (acc?.exists ? Number(new DataView(acc.data.buffer, acc.data.byteOffset).getBigUint64(64, true)) : 0)

// Unclaimed rewards of an obligation in its markets' collateral farms: [{ farm, mint, index, amount }].
export function pendingRewards(farmStates, userStates) {
  const out = []
  const now = new Decimal(Math.floor(Date.now() / 1000))
  for (const [farm, user] of userStates) {
    const fs = farmStates.get(farm)
    if (!fs || !user) continue
    farms.getUserPendingRewards(user, fs, now, null).userPendingRewardAmounts.forEach((raw, index) => {
      const info = fs.rewardInfos[index]
      const amount = Number(String(raw)) / 10 ** Number(info.token.decimals)
      if (amount > 0) out.push({ farm, mint: String(info.token.mint), index, amount })
    })
  }
  return out
}

async function readAccount(wallet) {
  const owner = address(wallet)
  const balances = {}, positions = {}, claimable = {}
  for (const m of LIVE) {
    const { market, now, farms: farmStates } = getLive(m)
    const tokens = tokensOf(m)
    const ob = await market.getObligationByWallet(owner, obligationType())
    // One getMultipleAccounts: the wallet's token account per token, then its farm user state per reward farm.
    const atas = await Promise.all(tokens.map((t) => ataOf(owner, address(t.mint), reserveOf(market, t).getLiquidityTokenProgram())))
    const farmAddrs = ob ? [...farmStates.keys()] : []
    const userPdas = await Promise.all(farmAddrs.map((f) => obligationFarmStatePda(address(f), ob.obligationAddress)))
    const accounts = await fetchEncodedAccounts(rpc, [...atas, ...userPdas])
    tokens.forEach((t, i) => (balances[t.token_id] = tokenAmount(accounts[i]) / 10 ** t.decimals))
    const users = farmAddrs.map((f, i) => {
      const acc = accounts[atas.length + i]
      return [f, acc.exists ? decodeUserState(acc).data : null]
    })
    claimable[m.id] = pendingRewards(farmStates, users).map(({ mint, amount }) => ({ symbol: tokens.find((t) => t.mint === mint)?.name ?? mint, amount }))
    for (const t of tokens) {
      const r = reserveOf(market, t)
      const f = num(r.getMintFactor()) || 1
      const supplied = ob ? num(ob.getDepositByReserve(r.address)?.amount) / f : 0
      const borrowed = ob ? num(ob.getBorrowByReserve(r.address)?.amount) / f : 0
      let maxWithdraw = supplied
      if (ob && supplied > 0) {
        try { maxWithdraw = Math.min(num(ob.getMaxWithdrawAmount(market, r.address, now).maxWithdrawAmount) / f, supplied) } catch { /* keep supplied */ }
      }
      positions[t.token_id] = { supplied, borrowed, maxWithdraw }
    }
  }
  return { balances, positions, claimable }
}

const cache = new Map() // wallet -> { at, value: Promise }
export function getAccount(wallet, fresh = false) {
  const hit = cache.get(wallet)
  if (hit && !fresh && Date.now() - hit.at < TTL_MS) return hit.value
  if (cache.size > 10_000) for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k)
  const value = readAccount(wallet)
  cache.set(wallet, { at: Date.now(), value })
  value.catch(() => cache.delete(wallet))
  return value
}
