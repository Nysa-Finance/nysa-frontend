import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import bs58 from 'bs58'
import { LIVE, TOKENS } from '../src/config.js'
import { indexedPositionSummary, loopPositionIdentity, recordIndexedObligation } from './positions.js'
import { evaluateLoopActionReadiness, LOOP_ALLOWED_MARKET_IDS, LOOP_POSITION_MARKET_IDS } from './strategy.js'
import { loopPortfolioTotals, loopPositionFullyClosed, portfolioHealthFactor, selectedLoopCloseReadiness } from '../src/loop-positions.js'
import { snapshotPoints } from '../src/logic.js'
import { readPositions } from './analytics.js'
import { readMarkets } from './snapshot.js'
import { refreshIndex } from './updates.js'

const wallet = '11111111111111111111111111111111'
assert.ok(LOOP_POSITION_MARKET_IDS.includes('sol-usdy-usdc'), 'position discovery stays configured when new-entry allowlisting changes')
assert.notEqual(LOOP_POSITION_MARKET_IDS, LOOP_ALLOWED_MARKET_IDS, 'position discovery is not coupled to entry allowlisting')
const makePosition = (obligationAddress, collateralAmount, liabilityAmount) => ({
  id: loopPositionIdentity({ wallet, marketId: 'sol-usdy-usdc', obligationAddress, collateralReserve: 'reserve-usdy', liabilityReserve: 'reserve-usdc' }),
  wallet,
  market: { id: 'sol-usdy-usdc' },
  obligation: {
    address: obligationAddress, type: 'multiply',
    balances: {
      deposits: [{ reserve: 'reserve-usdy', cTokenBaseUnits: String(BigInt(collateralAmount) * 1_000_000n), amountBaseUnits: String(BigInt(collateralAmount) * 1_000_000n) }],
      borrows: [{ reserve: 'reserve-usdc', amountScaled: String(BigInt(liabilityAmount) * 1_000_000n * 1_000_000_000_000_000_000n), amountBaseUnits: String(BigInt(liabilityAmount) * 1_000_000n) }],
    },
    unsupportedReserves: [],
  },
  collateral: { tokenId: 'svm-usdy', reserve: 'reserve-usdy', amount: collateralAmount, amountBaseUnits: String(BigInt(collateralAmount) * 1_000_000n) },
  liability: { tokenId: 'svm-usdc', reserve: 'reserve-usdc', amount: liabilityAmount, amountBaseUnits: String(BigInt(liabilityAmount) * 1_000_000n) },
  healthFactor: 1.8,
})
const first = makePosition('multiply-one', '100', '60')
const second = makePosition('multiply-two', '40', '20')
assert.notEqual(first.id, second.id, 'two Multiply obligations with the same mints remain separately identified')

const totals = loopPortfolioTotals([first, second, first], { 'svm-usdy': 1.1, 'svm-usdc': 1 })
assert.equal(totals.suppliedUsd, 154, 'each obligation contributes collateral once even if a consumer sees a duplicate')
assert.equal(totals.borrowedUsd, 80)
assert.equal(totals.healthFactor, 1.8)
assert.equal(loopPortfolioTotals([], {}).suppliedUsd, 0)
const unknownDebtHealth = loopPortfolioTotals([{ ...second, healthFactor: null }], { 'svm-usdy': 1.1, 'svm-usdc': 1 })
assert.equal(unknownDebtHealth.healthFactor, null)
assert.equal(unknownDebtHealth.healthFactorKnown, false, 'active debt with missing HF remains explicitly unknown')
assert.equal(loopPortfolioTotals([{ ...second, healthFactor: null }], {}).healthFactorKnown, false,
  'missing token prices do not turn active debt with unknown HF into a debt-free state')
assert.equal(portfolioHealthFactor([], unknownDebtHealth), null, 'Portfolio renders unknown loop health as unknown, not infinity')
assert.equal(portfolioHealthFactor([], loopPortfolioTotals([], {})), Infinity, 'a debt-free portfolio keeps the infinite health display')
const noDebtHealth = loopPortfolioTotals([{ ...second, liability: { ...second.liability, amount: '0' }, healthFactor: null }], { 'svm-usdy': 1.1, 'svm-usdc': 1 })
assert.equal(noDebtHealth.healthFactorKnown, true, 'missing HF is not unknown when there is no active debt')

