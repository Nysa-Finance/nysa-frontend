// A wallet's view of the markets: token balances, Kamino positions and unclaimed farm rewards.
// Two RPC calls per read (the obligation, then token accounts + farm user states in one getMultipleAccounts), computed
// against the shared market cache, and cached per wallet for TTL_MS.
import { createRequire } from 'node:module'
import { VanillaObligation, PROGRAM_ID, obligationFarmStatePda } from '@kamino-finance/klend-sdk'
import { address, fetchEncodedAccounts, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit'
import Decimal from 'decimal.js'
import { LIVE, VAULTS, tokensOf } from '../src/config.js'
import { rpc } from './rpc.js'
import { getLive, getVault, reserveOf, farms, num } from './market.js'

const require = createRequire(import.meta.url)
const { decodeUserState, getUserStatePDA } = require('@kamino-finance/farms-sdk')

const TTL_MS = 15_000
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') // kVault shares are SPL Token
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
  return { balances, positions, claimable, vaults: await vaultPositions(owner) }
}

// Each owner's shares in a vault: in the wallet (shares ATA) and staked in the vault farm, where Kamino's UI puts
// deposits (as klend-sdk counts them: the active stake). -> Map owner -> { wallet, staked } in shares.
export async function vaultShares(live, owners, config) {
  const dec = Number(live.state.sharesMintDecimals)
  const atas = await Promise.all(owners.map((o) => ataOf(address(o), live.state.sharesMint, TOKEN_PROGRAM)))
  const pdas = live.farm ? await Promise.all(owners.map((o) => getUserStatePDA(farms.getProgramID(), address(live.farm.address), address(o)))) : []
  const keys = [...atas, ...pdas], accounts = []
  for (let i = 0; i < keys.length; i += 100) accounts.push(...await fetchEncodedAccounts(rpc, keys.slice(i, i + 100), config)) // RPC limit
  return new Map(owners.map((o, i) => {
    const user = pdas.length && accounts[atas.length + i]?.exists ? decodeUserState(accounts[atas.length + i]).data : null
    return [o, { wallet: tokenAmount(accounts[i]) / 10 ** dec, staked: user ? stakedShares(user, dec) : 0 }]
  }))
}
// Farm stakes are WAD-scaled lamports (farms-sdk scaleDownWads).
const stakedShares = (user, dec) => Number(BigInt(user.activeStakeScaled) / 10n ** 18n) / 10 ** dec

// The wallet's shares in each vault (wallet + staked) and what they're worth in the vault's token.
async function vaultPositions(owner) {
  const vaults = VAULTS.flatMap((v) => { try { return [{ v, live: getVault(v.id) }] } catch { return [] } })
  return Object.fromEntries(await Promise.all(vaults.map(async ({ v, live }) => {
    const { wallet, staked } = (await vaultShares(live, [String(owner)])).get(String(owner))
    return [v.id, { shares: wallet + staked, staked, value: (wallet + staked) * num(live.perShare) }]
  })))
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
