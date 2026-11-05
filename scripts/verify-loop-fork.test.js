import assert from 'node:assert/strict'
import { address, generateKeyPairSigner } from '@solana/kit'
import { assertLoopbackForkEndpoint, missingForkPrerequisites, verifyLoopFork } from './verify-loop-fork.js'
import * as fork from './verify-loop-fork.js'

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
assert.deepEqual(fork.missingLocalExecutionInputs({}), ['LOCAL_FORK_TEST_WALLET_SECRET_KEY (64-byte JSON keypair)', 'LOCAL_FORK_STARTING_USDC_BASE_UNITS'])
assert.deepEqual(fork.missingLocalExecutionInputs({
  LOCAL_FORK_TEST_WALLET_SECRET_KEY: JSON.stringify(Array(64).fill(1)),
  LOCAL_FORK_STARTING_USDC_BASE_UNITS: '10000000',
}), [])
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

assert.equal(typeof fork.assertTokenBalanceDelta, 'function')
assert.doesNotThrow(() => fork.assertTokenBalanceDelta({ beforeBaseUnits: '100', afterBaseUnits: '110', expectedBaseUnits: '10', label: 'USDY fee account' }))
assert.throws(() => fork.assertTokenBalanceDelta({ beforeBaseUnits: '100', afterBaseUnits: '109', expectedBaseUnits: '10', label: 'USDY fee account' }), /delta/i)
assert.equal(typeof fork.assertTokenBalanceChange, 'function')
assert.doesNotThrow(() => fork.assertTokenBalanceChange({ beforeBaseUnits: '100', afterBaseUnits: '0', expectedChangeBaseUnits: -100n, label: 'USDC input' }))
assert.equal(typeof fork.forcedFailureInstruction, 'function')
assert.deepEqual([...fork.forcedFailureInstruction().data], [255])
assert.equal(typeof fork.composeAtomicOpenInstructions, 'function')
const testAta = '11111111111111111111111111111111'
const testAtaCreate = { programAddress: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), accounts: [{ address: 'SysvarRent111111111111111111111111111111111' }, { address: testAta }], data: new Uint8Array([1]) }
const testCompute = { programAddress: address('ComputeBudget111111111111111111111111111111'), accounts: [], data: new Uint8Array([3]) }
const testSwap = { programAddress: address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), accounts: [], data: new Uint8Array([1]) }
const testOpen = { programAddress: address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'), accounts: [], data: new Uint8Array([1]) }
assert.deepEqual(fork.composeAtomicOpenInstructions([testCompute, testAtaCreate, testSwap], [testAtaCreate, testOpen], new Set([testAta])).map((ix) => ix.programAddress), [testCompute.programAddress, testSwap.programAddress, testOpen.programAddress])
assert.deepEqual(fork.composeAtomicOpenInstructions([testCompute, testAtaCreate, testSwap], [testAtaCreate, testOpen]).map((ix) => ix.programAddress), [testCompute.programAddress, testAtaCreate.programAddress, testSwap.programAddress, testOpen.programAddress])
const testSigner = await generateKeyPairSigner()
const signedLocal = await fork.compileSignedLocalTransaction({
  getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n } }) }),
}, testSigner, [fork.forcedFailureInstruction()])
assert.ok(Buffer.from(signedLocal, 'base64').byteLength > 0)

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