const index = { obligations: {}, owners: {} }
recordIndexedObligation(index, 'market-address', 'vanilla-obligation', wallet)
recordIndexedObligation(index, 'market-address', 'multiply-obligation', wallet)
recordIndexedObligation(index, 'market-address', 'multiply-obligation', wallet)
assert.deepEqual(index.obligations['market-address'], ['vanilla-obligation', 'multiply-obligation'], 'vanilla and Multiply obligations are indexed once by address')
assert.equal(index.owners['multiply-obligation'], wallet)
const vanillaSummary = indexedPositionSummary({ refreshedStats: { userTotalDeposit: '100', userTotalBorrow: '20', loanToValue: '0.2', liquidationLtv: '0.95', borrowLiquidationLimit: '95' } })
const multiplySummary = indexedPositionSummary({ refreshedStats: { userTotalDeposit: '150', userTotalBorrow: '50', loanToValue: '0.333', liquidationLtv: '0.95', borrowLiquidationLimit: '142.5' } })
assert.equal(vanillaSummary.deposits + multiplySummary.deposits, 250, 'market analytics can consume both obligation kinds')
assert.equal(indexedPositionSummary({ refreshedStats: { userTotalDeposit: '10', userTotalBorrow: '5' } }).hf, null,
  'missing liquidation data is not treated as an instant liquidation')
const points = snapshotPoints([], new Map([[wallet, vanillaSummary.deposits + multiplySummary.deposits]]), 100)
assert.equal(points[0].supplied, 250, 'Farm Points keep the existing gross-deposit basis across indexed obligation kinds')

const routeReady = { executionEnabled: true, unavailableReasons: [] }
const openBlockedByEntry = evaluateLoopActionReadiness({
  action: 'loop-open', strategy: { enabled: false, unavailableReasons: [{ code: 'allocation', message: 'No entry allocation.' }] },
  routeReadiness: routeReady, builderAvailable: true, previewAcknowledgementValid: true,
})
assert.equal(openBlockedByEntry.executionEnabled, false)
assert.ok(openBlockedByEntry.unavailableReasons.some((reason) => reason.code === 'allocation'))

const closeIgnoresEntryPolicy = evaluateLoopActionReadiness({
  action: 'loop-close', strategy: { enabled: false, unavailableReasons: [{ code: 'allocation', message: 'Entry allocation was removed.' }] },
  routeReadiness: routeReady, builderAvailable: true, positionId: first.id, positionVerified: true,
})
assert.equal(closeIgnoresEntryPolicy.executionEnabled, true, 'a safe full close is not coupled to entry allocation or carry policy')
assert.equal(evaluateLoopActionReadiness({
  action: 'loop-close', routeReadiness: routeReady, builderAvailable: true,
}).executionEnabled, false, 'close requires an exact identified position')
assert.equal(evaluateLoopActionReadiness({
  action: 'loop-close', routeReadiness: { executionEnabled: false, unavailableReasons: [{ code: 'route', message: 'Route is unverified.' }] },
  builderAvailable: true, positionId: first.id, positionVerified: true,
}).executionEnabled, false, 'exit route safety still gates a full close')
assert.equal(evaluateLoopActionReadiness({
  action: 'loop-open', strategy: { enabled: true, unavailableReasons: [] }, routeReadiness: routeReady,
  builderAvailable: false, previewAcknowledgementValid: true,
}).executionEnabled, false, 'the production atomic transaction builder remains a separate prerequisite')
const genericCloseReadiness = evaluateLoopActionReadiness({ action: 'loop-close', routeReadiness: routeReady, builderAvailable: true })
const verifiedLoopPositionRead = { 'sol-usdy-usdc': 'verified' }
assert.equal(selectedLoopCloseReadiness(genericCloseReadiness, first, wallet, verifiedLoopPositionRead).executionEnabled, true,
  'selecting an account-API position with a matching wallet enables close independently of entry allocation')
assert.equal(selectedLoopCloseReadiness(genericCloseReadiness, { ...first, wallet: 'other-wallet' }, wallet, verifiedLoopPositionRead).executionEnabled, false,
  'a position returned for a different wallet never enables close')
assert.equal(selectedLoopCloseReadiness(genericCloseReadiness, first, wallet, { 'sol-usdy-usdc': 'unavailable' }).executionEnabled, false,
  'a cached position does not enable close when the latest owner-scoped Multiply read failed')
assert.equal(selectedLoopCloseReadiness({ executionEnabled: false, unavailableReasons: [{ code: 'route', message: 'Unsafe exit route.' }] }, first, wallet, verifiedLoopPositionRead).executionEnabled, false,
  'position selection does not remove route safety blockers')
assert.equal(loopPositionFullyClosed([], first.id, verifiedLoopPositionRead), true, 'a verified absent obligation confirms full close')
assert.equal(loopPositionFullyClosed([], first.id, { 'sol-usdy-usdc': 'unavailable' }), false,
  'an absent position after a failed owner-scoped read is unknown, not closed')
