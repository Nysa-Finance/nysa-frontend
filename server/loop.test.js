import assert from 'node:assert/strict'
import Decimal from 'decimal.js'
import { address } from '@solana/kit'
import { TOKENS } from '../src/config.js'
import { buildLoopPreview, createKaminoSwapCallbacks } from './loop.js'

const usdc = TOKENS['svm-usdc'].mint
const usdy = TOKENS['svm-usdy'].mint
const wallet = '11111111111111111111111111111111'
const feeAccount = 'SysvarRent111111111111111111111111111111111'
const instruction = { programAddress: address(wallet), accounts: [], data: new Uint8Array([1]) }
let buildRequests = []
const buildSwapFn = async (request) => {
  buildRequests.push(request)
  return {
    inputAmountBaseUnits: request.inputAmountBaseUnits,
    outputAmountBaseUnits: request.outputMint === usdy ? '1098900' : '909000',
    minimumOutputBaseUnits: request.outputMint === usdy ? '1093000' : '904000',
  fee: { bps: 10, mint: request.outputMint, amountBaseUnits: '1100', routeDeltaVerified: true },
    feeVerified: true,
    feeAccountMintVerified: true,
    feeBalanceDeltaVerified: true,
    executable: true,
    programPolicy: { approved: true },
    instructions: [instruction],
    addressesByLookupTableAddress: {},
  }
}
const callbacks = createKaminoSwapCallbacks({
  wallet,
  buildSwapFn,
  getFeeAccount: async (mint) => ({ account: feeAccount, mint }),
  tokenDecimals: { [usdc]: 6, [usdy]: 6 },
})

const inputs = { inputAmountLamports: new Decimal('1000000'), inputMint: address(usdc), outputMint: address(usdy) }
const quote = await callbacks.quoter(inputs, [])
assert.equal(quote.priceAInB.toString(), '1.0989')
assert.equal(quote.quoteResponse.outputAmountBaseUnits, '1098900')
assert.equal(buildRequests[0].feeBps, 10)
assert.equal(buildRequests[0].feeAccount, feeAccount)
assert.equal(buildRequests[0].feeAccountMint, usdy)

const swapped = await callbacks.swapper(inputs, [], quote)
assert.deepEqual(swapped[0].preActionIxs, [])
assert.deepEqual(swapped[0].swapIxs, [instruction])
assert.deepEqual(swapped[0].lookupTables, [])
assert.equal(swapped[0].quote, quote)

await assert.rejects(callbacks.swapper({ ...inputs, minOutAmountLamports: new Decimal('1095000') }, [], quote), /minimum output/i)

const missingFeeAccount = createKaminoSwapCallbacks({ wallet, buildSwapFn, getFeeAccount: async () => null, tokenDecimals: { [usdc]: 6, [usdy]: 6 } })
await assert.rejects(missingFeeAccount.quoter(inputs, []), /fee account/i)

const unverifiedBalanceDelta = createKaminoSwapCallbacks({
  wallet,
  getFeeAccount: async (mint) => ({ account: feeAccount, mint }),
  tokenDecimals: { [usdc]: 6, [usdy]: 6 },
  buildSwapFn: async (request) => ({
    inputAmountBaseUnits: request.inputAmountBaseUnits,
    outputAmountBaseUnits: '1098900', minimumOutputBaseUnits: '1093000',
    fee: { bps: 10, mint: request.outputMint, amountBaseUnits: '1100', routeDeltaVerified: true },
    feeVerified: false, feeAccountMintVerified: true, feeBalanceDeltaVerified: false, executable: false,
    programPolicy: { approved: true }, instructions: [instruction], addressesByLookupTableAddress: {},
  }),
})
const unverifiedQuote = await unverifiedBalanceDelta.quoter(inputs, [])
await assert.rejects(unverifiedBalanceDelta.swapper(inputs, [], unverifiedQuote), /fee|simulation/i)

const strategy = { enabled: false, unavailableReasons: [{ code: 'no-approval', message: 'Risk approval is not configured.' }], carry: { estimatedCarryPct: null } }
const preview = buildLoopPreview({
  fundingAmount: '1000', leverage: 1.5, strategy,
  maxBorrowLtvPct: 90, liquidationLtvPct: 95,
  acquisitionQuote: { fee: { mint: usdy, amountBaseUnits: '1000', bps: 10 } },
  leverageQuote: { fee: { mint: usdy, amountBaseUnits: '2000', bps: 10 } },
})
assert.equal(preview.exposure.grossCollateral, '1500')
assert.equal(preview.exposure.debt, '500')
assert.equal(preview.limits.projectedLtvPct, 38)
assert.equal(preview.risk.projectedLtvPct, '33.33333333333333333333333333333333333333')
assert.equal(preview.fees.length, 2)
assert.equal(preview.available, false)
assert.ok(preview.unavailableReasons.some((x) => x.code === 'no-approval'))

console.log('loop preview ok')
