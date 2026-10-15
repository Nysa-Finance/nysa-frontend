// Market index: admin changes to the Nysa Kamino market and its reserves (LTVs, rate curve, oracles, caps…) and to the
// Earn vaults (allocations, fees, limits, admin), decoded from on-chain transactions; every liquidation; the addresses
// (and owners) of every position (obligation); and every wallet that deposited into a vault (Farm Points).
// Each update carries its `source`: the market or vault address it belongs to.
// Indexed incrementally into DATA_DIR: each refresh only fetches transactions newer than the last one seen.
// The position list replaces getProgramAccounts, which rate-limited RPC plans refuse (Alchemy free).
import { createRequire } from 'node:module'
import { address, getBase58Decoder, getBase58Encoder } from '@solana/kit'
import { rpc as client } from './rpc.js'
import { LIVE, VAULTS, TOKENS } from '../src/config.js'
import { getVault } from './market.js'
import { compact, usd, dur, short } from '../src/logic.js'
import { read, write, INDEX } from './storage.js'

const require = createRequire(import.meta.url)
const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'
const KVAULT = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd'

// Kamino admin instructions (Anchor discriminator → name + args layout), from klend-sdk's generated code.
const ADMIN = {
  initLendingMarket: 'Market created',
  updateLendingMarket: null, // described per mode
  updateLendingMarketOwner: 'Market ownership transferred',
  initReserve: 'Reserve created',
  seedDepositOnInitReserve: 'Initial deposit seeded',
  updateReserveConfig: null, // described per mode
  cloneReserveConfig: 'Reserve config cloned',
  initFarmsForReserve: 'Rewards farm initialized',
  withdrawProtocolFee: 'Protocol fees withdrawn',
  socializeLoss: 'Bad debt socialized',
  socializeLossV2: 'Bad debt socialized',
}
const IX_MODULES = {
  initLendingMarket: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initLendingMarket.js'),
  initObligation: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initObligation.js'), // indexed, not listed
  liquidateObligationAndRedeemReserveCollateral: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/liquidateObligationAndRedeemReserveCollateral.js'),
  liquidateObligationAndRedeemReserveCollateralV2: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/liquidateObligationAndRedeemReserveCollateralV2.js'),
  updateLendingMarket: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/updateLendingMarket.js'),
  updateLendingMarketOwner: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/updateLendingMarketOwner.js'),
  initReserve: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initReserve.js'),
  seedDepositOnInitReserve: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/seedDepositOnInitReserve.js'),
  updateReserveConfig: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/updateReserveConfig.js'),
  cloneReserveConfig: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/cloneReserveConfig.js'),
  initFarmsForReserve: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initFarmsForReserve.js'),
  withdrawProtocolFee: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/withdrawProtocolFee.js'),
  socializeLoss: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/socializeLoss.js'),
  socializeLossV2: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/socializeLossV2.js'),
}
const IXS = Object.fromEntries(Object.entries(IX_MODULES).map(([name, m]) => [Buffer.from(m.DISCRIMINATOR).toString('hex'), { name, layout: m.layout }]))
const MARKET_MODES = Object.fromEntries(Object.values(require('@kamino-finance/klend-sdk/dist/@codegen/klend/types/UpdateLendingMarketMode.js'))
  .filter((c) => typeof c === 'function' && 'discriminator' in c).map((c) => [c.discriminator, c.kind]))

// ---- value formatting (pure, tested in _market-updates.test.js) ----
const MAX64 = 0xffffffffffffffffn
const u64 = (v, o = 0) => v.readBigUInt64LE(o)
const pctOf = (x) => `${+Number(x).toFixed(2)}%`
const bps = (n) => pctOf(Number(n) / 100)
const text = (v) => v.toString('utf8').replace(/\0+$/, '')
const addr = (v) => short(getBase58Decoder().decode(v.subarray(0, 32)), 4, 4)
const secs = (n) => dur(Number(n))
const chain = (v) => [0, 2, 4, 6].map((i) => v.readUInt16LE(i)).filter((x) => x !== 0xffff).join(' → ') || 'none'
const amount = (n, t) => {
  if (n === MAX64) return 'unlimited'
  if (!t) return String(n)
  const v = Number(n) / 10 ** t.decimals
  return v > 0 && v < 1 ? `${+v.toPrecision(3)} ${t.name}` : compact(v, t.name) // small minimums stay visible (0.001 USDC)
}
function curve(v) {
  const pts = []
  for (let i = 0; i + 8 <= v.length; i += 8) {
    const p = `${pctOf(v.readUInt32LE(i) / 100)}: ${pctOf(v.readUInt32LE(i + 4) / 100)}`
    if (pts.at(-1) !== p) pts.push(p)
  }
  return pts.join(', ')
}

