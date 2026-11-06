import assert from 'node:assert/strict'
import { loopPreviewRequestMatches } from './loop-preview-request.js'

const request = { fundingAmount: '100', leverage: 1.5, wallet: 'wallet-a' }
const current = { fundingAmount: '100', leverage: 1.5, wallet: 'wallet-a' }
assert.equal(loopPreviewRequestMatches({ request, current, requestId: 2, currentRequestId: 2 }), true)
assert.equal(loopPreviewRequestMatches({ request, current: { ...current, wallet: 'wallet-b' }, requestId: 2, currentRequestId: 2 }), false,
  'a delayed response for the previous wallet cannot replace the current preview')
assert.equal(loopPreviewRequestMatches({ request, current: { ...current, fundingAmount: '101' }, requestId: 2, currentRequestId: 2 }), false,
  'a delayed response for an old funding amount cannot replace the current preview')
assert.equal(loopPreviewRequestMatches({ request, current: { ...current, leverage: 1.4 }, requestId: 2, currentRequestId: 2 }), false,
  'a delayed response for an old leverage cannot replace the current preview')
assert.equal(loopPreviewRequestMatches({ request, current, requestId: 1, currentRequestId: 2 }), false,
  'a superseded request cannot replace the latest preview even when inputs later return to the same values')
console.log('loop preview request binding ok')