assert.equal(loopPositionFullyClosed([{ ...first,
  collateral: { ...first.collateral, amount: '0', amountBaseUnits: '0' },
  liability: { ...first.liability, amount: '0', amountBaseUnits: '0' },
  obligation: { ...first.obligation, balances: { deposits: [], borrows: [] } },
}], first.id, verifiedLoopPositionRead), true)
assert.equal(loopPositionFullyClosed([first], first.id, verifiedLoopPositionRead), false, 'confirmed signature alone does not confirm zero debt')
assert.equal(loopPositionFullyClosed([{ ...first, liability: { ...first.liability, amount: '0', amountBaseUnits: '0' } }], first.id, verifiedLoopPositionRead), false,
  'residual obligation collateral keeps full-close reconciliation pending')
assert.equal(loopPositionFullyClosed([{ ...first, liability: { amount: '0', amountBaseUnits: null } }], first.id, verifiedLoopPositionRead), false,
  'unknown debt state is never treated as a completed close')
assert.equal(loopPositionFullyClosed([{
  ...first, liability: { amount: '0', amountBaseUnits: null }, collateral: { ...first.collateral, amount: '0', amountBaseUnits: '0' },
}], first.id, verifiedLoopPositionRead), false, 'an absent debt amount cannot pass as zero even when collateral is zero')
assert.equal(loopPositionFullyClosed([{
  ...first, liability: { ...first.liability, amount: '0', amountBaseUnits: '0.000000000001' },
  collateral: { ...first.collateral, amount: '0', amountBaseUnits: '0' },
}], first.id, verifiedLoopPositionRead), false,
  'sub-display-unit raw debt remains nonzero even when the rounded UI amount is zero')
assert.equal(loopPositionFullyClosed([{
  ...first,
  collateral: { ...first.collateral, amount: '0', amountBaseUnits: '0' },
  liability: { ...first.liability, amount: '0', amountBaseUnits: '0' },
  obligation: { ...first.obligation, balances: {
    deposits: [{ reserve: 'extra-reserve', cTokenBaseUnits: '1', amountBaseUnits: '1.5' }], borrows: [],
  } },
}], first.id, verifiedLoopPositionRead), false, 'a residual collateral reserve keeps the whole Multiply obligation open')
assert.equal(loopPositionFullyClosed([{
  ...first,
  collateral: { ...first.collateral, amount: '0', amountBaseUnits: '0' },
  liability: { ...first.liability, amount: '0', amountBaseUnits: '0' },
  obligation: { ...first.obligation, balances: {
    deposits: [], borrows: [{ reserve: 'extra-reserve', amountScaled: '1', amountBaseUnits: '0.000000000000000001' }],
  } },
}], first.id, verifiedLoopPositionRead), false, 'a residual borrow reserve keeps the whole Multiply obligation open')
const extraReservePosition = {
  ...first, obligation: { ...first.obligation, unsupportedReserves: ['extra-reserve'] },
}
assert.equal(selectedLoopCloseReadiness(genericCloseReadiness, extraReservePosition, wallet, verifiedLoopPositionRead).executionEnabled, false,
  'an unsupported extra reserve blocks client close readiness')
assert.equal(loopPositionFullyClosed([{ ...first, obligation: { address: first.obligation.address, type: 'multiply' },
  collateral: { ...first.collateral, amount: '0', amountBaseUnits: '0' },
  liability: { ...first.liability, amount: '0', amountBaseUnits: '0' },
}], first.id, verifiedLoopPositionRead), false, 'missing whole-obligation state cannot verify a full close')