// Reserve config modes: [label, value formatter(bytes, token)].
const RESERVE = {
  UpdateLoanToValuePct: ['Max LTV', (v) => pctOf(v[0])],
  UpdateLiquidationThresholdPct: ['Liquidation LTV', (v) => pctOf(v[0])],
  UpdateMaxLiquidationBonusBps: ['Max liquidation bonus', (v) => bps(v.readUInt16LE(0))],
  UpdateMinLiquidationBonusBps: ['Min liquidation bonus', (v) => bps(v.readUInt16LE(0))],
  UpdateBadDebtLiquidationBonusBps: ['Bad-debt liquidation bonus', (v) => bps(v.readUInt16LE(0))],
  UpdateProtocolLiquidationFee: ['Protocol liquidation fee', (v) => pctOf(v[0])],
  UpdateProtocolTakeRate: ['Protocol take rate', (v) => pctOf(v[0])],
  UpdateFeesOriginationFee: ['Borrow origination fee', (v) => pctOf((Number(u64(v)) / 2 ** 60) * 100)],
  UpdateFeesFlashLoanFee: ['Flash loan fee', (v) => pctOf((Number(u64(v)) / 2 ** 60) * 100)],
  UpdateDepositLimit: ['Supply cap', (v, t) => amount(u64(v), t)],
  UpdateBorrowLimit: ['Borrow cap', (v, t) => amount(u64(v), t)],
  UpdateBorrowLimitOutsideElevationGroup: ['Borrow cap outside elevation groups', (v, t) => amount(u64(v), t)],
  UpdateDepositWithdrawalCap: ['Deposit withdrawal cap', (v, t) => `${amount(u64(v), t)} per ${secs(u64(v, 8))}`],
  UpdateDebtWithdrawalCap: ['Debt withdrawal cap', (v, t) => `${amount(u64(v), t)} per ${secs(u64(v, 8))}`],
  UpdateBorrowRateCurve: ['Interest rate curve', curve],
  UpdateBorrowFactor: ['Borrow factor', (v) => pctOf(u64(v))],
  UpdateReserveStatus: ['Reserve status', (v) => ['Active', 'Obsolete', 'Hidden'][v[0]] ?? String(v[0])],
  UpdateScopePriceFeed: ['Oracle · Scope price feed', addr],
  UpdatePythPrice: ['Oracle · Pyth feed', addr],
  UpdateSwitchboardFeed: ['Oracle · Switchboard feed', addr],
  UpdateSwitchboardTwapFeed: ['Oracle · Switchboard TWAP feed', addr],
  UpdateTokenInfoScopeChain: ['Oracle · Scope price chain', chain],
  UpdateTokenInfoScopeTwap: ['Oracle · Scope TWAP chain', chain],
  UpdateTokenInfoPriceMaxAge: ['Oracle · max price age', (v) => secs(u64(v))],
  UpdateTokenInfoTwapMaxAge: ['Oracle · max TWAP age', (v) => secs(u64(v))],
  UpdateTokenInfoTwapDivergence: ['Oracle · max TWAP divergence', (v) => bps(u64(v))],
  UpdateTokenInfoLowerHeuristic: ['Oracle · price sanity lower bound', (v) => String(u64(v))],
  UpdateTokenInfoUpperHeuristic: ['Oracle · price sanity upper bound', (v) => String(u64(v))],
  UpdateTokenInfoExpHeuristic: ['Oracle · price sanity exponent', (v) => String(u64(v))],
  UpdateTokenInfoName: ['Token name', text],
  UpdateDeleveragingThresholdDecreaseBpsPerDay: ['Deleveraging threshold decrease', (v) => `${bps(u64(v))}/day`],
  UpdateDeleveragingBonusIncreaseBpsPerDay: ['Deleveraging bonus increase', (v) => `${bps(u64(v))}/day`],
}
// Lending market modes: value type by name.
const MARKET = {
  UpdateName: ['Market name', (v) => text(v)],
  UpdateOwner: ['Market owner', addr],
  UpdateEmergencyCouncil: ['Emergency council', addr],
  UpdateProposerAuthority: ['Proposer authority', addr],
  UpdatePermissioningAuthority: ['Permissioning authority', addr],
  UpdateLiquidationCloseFactor: ['Liquidation close factor', (v) => pctOf(v[0])],
  UpdateInsolvencyRiskLtv: ['Insolvency risk LTV', (v) => pctOf(v[0])],
  UpdatePriceRefreshTriggerToMaxAgePct: ['Price refresh trigger', (v) => `${pctOf(v[0])} of max age`],
  UpdateLiquidationMaxValue: ['Max liquidatable debt at once', (v) => usd(Number(u64(v)))],
  UpdateGlobalAllowedBorrow: ['Global borrow limit', (v) => usd(Number(u64(v)))],
  UpdateMinFullLiquidationThreshold: ['Min full-liquidation value', (v) => usd(Number(u64(v)))],
  UpdateMinValueLtvSkipPriorityLiqCheck: ['Min value to skip LTV priority check', (v) => usd(Number(u64(v)))],
  UpdateMinValueBfSkipPriorityLiqCheck: ['Min value to skip borrow-factor priority check', (v) => usd(Number(u64(v)))],
  UpdateReferralFeeBps: ['Referral fee', (v) => bps(v.readUInt16LE(0))],
  UpdateIndividualAutodeleverageMarginCallPeriodSecs: ['Auto-deleverage margin call period', (v) => secs(u64(v))],
}
const humanize = (kind) => kind.replace(/^Update/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, (_, c) => ' ' + c.toLowerCase())
const isFlag = (kind) => /Enabled$|Disabled$|EmergencyMode$|ImmutableFlag$|DisableNonceBlock$|PermissionedOps$/.test(kind)

