import assert from 'node:assert/strict'
import { createBorrowerFlowIntentStore, createSwapIntentStore, TransactionIntentError } from './tx-intent.js'

let now = 1_000
let id = 0
const store = createSwapIntentStore({ now: () => now, ttlMs: 50, idFactory: () => `intent-${++id}` })
const wallet = '11111111111111111111111111111111'
const message = Uint8Array.from([1, 2, 3, 4])
const issued = store.issue({ wallet, messageBytes: message, metadata: { inputMint: 'USDC', amount: '100' } })
message[0] = 9
assert.equal(issued.id, 'intent-1')
assert.equal(issued.expiresAt, 1_050)
assert.deepEqual(issued.metadata, { inputMint: 'USDC', amount: '100' })
assert.throws(() => store.assertAndConsume(issued.id, '22222222222222222222222222222222', Uint8Array.from([1, 2, 3, 4])), TransactionIntentError)
assert.equal(store.size(), 1, 'wallet mismatch must not consume a valid intent')
assert.throws(() => store.assertAndConsume(issued.id, wallet, Uint8Array.from([1, 2, 3, 5])), /transaction changed/i)
assert.equal(store.size(), 1, 'message mismatch must not consume a valid intent')
assert.deepEqual(store.assertAndConsume(issued.id, wallet, Uint8Array.from([1, 2, 3, 4])), {
  id: issued.id, wallet, expiresAt: 1_050, metadata: { inputMint: 'USDC', amount: '100' },
})
assert.equal(store.size(), 0)
assert.throws(() => store.assertAndConsume(issued.id, wallet, Uint8Array.from([1, 2, 3, 4])), /unknown or already used/i)

const expired = store.issue({ wallet, messageBytes: Uint8Array.from([5]) })
now = 1_050
assert.throws(() => store.assertAndConsume(expired.id, wallet, Uint8Array.from([5])), /expired/i)
assert.equal(store.size(), 0)
assert.throws(() => store.issue({ wallet, messageBytes: new Uint8Array() }), /transaction message/i)
assert.throws(() => store.issue({ wallet: 'bad', messageBytes: Uint8Array.from([1]) }), /wallet/i)

now = 2_000
const quoteCapped = store.issue({ wallet, messageBytes: Uint8Array.from([6]), expiresAt: 2_025 })
assert.equal(quoteCapped.expiresAt, 2_025, 'intent lifetime must be capped by its quote expiry')
const alreadyExpired = () => store.issue({ wallet, messageBytes: Uint8Array.from([7]), expiresAt: now })
assert.throws(alreadyExpired, /expired/i, 'an expired quote cannot issue an intent')
now = 2_025
assert.throws(() => store.assertAndConsume(quoteCapped.id, wallet, Uint8Array.from([6])), /expired/i)

const flowIntents = createBorrowerFlowIntentStore({ now: () => now, ttlMs: 100, idFactory: () => `flow-${++id}` })
const flowMetadata = {
  kind: 'borrower-flow', flow: 'acquire-supply', stage: 'supply', action: 'deposit',
  marketId: 'sol-usdy-usdc', tokenId: 'svm-usdy', amountBaseUnits: '25000000',
}
const flowIntent = flowIntents.issue({ wallet, messageBytes: Uint8Array.of(8, 9), metadata: flowMetadata })
assert.deepEqual(flowIntents.assertAndConsume(flowIntent.id, wallet, Uint8Array.of(8, 9)).metadata, flowMetadata)
assert.throws(() => flowIntents.issue({ wallet, messageBytes: Uint8Array.of(8), metadata: { ...flowMetadata, action: 'withdraw' } }), /does not match/i)
assert.throws(() => flowIntents.issue({ wallet, messageBytes: Uint8Array.of(8), metadata: { ...flowMetadata, amountBaseUnits: '-1' } }), /amount/i)
assert.throws(() => flowIntents.issue({ wallet, messageBytes: Uint8Array.of(8), metadata: { ...flowMetadata, kind: 'swap' } }), /borrower flow/i)

console.log('transaction intents ok')
