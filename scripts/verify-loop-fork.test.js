import assert from 'node:assert/strict'
import {
  address, appendTransactionMessageInstructions, compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner, createTransactionMessage, generateKeyPairSigner, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, none, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from '@solana/kit'
import BN from 'bn.js'
import { flashBorrowReserveLiquidity, flashRepayReserveLiquidity, PROGRAM_ID } from '@kamino-finance/klend-sdk'
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
assert.equal(fork.stringifyErrorDetails({ custom: 'simulation-error', slot: 11n }), '{"custom":"simulation-error","slot":"11"}')

assert.equal(typeof fork.assertTokenBalanceDelta, 'function')
assert.doesNotThrow(() => fork.assertTokenBalanceDelta({ beforeBaseUnits: '100', afterBaseUnits: '110', expectedBaseUnits: '10', label: 'USDY fee account' }))
assert.throws(() => fork.assertTokenBalanceDelta({ beforeBaseUnits: '100', afterBaseUnits: '109', expectedBaseUnits: '10', label: 'USDY fee account' }), /observedDelta=9, expectedDelta=10/i)
assert.equal(typeof fork.assertTokenBalanceChange, 'function')
assert.doesNotThrow(() => fork.assertTokenBalanceChange({ beforeBaseUnits: '100', afterBaseUnits: '0', expectedChangeBaseUnits: -100n, label: 'USDC input' }))
assert.equal(await fork.readLocalSlot({ getSlot: () => ({ send: async () => 987654 }) }), 987654, 'Kit getSlot returns the slot number directly')
assert.equal(await fork.readLocalSlot({ getSlot: () => ({ send: async () => 987654n }) }), 987654, 'large numeric JSON-RPC slot results normalize safely from bigint')
await assert.rejects(fork.readLocalSlot({ getSlot: () => ({ send: async () => ({ value: 987654 }) }) }), /slot/i)
assert.equal(typeof fork.forcedFailureInstruction, 'function')
assert.deepEqual([...fork.forcedFailureInstruction().data], [255])
assert.equal(typeof fork.composeAtomicOpenInstructions, 'function')
const testAta = '11111111111111111111111111111111'
const testAtaCreate = { programAddress: address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), accounts: [{ address: 'SysvarRent111111111111111111111111111111111' }, { address: testAta }], data: new Uint8Array([1]) }
const testCompute = { programAddress: address('ComputeBudget111111111111111111111111111111'), accounts: [], data: new Uint8Array([3]) }
const duplicateCompute = { ...testCompute, data: Uint8Array.from(testCompute.data) }
const testSwap = { programAddress: address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), accounts: [], data: new Uint8Array([1]) }
const testOpen = { programAddress: address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'), accounts: [], data: new Uint8Array([1]) }
const upstreamLookupTable = { address: address('SysvarRent111111111111111111111111111111111'), data: { addresses: [] } }
const temporaryLookupTable = { address: address('SysvarC1ock11111111111111111111111111111111'), data: { addresses: [] } }
assert.deepEqual(fork.lookupTablesForAtomicOpen([upstreamLookupTable], temporaryLookupTable), [temporaryLookupTable], 'temporary local table is used exclusively for the composed fork open')
assert.equal(fork.composeAtomicOpenInstructions([testCompute, duplicateCompute, testSwap], [duplicateCompute, testOpen]).filter((ix) => String(ix.programAddress) === String(testCompute.programAddress)).length, 1, 'identical setup compute-budget instructions are emitted once')
assert.deepEqual(fork.composeAtomicOpenInstructions([testCompute, testAtaCreate, testSwap], [testAtaCreate, testOpen], new Set([testAta])).map((ix) => ix.programAddress), [testCompute.programAddress, testSwap.programAddress, testOpen.programAddress])
assert.deepEqual(fork.composeAtomicOpenInstructions([testCompute, testAtaCreate, testSwap], [testAtaCreate, testOpen]).map((ix) => ix.programAddress), [testCompute.programAddress, testAtaCreate.programAddress, testSwap.programAddress, testOpen.programAddress])
const testAta2 = address('SysvarC1ock11111111111111111111111111111111')
const lookupCandidates = fork.collectLookupTableAddresses([
  { programAddress: testSwap.programAddress, accounts: [{ address: testAta }, { address: testAta2 }], data: new Uint8Array([1]) },
  { programAddress: testOpen.programAddress, accounts: [{ address: testAta2 }], data: new Uint8Array([2]) },
], [testAta])
assert.deepEqual(lookupCandidates, [String(testSwap.programAddress), String(testAta2), String(testOpen.programAddress)], 'local lookup-table setup excludes the wallet signer and deduplicates keys in first-use order')
const owner = createNoopSigner(address(testAta))
const klend = address(PROGRAM_ID)
const fake = address('SysvarRent111111111111111111111111111111111')
const tokenProgram = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const flashCommon = {
  userTransferAuthority: owner,
  lendingMarketAuthority: fake,
  lendingMarket: fake,
  reserve: fake,
  reserveLiquidityMint: fake,
  reserveLiquidityFeeReceiver: fake,
  referrerTokenState: none(),
  referrerAccount: none(),
  sysvarInfo: address('Sysvar1nstructions1111111111111111111111111'),
  tokenProgram,
}
const sdkFlashBorrow = flashBorrowReserveLiquidity({ liquidityAmount: new BN(123) }, {
  ...flashCommon, reserveSourceLiquidity: fake, userDestinationLiquidity: fake,
}, [], klend)
const sdkFlashRepay = (borrowInstructionIndex) => flashRepayReserveLiquidity({ liquidityAmount: new BN(123), borrowInstructionIndex }, {
  ...flashCommon, reserveDestinationLiquidity: fake, userSourceLiquidity: fake,
}, [], klend)
const assertFlashRepayPointsAtBorrow = (instructions, expectedIndex) => {
  const borrowIndex = instructions.findIndex((ix) => Buffer.from(ix.data).subarray(0, 8).equals(Buffer.from(sdkFlashBorrow.data).subarray(0, 8)))
  const repay = instructions.find((ix) => Buffer.from(ix.data).subarray(0, 8).equals(Buffer.from(sdkFlashRepay(0).data).subarray(0, 8)))
  assert.equal(borrowIndex, expectedIndex)
  assert.ok(repay, 'installed Kamino SDK flash repay instruction remains in composed open')
  assert.equal(repay.data[16], expectedIndex, 'flash repay ABI points to the final composed borrow instruction index')
}
const sdkOpenWithAtaSetups = [
  { programAddress: address('SysvarC1ock11111111111111111111111111111111'), accounts: [], data: new Uint8Array([7]) },
  { ...testAtaCreate, accounts: [testAtaCreate.accounts[0], { address: testAta }] },
  { ...testAtaCreate, accounts: [testAtaCreate.accounts[0], { address: testAta2 }] },
  sdkFlashBorrow,
  testOpen,
  testSwap,
  sdkFlashRepay(3),
  testCompute,
]
const composedWithSetup = fork.composeAtomicOpenInstructions(
  [testCompute, testAtaCreate, testSwap], sdkOpenWithAtaSetups,
)
assertFlashRepayPointsAtBorrow(composedWithSetup, 5)
assert.equal(sdkOpenWithAtaSetups[6].data[16], 3, 'composition does not mutate the SDK-owned instruction')
const sdkOpenWithPreexistingAtas = [
  sdkOpenWithAtaSetups[0], sdkOpenWithAtaSetups[1], sdkOpenWithAtaSetups[2], sdkFlashBorrow, testOpen, testSwap, sdkFlashRepay(3), testCompute,
]
const composedWithPreexistingAtas = fork.composeAtomicOpenInstructions(
  [testCompute, testSwap], sdkOpenWithPreexistingAtas, new Set([testAta, String(testAta2)]),
)
assertFlashRepayPointsAtBorrow(composedWithPreexistingAtas, 3)
const testSigner = await generateKeyPairSigner()
const lookupTableAddress = address('Sysvar1nstructions1111111111111111111111111')
const lookupTargetAddress = address('SysvarRent111111111111111111111111111111111')
let lookupMessage = createTransactionMessage({ version: 0 })
lookupMessage = setTransactionMessageFeePayerSigner(testSigner, lookupMessage)
lookupMessage = setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n }, lookupMessage)
lookupMessage = appendTransactionMessageInstructions([{
  programAddress: address('11111111111111111111111111111111'),
  accounts: [{ address: lookupTargetAddress }], data: new Uint8Array([1]),
}], lookupMessage)
lookupMessage = compressTransactionMessageUsingAddressLookupTables(lookupMessage, {
  [lookupTableAddress]: [lookupTargetAddress],
})
const lookupWire = getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(lookupMessage))
const lookupTx = getTransactionDecoder().decode(Buffer.from(lookupWire, 'base64'))
const decodedLookupMessage = getCompiledTransactionMessageDecoder().decode(lookupTx.messageBytes)
assert.deepEqual(decodedLookupMessage.addressTableLookups, [{
  lookupTableAddress, writableIndexes: [], readonlyIndexes: [0],
}], 'regression inspects the lookup indexes in a serialized v0 transaction')
assert.equal(fork.instructionProgramAddressAt(decodedLookupMessage, 0, [{
  address: lookupTableAddress, data: { addresses: [lookupTargetAddress] },
}]), String(address('11111111111111111111111111111111')))
assert.deepEqual(fork.instructionAccountAddressesAt?.(decodedLookupMessage, 0, [{
  address: lookupTableAddress, data: { addresses: [lookupTargetAddress] },
}]), [String(lookupTargetAddress)], 'diagnostic resolves the serialized instruction account meta through the lookup table')
const recentlyExtendedLookupTable = {
  address: lookupTableAddress,
  data: { addresses: [lookupTargetAddress], lastExtendedSlot: 10n, lastExtendedSlotStartIndex: 0 },
}
assert.throws(() => fork.assertV0LookupReferencesActive(decodedLookupMessage, [recentlyExtendedLookupTable], 10), /index 0 is inactive/i)
assert.doesNotThrow(() => fork.assertV0LookupReferencesActive(decodedLookupMessage, [recentlyExtendedLookupTable], 11))
assert.throws(() => fork.assertV0LookupReferencesActive(decodedLookupMessage, [{
  ...recentlyExtendedLookupTable, data: { ...recentlyExtendedLookupTable.data, addresses: [] },
}], 11), /index 0.*active address count 0/i)
const metadataAddress = address('SysvarRent111111111111111111111111111111111')
const metadataInstruction = { programAddress: address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'), accounts: [], data: new Uint8Array([1]) }
let metadataSetupOptions
const metadataSetup = await fork.prepareLocalUserMetadataSetup?.({
  market: { getUserMetadata: async () => [metadataAddress, null] },
  signer: { address: testSigner.address },
  builder: async (options) => { metadataSetupOptions = options; return { ixs: [metadataInstruction], labels: [`initUserMetadata[${metadataAddress}]`], luts: [] } },
})
assert.deepEqual(metadataSetup?.instructions, [metadataInstruction], 'local verifier returns a distinct user-metadata setup instruction')
assert.deepEqual(metadataSetupOptions?.initUserMetadata, { skipInitialization: false, skipLutCreation: true }, 'metadata setup initializes only the program-owned account and does not create a lookup table')
assert.equal(metadataSetup?.alreadyInitialized, false)
const existingMetadataSetup = await fork.prepareLocalUserMetadataSetup?.({
  market: { getUserMetadata: async () => [metadataAddress, { userLookupTable: address('11111111111111111111111111111111') }] },
  signer: { address: testSigner.address },
  builder: async () => { throw new Error('existing user metadata must not produce another setup instruction') },
})
assert.deepEqual(existingMetadataSetup?.instructions, [], 'existing user metadata avoids setup')
assert.equal(existingMetadataSetup?.alreadyInitialized, true)
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
