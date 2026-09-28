// GET /api/market-updates — admin changes to the Nysa Kamino market and its reserves (LTVs, rate curve, oracles, caps…),
// decoded from on-chain transactions. Indexed incrementally into a private Blob: each call only fetches transactions
// newer than the last one seen, so cost stays flat as user activity grows.
import { createRequire } from 'node:module'
import { put } from '@vercel/blob'
import { address, createSolanaRpc, getBase58Decoder, getBase58Encoder } from '@solana/kit'
import { LIVE, TOKENS } from '../src/config.js'
import { compact, usd, dur, short } from '../src/logic.js'
import { readBlob } from './points.js'

const require = createRequire(import.meta.url)
const BLOB = 'market-history/updates.json'
const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'

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
// Static require paths on purpose: Vercel's file tracer can't follow template-string requires.
const IX_MODULES = {
  initLendingMarket: require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initLendingMarket.js'),
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
const amount = (n, t) => (n === MAX64 ? 'unlimited' : t ? compact(Number(n) / 10 ** t.decimals, t.name) : String(n))
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

// ---- indexing ----
const RESERVES = new Map(Object.values(TOKENS).map((t) => [t.reserve, t]))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// RPC plans are rate-limited (QuickNode free: 15 req/s): back off and retry on HTTP 429.
async function withRetry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= tries - 1 || e?.context?.statusCode !== 429) throw e
      await sleep(1000 * (i + 1))
    }
  }
}

async function indexNew(rpc, marketAddr, state) {
  const b58 = getBase58Encoder()
  const sigs = []
  for (let before; ;) {
    const page = await withRetry(() => rpc.getSignaturesForAddress(address(marketAddr), { limit: 1000, before, until: state.lastSig[marketAddr] ?? undefined }).send())
    sigs.push(...page)
    if (page.length < 1000) break
    before = page.at(-1).signature
  }
  if (!sigs.length) return false
  const seen = new Set(state.updates.map((u) => u.id))
  const ok = sigs.filter((s) => !s.err).reverse() // oldest first
  for (let i = 0; i < ok.length; i += 4) {
    const txs = await Promise.all(ok.slice(i, i + 4).map((s) => withRetry(() => rpc.getTransaction(s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }).send())))
    txs.forEach((t, j) => {
      if (!t) return
      const sig = ok[i + j].signature
      const keys = [...t.transaction.message.accountKeys, ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])].map(String)
      // Top-level and inner (CPI, e.g. via a multisig) instructions.
      const all = [...t.transaction.message.instructions, ...(t.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)]
      all.forEach((ix, k) => {
        if (keys[ix.programIdIndex] !== KLEND) return
        const data = Buffer.from(b58.encode(ix.data))
        const def = IXS[data.subarray(0, 8).toString('hex')]
        const accounts = ix.accounts.map((a) => keys[a])
        if (!def || !accounts.includes(marketAddr)) return
        const id = `${sig}:${k}`
        if (seen.has(id)) return
        const reserve = accounts.find((a) => RESERVES.has(a))
        const token = reserve && RESERVES.get(reserve)
        let args = {}
        try { args = def.layout.decode(data.subarray(8)) } catch { /* keep generic description */ }
        state.updates.push({
          id, sig, ts: Number(t.blockTime),
          target: token ? `${token.name} reserve` : 'Market',
          ...describe(def.name, args, token),
        })
        seen.add(id)
      })
    })
  }
  state.lastSig[marketAddr] = sigs[0].signature // newest
  return true
}

export default async function handler(req, res) {
  try {
    const state = JSON.parse((await readBlob(BLOB)) ?? '{"lastSig":{},"updates":[]}')
    const rpcUrl = process.env.SOLANA_RPC || process.env.VITE_SOLANA_RPC
    if (rpcUrl) {
      const rpc = createSolanaRpc(rpcUrl)
      let changed = false
      for (const m of LIVE) changed = (await indexNew(rpc, m.kaminoMarket, state)) || changed
      if (changed) await put(BLOB, JSON.stringify(state), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' })
    }
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600')
    res.end(JSON.stringify({ updates: [...state.updates].sort((a, b) => b.ts - a.ts) }))
  } catch (e) {
    console.error('[market-updates] failed', e)
    res.statusCode = 500
    res.end(JSON.stringify({ error: 'Could not read market updates' }))
  }
}
