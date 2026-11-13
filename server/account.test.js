import assert from 'node:assert/strict'
import { maxWithdrawBaseUnits, maxWithdrawFromObligation, readWalletObligations } from './account.js'
import { LIVE, TOKENS } from '../src/config.js'

assert.equal(maxWithdrawBaseUnits({ maxWithdrawAmountScaled: '1500000', suppliedAmountScaled: '2000000', mintFactor: '1000000', decimals: 6 }), '1500000')
assert.equal(maxWithdrawBaseUnits({ maxWithdrawAmountScaled: '1500001', suppliedAmountScaled: '1500000', mintFactor: '1000000', decimals: 6 }), '1500000')
assert.equal(maxWithdrawBaseUnits({ maxWithdrawAmountScaled: '1500000999999', suppliedAmountScaled: '2000000000000', mintFactor: '1000000', decimals: 6 }), '1500000999999')
assert.equal(maxWithdrawBaseUnits({ maxWithdrawAmountScaled: '0', suppliedAmountScaled: '0', mintFactor: '1000000', decimals: 6 }), '0')
assert.throws(() => maxWithdrawBaseUnits({ maxWithdrawAmountScaled: '-1', suppliedAmountScaled: '1', mintFactor: '1', decimals: 6 }), /invalid/i)
const allowanceArgs = { market: {}, reserve: {}, instant: {}, suppliedAmountScaled: '2000000', mintFactor: '1000000', decimals: 6 }
assert.equal(maxWithdrawFromObligation({ ...allowanceArgs, obligation: { getMaxWithdrawAmount: () => ({ maxWithdrawAmount: 1_500_000n }) } }), '1500000')
assert.throws(() => maxWithdrawFromObligation({ ...allowanceArgs, obligation: { getMaxWithdrawAmount: () => { throw new Error('stale reserve') } } }), /fresh withdrawal allowance/i,
  'allowance calculation failures must fail closed instead of falling back to all supplied collateral')
assert.equal(maxWithdrawFromObligation({ ...allowanceArgs, obligation: null }), '0')

const wallet = '11111111111111111111111111111111'
const marketConfig = LIVE.find((candidate) => candidate.id === 'sol-usdy-usdc')
const vanillaObligation = { obligationAddress: 'Vanilla11111111111111111111111111111111111' }
const multiplyObligation = {
  obligationAddress: 'Multiply1111111111111111111111111111111111',
  state: {
    owner: wallet,
    deposits: [{ depositReserve: LIVE[0].reserves['svm-usdy'], depositedAmount: '150000000' }],
    borrows: [{ borrowReserve: LIVE[0].reserves['svm-usdc'], borrowedAmountSf: '50000000000000000000000000' }],
  },
  refreshedStats: { userTotalBorrow: '100', borrowLiquidationLimit: '150' },
  getDepositByReserve: () => ({ amount: '150000000' }),
  getBorrowByReserve: () => ({ amount: '50000000' }),
  getDeposits: () => [{ reserveAddress: LIVE[0].reserves['svm-usdy'], amount: '150000000' }],
  getBorrows: () => [{ reserveAddress: LIVE[0].reserves['svm-usdc'], amount: '50000000' }],
}
const reservesByAddress = new Map([
  [LIVE[0].reserves['svm-usdy'], { address: LIVE[0].reserves['svm-usdy'], getLiquidityMint: () => TOKENS['svm-usdy'].mint, getMintFactor: () => '1000000' }],
  [LIVE[0].reserves['svm-usdc'], { address: LIVE[0].reserves['svm-usdc'], getLiquidityMint: () => TOKENS['svm-usdc'].mint, getMintFactor: () => '1000000' }],
])
const market = {
  programId: 'KaminoProgram1111111111111111111111111111',
  getAddress: () => marketConfig.kaminoMarket,
  getReserveByAddress: (reserve) => reservesByAddress.get(String(reserve)),
  getExistingReserveByAddress: (reserve) => reservesByAddress.get(String(reserve)),
  getObligationByWallet: async (_owner, type) => type.constructor.name === 'VanillaObligation' ? vanillaObligation : multiplyObligation,
}
const walletPositions = await readWalletObligations({ wallet, marketConfig, market })
assert.equal(walletPositions.obligation, vanillaObligation, 'vanilla obligation remains available with a non-empty Multiply obligation')
assert.equal(walletPositions.loopPositions.length, 1)
assert.equal(walletPositions.loopPositions[0].collateral.tokenId, TOKENS['svm-usdy'].token_id, 'real token_id config shape maps to UI token identity')
assert.equal(walletPositions.loopPositions[0].liability.amount, '50')
assert.equal(walletPositions.loopPositions[0].healthFactor, 1.5, 'health uses USD debt, not raw USDC token amount')
assert.deepEqual(walletPositions.loopPositionReadStatus, { 'sol-usdy-usdc': 'verified' },
  'a successful absent/present Multiply lookup explicitly marks the owner-scoped read as authoritative')

const unavailableMultiplyMarket = {
  ...market,
  getObligationByWallet: async (_owner, type) => {
    if (type.constructor.name === 'VanillaObligation') return vanillaObligation
    throw new Error('Multiply account read unavailable')
  },
}
const vanillaSurvivesMultiplyFailure = await readWalletObligations({ wallet, marketConfig, market: unavailableMultiplyMarket })
assert.equal(vanillaSurvivesMultiplyFailure.obligation, vanillaObligation)
assert.deepEqual(vanillaSurvivesMultiplyFailure.loopPositions, [], 'Multiply read failure does not reject the vanilla account load')
assert.deepEqual(vanillaSurvivesMultiplyFailure.loopPositionReadStatus, { 'sol-usdy-usdc': 'unavailable' },
  'a failed Multiply lookup is distinguished from a verified absent obligation')
console.log('account raw withdrawal amounts ok')
