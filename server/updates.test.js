// Decoding checks for the market index (/api/market-updates), using byte values from real transactions on the Nysa market.
import assert from 'node:assert/strict'
import { describe, describeVault, liquidation } from './updates.js'
import { TOKENS } from '../src/config.js'

const USDC = TOKENS['svm-usdc'], USDY = TOKENS['svm-usdy']
const reserve = (kind, hex, token) => describe('updateReserveConfig', { mode: { [kind]: {} }, value: Buffer.from(hex, 'hex') }, token)
const market = (mode, bytes) => describe('updateLendingMarket', { mode, value: Buffer.concat([Buffer.from(bytes), Buffer.alloc(72 - bytes.length)]) })

assert.deepEqual(reserve('UpdateLoanToValuePct', '5c', USDY), { action: 'Max LTV', value: '92%' })
assert.deepEqual(reserve('UpdateLiquidationThresholdPct', '5f', USDY), { action: 'Liquidation LTV', value: '95%' })
assert.deepEqual(reserve('UpdateDepositLimit', '004429353a000000', USDC), { action: 'Supply cap', value: '250K USDC' })
assert.deepEqual(reserve('UpdateBorrowLimitOutsideElevationGroup', 'ffffffffffffffff', USDC).value, 'unlimited')
assert.deepEqual(reserve('UpdateMaxLiquidationBonusBps', 'f401', USDC).value, '5%')
assert.deepEqual(reserve('UpdateTokenInfoScopeChain', '1400e600ffffffff', USDC), { action: 'Oracle · Scope price chain', value: '20 → 230' })
assert.deepEqual(reserve('UpdateTokenInfoPriceMaxAge', 'b400000000000000', USDC).value, '3m')
assert.deepEqual(reserve('UpdateReserveStatus', '00', USDC).value, 'Active')
assert.deepEqual(reserve('UpdateTokenInfoName', Buffer.from('USDC').toString('hex') + '00'.repeat(28), USDC).value, 'USDC')
// Rate curve: 11 × (util bps u32, rate bps u32); repeated tail points collapse.
const pts = [[0, 0], [5000, 205], [9000, 307], [10000, 1133], ...Array(7).fill([10000, 1133])]
const curve = Buffer.concat(pts.map(([u, r]) => { const b = Buffer.alloc(8); b.writeUInt32LE(u, 0); b.writeUInt32LE(r, 4); return b }))
assert.equal(reserve('UpdateBorrowRateCurve', curve.toString('hex'), USDC).value, '0%: 0%, 50%: 2.05%, 90%: 3.07%, 100%: 11.33%')
// Unknown mode still gets a readable label.
assert.deepEqual(reserve('UpdateRewardsAmountPerAccrualUnit', 'c403000000000000', USDC), { action: 'Rewards amount per accrual unit', value: null })
// Lending market modes (numeric), incl. flags and names.
assert.deepEqual(market(19, Buffer.from('USDY Ondo Market')), { action: 'Market name', value: 'USDY Ondo Market' })
assert.deepEqual(market(5, [0xe0, 0x93, 0x04]), { action: 'Global borrow limit', value: '$300.0K' })
assert.deepEqual(market(2, [25]), { action: 'Liquidation close factor', value: '25%' })
assert.deepEqual(market(30, [1]), { action: 'Borrow order execution enabled', value: 'on' })
assert.deepEqual(describe('initReserve', {}), { action: 'Reserve created', value: null })

// Liquidation: repaid = transfers into the repay reserve's liquidity vault, seized = transfers out of the withdraw
// reserve's liquidity vault (liquidator share + fee); unrelated transfers are ignored.
const acc = ['LIQUIDATOR', 'OBLIGATION', 'MARKET', 'AUTH', USDC.reserve, USDC.mint, 'USDC_VAULT', USDY.reserve, USDY.mint, 'CMINT', 'CSUPPLY', 'USDY_VAULT']
assert.deepEqual(liquidation(acc, [
  { source: 'LIQ_USDC', dest: 'USDC_VAULT', amount: 1_000_000_000n }, // 1,000 USDC repaid
  { source: 'CSUPPLY', dest: 'LIQ_C', amount: 900_000_000n }, // cTokens (not counted)
  { source: 'USDY_VAULT', dest: 'LIQ_USDY', amount: 910_000_000n },
  { source: 'USDY_VAULT', dest: 'FEE', amount: 4_000_000n },
], { OBLIGATION: 'OWNER' }), { obligation: 'OBLIGATION', owner: 'OWNER', liquidator: 'LIQUIDATOR', repaid: 1000, repaidToken: 'USDC', seized: 914, seizedToken: 'USDY' })

// Earn vault admin changes (values from the RWA Prime vault's own transactions).
const vaultCfg = (field, bytes) => describeVault('updateVaultConfig', { entry: { [field]: {} }, data: Buffer.from(bytes) }, USDC)
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
assert.deepEqual(vaultCfg('DepositCap', le64(250_000_000_000)), { action: 'Deposit cap', value: '250K USDC' })
assert.deepEqual(vaultCfg('MinDepositAmount', le64(1000)), { action: 'Min deposit', value: '0.001 USDC' })
assert.deepEqual(vaultCfg('PerformanceFeeBps', le64(1000)), { action: 'Performance fee', value: '10%' })
assert.deepEqual(vaultCfg('Name', Buffer.from('RWA Prime')), { action: 'Vault name', value: 'RWA Prime' })
assert.deepEqual(describeVault('updateReserveAllocation', { weight: 100n, cap: 0xffffffffffffffffn }, USDC, USDC), { action: 'Allocation', value: 'weight 100, cap unlimited' })
assert.deepEqual(describeVault('removeAllocation', {}, USDC), { action: 'Allocation removed', value: null })

console.log('market-updates ok')