// Exercise the real transaction index, analytics reader, liquidation decoder and snapshot reader with RPC/storage fakes.
const require = createRequire(import.meta.url)
const initObligation = require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initObligation.js')
const liquidate = require('@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/liquidateObligationAndRedeemReserveCollateral.js')
const marketConfig = LIVE[0]
const owner = bs58.encode(Buffer.alloc(32, 41))
const payer = bs58.encode(Buffer.alloc(32, 42))
const vanillaAddress = bs58.encode(Buffer.alloc(32, 43))
const multiplyAddress = bs58.encode(Buffer.alloc(32, 44))
const authority = bs58.encode(Buffer.alloc(32, 45))
const repayVault = bs58.encode(Buffer.alloc(32, 46))
const collateralSupply = bs58.encode(Buffer.alloc(32, 47))
const withdrawVault = bs58.encode(Buffer.alloc(32, 48))
const liquidator = bs58.encode(Buffer.alloc(32, 49))
const transferSource = bs58.encode(Buffer.alloc(32, 50))
const usdcConfig = TOKENS['svm-usdc']
const usdyConfig = TOKENS['svm-usdy']
const transactionKeys = [owner, payer, vanillaAddress, multiplyAddress, marketConfig.kaminoMarket, authority,
  LIVE[0].reserves['svm-usdc'], usdcConfig.mint, repayVault, LIVE[0].reserves['svm-usdy'], usdyConfig.mint, usdyConfig.mint,
  collateralSupply, withdrawVault, liquidator, 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', transferSource]
const ix = (programIdIndex, accounts, data) => ({ programIdIndex, accounts, data: bs58.encode(data) })
const transferData = (amount) => {
  const data = Buffer.alloc(9)
  data[0] = 3
  data.writeBigUInt64LE(BigInt(amount), 1)
  return bs58.encode(data)
}
let indexedStateWritten
const fakeTransaction = {
  transaction: { message: { accountKeys: transactionKeys, instructions: [
    ix(15, [0, 1, 2, 4], initObligation.DISCRIMINATOR),
    ix(15, [0, 1, 3, 4], initObligation.DISCRIMINATOR),
    ix(15, [14, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], liquidate.DISCRIMINATOR),
  ] } },
  meta: { loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [{ index: 2, instructions: [
    { programIdIndex: 16, accounts: [17, 8], data: transferData(25_000_000) },
    { programIdIndex: 16, accounts: [13, 14], data: transferData(27_000_000) },
  ] }] }, blockTime: 100,
}
const indexedState = await refreshIndex({
  getSignaturesForAddress: () => ({ send: async () => [{ signature: 'loop-consumer-fixture', err: null }] }),
  getTransaction: () => ({ send: async () => fakeTransaction }),
}, {
  markets: [marketConfig], vaults: [], readIndex: async () => null,
  writeIndex: async (serialized) => { indexedStateWritten = JSON.parse(serialized) },
})
assert.deepEqual(indexedState.obligations[marketConfig.kaminoMarket], [vanillaAddress, multiplyAddress],
  'the transaction index records both vanilla and Multiply obligation initialization through the real instruction parser')
assert.equal(indexedState.liquidations[0].owner, owner, 'liquidation index resolves its owner from obligations indexed earlier in the transaction')
assert.deepEqual(indexedStateWritten.obligations[marketConfig.kaminoMarket], [vanillaAddress, multiplyAddress],
  'the index persistence boundary stores both obligation kinds')

const liveObligations = [
  { state: { owner }, refreshedStats: { userTotalDeposit: '100', userTotalBorrow: '20', loanToValue: '0.2', liquidationLtv: '0.95', borrowLiquidationLimit: '95' } },
  { state: { owner }, refreshedStats: { userTotalDeposit: '200', userTotalBorrow: '80', loanToValue: '0.4', liquidationLtv: '0.95', borrowLiquidationLimit: '100' } },
]
const fetchedAddresses = []
const liveMarket = {
  state: { referralFeeBps: 0 },
  async getMultipleObligationsByAddress(addresses) { fetchedAddresses.push(addresses.map(String)); return liveObligations },
  getReserveByAddress(reserveAddress) {
    return {
      address: String(reserveAddress),
      getEstimatedCollateralExchangeRate: () => ({ toNumber: () => 1 }),
      totalSupplyAPY: () => 0, totalBorrowAPY: () => 0, calculateUtilizationRatio: () => 0,
    }
  },
}
const analyticsPositions = await readPositions({
  indexReader: async () => indexedState,
  markets: [marketConfig],
  marketReader: () => ({ market: liveMarket, now: {} }),
})
assert.deepEqual(fetchedAddresses[0], [vanillaAddress, multiplyAddress], 'analytics reads the complete indexed obligation set')
assert.equal(analyticsPositions.length, 2, 'analytics returns both coexisting vanilla and Multiply positions')
assert.equal(analyticsPositions.reduce((sum, position) => sum + position.deposits, 0), 300)
assert.equal(analyticsPositions[0].debt, 80, 'analytics preserves SDK refreshed position summary units')

const historyForSnapshot = { tokens: {}, vaults: {} }
const snapshotBalances = await readMarkets(historyForSnapshot, {
  indexReader: async () => indexedState,
  ledgerReader: async () => ({ blockTime: 200 }),
  markets: [marketConfig], vaults: [],
  marketLoader: async () => liveMarket,
  firstTxTimeReader: async () => 100,
  vaultDayReader: async () => {},
})
assert.equal(snapshotBalances.get(owner), 300, 'snapshot reader includes both indexed obligations in supplied balances')
assert.equal(snapshotPoints([], snapshotBalances, 200)[0].supplied, 300, 'Farm Points snapshot carries the combined vanilla and Multiply deposits')

console.log('Multiply loop consumer readiness ok')
