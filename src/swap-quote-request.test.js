import assert from 'node:assert/strict'
import { createLatestRequestGate } from './swap-quote-request.js'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const gate = createLatestRequestGate()
const first = gate.begin('wallet-a|usdc|usdy|1|50')
const second = gate.begin('wallet-a|usdc|usdy|2|50')
assert.equal(first.signal.aborted, true, 'starting a newer quote aborts the old request')
assert.equal(first.isCurrent('wallet-a|usdc|usdy|1|50'), false)
assert.equal(second.isCurrent('wallet-a|usdc|usdy|2|50'), true)
assert.equal(second.isCurrent('wallet-a|usdc|usdy|1|50'), false)

gate.invalidate()
assert.equal(second.signal.aborted, true, 'form/wallet changes abort active request')
assert.equal(second.isCurrent('wallet-a|usdc|usdy|2|50'), false)
const afterInvalidate = gate.begin('wallet-b|usdy|usdc|1|50')
assert.equal(afterInvalidate.isCurrent('wallet-b|usdy|usdc|1|50'), true)

afterInvalidate.cancel()
assert.equal(afterInvalidate.signal.aborted, true)
assert.equal(afterInvalidate.isCurrent('wallet-b|usdy|usdc|1|50'), false)

const responses = createLatestRequestGate()
const firstResult = deferred(), secondResult = deferred()
let visibleQuote = null
const firstRequest = responses.begin('same-wallet|usdc|usdy|1|50')
const firstCommit = firstResult.promise.then((quote) => { if (firstRequest.isCurrent('same-wallet|usdc|usdy|1|50')) visibleQuote = quote })
const secondRequest = responses.begin('same-wallet|usdc|usdy|2|50')
const secondCommit = secondResult.promise.then((quote) => { if (secondRequest.isCurrent('same-wallet|usdc|usdy|2|50')) visibleQuote = quote })
secondResult.resolve('new amount route')
await secondCommit
firstResult.resolve('stale old amount route')
await firstCommit
assert.equal(visibleQuote, 'new amount route', 'late prior response cannot replace the quote for current form')

console.log('swap quote request gate ok')
