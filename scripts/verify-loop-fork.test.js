import assert from 'node:assert/strict'
import { assertLoopbackForkEndpoint, missingForkPrerequisites, verifyLoopFork } from './verify-loop-fork.js'

assert.equal(assertLoopbackForkEndpoint('http://127.0.0.1:8899').hostname, '127.0.0.1')
assert.equal(assertLoopbackForkEndpoint('http://localhost:8899').hostname, 'localhost')
assert.equal(assertLoopbackForkEndpoint('http://[::1]:8899').hostname, '[::1]')
assert.throws(() => assertLoopbackForkEndpoint('https://api.mainnet-beta.solana.com'), /local HTTP/)
assert.throws(() => assertLoopbackForkEndpoint('http://mainnet.localhost.example:8899'), /loopback/)
assert.throws(() => assertLoopbackForkEndpoint('file:///tmp/validator'), /HTTP/)

assert.deepEqual(missingForkPrerequisites({}), [
  'LOCAL_FORK_TEST_WALLET',
  'LOCAL_FORK_FEE_ACCOUNT_USDC',
  'LOCAL_FORK_FEE_ACCOUNT_USDY',
  'LOCAL_FORK_TREASURY_AUTHORITY',
])
assert.deepEqual(missingForkPrerequisites({
  LOCAL_FORK_TEST_WALLET: '11111111111111111111111111111111',
  LOCAL_FORK_FEE_ACCOUNT_USDC: '11111111111111111111111111111111',
  LOCAL_FORK_FEE_ACCOUNT_USDY: '11111111111111111111111111111111',
  LOCAL_FORK_TREASURY_AUTHORITY: '11111111111111111111111111111111',
}), [])
assert.deepEqual(missingForkPrerequisites({
  LOCAL_FORK_TEST_WALLET: 'not-an-address',
  LOCAL_FORK_FEE_ACCOUNT_USDC: '11111111111111111111111111111111',
  LOCAL_FORK_FEE_ACCOUNT_USDY: '11111111111111111111111111111111',
  LOCAL_FORK_TREASURY_AUTHORITY: '11111111111111111111111111111111',
}), ['LOCAL_FORK_TEST_WALLET (invalid address)'])

const calls = []
const messages = []
assert.equal(await verifyLoopFork({
  env: { LOCAL_FORK_RPC: 'https://api.mainnet-beta.solana.com' },
  fetcher: async (...args) => { calls.push(args); throw new Error('must not call remote endpoint') },
  log: (message) => messages.push(message),
}), 1)
assert.deepEqual(calls, [])
assert.match(messages.join('\n'), /local HTTP/)

console.log('loop fork guard ok')