// { action, value } for one decoded admin instruction. `token` is the reserve's token config (if any).
export function describe(name, args, token) {
  if (name === 'updateReserveConfig') {
    const kind = Object.keys(args.mode)[0]
    const [label, fmt] = RESERVE[kind] ?? [humanize(kind)]
    return { action: label, value: fmt ? safe(() => fmt(Buffer.from(args.value), token)) : null }
  }
  if (name === 'updateLendingMarket') {
    const kind = MARKET_MODES[Number(args.mode)] ?? `Mode ${args.mode}`
    const v = Buffer.from(args.value)
    if (isFlag(kind)) return { action: humanize(kind), value: v[0] ? 'on' : 'off' }
    const [label, fmt] = MARKET[kind] ?? [humanize(kind), (b) => String(u64(b))]
    return { action: label, value: safe(() => fmt(v)) }
  }
  if (name === 'initFarmsForReserve') return { action: ADMIN[name], value: ['collateral', 'debt'][Number(args.mode)] ?? null }
  return { action: ADMIN[name], value: null }
}
function safe(fn) { try { return fn() } catch { return null } }

// ---- liquidations ----
const RESERVES = new Map(Object.values(TOKENS).map((t) => [t.reserve, t]))
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PhnBqCXEpPxuEb']

// SPL token transfers among an instruction's inner instructions: [{ source, dest, amount }].
function transfers(ixs, keys, b58) {
  const out = []
  for (const ix of ixs) {
    if (!TOKEN_PROGRAMS.includes(keys[ix.programIdIndex])) continue
    const d = Buffer.from(b58.encode(ix.data))
    const a = ix.accounts.map((i) => keys[i])
    if (d[0] === 3 && d.length >= 9) out.push({ source: a[0], dest: a[1], amount: d.readBigUInt64LE(1) }) // Transfer
    if (d[0] === 12 && d.length >= 10) out.push({ source: a[0], dest: a[2], amount: d.readBigUInt64LE(1) }) // TransferChecked
  }
  return out
}

