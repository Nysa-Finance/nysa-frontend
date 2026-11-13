// A wallet's view of the markets: token balances, Kamino positions and unclaimed farm rewards.
// Two RPC calls per read (the obligation, then token accounts + farm user states in one getMultipleAccounts), computed
// against the shared market cache, and cached per wallet for TTL_MS.
import { createRequire } from 'node:module'
import { VanillaObligation, ObligationTypeTag, PROGRAM_ID, getObligationType, obligationFarmStatePda } from '@kamino-finance/klend-sdk'
import { address, fetchEncodedAccounts, getAddressEncoder, getProgramDerivedAddress, some } from '@solana/kit'
import Decimal from 'decimal.js'
import { LIVE, TOKENS, VAULTS, tokensOf } from '../src/config.js'
import { rpc } from './rpc.js'
import { getLive, getVault, reserveOf, farms, num } from './market.js'
import { LOOP_POSITION_MARKET_IDS } from './strategy.js'
import { multiplyPosition } from './positions.js'

const require = createRequire(import.meta.url)
const { decodeUserState, getUserStatePDA } = require('@kamino-finance/farms-sdk')

const TTL_MS = 15_000
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') // kVault shares are SPL Token
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const enc = getAddressEncoder()
export const obligationType = () => new VanillaObligation(PROGRAM_ID)

/** Read the ordinary obligation as the account's primary result; Multiply reads are isolated and additive. */
export async function readWalletObligations({ wallet, marketConfig, market, vanillaObligationType = obligationType() } = {}) {
  if (typeof wallet !== 'string' || !wallet || !marketConfig || !market) throw new TypeError('Wallet, market configuration and market are required.')
  const owner = address(wallet)
  const multiplyPairs = LOOP_POSITION_MARKET_IDS.includes(marketConfig.id)
    ? marketConfig.pairs.filter((pair) => pair.collateral === 'svm-usdy' && pair.liability === 'svm-usdc')
    : []
  const loopPositionReadStatus = multiplyPairs.length ? { [marketConfig.id]: 'verified' } : {}
  const reads = await Promise.allSettled([
    market.getObligationByWallet(owner, vanillaObligationType),
    ...multiplyPairs.map(async (pair) => {
      const collateralReserve = reserveOf(market, TOKENS[pair.collateral])
      const liabilityReserve = reserveOf(market, TOKENS[pair.liability])
      const type = getObligationType(market, ObligationTypeTag.Multiply, some(collateralReserve.address), some(liabilityReserve.address))
      const obligation = await market.getObligationByWallet(owner, type)
      return { obligation, pair, collateralReserve, liabilityReserve }
    }),
  ])
  if (reads[0].status === 'rejected') throw reads[0].reason
  const loopPositions = []
  for (const result of reads.slice(1)) {
    if (result.status === 'rejected') {
      loopPositionReadStatus[marketConfig.id] = 'unavailable'
      console.warn('[account] Multiply obligation read unavailable', result.reason?.message)
      continue
    }
    const item = result.value
    if (!item.obligation) continue
    try {
      const position = multiplyPosition({
        wallet,
        marketId: marketConfig.id,
        marketName: marketConfig.name,
        obligation: item.obligation,
        collateralReserve: item.collateralReserve.address,
        liabilityReserve: item.liabilityReserve.address,
        collateral: TOKENS[item.pair.collateral],
        liability: TOKENS[item.pair.liability],
        collateralMintFactor: String(item.collateralReserve.getMintFactor()),
        liabilityMintFactor: String(item.liabilityReserve.getMintFactor()),
      })
      if (position) loopPositions.push(position)
    } catch (error) {
      loopPositionReadStatus[marketConfig.id] = 'unavailable'
      console.warn('[account] Multiply obligation omitted', error?.message)
    }
  }
  return { obligation: reads[0].value, loopPositions, loopPositionReadStatus }
}
// What the obligation can borrow / withdraw of a reserve, in token units, as Kamino computes it at `now`: the panels'
// limits, and checked before building (tx.js) to say what fits instead of failing the simulation. null if unknown.
export function maxOf(kind, ob, market, reserve, now) {
  try {
    const f = num(reserve.getMintFactor()) || 1
    return num(kind === 'borrow' ? ob.getMaxBorrowAmount(market, reserve.address, now, false) : ob.getMaxWithdrawAmount(market, reserve.address, now).maxWithdrawAmount) / f
  } catch { return null }
}

export async function ataOf(owner, mint, tokenProgram) {
  const [ata] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(owner), enc.encode(tokenProgram), enc.encode(mint)] })
  return ata
}

// SPL token account amount (u64 at byte 64; same layout for Token-2022 accounts).
const tokenAmount = (acc) => (acc?.exists ? Number(new DataView(acc.data.buffer, acc.data.byteOffset).getBigUint64(64, true)) : 0)

