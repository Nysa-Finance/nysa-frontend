import assert from 'node:assert/strict'
import BN from 'bn.js'
import { loopPositionIdentity, multiplyPosition, obligationPair } from './positions.js'

const wallet = '11111111111111111111111111111111'
const baseIdentity = {
  wallet,
  marketId: 'sol-usdy-usdc',
  obligationAddress: 'MultiplyObligation1111111111111111111111111',
  collateralReserve: 'USDYReserve1111111111111111111111111111111',
  liabilityReserve: 'USDCReserve1111111111111111111111111111111',
}

const id = loopPositionIdentity(baseIdentity)
assert.match(id, /^multiply:/)
assert.equal(loopPositionIdentity({ ...baseIdentity }), id, 'same wallet, market, obligation and reserves have stable identity')
assert.notEqual(loopPositionIdentity({ ...baseIdentity, obligationAddress: 'AnotherMultiply11111111111111111111111111' }), id)
assert.notEqual(loopPositionIdentity({ ...baseIdentity, marketId: 'another-market' }), id)
assert.notEqual(loopPositionIdentity({ ...baseIdentity, wallet: 'Vote111111111111111111111111111111111111111' }), id)
assert.throws(() => loopPositionIdentity({ ...baseIdentity, liabilityReserve: '' }), /identity/i)

const obligation = {
  obligationAddress: baseIdentity.obligationAddress,
  state: {
    owner: wallet,
    deposits: [
      { depositReserve: baseIdentity.collateralReserve, depositedAmount: new BN('150000000') },
      { depositReserve: 'ExtraReserve11111111111111111111111111111111', depositedAmount: new BN('17') },
    ],
    borrows: [
      { borrowReserve: baseIdentity.liabilityReserve, borrowedAmountSf: new BN('50000000000000000000') },
    ],
  },
  refreshedStats: { userTotalDeposit: '150', userTotalBorrow: '50', borrowLiquidationLimit: '90' },
  getDepositByReserve: (reserve) => reserve === baseIdentity.collateralReserve ? { amount: '150000000' } : null,
  getBorrowByReserve: (reserve) => reserve === baseIdentity.liabilityReserve ? { amount: '50000000' } : null,
  getDeposits: () => [
    { reserveAddress: baseIdentity.collateralReserve, amount: '150000000' },
    { reserveAddress: 'ExtraReserve11111111111111111111111111111111', amount: '28.333333333' },
  ],
  getBorrows: () => [{ reserveAddress: baseIdentity.liabilityReserve, amount: '50000000' }],
}
const position = multiplyPosition({
  ...baseIdentity,
  marketName: 'USDY Ondo Market',
  obligation,
  collateral: { tokenId: 'svm-usdy', mint: 'USDYMint111111111111111111111111111111111', decimals: 6 },
  liability: { tokenId: 'svm-usdc', mint: 'USDCMint111111111111111111111111111111111', decimals: 6 },
  collateralMintFactor: '1000000',
  liabilityMintFactor: '1000000',
})
assert.equal(position.id, id)
assert.equal(position.obligation.type, 'multiply')
assert.equal(position.collateral.amount, '150')
assert.equal(position.liability.amount, '50')
assert.equal(position.healthFactor, 1.8)
assert.deepEqual(position.obligation.balances.deposits, [
  { reserve: baseIdentity.collateralReserve, cTokenBaseUnits: '150000000', amountBaseUnits: '150000000' },
  { reserve: 'ExtraReserve11111111111111111111111111111111', cTokenBaseUnits: '17', amountBaseUnits: '28.333333333' },
], 'account API preserves every obligation collateral reserve and its exact raw position')
assert.deepEqual(position.obligation.balances.borrows, [
  { reserve: baseIdentity.liabilityReserve, amountScaled: '50000000000000000000', amountBaseUnits: '50000000' },
], 'account API preserves every obligation borrow and exact raw debt')
assert.deepEqual(position.obligation.unsupportedReserves, ['ExtraReserve11111111111111111111111111111111'],
  'extra reserve state is identified for a fail-closed close gate')