// One Kamino liquidation from its accounts and the token transfers it made: the debt repaid into the repay reserve's
// liquidity vault and the collateral paid out of the withdraw reserve's liquidity vault (to the liquidator, incl. fees).
// accounts: liquidator, obligation, lendingMarket, authority, repayReserve, repayMint, repaySupply, withdrawReserve,
// withdrawMint, collateralMint, collateralSupply, withdrawLiquiditySupply, …
export function liquidation(accounts, moves, owners = {}) {
  const repay = RESERVES.get(accounts[4]), withdraw = RESERVES.get(accounts[7])
  const sum = (pick) => moves.filter(pick).reduce((s, m) => s + m.amount, 0n)
  const units = (n, t) => (t ? Number(n) / 10 ** t.decimals : null)
  return {
    obligation: accounts[1],
    owner: owners[accounts[1]] ?? null,
    liquidator: accounts[0],
    repaid: units(sum((m) => m.dest === accounts[6]), repay),
    repaidToken: repay?.name ?? short(accounts[5], 4, 4),
    seized: units(sum((m) => m.source === accounts[11]), withdraw),
    seizedToken: withdraw?.name ?? short(accounts[8], 4, 4),
  }
}

// ---- Earn vault (kVault) instructions ----
const kv = (name) => require(`@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/${name}.js`)
const VAULT_ADMIN = {
  initVault: 'Vault created',
  updateVaultConfig: null, // described per field
  updateReserveAllocation: 'Allocation', updateReserveAllocationV2: 'Allocation',
  removeAllocation: 'Allocation removed',
  updateAdmin: 'Vault admin transferred',
  addUpdateWhitelistedReserve: 'Reserve whitelist updated',
  withdrawPendingFees: 'Fees withdrawn', giveUpPendingFees: 'Pending fees waived',
  updateSharesMetadata: 'Shares name/symbol updated',
}
const VAULT_DEPOSITS = ['deposit', 'depositWithMinSharesOut', 'buy', 'buyWithMinSharesOut'] // accounts[0] = user
const VIXS = Object.fromEntries([...Object.keys(VAULT_ADMIN), ...VAULT_DEPOSITS].map((name) => [Buffer.from(kv(name).DISCRIMINATOR).toString('hex'), { name, layout: kv(name).layout }]))
const bool = (v) => (v[0] ? 'on' : 'off')
// updateVaultConfig fields: [label, value formatter(bytes, vault token)].
const VAULT_FIELDS = {
  PerformanceFeeBps: ['Performance fee', (v) => bps(u64(v))],
  ManagementFeeBps: ['Management fee', (v) => bps(u64(v))],
  DepositCap: ['Deposit cap', (v, t) => amount(u64(v), t)],
  MinDepositAmount: ['Min deposit', (v, t) => amount(u64(v), t)],
  MinWithdrawAmount: ['Min withdrawal', (v, t) => amount(u64(v), t)],
  MinInvestAmount: ['Min invest amount', (v, t) => amount(u64(v), t)],
  MinInvestDelaySlots: ['Min invest delay', (v) => `${u64(v)} slots`],
  CrankFundFeePerReserve: ['Crank fee per reserve', (v) => `${u64(v)} lamports`],
  UnallocatedWeight: ['Unallocated weight', (v) => String(u64(v))],
  UnallocatedTokensCap: ['Unallocated cap', (v, t) => amount(u64(v), t)],
  WithdrawalPenaltyBps: ['Withdrawal penalty', (v) => bps(u64(v))],
  WithdrawalPenaltyLamports: ['Withdrawal penalty (fixed)', (v, t) => amount(u64(v), t)],
  PendingVaultAdmin: ['Vault admin transfer proposed', addr],
  AllocationAdmin: ['Allocation admin', addr],
  Farm: ['Rewards farm', addr],
  FirstLossCapitalFarm: ['First-loss capital farm', addr],
  LookupTable: ['Lookup table', addr],
  Name: ['Vault name', text],
  AllowAllocationsInWhitelistedReservesOnly: ['Allocations only in whitelisted reserves', bool],
  AllowInvestInWhitelistedReservesOnly: ['Invest only in whitelisted reserves', bool],
}