export function maxWithdrawBaseUnits({ maxWithdrawAmountScaled, suppliedAmountScaled, mintFactor, decimals } = {}) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new TypeError('Invalid token decimals.')
  let max, supplied, factor
  try {
    max = new Decimal(String(maxWithdrawAmountScaled))
    supplied = new Decimal(String(suppliedAmountScaled))
    factor = new Decimal(String(mintFactor))
  } catch { throw new TypeError('Invalid withdrawal amount.') }
  if (!max.isFinite() || !supplied.isFinite() || !factor.isFinite() || max.isNegative() || supplied.isNegative() || factor.lte(0)) {
    throw new TypeError('Invalid withdrawal amount.')
  }
  return Decimal.min(max, supplied).div(factor).mul(new Decimal(10).pow(decimals)).floor().toFixed(0)
}

export function maxWithdrawFromObligation({ obligation, market, reserve, instant, suppliedAmountScaled, mintFactor, decimals } = {}) {
  if (!obligation) return maxWithdrawBaseUnits({ maxWithdrawAmountScaled: '0', suppliedAmountScaled: '0', mintFactor, decimals })
  let maxWithdrawAmountScaled
  try { maxWithdrawAmountScaled = String(obligation.getMaxWithdrawAmount(market, reserve.address, instant).maxWithdrawAmount) }
  catch { throw new TypeError('Could not calculate the fresh withdrawal allowance.') }
  return maxWithdrawBaseUnits({ maxWithdrawAmountScaled, suppliedAmountScaled, mintFactor, decimals })
}

const tokenAmountBaseUnits = (acc) => (acc?.exists
  ? String(new DataView(acc.data.buffer, acc.data.byteOffset).getBigUint64(64, true))
  : '0')

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
  // balances: token id -> …; positions: market id -> token id -> … (a token lent in two markets is two positions)
  const balances = {}, balancesBaseUnits = {}, positions = {}, positionsBaseUnits = {}, claimable = {}, loopPositions = [], loopPositionReadStatus = {}
  let sol = 0
  for (const m of LIVE) {
    positions[m.id] = {}
    positionsBaseUnits[m.id] = {}
    const { market, now, farms: farmStates } = getLive(m)
    const tokens = tokensOf(m)
    const { obligation: ob, loopPositions: marketLoopPositions, loopPositionReadStatus: marketLoopPositionReadStatus } = await readWalletObligations({ wallet, marketConfig: m, market })
    loopPositions.push(...marketLoopPositions)
    Object.assign(loopPositionReadStatus, marketLoopPositionReadStatus)
    // One getMultipleAccounts: the wallet's token account per token, then its farm user state per reward farm.
    const atas = await Promise.all(tokens.map((t) => ataOf(owner, address(t.mint), reserveOf(market, t).getLiquidityTokenProgram())))
    const farmAddrs = ob ? [...farmStates.keys()] : []
    const userPdas = await Promise.all(farmAddrs.map((f) => obligationFarmStatePda(address(f), ob.obligationAddress)))
    const accounts = await fetchEncodedAccounts(rpc, [...atas, ...userPdas, owner])
    const self = accounts.at(-1) // the wallet itself: its SOL pays every transaction's fees
    sol = self.exists ? Number(self.lamports) / 1e9 : 0
    tokens.forEach((t, i) => {
      balancesBaseUnits[t.token_id] = tokenAmountBaseUnits(accounts[i])
      balances[t.token_id] = Number(balancesBaseUnits[t.token_id]) / 10 ** t.decimals
    })
    const users = farmAddrs.map((f, i) => {
      const acc = accounts[atas.length + i]
      return [f, acc.exists ? decodeUserState(acc).data : null]
    })
    claimable[m.id] = pendingRewards(farmStates, users).map(({ mint, amount }) => ({ symbol: tokens.find((t) => t.mint === mint)?.name ?? mint, amount }))
    for (const t of tokens) {
      const r = reserveOf(market, t)
      const factorValue = r.getMintFactor()
      const f = num(factorValue) || 1
      const depositAmount = ob?.getDepositByReserve(r.address)?.amount
      const suppliedScaled = depositAmount == null ? '0' : String(depositAmount)
      const supplied = ob ? num(depositAmount) / f : 0
      const borrowed = ob ? num(ob.getBorrowByReserve(r.address)?.amount) / f : 0
      const maxWithdraw = maxWithdrawFromObligation({
        obligation: ob && supplied > 0 ? ob : null,
        market,
        reserve: r,
        instant: now,
        suppliedAmountScaled: suppliedScaled,
        mintFactor: String(factorValue ?? '1'),
        decimals: t.decimals,
      })
      positions[m.id][t.token_id] = { supplied, borrowed, maxWithdraw: Number(maxWithdraw) / 10 ** t.decimals }
      positionsBaseUnits[m.id][t.token_id] = { maxWithdraw }
      const maxBorrow = ob && m.loans.includes(t.token_id) ? maxOf('borrow', ob, market, r, now) : null
      positions[m.id][t.token_id].maxBorrow = maxBorrow
    }
  }
  return { balances, balancesBaseUnits, positions, positionsBaseUnits, loopPositions, loopPositionReadStatus, claimable, sol, vaults: await vaultPositions(owner) }
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