const extraOnlyPosition = multiplyPosition({
  ...baseIdentity,
  obligation: {
    ...obligation,
    state: { ...obligation.state, deposits: [{ depositReserve: 'ExtraReserve11111111111111111111111111111111', depositedAmount: new BN(17) }], borrows: [] },
    getDepositByReserve: () => null, getBorrowByReserve: () => null,
    getDeposits: () => [{ reserveAddress: 'ExtraReserve11111111111111111111111111111111', amount: '28' }], getBorrows: () => [],
  },
  collateral: { tokenId: 'svm-usdy', mint: 'USDYMint111111111111111111111111111111111', decimals: 6 },
  liability: { tokenId: 'svm-usdc', mint: 'USDCMint111111111111111111111111111111111', decimals: 6 },
  collateralMintFactor: '1000000', liabilityMintFactor: '1000000',
})
assert.ok(extraOnlyPosition, 'extra reserve state remains indexed after the selected USDY/USDC amounts reach zero')
assert.equal(multiplyPosition({
  ...baseIdentity,
  obligation: { ...obligation, refreshedStats: { userTotalDeposit: '150', userTotalBorrow: '50' } },
  collateral: { tokenId: 'svm-usdy', mint: 'USDYMint111111111111111111111111111111111', decimals: 6 },
  liability: { tokenId: 'svm-usdc', mint: 'USDCMint111111111111111111111111111111111', decimals: 6 },
  collateralMintFactor: '1000000', liabilityMintFactor: '1000000',
}).healthFactor, null, 'missing liquidation data is shown as unknown, not a zero health factor')
assert.equal(multiplyPosition({
  ...baseIdentity,
  obligation: { ...obligation, refreshedStats: { userTotalDeposit: '150', userTotalBorrow: null, borrowLiquidationLimit: '90' } },
  collateral: { tokenId: 'svm-usdy', mint: 'USDYMint111111111111111111111111111111111', decimals: 6 },
  liability: { tokenId: 'svm-usdc', mint: 'USDCMint111111111111111111111111111111111', decimals: 6 },
  collateralMintFactor: '1000000', liabilityMintFactor: '1000000',
}).healthFactor, null, 'a raw token debt cannot stand in for missing refreshed USD debt')
assert.equal(multiplyPosition({
  ...baseIdentity, obligation: {
    ...obligation,
    state: { ...obligation.state, deposits: [], borrows: [] },
    getDepositByReserve: () => null, getBorrowByReserve: () => null, getDeposits: () => [], getBorrows: () => [],
  },
  collateral: { tokenId: 'svm-usdy', mint: 'USDYMint111111111111111111111111111111111', decimals: 6 },
  liability: { tokenId: 'svm-usdc', mint: 'USDCMint111111111111111111111111111111111', decimals: 6 },
  collateralMintFactor: '1000000', liabilityMintFactor: '1000000',
}), null, 'empty Multiply PDAs are not reported as positions')
assert.throws(() => multiplyPosition({
  ...baseIdentity, obligation: { ...obligation, state: { owner: 'Vote111111111111111111111111111111111111111' } },
  collateral: { tokenId: 'svm-usdy', mint: 'USDYMint111111111111111111111111111111111', decimals: 6 },
  liability: { tokenId: 'svm-usdc', mint: 'USDCMint111111111111111111111111111111111', decimals: 6 },
  collateralMintFactor: '1000000', liabilityMintFactor: '1000000',
}), /owner/i, 'foreign obligation data must not be attributed to the requested wallet')

console.log('identified Multiply positions ok')

// A loan's pair is its largest deposit and its largest borrow, among the market's own collateral and loan reserves.
const twoCollateral = { reserves: { a: 'RA', b: 'RB', usdc: 'RU' }, collateral: ['a', 'b'], loans: ['usdc'] }
const pos = (amount, value) => ({ amount, marketValueRefreshed: value })
assert.deepEqual(obligationPair(twoCollateral, {
  deposits: new Map([['RA', pos(5, 50)], ['RB', pos(9, 90)], ['OTHER', pos(1, 999)]]),
  borrows: new Map([['RU', pos(3, 30)]]),
}), { collateral: 'b', debt: 'usdc' })
assert.deepEqual(obligationPair(twoCollateral, { deposits: new Map([['RA', pos(0, 0)]]), borrows: new Map() }), { collateral: null, debt: null })
console.log('obligation pair ok')