// { action, value } for one decoded vault admin instruction; `reserveToken`: the allocated reserve's token, if any.
export function describeVault(name, args, vaultToken, reserveToken) {
  if (name === 'updateVaultConfig') {
    const kind = Object.keys(args.entry ?? {})[0] ?? 'config'
    const [label, fmt] = VAULT_FIELDS[kind] ?? [humanize(kind)]
    return { action: label, value: fmt ? safe(() => fmt(Buffer.from(args.data), vaultToken)) : null }
  }
  if (name.startsWith('updateReserveAllocation')) {
    return { action: 'Allocation', value: `weight ${args.weight}${args.cap != null ? `, cap ${amount(BigInt(String(args.cap)), reserveToken)}` : ''}` }
  }
  return { action: VAULT_ADMIN[name], value: null }
}

// ---- indexing ----

// src: { address, vault?: { name, token } }: a market (Kamino Lend instructions) or a vault (kVault instructions).
async function indexNew(rpc, src, state) {
  const marketAddr = src.address
  const b58 = getBase58Encoder()
  const sigs = []
  for (let before; ;) {
    const page = await rpc.getSignaturesForAddress(address(marketAddr), { limit: 1000, before, until: state.lastSig[marketAddr] ?? undefined }).send()
    sigs.push(...page)
    if (page.length < 1000) break
    before = page.at(-1).signature
  }
  if (!sigs.length) return false
  const seen = new Set([...state.updates, ...state.liquidations].map((u) => u.id))
  const ok = sigs.filter((s) => !s.err).reverse() // oldest first
  for (let i = 0; i < ok.length; i += 4) {
    // Version 1 is Solana's newer transaction format (same JSON fields here); asking for 0 would fail on those.
    const txs = await Promise.all(ok.slice(i, i + 4).map((s) => rpc.getTransaction(s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1 }).send()))
    txs.forEach((t, j) => {
      if (!t) return
      const sig = ok[i + j].signature
      const keys = [...t.transaction.message.accountKeys, ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])].map(String)
      // Top-level and inner (CPI, e.g. via a multisig) instructions, each with the instructions it invoked: a top-level
      // instruction's whole inner group, an inner one's deeper calls that follow it.
      // ponytail: a liquidation called through another program shares that group, so a flash loan from the same
      // reserve in the same group would count toward "repaid"; split by stackHeight further if a bot ever does that.
      const all = []
      t.transaction.message.instructions.forEach((ix, i) => {
        const inner = t.meta?.innerInstructions?.find((g) => g.index === i)?.instructions ?? []
        all.push({ ix, calls: inner })
        inner.forEach((x, j) => {
          const end = inner.findIndex((y, k) => k > j && (y.stackHeight ?? 2) <= (x.stackHeight ?? 2))
          all.push({ ix: x, calls: inner.slice(j + 1, end === -1 ? undefined : end) })
        })
      })
      all.forEach(({ ix, calls }, k) => {
        if (src.vault) return indexVaultIx(src, state, seen, sig, t, k, ix, keys, b58)
        if (keys[ix.programIdIndex] !== KLEND) return
        const data = Buffer.from(b58.encode(ix.data))
        const def = IXS[data.subarray(0, 8).toString('hex')]
        const accounts = ix.accounts.map((a) => keys[a])
        if (!def || !accounts.includes(marketAddr)) return
        if (def.name === 'initObligation') { // accounts: owner, feePayer, obligation, lendingMarket, …
          const list = (state.obligations[marketAddr] ??= [])
          if (!list.includes(accounts[2])) list.push(accounts[2])
          state.owners[accounts[2]] = accounts[0]
          return
        }
        const id = `${sig}:${k}`
        if (seen.has(id)) return
        seen.add(id)
        if (def.name.startsWith('liquidate')) {
          state.liquidations.push({ id, sig, ts: Number(t.blockTime), market: marketAddr, ...liquidation(accounts, transfers(calls, keys, b58), state.owners) })
          return
        }
        const reserve = accounts.find((a) => RESERVES.has(a))
        const token = reserve && RESERVES.get(reserve)
        let args = {}
        try { args = def.layout.decode(data.subarray(8)) } catch { /* keep generic description */ }
        state.updates.push({
          id, sig, ts: Number(t.blockTime), source: marketAddr,
          target: token ? `${token.name} reserve` : 'Market',
          ...describe(def.name, args, token),
        })
      })
    })
  }
  state.lastSig[marketAddr] = sigs[0].signature // newest
  return true
}

// A vault instruction: an admin change (listed with the vault as source) or a deposit (its wallet is remembered).
function indexVaultIx(src, state, seen, sig, t, k, ix, keys, b58) {
  if (keys[ix.programIdIndex] !== KVAULT) return
  const data = Buffer.from(b58.encode(ix.data))
  const def = VIXS[data.subarray(0, 8).toString('hex')]
  const accounts = ix.accounts.map((a) => keys[a])
  if (!def || !accounts.includes(src.address)) return
  if (VAULT_DEPOSITS.includes(def.name)) {
    const users = (state.vaultUsers[src.address] ??= [])
    if (!users.includes(accounts[0])) users.push(accounts[0])
    return
  }
  const id = `${sig}:${k}`
  if (seen.has(id)) return
  seen.add(id)
  // Only allocation-type changes are about a reserve; config changes may list reserves too but apply to the vault.
  const reserve = def.name === 'updateVaultConfig' ? null : accounts.find((a) => RESERVES.has(a))
  let args = {}
  try { args = def.layout.decode(data.subarray(8)) } catch { /* keep generic description */ }
  state.updates.push({
    id, sig, ts: Number(t.blockTime), source: src.address,
    target: reserve ? `${src.vault.name} → ${RESERVES.get(reserve).name} reserve` : `${src.vault.name} vault`,
    ...describeVault(def.name, args, src.vault.token, reserve && RESERVES.get(reserve)),
  })
}

// The vault's token (for amounts in its updates), from the live cache when this process has it (the server).
function vaultToken(v) {
  try { return Object.values(TOKENS).find((t) => t.mint === String(getVault(v.id).state.tokenMint)) } catch { return null }
}

// Bring the index up to date and return it: { lastSig, updates, liquidations, obligations: { [market]: [address] },
// owners: { [obligation]: wallet }, vaultUsers: { [vault]: [wallet] } }.
// Also used by the daily snapshot to find every position and vault depositor without getProgramAccounts.
export async function refreshIndex(rpc) {
  const state = { lastSig: {}, updates: [], liquidations: [], obligations: {}, owners: {}, vaultUsers: {}, ...JSON.parse((await read(INDEX)) ?? '{}') }
  let changed = false
  for (const m of LIVE) changed = (await indexNew(rpc, { address: m.kaminoMarket }, state)) || changed
  for (const v of VAULTS) changed = (await indexNew(rpc, { address: v.address, vault: { name: v.name, token: vaultToken(v) } }, state)) || changed
  if (changed) await write(INDEX, JSON.stringify(state))
  return state
}

// At most one refresh per minute, shared by concurrent requests (and by the analytics positions list).
let cached = null, cachedAt = 0
export function freshIndex() {
  if (!cached || Date.now() - cachedAt > 60_000) {
    cachedAt = Date.now()
    cached = refreshIndex(client).catch((e) => { cached = null; throw e })
  }
  return cached
}

// GET /api/market-updates payload: newest first.
export const marketUpdates = async () => ({ updates: [...(await freshIndex()).updates].sort((a, b) => b.ts - a.ts) })
// GET /api/liquidations payload: newest first.
export const marketLiquidations = async () => ({ liquidations: [...(await freshIndex()).liquidations].sort((a, b) => b.ts - a.ts) })
