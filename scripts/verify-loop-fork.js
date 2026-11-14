import { pathToFileURL } from 'node:url'
import Decimal from 'decimal.js'
import {
  address, appendTransactionMessageInstructions, compressTransactionMessageUsingAddressLookupTables, lamports,
  createKeyPairSignerFromBytes, createNoopSigner, createTransactionMessage, fetchEncodedAccount, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getTransactionDecoder,
  none, signTransactionMessageWithSigners, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { fetchAddressLookupTable, getCreateLookupTableInstructionAsync, getExtendLookupTableInstruction } from '@solana-program/address-lookup-table'
import { getCurrentLedgerInstant, KaminoAction, MultiplyObligation, ObligationTypeTag, PROGRAM_ID } from '@kamino-finance/klend-sdk'
import { TOKENS, marketById } from '../src/config.js'
import { ataOf, maxWithdrawFromObligation, obligationType } from '../server/account.js'
import { loadMarket, reserveOf } from '../server/market.js'
import { buildSwap, inspectFeeTokenAccount } from '../server/swap.js'
import { createRpc } from '../server/rpc.js'
import { ROUTE_PROGRAM_IDS_BY_LABEL } from '../server/program-policy.js'
import { composeAtomicOpenInstructions } from '../server/loop-composition.js'
import { createLoopExecutionService } from '../server/loop-execution.js'
import { multiplyPosition } from '../server/positions.js'
import { validateProviderSwapInstructions } from '../server/swap-execution.js'
import {
  buildLoopCloseApplication, buildLoopOpenApplication, buildLoopPreview,
  createKaminoSwapCallbacks,
  quoteMultiplyOpenAtFinalAmount, sdkSlippagePctFromBps, simulateLoopApplication,
  verifyLoopApplicationSimulation,
} from '../server/loop.js'

export { composeAtomicOpenInstructions }

const FORK_ADDRESSES = [
  'LOCAL_FORK_TEST_WALLET',
  'LOCAL_FORK_FEE_ACCOUNT_USDC',
  'LOCAL_FORK_FEE_ACCOUNT_USDY',
  'LOCAL_FORK_TREASURY_AUTHORITY',
]
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function assertLoopbackForkEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('LOCAL_FORK_RPC is not set.')
  let endpoint
  try { endpoint = new URL(value) } catch { throw new Error('LOCAL_FORK_RPC must be a valid local HTTP URL.') }
  if (endpoint.protocol !== 'http:') throw new Error('LOCAL_FORK_RPC must use local HTTP; HTTPS endpoints are rejected.')
  if (!LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase())) throw new Error('LOCAL_FORK_RPC must use a local loopback host; public RPC endpoints are rejected.')
  if (endpoint.username || endpoint.password) throw new Error('LOCAL_FORK_RPC must not include credentials.')
  return endpoint
}

export function missingForkPrerequisites(env = {}) {
  return FORK_ADDRESSES.flatMap((name) => {
    const value = env[name]
    if (typeof value !== 'string' || !value.trim()) return [name]
    try { address(value) } catch { return [`${name} (invalid address)`] }
    return []
  })
}

export function missingLocalExecutionInputs(env = {}) {
  const missing = []
  let secretBytes
  try { secretBytes = JSON.parse(env.LOCAL_FORK_TEST_WALLET_SECRET_KEY) } catch { secretBytes = null }
  if (!Array.isArray(secretBytes) || secretBytes.length !== 64 || secretBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    missing.push('LOCAL_FORK_TEST_WALLET_SECRET_KEY (64-byte JSON keypair)')
  }
  if (typeof env.LOCAL_FORK_STARTING_USDC_BASE_UNITS !== 'string' || !/^\d+$/.test(env.LOCAL_FORK_STARTING_USDC_BASE_UNITS) || BigInt(env.LOCAL_FORK_STARTING_USDC_BASE_UNITS || '0') <= 0n) {
    missing.push('LOCAL_FORK_STARTING_USDC_BASE_UNITS')
  }
  return missing
}

export function assertLocalOracleFreshness({ now, oracles }) {
  if (!Number.isFinite(now) || !Array.isArray(oracles) || oracles.length === 0) {
    throw new Error('Local oracle freshness inputs are unavailable.')
  }
  const report = oracles.map(({ asset, feed, timestamp, heartbeatSeconds }) => ({
    asset: String(asset), feed: String(feed), ageSeconds: Math.max(0, now - Number(timestamp)),
    heartbeatSeconds: Number(heartbeatSeconds),
  }))
  if (report.some((item) => !Number.isFinite(item.ageSeconds) || !Number.isFinite(item.heartbeatSeconds)
    || item.heartbeatSeconds <= 0 || item.ageSeconds > item.heartbeatSeconds)) {
    throw new Error(`Local fork oracle preflight failed: ${JSON.stringify(report)}`)
  }
  return report
}

async function localRpc(fetcher, endpoint, method, params = []) {
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response?.ok) throw new Error('Local validator RPC is unavailable.')
  const body = await response.json()
  if (body?.error) throw new Error(`Local validator RPC ${method} failed.`)
  return body?.result
}

export async function readLocalSlot(rpcClient) {
  const result = await rpcClient.getSlot({ commitment: 'confirmed' }).send()
  const slot = typeof result === 'bigint' && result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Local validator getSlot did not return a safe slot number.')
  return slot
}

function localTokenAccount(value, mint, authority, name) {
  const raw = value?.data
  if (!value || !Array.isArray(raw) || typeof raw[0] !== 'string' || raw[1] !== 'base64') {
    throw new Error(`${name} is missing or is not a base64 token account on the local validator.`)
  }
  const account = inspectFeeTokenAccount({
    exists: true,
    programAddress: value.owner,
    data: Uint8Array.from(Buffer.from(raw[0], 'base64')),
  })
  if (!account || account.mint !== mint || account.authority !== authority) {
    throw new Error(`${name} must be an initialized real token account for the expected mint and disposable test treasury.`)
  }
}

export function assertTokenBalanceDelta({ beforeBaseUnits, afterBaseUnits, expectedBaseUnits, label }) {
  let before, after, expected
  try { before = BigInt(beforeBaseUnits); after = BigInt(afterBaseUnits); expected = BigInt(expectedBaseUnits) } catch { throw new Error(`${label} balance delta inputs are invalid.`) }
  if (before < 0n || after < 0n || expected < 0n || after - before !== expected) {
    throw new Error(`${label} fee balance delta does not match the provider-reported amount (before=${before}, after=${after}, observedDelta=${after - before}, expectedDelta=${expected}).`)
  }
}

function assertRouterFeeBalanceDelta({ beforeBaseUnits, afterBaseUnits, expectedBaseUnits, label }) {
  let before, after, expected
  try { before = BigInt(beforeBaseUnits); after = BigInt(afterBaseUnits); expected = BigInt(expectedBaseUnits) }
  catch { throw new Error(`${label} fee balance delta inputs are invalid.`) }
  const actual = after - before
  const roundingAllowance = 10n
  if (before < 0n || after < 0n || expected <= 0n || actual < 0n
    || actual > expected + roundingAllowance || actual + roundingAllowance < expected) {
    throw new Error(`${label} fee delta ${actual} does not match the provider amount ${expected} within ${roundingAllowance} base units of route rounding.`)
  }
  return String(actual)
}

export function assertTokenBalanceChange({ beforeBaseUnits, afterBaseUnits, expectedChangeBaseUnits, label }) {
  let before, after, expected
  try { before = BigInt(beforeBaseUnits); after = BigInt(afterBaseUnits); expected = BigInt(expectedChangeBaseUnits) } catch { throw new Error(`${label} balance change inputs are invalid.`) }
  if (before < 0n || after < 0n || after - before !== expected) throw new Error(`${label} token balance change does not match the expected amount.`)
}

export function assertPositiveBalanceIncreaseWithinMax({ beforeBaseUnits, afterBaseUnits, maxIncreaseBaseUnits, label }) {
  let before, after, maximum
  try { before = BigInt(beforeBaseUnits); after = BigInt(afterBaseUnits); maximum = BigInt(maxIncreaseBaseUnits) }
  catch { throw new Error(`${label} balance delta inputs are invalid.`) }
  const increase = after - before
  if (before < 0n || after < 0n || maximum <= 0n || increase <= 0n) {
    throw new Error(`${label} did not produce a positive confirmed wallet balance increase.`)
  }
  if (increase > maximum) throw new Error(`${label} balance increase exceeds the fresh allowance.`)
  return increase.toString()
}

async function sdkActionLookupTables(rpcClient, action) {
  return Promise.all((action?.luts ?? []).map(async (tableAddress) => {
    const table = await fetchAddressLookupTable(rpcClient, address(String(tableAddress)), { commitment: 'confirmed' })
    if (!table.exists) throw new Error('A Kamino action lookup table is absent on the local validator.')
    return table
  }))
}

async function executeStandaloneKaminoAction({ rpcClient, signer, action, tokenAccounts, label, assertBalances, log }) {
  const instructions = KaminoAction.actionToIxs(action)
  const lookupTables = await sdkActionLookupTables(rpcClient, action)
  const before = await snapshotTokenAccounts(rpcClient, tokenAccounts)
  const rollback = await compileSignedLocalTransaction(rpcClient, signer, [...instructions, forcedFailureInstruction()], lookupTables)
  const rollbackSimulation = await simulateLocalTransaction(rpcClient, rollback, tokenAccounts.map(String), lookupTables)
  if (!rollbackSimulation.err) throw new Error(`${label} forced-failure simulation unexpectedly succeeded.`)
  const rollbackResult = await submitAndConfirmLocal(rpcClient, rollback, true)
  if (!rollbackResult.failed) throw new Error(`${label} forced-failure transaction did not roll back.`)
  await assertNoTokenBalanceChanges(rpcClient, before, `${label} forced failure`)

  const transaction = await compileSignedLocalTransaction(rpcClient, signer, instructions, lookupTables)
  const simulation = await simulateLocalTransaction(rpcClient, transaction, tokenAccounts.map(String), lookupTables)
  if (simulation.err) throw new Error(`${label} simulation failed: ${stringifyErrorDetails({ error: simulation.err, logs: simulation.logs ?? [] })}`)
  if (!Array.isArray(simulation.accounts) || simulation.accounts.length !== tokenAccounts.length) {
    throw new Error(`${label} simulation omitted token account balances.`)
  }
  const instructionAccountAddresses = new Set(instructions.flatMap((instruction) => (instruction.accounts ?? [])
    .map((item) => String(typeof item === 'string' ? item : item?.address))
    .filter((item) => item && item !== 'undefined')))
  const simulatedAfter = tokenAccounts.map((account, index) => ({
    address: String(account),
    amount: simulatedTokenAccountAmount({
      value: simulation.accounts[index], account,
      beforeAmount: before.find((item) => String(item.address) === String(account))?.amount ?? '0',
      instructionAccountAddresses, label: `${label} simulated account ${account}`,
    }),
  }))
  assertBalances(before, simulatedAfter)
  const confirmed = await submitAndConfirmLocal(rpcClient, transaction)
  const after = await snapshotTokenAccounts(rpcClient, tokenAccounts)
  assertBalances(before, after)
  log(`LOCAL ${label.toUpperCase()} PASS: signature ${confirmed.signature}; forced-failure rollback preserved token balances.`)
  return { signature: confirmed.signature, before, after }
}

export function assertRouterSwapBalanceDeltas({ beforeInputBaseUnits, afterInputBaseUnits, beforeOutputBaseUnits, afterOutputBaseUnits, beforeFeeBaseUnits, afterFeeBaseUnits, inputAmountBaseUnits, minimumOutputBaseUnits, feeAmountBaseUnits, label }) {
  assertTokenBalanceChange({ beforeBaseUnits: beforeInputBaseUnits, afterBaseUnits: afterInputBaseUnits, expectedChangeBaseUnits: -BigInt(inputAmountBaseUnits), label: `${label} input` })
  const outputDelta = BigInt(afterOutputBaseUnits) - BigInt(beforeOutputBaseUnits)
  if (outputDelta < BigInt(minimumOutputBaseUnits)) throw new Error(`${label} output balance delta is below the route minimum.`)
  assertRouterFeeBalanceDelta({ beforeBaseUnits: beforeFeeBaseUnits, afterBaseUnits: afterFeeBaseUnits, expectedBaseUnits: feeAmountBaseUnits, label: `${label} fee account` })
  return String(outputDelta)
}

export function assertTokenBalanceSnapshotsUnchanged(before, after, label) {
  const afterByAddress = new Map(after.map((item) => [String(item.address), String(item.amount)]))
  for (const item of before) {
    if (afterByAddress.get(String(item.address)) !== String(item.amount)) {
      throw new Error(`${label} changed token balance ${item.address} despite transaction failure.`)
    }
  }
}

export function assertTokenBalanceDeltasForAccounts({ before, after, expectedByAddress = {}, label }) {
  const afterByAddress = new Map(after.map((item) => [String(item.address), String(item.amount)]))
  const beforeAddresses = new Set(before.map((item) => String(item.address)))
  if (afterByAddress.size !== beforeAddresses.size || [...afterByAddress.keys()].some((item) => !beforeAddresses.has(item))) {
    throw new Error(`${label} changed the token account set.`)
  }
  for (const item of before) {
    const account = String(item.address)
    const beforeAmount = BigInt(item.amount)
    const afterAmount = BigInt(afterByAddress.get(account))
    const expected = BigInt(expectedByAddress[account] ?? '0')
    if (afterAmount - beforeAmount !== expected) {
      throw new Error(`${label} ${account} balance delta was ${afterAmount - beforeAmount}; expected ${expected}.`)
    }
  }
}

export function assertRawAccountDataUnchanged(before, after, label) {
  if (!before?.address || !before?.owner || typeof before?.data !== 'string'
    || !after?.address || !after?.owner || typeof after?.data !== 'string') {
    throw new Error(`${label} account snapshot is incomplete.`)
  }
  if (String(after.address) !== String(before.address)
    || String(after.owner) !== String(before.owner)
    || after.data !== before.data) {
    throw new Error(`${label} account bytes changed.`)
  }
}

export function assertObligationRawBalancesZero(obligation, label) {
  const deposits = obligation?.state?.deposits
  const borrows = obligation?.state?.borrows
  if (!Array.isArray(deposits) || !Array.isArray(borrows)) throw new Error(`${label} omitted whole-obligation raw balances.`)
  const isNonzero = (value, field) => {
    let amount
    try { amount = BigInt(String(value)) } catch { throw new Error(`${label} has invalid raw ${field} state.`) }
    return amount !== 0n
  }
  if (deposits.some((item) => isNonzero(item.depositedAmount, 'collateral'))
    || borrows.some((item) => isNonzero(item.borrowedAmountSf, 'debt'))) {
    throw new Error(`${label} left nonzero Multiply obligation balances.`)
  }
}

async function snapshotRawProgramAccountData(rpcClient, account, label) {
  const { value } = await rpcClient.getAccountInfo(address(account), { encoding: 'base64', commitment: 'confirmed' }).send()
  if (!value || value.owner !== String(PROGRAM_ID) || !Array.isArray(value.data)
    || typeof value.data[0] !== 'string' || value.data[1] !== 'base64') {
    throw new Error(`${label} account is absent, has a foreign owner, or returned invalid bytes.`)
  }
  return { address: String(account), owner: value.owner, data: value.data[0] }
}

async function assertRawProgramAccountUnchanged(rpcClient, before, label) {
  const after = await snapshotRawProgramAccountData(rpcClient, before.address, label)
  assertRawAccountDataUnchanged(before, after, label)
  return after
}

export async function prepareLocalUserMetadataSetup({ market, signer, builder = KaminoAction.buildUserMetadataSetupIxs }) {
  const [userMetadataAddress, userMetadata] = await market.getUserMetadata(signer.address)
  if (userMetadata) return { userMetadataAddress, instructions: [], alreadyInitialized: true }

  const bundle = await builder({
    kaminoMarket: market,
    owner: signer,
    payer: signer,
    referrer: none(),
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
  })
  if (!Array.isArray(bundle?.ixs) || bundle.ixs.length !== 1 || (bundle.luts?.length ?? 0) !== 0) {
    throw new Error('Kamino user metadata setup must contain only its initialization instruction and no lookup-table setup.')
  }
  if (bundle.labels?.length !== 1 || !String(bundle.labels[0]).startsWith('initUserMetadata[')) {
    throw new Error('Kamino user metadata setup returned an unexpected instruction bundle.')
  }
  return { userMetadataAddress, instructions: bundle.ixs, alreadyInitialized: false }
}

export function forcedFailureInstruction() {
  return { programAddress: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), accounts: [], data: new Uint8Array([255]) }
}

export function collectLookupTableAddresses(instructions, excludedAddresses = []) {
  const excluded = new Set([...excludedAddresses].map(String))
  const found = new Set()
  for (const instruction of instructions ?? []) {
    const candidates = [instruction?.programAddress, ...(instruction?.accounts ?? []).map((account) =>
      typeof account === 'string' ? account : account?.address)]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || excluded.has(candidate)) continue
      try { found.add(String(address(candidate))) } catch { /* non-address metadata is not a table key */ }
    }
  }
  return [...found]
}

export function lookupTablesForAtomicOpen(upstreamLookupTables, temporaryLocalLookupTable) {
  return temporaryLocalLookupTable ? [temporaryLocalLookupTable] : upstreamLookupTables
}

export function assertV0LookupReferencesActive(message, lookupTables, bankSlot) {
  if (message?.version !== 0) throw new Error('Local simulation requires a compiled v0 message.')
  const slot = BigInt(bankSlot)
  const byAddress = new Map(lookupTables.map((table) => [String(table.address), table.data]))
  for (const lookup of message.addressTableLookups ?? []) {
    const table = byAddress.get(String(lookup.lookupTableAddress))
    if (!table) throw new Error(`Lookup table ${lookup.lookupTableAddress} referenced by v0 message is unavailable locally.`)
    const lastExtendedSlot = BigInt(table.lastExtendedSlot)
    if (lastExtendedSlot > slot) {
      throw new Error(`Lookup table ${lookup.lookupTableAddress} was last extended at slot ${lastExtendedSlot}, newer than simulation bank slot ${slot}.`)
    }
    const activeAddressCount = lastExtendedSlot === slot
      ? Number(table.lastExtendedSlotStartIndex)
      : table.addresses.length
    for (const index of [...lookup.writableIndexes, ...lookup.readonlyIndexes]) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= activeAddressCount) {
        throw new Error(`Lookup table ${lookup.lookupTableAddress} index ${index} is inactive at bank slot ${slot} (active address count ${activeAddressCount}).`)
      }
    }
  }
}

export function instructionProgramAddressAt(message, instructionIndex, lookupTables) {
  const instruction = message?.instructions?.[instructionIndex]
  if (!instruction) return null
  const allAddresses = messageAccountAddresses(message, lookupTables)
  const programAddress = allAddresses[instruction.programAddressIndex]
  return typeof programAddress === 'string' ? programAddress : null
}

export function instructionAccountAddressesAt(message, instructionIndex, lookupTables) {
  const instruction = message?.instructions?.[instructionIndex]
  if (!instruction) return null
  const allAddresses = messageAccountAddresses(message, lookupTables)
  const accounts = instruction.accountIndices.map((index) => allAddresses[index])
  return accounts.every((account) => typeof account === 'string') ? accounts : null
}

function messageAccountAddresses(message, lookupTables) {
  const byAddress = new Map(lookupTables.map((table) => [String(table.address), table.data.addresses]))
  const loadedWritable = []
  const loadedReadonly = []
  for (const lookup of message.addressTableLookups ?? []) {
    const addresses = byAddress.get(String(lookup.lookupTableAddress))
    if (!addresses) return null
    for (const index of lookup.writableIndexes) loadedWritable.push(addresses[index])
  }
  for (const lookup of message.addressTableLookups ?? []) {
    const addresses = byAddress.get(String(lookup.lookupTableAddress))
    if (!addresses) return null
    for (const index of lookup.readonlyIndexes) loadedReadonly.push(addresses[index])
  }
  return [...message.staticAccounts, ...loadedWritable, ...loadedReadonly]
}

export function stringifyErrorDetails(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
}

async function waitForLocalLookupTableActivation(rpcClient, tableAddress, requiredAddresses) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const [slot, table] = await Promise.all([
      rpcClient.getSlot({ commitment: 'confirmed' }).send(),
      fetchAddressLookupTable(rpcClient, tableAddress, { commitment: 'confirmed' }),
    ])
    if (table.exists && slot > Number(table.data.lastExtendedSlot)) {
      const fresh = await fetchAddressLookupTable(rpcClient, tableAddress, { commitment: 'confirmed' })
      const freshSlot = await readLocalSlot(rpcClient)
      if (!fresh.exists || freshSlot <= Number(fresh.data.lastExtendedSlot)) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        continue
      }
      const missing = requiredAddresses.filter((key) => !fresh.data.addresses.includes(key))
      if (missing.length) throw new Error(`Local address lookup table omitted ${missing.length} composed account address(es).`)
      return fresh
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Local address lookup table did not warm up before open composition.')
}

// Loopback fork only.
async function prepareLocalAddressLookupTable(rpcClient, signer, instructions) {
  const addresses = collectLookupTableAddresses(instructions, [String(signer.address)])
  if (!addresses.length) return null
  const slot = await readLocalSlot(rpcClient)
  if (slot < 1) throw new Error('Local validator slot is too low to create a lookup table.')
  const create = await getCreateLookupTableInstructionAsync({ authority: signer, payer: signer, recentSlot: slot - 1 })
  const tableAddress = address(String(create.accounts[0].address))
  const createTransaction = await compileSignedLocalTransaction(rpcClient, signer, [create])
  await submitAndConfirmLocal(rpcClient, createTransaction)
  for (let offset = 0; offset < addresses.length; offset += 20) {
    const extend = getExtendLookupTableInstruction({
      address: tableAddress,
      authority: signer,
      payer: signer,
      addresses: addresses.slice(offset, offset + 20).map((key) => address(key)),
    })
    const extendTransaction = await compileSignedLocalTransaction(rpcClient, signer, [extend])
    await submitAndConfirmLocal(rpcClient, extendTransaction)
  }
  return waitForLocalLookupTableActivation(rpcClient, tableAddress, addresses)
}

function tokenAmountBaseUnits(value, name) {
  const raw = value?.data
  const data = Array.isArray(raw) && typeof raw[0] === 'string' ? Buffer.from(raw[0], raw[1] === 'base64' ? 'base64' : 'utf8')
    : raw instanceof Uint8Array ? Buffer.from(raw) : null
  if (!data || data.length < 165) throw new Error(`${name} is missing or has invalid SPL token account data.`)
  return data.readBigUInt64LE(64).toString()
}

export function simulatedTokenAccountAmount({ value, account, beforeAmount, instructionAccountAddresses, label }) {
  if (value?.data != null) return tokenAmountBaseUnits(value, label)
  if (instructionAccountAddresses?.has(String(account))) {
    throw new Error(`${label} was used by the transaction but the local simulation omitted its account data.`)
  }
  // Surfpool may omit snapshots for requested accounts outside the message. Those accounts cannot
  // change during this transaction, so use their pre-simulation amount for the delta assertion.
  return String(beforeAmount)
}

async function readTokenAccount(rpcClient, account, allowMissing = false) {
  const { value } = await rpcClient.getAccountInfo(address(account), { encoding: 'base64', commitment: 'confirmed' }).send()
  if (!value && allowMissing) return { account: null, amount: '0' }
  if (!value) throw new Error('A local test token account disappeared.')
  return { account: value, amount: tokenAmountBaseUnits(value, account) }
}

async function localLookupTables(rpcClient, built) {
  const expected = built?.addressesByLookupTableAddress ?? {}
  return Promise.all(Object.entries(expected).map(async ([table, addresses]) => {
    const fetched = await fetchAddressLookupTable(rpcClient, address(table), { commitment: 'confirmed' })
    if (!fetched.exists || addresses.some((item) => !fetched.data.addresses.includes(item))) throw new Error('A provider lookup table is absent or changed on the local validator.')
    return fetched
  }))
}

export async function compileSignedLocalTransaction(rpcClient, signer, instructions, lookupTables = []) {
  const { value: blockhash } = await rpcClient.getLatestBlockhash({ commitment: 'confirmed' }).send()
  let message = createTransactionMessage({ version: 0 })
  message = setTransactionMessageFeePayerSigner(signer, message)
  message = setTransactionMessageLifetimeUsingBlockhash(blockhash, message)
  // Kamino builds owner accounts with createNoopSigner because the production wallet signs later. Here the same
  // keypair signs at once, so reuse it: @solana/kit rejects two signer objects for the same public key.
  const signerAddress = String(signer.address)
  const normalizedInstructions = instructions.map((instruction) => {
    if (!Array.isArray(instruction?.accounts)) return instruction
    let changed = false
    const accounts = instruction.accounts.map((account) => {
      if (!account?.signer || String(account.signer.address) !== signerAddress || account.signer === signer) return account
      changed = true
      return { ...account, signer }
    })
    return changed ? { ...instruction, accounts } : instruction
  })
  message = appendTransactionMessageInstructions(normalizedInstructions, message)
  if (lookupTables.length) {
    const contents = Object.fromEntries(lookupTables.map((table) => [String(table.address), table.data.addresses]))
    message = compressTransactionMessageUsingAddressLookupTables(message, contents)
  }
  const tx = getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message))
  const transactionBytes = Buffer.from(tx, 'base64').byteLength
  if (transactionBytes > 1232) throw new Error(`Local Multiply transaction is ${transactionBytes} bytes; Solana limit is 1232 bytes.`)
  return tx
}

async function simulateLocalTransaction(rpcClient, tx, accounts, lookupTables = []) {
  const transaction = getTransactionDecoder().decode(Buffer.from(tx, 'base64'))
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
  const simulationSlot = await readLocalSlot(rpcClient)
  assertV0LookupReferencesActive(message, lookupTables, simulationSlot)
  const { value } = await rpcClient.simulateTransaction(tx, {
    encoding: 'base64', sigVerify: true, commitment: 'confirmed',
    accounts: { addresses: accounts, encoding: 'base64' },
  }).send()
  return { ...value, compiledMessage: message }
}

async function submitAndConfirmLocal(rpcClient, tx, expectFailure = false) {
  const signature = await rpcClient.sendTransaction(tx, {
    encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: expectFailure, maxRetries: 0,
  }).send()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { value } = await rpcClient.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const status = value[0]
    if (status?.err) {
      if (expectFailure) return { signature, failed: true }
      throw new Error('Local validator rejected the economic transaction.')
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      if (expectFailure) throw new Error('Forced-failure transaction unexpectedly committed on the local validator.')
      return { signature, failed: false }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Local validator transaction confirmation timed out.')
}

async function confirmLocalSignature(rpcClient, signature) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { value } = await rpcClient.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const status = value[0]
    if (status?.err) throw new Error('Local validator rejected the test-wallet funding request.')
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Local test-wallet funding request confirmation timed out.')
}

async function assertFeeSimulationDeltas(rpcClient, simulation, feeAccounts, before, expectedByMint, composedSwapQuotes = [], providerQuoteBuilds = [], instructions = []) {
  if (!Array.isArray(simulation.accounts) || simulation.accounts.length !== feeAccounts.length) throw new Error('Local simulation omitted fee-account post-state.')
  const instructionAccounts = new Set(instructions.flatMap((instruction) => (instruction.accounts ?? [])
    .map((item) => String(typeof item === 'string' ? item : item?.address))
    .filter((item) => item && item !== 'undefined')))
  for (let index = 0; index < feeAccounts.length; index++) {
    const mint = feeAccounts[index].mint
    try {
      const expectedDelta = BigInt(expectedByMint[mint] ?? '0')
      const value = simulation.accounts[index]
      if (value?.data == null) {
        if (instructionAccounts.has(String(feeAccounts[index].account)) || expectedDelta !== 0n) {
          throw new Error(`Simulation omitted fee account ${feeAccounts[index].account} used by a fee-bearing transaction.`)
        }
        continue
      }
      const afterBaseUnits = tokenAmountBaseUnits(value, `fee account for ${mint}`)
      const actualDelta = BigInt(afterBaseUnits) - BigInt(before[index].amount)
      const roundingAllowance = BigInt(composedSwapQuotes.filter((quote) => quote.fee?.mint === mint).length) * 10n
      if (actualDelta < 0n || actualDelta > expectedDelta + roundingAllowance
        || actualDelta + roundingAllowance < expectedDelta) {
        throw new Error(`Mint ${mint} fee delta was ${actualDelta}; quote expected ${expectedDelta} with at most ${roundingAllowance} base units of transfer rounding.`)
      }
    } catch (error) {
      const diagnostic = {
        feeAccount: feeAccounts[index].account,
        mint,
        composedSwaps: composedSwapQuotes.filter((quote) => quote.fee?.mint === mint),
        providerQuoteBuilds: providerQuoteBuilds.filter((quote) => quote.fee?.mint === mint),
        simulationError: simulation.err ?? null,
        simulationLogs: simulation.logs ?? [],
      }
      throw new Error(`${error.message} Provider quotes and simulated transaction details: ${stringifyErrorDetails(diagnostic)}`)
    }
  }
}

function simulatedFeeDeltasByMint(simulation, feeAccounts) {
  return Object.fromEntries(feeAccounts.map(({ account, mint }) => {
    const delta = simulation?.tokenDeltas?.find((item) => item.account === String(account) && item.mint === mint)?.deltaBaseUnits ?? '0'
    if (!/^\d+$/.test(String(delta))) throw new Error(`Local simulation returned an invalid ${mint} fee-account delta.`)
    return [mint, String(delta)]
  }))
}

function swapQuoteDiagnostic(built, feeAccount, source = 'provider-build') {
  return {
    source,
    direction: `${built.inputMint}->${built.outputMint}`,
    feeAccount,
    inputAmountBaseUnits: built.inputAmountBaseUnits,
    grossRouteFeeBasisBaseUnits: built.fee?.basisAmountBaseUnits,
    quotedNetOutputBaseUnits: built.outputAmountBaseUnits,
    minimumOutputBaseUnits: built.minimumOutputBaseUnits,
    fee: built.fee,
    routePlan: (built.routePlan ?? []).map(({ swapInfo }) => ({
      label: swapInfo?.label,
      ammKey: swapInfo?.ammKey,
      inputMint: swapInfo?.inputMint,
      outputMint: swapInfo?.outputMint,
      inAmount: swapInfo?.inAmount,
      outAmount: swapInfo?.outAmount,
    })),
  }
}

function addExpectedFee(expectedByMint, fee) {
  if (!fee?.mint || !/^\d+$/.test(String(fee.amountBaseUnits ?? ''))) throw new Error('A composed swap omitted its verified fee amount or mint.')
  expectedByMint[fee.mint] = ((BigInt(expectedByMint[fee.mint] ?? '0') + BigInt(fee.amountBaseUnits))).toString()
}

async function snapshotTokenAccounts(rpcClient, accounts) {
  return Promise.all(accounts.map(async (account) => ({ address: account, ...(await readTokenAccount(rpcClient, account, true)) })))
}

async function assertNoTokenBalanceChanges(rpcClient, before, label) {
  const after = await snapshotTokenAccounts(rpcClient, before.map(({ address }) => address))
  assertTokenBalanceSnapshotsUnchanged(before, after, label)
}

async function executeStandaloneRouterSwap({ rpcClient, signer, built, feeAccounts, tokenProgramByMint, label, log }) {
  if (!built.feeAccountMintVerified || !built.fee.routeDeltaVerified || built.feeAccountMint !== built.outputMint) {
    throw new Error(`${label} route does not have a verified output-mint treasury fee.`)
  }
  const inputAta = await ataOf(signer.address, address(built.inputMint), address(tokenProgramByMint[built.inputMint]))
  const outputAta = await ataOf(signer.address, address(built.outputMint), address(tokenProgramByMint[built.outputMint]))
  const accountAddresses = [inputAta, outputAta, built.feeAccount]
  const allTokenAccounts = [...new Set([...feeAccounts.map(({ account }) => account), ...accountAddresses.map(String)])]
  const before = await snapshotTokenAccounts(rpcClient, allTokenAccounts)
  const lookupTables = await localLookupTables(rpcClient, built)

  const rollbackTransaction = await compileSignedLocalTransaction(rpcClient, signer, [...built.instructions, forcedFailureInstruction()], lookupTables)
  const rollbackSimulation = await simulateLocalTransaction(rpcClient, rollbackTransaction, allTokenAccounts, lookupTables)
  if (!rollbackSimulation.err) throw new Error(`${label} forced-failure simulation unexpectedly succeeded.`)
  const rollbackResult = await submitAndConfirmLocal(rpcClient, rollbackTransaction, true)
  if (!rollbackResult.failed) throw new Error(`${label} forced-failure transaction did not roll back.`)
  await assertNoTokenBalanceChanges(rpcClient, before, `${label} forced failure`)

  const transaction = await compileSignedLocalTransaction(rpcClient, signer, built.instructions, lookupTables)
  const simulation = await simulateLocalTransaction(rpcClient, transaction, accountAddresses.map(String), lookupTables)
  if (simulation.err) throw new Error(`${label} simulation failed: ${stringifyErrorDetails({ error: simulation.err, logs: simulation.logs ?? [] })}`)
  if (!Array.isArray(simulation.accounts) || simulation.accounts.length !== accountAddresses.length) throw new Error(`${label} simulation omitted the user or treasury token-account balances.`)
  const beforeByAddress = new Map(before.map((item) => [String(item.address), item.amount]))
  const simulatedOutput = tokenAmountBaseUnits(simulation.accounts[1], `${label} simulated output account`)
  const simulatedFee = tokenAmountBaseUnits(simulation.accounts[2], `${label} simulated fee account`)
  assertRouterSwapBalanceDeltas({
    beforeInputBaseUnits: beforeByAddress.get(String(inputAta)) ?? '0',
    afterInputBaseUnits: tokenAmountBaseUnits(simulation.accounts[0], `${label} simulated input account`),
    beforeOutputBaseUnits: beforeByAddress.get(String(outputAta)) ?? '0',
    afterOutputBaseUnits: simulatedOutput,
    beforeFeeBaseUnits: beforeByAddress.get(String(built.feeAccount)) ?? '0',
    afterFeeBaseUnits: simulatedFee,
    inputAmountBaseUnits: built.inputAmountBaseUnits,
    minimumOutputBaseUnits: built.minimumOutputBaseUnits,
    feeAmountBaseUnits: built.fee.amountBaseUnits,
    label: `${label} simulation`,
  })

  const confirmed = await submitAndConfirmLocal(rpcClient, transaction)
  const after = await snapshotTokenAccounts(rpcClient, allTokenAccounts)
  const afterByAddress = new Map(after.map((item) => [String(item.address), item.amount]))
  const outputDeltaBaseUnits = assertRouterSwapBalanceDeltas({
    beforeInputBaseUnits: beforeByAddress.get(String(inputAta)) ?? '0',
    afterInputBaseUnits: afterByAddress.get(String(inputAta)) ?? '0',
    beforeOutputBaseUnits: beforeByAddress.get(String(outputAta)) ?? '0',
    afterOutputBaseUnits: afterByAddress.get(String(outputAta)) ?? '0',
    beforeFeeBaseUnits: beforeByAddress.get(String(built.feeAccount)) ?? '0',
    afterFeeBaseUnits: afterByAddress.get(String(built.feeAccount)) ?? '0',
    inputAmountBaseUnits: built.inputAmountBaseUnits,
    minimumOutputBaseUnits: built.minimumOutputBaseUnits,
    feeAmountBaseUnits: built.fee.amountBaseUnits,
    label,
  })
  const feeDeltaBaseUnits = String(BigInt(afterByAddress.get(String(built.feeAccount)) ?? '0')
    - BigInt(beforeByAddress.get(String(built.feeAccount)) ?? '0'))
  log(`LOCAL ${label.toUpperCase()} PASS: signature ${confirmed.signature}; input ${built.inputAmountBaseUnits}; output delta ${outputDeltaBaseUnits}; router fee quote ${built.fee.amountBaseUnits}, treasury credited ${feeDeltaBaseUnits} ${built.fee.mint}; rollback preserved user and treasury balances.`)
  return { outputDeltaBaseUnits, feeDeltaBaseUnits, signature: confirmed.signature }
}

async function executeLocalMultiplyScenario({ rpcClient, signer, market, collReserve, debtReserve, callbacks, feeAccounts, initialUsdyBaseUnits, leverage, flashBorrowType, localSwapQuotes, composedSwapQuotes, localRouteProgramVerifier, validateRoute, log }) {
  let currentLedgerInstant = await getCurrentLedgerInstant(rpcClient)
  let selectedPosition = null, activeApplication = null, activeRoutes = [], activeCompiled = null
  let rawSimulation = null, completedSimulation = null, trackedSimulationAccounts = [], beforeSimulationTokenAccounts = []
  const marketConfig = marketById('sol-usdy-usdc')
  const collateralToken = TOKENS['svm-usdy'], liabilityToken = TOKENS['svm-usdc']
  const multiplyType = new MultiplyObligation(collReserve.getLiquidityMint(), debtReserve.getLiquidityMint(), address(PROGRAM_ID))
  const usdcAta = await ataOf(signer.address, address(liabilityToken.mint), debtReserve.getLiquidityTokenProgram())
  const usdyAta = await ataOf(signer.address, address(collateralToken.mint), collReserve.getLiquidityTokenProgram())
  const allTokenAccounts = [...feeAccounts.map(({ account }) => account), usdcAta, usdyAta]
  const beforeOpen = await snapshotTokenAccounts(rpcClient, allTokenAccounts)
  if (BigInt(beforeOpen.find((x) => x.address === usdyAta)?.amount ?? '0') < BigInt(initialUsdyBaseUnits)) {
    throw new Error('Local test wallet lacks the USDY amount selected for loop funding.')
  }
  const vanillaObligation = await market.getObligationByWallet(signer.address, obligationType())
  if (!vanillaObligation?.getDepositByReserve(collReserve.address)?.amount?.gt(0)) {
    throw new Error('Local loop proof requires a positive coexisting vanilla USDY position.')
  }
  const vanillaAccountBefore = await snapshotRawProgramAccountData(
    rpcClient, String(vanillaObligation.obligationAddress), 'Vanilla USDY obligation before Multiply open',
  )
  const assertVanillaStillPositive = async (label) => {
    const current = await market.getObligationByWallet(signer.address, obligationType())
    if (!current?.getDepositByReserve(collReserve.address)?.amount?.gt(0)) {
      throw new Error(`${label} removed or zeroed the coexisting vanilla USDY position.`)
    }
    await assertRawProgramAccountUnchanged(rpcClient, vanillaAccountBefore, label)
  }

  const refreshLocalMarket = async () => {
    market = await loadMarket(rpcClient, marketConfig)
    collReserve = reserveOf(market, collateralToken)
    debtReserve = reserveOf(market, liabilityToken)
    currentLedgerInstant = await getCurrentLedgerInstant(rpcClient)
  }
  const contextReader = (wallet) => ({
    owner: address(wallet), marketConfig, market, currentLedgerInstant,
    collateral: collateralToken, liability: liabilityToken,
    collateralReserve: collReserve, liabilityReserve: debtReserve,
  })

  const fundingAmount = new Decimal(String(initialUsdyBaseUnits)).div(new Decimal(10).pow(collateralToken.decimals)).toString()
  const openInputs = {
    owner: signer,
    kaminoMarket: market,
    debtReserveAddress: debtReserve.address,
    collReserveAddress: collReserve.address,
    depositAmount: new Decimal(String(initialUsdyBaseUnits)).div(new Decimal(10).pow(collReserve.stats.decimals)),
    priceDebtToColl: new Decimal(String(debtReserve.getOracleMarketPrice())).div(String(collReserve.getOracleMarketPrice())),
    slippagePct: sdkSlippagePctFromBps(50), obligation: null, referrer: none(), currentLedgerInstant,
    targetLeverage: leverage, selectedTokenMint: collReserve.getLiquidityMint(),
    obligationTypeTagOverride: ObligationTypeTag.Multiply, scopeRefreshIx: [], budgetAndPriorityFeeIxs: [],
    quoteBufferBps: new Decimal(0), useV2Ixs: true, flashBorrowType, logger: () => {},
  }
  const sdkQuote = await quoteMultiplyOpenAtFinalAmount(openInputs, callbacks)
  const leverageQuote = sdkQuote.leverageQuote, sdkPreview = sdkQuote.sdkPreview
  const previewNow = Date.now()
  const oracleReserves = [collReserve, debtReserve].map((reserve) => ({
    oracleTs: Number(reserve.tokenOraclePrice?.timestamp ?? 0),
    maxAge: Number(reserve.state.config.tokenInfo.maxAgePriceSeconds),
    price: String(reserve.getOracleMarketPrice()),
  }))
  const quoteTimes = [leverageQuote.quoteAt]
  const previewBase = buildLoopPreview({
    fundingAmount, leverage: Number(leverage), strategy: { enabled: true, unavailableReasons: [] },
    maxBorrowLtvPct: collReserve.stats.loanToValue * 100,
    liquidationLtvPct: collReserve.stats.liquidationThreshold * 100,
    riskInputs: {
      slippageBps: 50,
      priceImpactPct: leverageQuote.priceImpactPct,
      quoteAgeSeconds: Math.max(...quoteTimes.map((at) => (previewNow - at) / 1000)),
      oracleAgeSeconds: Math.max(...oracleReserves.map((reserve) => Math.max(0, Number(currentLedgerInstant.blockTime) - reserve.oracleTs))),
      oracleHeartbeatSeconds: Math.min(...oracleReserves.map((reserve) => reserve.maxAge)),
    },
    leverageQuote,
    feePricesUsd: { [collateralToken.mint]: Number(oracleReserves[0].price), [liabilityToken.mint]: Number(oracleReserves[1].price) },
    sdkPosition: {
      collateralMint: collateralToken.mint, collateralDecimals: collReserve.stats.decimals,
      collateralAmount: sdkPreview.initialInputs.calcs.collTokenToDeposit,
      collateralPriceUsd: oracleReserves[0].price,
      liabilityMint: liabilityToken.mint, liabilityDecimals: debtReserve.stats.decimals,
      debtBorrowAmount: sdkPreview.initialInputs.calcs.debtTokenToBorrow,
      borrowFeeRatio: debtReserve.getBorrowFee(), liabilityPriceUsd: oracleReserves[1].price,
      flashBorrowAmount: sdkPreview.initialInputs.calcs.flashBorrowInCollToken,
      flashFeeRatio: sdkPreview.flashLoanInfo.flashLoanFee,
    },
  })
  if (previewBase.available !== true) {
    const risk = {
      violations: previewBase.risk.violations,
      projectedLtvPct: previewBase.risk.projectedLtvPct,
      limits: previewBase.limits,
      inputs: {
        slippageBps: 50,
        priceImpactPct: leverageQuote.priceImpactPct,
        quoteAgeSeconds: Math.max(...quoteTimes.map((at) => (previewNow - at) / 1000)),
        oracleAgeSeconds: Math.max(...oracleReserves.map((reserve) => Math.max(0, Number(currentLedgerInstant.blockTime) - reserve.oracleTs))),
        oracleHeartbeatSeconds: Math.min(...oracleReserves.map((reserve) => reserve.maxAge)),
      },
    }
    throw new Error(`Local final-builder preview is not ready: ${JSON.stringify(risk)}`)
  }
  const preview = {
    ...previewBase,
    id: `local-fork-${Date.now()}`,
    wallet: String(signer.address), marketId: 'sol-usdy-usdc', fundingAmount,
    leverage: Number(leverage), expiresAt: Math.min(...quoteTimes) + 15_000,
    sdk: {
      flashBorrowFee: sdkPreview.flashLoanInfo.flashLoanFee.toString(),
      collateralToDeposit: sdkPreview.initialInputs.calcs.collTokenToDeposit.toString(),
      debtToBorrow: sdkPreview.initialInputs.calcs.debtTokenToBorrow.toString(),
      leverageSwapInputBaseUnits: sdkPreview.swapInputs.inputAmountLamports.toString(),
      leverageSwapMinimumOutputBaseUnits: sdkPreview.swapInputs.minOutAmountLamports?.toString() ?? null,
      marketRisk: {
        collateralPriceUsd: String(oracleReserves[0].price),
        liabilityPriceUsd: String(oracleReserves[1].price),
        maxBorrowLtvPct: Number(collReserve.stats.loanToValue) * 100,
        liquidationLtvPct: Number(collReserve.stats.liquidationThreshold) * 100,
        collateralOracleTimestamp: oracleReserves[0].oracleTs,
        liabilityOracleTimestamp: oracleReserves[1].oracleTs,
        collateralOracleHeartbeatSeconds: oracleReserves[0].maxAge,
        liabilityOracleHeartbeatSeconds: oracleReserves[1].maxAge,
      },
    },
    applicationContext: {
      wallet: String(signer.address), fundingAmount, fundingBaseUnits: String(initialUsdyBaseUnits),
      leverage: Number(leverage), leverageQuote, callbacks,
    },
  }
  callbacks.sealQuotes()

  const localCompile = async ({ wallet, instructions }) => {
    const temporaryTable = await prepareLocalAddressLookupTable(rpcClient, signer, instructions)
    const lookupTables = temporaryTable ? [temporaryTable] : []
    const tx = await compileSignedLocalTransaction(rpcClient, signer, instructions, lookupTables)
    const decoded = getTransactionDecoder().decode(Buffer.from(tx, 'base64'))
    activeCompiled = {
      tx,
      messageBytes: decoded.messageBytes,
      size: Buffer.from(tx, 'base64').byteLength,
      minContextSlot: await readLocalSlot(rpcClient),
      lookupTables,
    }
    log(`LOCAL FINAL APPLICATION SIZE: ${activeCompiled.size} bytes with ${temporaryTable?.data.addresses.length ?? 0} temporary local ALT entries.`)
    return activeCompiled
  }

  const localSimulate = async ({ built, compiled }) => simulateLoopApplication({
    built, compiled,
    simulate: async ({ accounts, tokenAccounts }) => {
      const dedupedTokens = [...new Map(tokenAccounts.map((item) => [`${item.account}:${item.mint}`, item])).values()]
      const tracked = [...new Set([...accounts, ...dedupedTokens.map((item) => item.account)].map(String))]
      const before = await snapshotTokenAccounts(rpcClient, dedupedTokens.map((item) => item.account))
      const simulation = await simulateLocalTransaction(rpcClient, compiled.tx, tracked, compiled.lookupTables)
      rawSimulation = simulation
      trackedSimulationAccounts = tracked
      beforeSimulationTokenAccounts = before
      if (simulation.err) {
        const index = Array.isArray(simulation.err.InstructionError) ? Number(simulation.err.InstructionError[0]) : null
        const program = Number.isSafeInteger(index) ? instructionProgramAddressAt(simulation.compiledMessage, index, compiled.lookupTables) : null
        const location = Number.isSafeInteger(index) ? ` at instruction ${index}${program ? ` (${program})` : ''}` : ''
        const metas = Number.isSafeInteger(index) ? instructionAccountAddressesAt(simulation.compiledMessage, index, compiled.lookupTables) : null
        throw new Error(`Local final loop application simulation failed${location}; account metas ${stringifyErrorDetails(metas)}; runtime logs ${stringifyErrorDetails(simulation.logs ?? [])}; error ${stringifyErrorDetails(simulation.err)}`)
      }
      const accountData = new Map(tracked.map((key, index) => {
        const value = simulation.accounts?.[index]
        if (!value) return [key, null]
        const encoded = value.data?.[0]
        return [key, typeof encoded === 'string' ? Uint8Array.from(Buffer.from(encoded, value.data[1] === 'base64' ? 'base64' : 'utf8')) : null]
      }))
      const accountOwners = new Map(tracked.map((key, index) => [key, simulation.accounts?.[index]?.owner ?? null]))
      const beforeByAddress = new Map(before.map((item) => [String(item.address), item.amount]))
      const tokenDeltas = dedupedTokens.map((item) => {
        const index = tracked.indexOf(String(item.account))
        const after = simulation.accounts?.[index]
        const afterAmount = after ? tokenAmountBaseUnits(after, `simulated token account ${item.account}`) : '0'
        return { account: String(item.account), mint: String(item.mint), deltaBaseUnits: String(BigInt(afterAmount) - BigInt(beforeByAddress.get(String(item.account)) ?? '0')) }
      })
      return { ok: true, accountData, accountOwners, tokenDeltas }
    },
  })

  const localService = createLoopExecutionService({
    readiness: async () => ({ executionEnabled: true, unavailableReasons: [] }),
    getPreview: async (id) => id === preview.id ? preview : null,
    getPosition: async () => selectedPosition,
    metadataReady: async ({ wallet }) => {
      await refreshLocalMarket()
      const [, metadata] = await market.getUserMetadata(address(wallet))
      return !!metadata && String(metadata.owner) === wallet
    },
    setupRequired: async () => false,
    buildOpen: async ({ wallet, request }) => {
      const routeStart = callbacks.composedQuotes().length
      activeApplication = await buildLoopOpenApplication({
        wallet, amount: request.amount, leverage: request.leverage, preview,
        refreshMarket: refreshLocalMarket, contextReader, flashBorrowType,
        validateRoute,
      })
      activeRoutes = callbacks.composedQuotes().slice(routeStart)
      return activeApplication
    },
    buildClose: async ({ wallet, position }) => {
      const routeStart = callbacks.composedQuotes().length
      activeApplication = await buildLoopCloseApplication({
        wallet, position, refreshMarket: refreshLocalMarket, contextReader, callbacks, flashBorrowType,
        validateRoute,
      })
      activeRoutes = callbacks.composedQuotes().slice(routeStart)
      return activeApplication
    },
    buildSetup: async () => { throw new Error('The separate metadata setup already ran before loop execution.') },
    compile: localCompile,
    simulate: localSimulate,
    verifySimulation: ({ kind, built, simulation }) => {
      completedSimulation = simulation
      const verified = verifyLoopApplicationSimulation({ kind, built, simulation })
      if (!verified && kind === 'loop-open') {
        log(`LOCAL OPEN SIMULATION DIAGNOSTIC: ${JSON.stringify({
          fundingBaseUnits: built.simulationContext?.fundingBaseUnits,
          authorizedPosition: built.simulationContext?.authorizedPosition,
          positionCollateralBaseUnits: simulation?.positionCollateralBaseUnits,
          positionCollateralCTokenBaseUnits: simulation?.positionCollateralCTokenBaseUnits,
          positionDebtBaseUnits: simulation?.positionDebtBaseUnits,
          tokenDeltas: simulation?.tokenDeltas,
        })}`)
      }
      return verified
    },
    authorize: async ({ intent }) => intent?.metadata?.market === 'sol-usdy-usdc'
      && activeRoutes.length > 0
      && Promise.all(activeRoutes.map(async (route) => Number.isFinite(route.quoteAt)
        && Date.now() >= route.quoteAt && Date.now() - route.quoteAt <= 15_000
        && route.feeAccountMintVerified === true && route.fee?.routeDeltaVerified === true
        && await localRouteProgramVerifier(route))).then((results) => results.every(Boolean)),
    authorizeSetup: async () => false,
    send: async ({ tx }) => submitAndConfirmLocal(rpcClient, tx),
  })

  const openQuoteStart = composedSwapQuotes.length
  const openBuilt = await localService.build({
    kind: 'loop-open', wallet: String(signer.address), market: 'sol-usdy-usdc',
    amount: fundingAmount, leverage: Number(leverage), previewId: preview.id,
  })
  const openApplication = activeApplication
  const openCompiled = activeCompiled
  const openComposedSwaps = composedSwapQuotes.slice(openQuoteStart)
  if (!openComposedSwaps.length) throw new Error('Final atomic open builder did not compose its fee-aware leverage route.')
  const openInstructions = openApplication.instructions
  const openLookupTables = openCompiled.lookupTables
  const openTransaction = openBuilt.tx
  const openSimulation = rawSimulation
  const openVerifiedSimulation = completedSimulation
  log(`LOCAL FINAL ATOMIC OPEN BUILDER PASS: ${openApplication.instructions.length} instructions, preview route ${openApplication.quotePlan.leverageSwapInputBaseUnits} base units.`)
  const expectedOpenFees = {}
  for (const fee of openApplication.feeEvents) addExpectedFee(expectedOpenFees, fee)
  const simulatedOpenFees = simulatedFeeDeltasByMint(openVerifiedSimulation, feeAccounts)
  const openFeeQuotes = openComposedSwaps.map((swap) => swapQuoteDiagnostic(swap, feeAccounts.find(({ mint }) => mint === swap.fee.mint)?.account, 'sdk-composed-swap'))
  const openFeeSimulation = { ...openSimulation, accounts: feeAccounts.map((fee) => openSimulation.accounts[trackedSimulationAccounts.indexOf(String(fee.account))]) }
  await assertFeeSimulationDeltas(rpcClient, openFeeSimulation, feeAccounts, beforeOpen.slice(0, feeAccounts.length), expectedOpenFees, openFeeQuotes, localSwapQuotes, openInstructions)

  const failedOpen = await compileSignedLocalTransaction(rpcClient, signer, [...openInstructions, forcedFailureInstruction()], openLookupTables)
  const failedOpenSimulation = await simulateLocalTransaction(rpcClient, failedOpen, [], openLookupTables)
  if (!failedOpenSimulation.err) throw new Error('Forced-failure open simulation unexpectedly succeeded.')
  const failedOpenResult = await submitAndConfirmLocal(rpcClient, failedOpen, true)
  if (!failedOpenResult.failed) throw new Error('Forced-failure open did not roll back on the local validator.')
  await assertNoTokenBalanceChanges(rpcClient, beforeOpen, 'Forced-failure open')
  if (await market.getObligationByWallet(signer.address, multiplyType)) throw new Error('Forced-failure open left a Multiply obligation on the local validator.')
  await assertVanillaStillPositive('Forced-failure open')

  const openResult = await localService.send({ tx: openBuilt.tx, wallet: String(signer.address), intentId: openBuilt.intentId })
  const openFeesAfter = await snapshotTokenAccounts(rpcClient, feeAccounts.map(({ account }) => account))
  for (const before of beforeOpen.slice(0, feeAccounts.length)) {
    const after = openFeesAfter.find((item) => item.address === before.address)
    const mint = feeAccounts.find((item) => item.account === before.address).mint
    assertRouterFeeBalanceDelta({ beforeBaseUnits: before.amount, afterBaseUnits: after.amount, expectedBaseUnits: simulatedOpenFees[mint] ?? '0', label: `Open fee account ${mint}` })
  }
  await refreshLocalMarket()
  await assertVanillaStillPositive('Multiply open')
  const opened = await market.getObligationByWallet(signer.address, multiplyType)
  if (!opened) throw new Error('Local Multiply open did not create an obligation.')
  const depositedPosition = opened.getDepositByReserve(collReserve.address)
  const borrowedPosition = opened.getBorrowByReserve(debtReserve.address)
  if (!depositedPosition?.amount?.gt(0) || !borrowedPosition?.amount?.gt(0)) throw new Error('Local Multiply open did not create both collateral and debt.')
  selectedPosition = multiplyPosition({
    wallet: String(signer.address), marketId: 'sol-usdy-usdc', marketName: marketConfig.name,
    obligation: opened, collateralReserve: String(collReserve.address), liabilityReserve: String(debtReserve.address),
    collateral: collateralToken, liability: liabilityToken,
    collateralMintFactor: String(collReserve.getMintFactor()), liabilityMintFactor: String(debtReserve.getMintFactor()),
  })
  if (!selectedPosition) throw new Error('Fresh local Multiply position could not be identified for close.')

  const beforeClose = await snapshotTokenAccounts(rpcClient, allTokenAccounts)
  const closeQuoteStart = composedSwapQuotes.length
  rawSimulation = null
  completedSimulation = null
  const closeBuilt = await localService.build({
    kind: 'loop-close', wallet: String(signer.address), market: 'sol-usdy-usdc', positionId: selectedPosition.id,
  })
  const closeApplication = activeApplication
  const closeCompiled = activeCompiled
  const closeComposedSwaps = composedSwapQuotes.slice(closeQuoteStart)
  if (!closeComposedSwaps.length) throw new Error('Final atomic close builder did not compose its fee-aware sale route.')
  const closeInstructions = closeApplication.instructions
  const closeLookupTables = closeCompiled.lookupTables
  const closeTransaction = closeBuilt.tx
  const closeSimulation = rawSimulation
  const closeVerifiedSimulation = completedSimulation
  log(`LOCAL FINAL ATOMIC CLOSE BUILDER PASS: ${closeApplication.instructions.length} instructions, sale input ${closeApplication.quotePlan.closeSwapInputBaseUnits} base units.`)
  const expectedCloseFees = {}
  for (const fee of closeApplication.feeEvents) addExpectedFee(expectedCloseFees, fee)
  const simulatedCloseFees = simulatedFeeDeltasByMint(closeVerifiedSimulation, feeAccounts)
  const closeFeeQuotes = closeComposedSwaps.map((swap) => swapQuoteDiagnostic(swap, feeAccounts.find(({ mint }) => mint === swap.fee.mint)?.account, 'sdk-composed-swap'))
  const closeFeeSimulation = { ...closeSimulation, accounts: feeAccounts.map((fee) => closeSimulation.accounts[trackedSimulationAccounts.indexOf(String(fee.account))]) }
  await assertFeeSimulationDeltas(rpcClient, closeFeeSimulation, feeAccounts, beforeClose.slice(0, feeAccounts.length), expectedCloseFees, closeFeeQuotes, localSwapQuotes, closeInstructions)

  const failedClose = await compileSignedLocalTransaction(rpcClient, signer, [...closeInstructions, forcedFailureInstruction()], closeLookupTables)
  const failedCloseSimulation = await simulateLocalTransaction(rpcClient, failedClose, [], closeLookupTables)
  if (!failedCloseSimulation.err) throw new Error('Forced-failure full-close simulation unexpectedly succeeded.')
  const failedCloseResult = await submitAndConfirmLocal(rpcClient, failedClose, true)
  if (!failedCloseResult.failed) throw new Error('Forced-failure full close did not roll back on the local validator.')
  await assertNoTokenBalanceChanges(rpcClient, beforeClose, 'Forced-failure full close')
  if (!((await market.getObligationByWallet(signer.address, multiplyType))?.getBorrowByReserve(debtReserve.address)?.amount?.gt(0))) {
    throw new Error('Forced-failure full close changed the live debt position.')
  }
  await assertVanillaStillPositive('Forced-failure full close')

  const closeResult = await localService.send({ tx: closeBuilt.tx, wallet: String(signer.address), intentId: closeBuilt.intentId })
  const closeFeesAfter = await snapshotTokenAccounts(rpcClient, feeAccounts.map(({ account }) => account))
  for (const before of beforeClose.slice(0, feeAccounts.length)) {
    const after = closeFeesAfter.find((item) => item.address === before.address)
    const mint = feeAccounts.find((item) => item.account === before.address).mint
    assertRouterFeeBalanceDelta({ beforeBaseUnits: before.amount, afterBaseUnits: after.amount, expectedBaseUnits: simulatedCloseFees[mint] ?? '0', label: `Full-close fee account ${mint}` })
  }
  await refreshLocalMarket()
  await assertVanillaStillPositive('Multiply full close')
  const closed = await market.getObligationByWallet(signer.address, multiplyType)
  const finalDebt = closed?.getBorrowByReserve(debtReserve.address)?.amount ?? new Decimal(0)
  if (!finalDebt.isZero()) throw new Error('Local Multiply full close left a nonzero debt balance.')
  const finalCollateral = closed?.getDepositByReserve(collReserve.address)?.amount ?? new Decimal(0)
  if (!finalCollateral.isZero()) throw new Error('Local Multiply full close left a nonzero collateral balance.')
  if (closed) assertObligationRawBalancesZero(closed, 'Local Multiply full close')

  log('LOCAL EXACT-MESSAGE INTENT PASS: final builders, post-state simulation and wallet-bound open/close intents were consumed on the loopback validator.')
  return {
    openSignature: openResult.signature,
    closeSignature: closeResult.signature,
    openFlashLoanFee: openApplication.quotePlan.flashBorrowFee,
    closeFlashLoanFee: closeApplication.quotePlan.flashBorrowFee,
    openFees: simulatedOpenFees,
    closeFees: simulatedCloseFees,
    forcedOpenFailureRollback: true,
    forcedCloseFailureRollback: true,
    finalDebt: finalDebt.toString(),
    finalCollateral: finalCollateral.toString(),
  }
}

async function runConfiguredLocalFork(env, endpoint, log) {
  const missingInputs = missingLocalExecutionInputs(env)
  if (missingInputs.length) throw new Error(`Configure isolated local transaction inputs: ${missingInputs.join(', ')}.`)
  let secretBytes
  try { secretBytes = JSON.parse(env.LOCAL_FORK_TEST_WALLET_SECRET_KEY) } catch { throw new Error('LOCAL_FORK_TEST_WALLET_SECRET_KEY must be a JSON byte array from a disposable test keypair.') }
  if (!Array.isArray(secretBytes) || secretBytes.length !== 64 || secretBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('LOCAL_FORK_TEST_WALLET_SECRET_KEY must contain 64 keypair bytes.')
  }
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(secretBytes))
  if (String(signer.address) !== env.LOCAL_FORK_TEST_WALLET) throw new Error('Local signer does not match LOCAL_FORK_TEST_WALLET.')
  const leverageValue = env.LOCAL_FORK_TARGET_LEVERAGE == null ? '1.5' : env.LOCAL_FORK_TARGET_LEVERAGE
  const leverage = new Decimal(leverageValue)
  if (!leverage.isFinite() || leverage.lte(1) || leverage.gt(1.5)) throw new Error('LOCAL_FORK_TARGET_LEVERAGE must be above 1 and at most 1.5.')
  const flashBorrowType = env.LOCAL_FORK_FLASH_BORROW_TYPE ?? 'coll'
  if (!['coll', 'debt'].includes(flashBorrowType)) throw new Error('LOCAL_FORK_FLASH_BORROW_TYPE must be coll or debt.')

  // Every runtime request in this function targets only this previously checked loopback validator.
  const localRpc = createRpc(endpoint.href)
  const airdrop = await localRpc.requestAirdrop(signer.address, lamports(2_000_000_000n)).send()
  await confirmLocalSignature(localRpc, airdrop)
  const marketConfig = marketById('sol-usdy-usdc')
  let market = await loadMarket(localRpc, marketConfig)
  const initialLedgerInstant = await getCurrentLedgerInstant(localRpc)
  const oracleReserves = [TOKENS['svm-usdy'], TOKENS['svm-usdc']].map((token) => {
    const reserve = reserveOf(market, token)
    return {
      asset: token.name,
      feed: String(reserve.state.config.tokenInfo.scopeConfiguration.priceFeed),
      timestamp: Number(reserve.tokenOraclePrice?.timestamp ?? 0),
      heartbeatSeconds: Number(reserve.state.config.tokenInfo.maxAgePriceSeconds),
    }
  })
  const oracleReport = assertLocalOracleFreshness({ now: Number(initialLedgerInstant.blockTime), oracles: oracleReserves })
  log(`LOCAL ORACLE PREFLIGHT OK: ${JSON.stringify(oracleReport)}`)
  const metadataSetup = await prepareLocalUserMetadataSetup({ market, signer })
  if (metadataSetup.instructions.length > 0) {
    const setupTransaction = await compileSignedLocalTransaction(localRpc, signer, metadataSetup.instructions)
    const setupResult = await submitAndConfirmLocal(localRpc, setupTransaction)
    const [initializedAddress, initializedMetadata] = await market.getUserMetadata(signer.address)
    if (!initializedMetadata || String(initializedAddress) !== String(metadataSetup.userMetadataAddress)) {
      throw new Error('Separate local Kamino user metadata setup did not initialize the expected account.')
    }
    log(`LOCAL NON-ECONOMIC SETUP PASS: Kamino user metadata initialized in separate loopback transaction ${setupResult.signature}; excluded from atomic open.`)
  } else {
    log('LOCAL NON-ECONOMIC SETUP PASS: Kamino user metadata already exists; no setup transaction needed.')
  }
  const collToken = TOKENS['svm-usdy']
  const debtToken = TOKENS['svm-usdc']
  let collReserve = reserveOf(market, collToken)
  let debtReserve = reserveOf(market, debtToken)
  const feeAccounts = [
    { mint: debtToken.mint, account: env.LOCAL_FORK_FEE_ACCOUNT_USDC },
    { mint: collToken.mint, account: env.LOCAL_FORK_FEE_ACCOUNT_USDY },
  ]
  const feeAccountForMint = (mint) => {
    const found = feeAccounts.find((item) => item.mint === mint)
    return found ? { mint, account: found.account } : null
  }
  const feeVerifier = async (account) => {
    try { return inspectFeeTokenAccount(await fetchEncodedAccount(localRpc, address(account), { commitment: 'confirmed' })) } catch { return null }
  }
  const localRouteProgramVerifier = async (built) => {
    const allowedDexPrograms = new Set(Object.values(ROUTE_PROGRAM_IDS_BY_LABEL).flat())
    if (!built.routeProgramIds?.length || built.routeProgramIds.some((programId) => !allowedDexPrograms.has(programId))) return false
    for (const programId of built.programIds ?? []) {
      const { value } = await localRpc.getAccountInfo(address(programId), { encoding: 'base64', commitment: 'confirmed' }).send()
      if (!value?.executable) return false
    }
    return true
  }
  const validateLocalSwapInstructions = async (request, built) => {
    if (!await localRouteProgramVerifier(built)) {
      throw new Error('The route does not invoke only the allowed DEX program deployed on this local validator.')
    }
    return validateProviderSwapInstructions(request, {
      ...built,
      programPolicy: { ...built.programPolicy, approved: true },
    })
  }
  const fetchLocalTables = async (tables, expected) => Promise.all(tables.map(async (table) => {
    const fetched = await fetchAddressLookupTable(localRpc, address(table), { commitment: 'confirmed' })
    if (!fetched.exists || (expected[table] ?? []).some((item) => !fetched.data.addresses.includes(item))) {
      throw new Error('A Jupiter address lookup table is absent or changed on the local validator.')
    }
    return fetched
  }))
  const buildLocalSwap = (request) => buildSwap({
    ...request,
    providerApiKey: process.env.JUPITER_API_KEY,
    feeAccountAuthority: env.LOCAL_FORK_TREASURY_AUTHORITY,
    feeAccountVerifier: feeVerifier,
    feeBalanceDeltaVerified: false,
    routeProgramIdsByLabel: ROUTE_PROGRAM_IDS_BY_LABEL,
  }).then((built) => {
    const diagnostic = swapQuoteDiagnostic(built, request.feeAccount)
    localSwapQuotes.push(diagnostic)
    log(`LOCAL SWAP QUOTE: ${stringifyErrorDetails(diagnostic)}`)
    return built
  })
  const localSwapQuotes = []
  const composedSwapQuotes = []
  const makeLoopCallbacks = (routeQuotes = []) => createKaminoSwapCallbacks({
    wallet: String(signer.address),
    buildSwapFn: buildLocalSwap,
    getFeeAccount: async (mint) => feeAccountForMint(mint),
    tokenDecimals: { [debtToken.mint]: debtToken.decimals, [collToken.mint]: collToken.decimals },
    lookupTableResolver: fetchLocalTables,
    localForkSimulation: true,
    localForkRpcUrl: endpoint.href,
    localRouteProgramVerifier,
    validateRoute: validateLocalSwapInstructions,
    routeQuotes,
    onSwapComposed: async (built) => {
      composedSwapQuotes.push(built)
      const feeAccount = feeAccountForMint(built.fee?.mint)?.account
      log(`LOCAL COMPOSED SWAP: ${stringifyErrorDetails(swapQuoteDiagnostic(built, feeAccount, 'sdk-composed-swap'))}`)
    },
  })

  const tokenProgramByMint = {
    [debtToken.mint]: debtReserve.getLiquidityTokenProgram(),
    [collToken.mint]: collReserve.getLiquidityTokenProgram(),
  }
  const usdcAta = await ataOf(signer.address, address(debtToken.mint), debtReserve.getLiquidityTokenProgram())
  const usdyAta = await ataOf(signer.address, address(collToken.mint), collReserve.getLiquidityTokenProgram())
  const lendingTokenAccounts = [...new Set([...feeAccounts.map(({ account }) => account), usdcAta, usdyAta].map(String))]
  const standaloneAmount = BigInt(env.LOCAL_FORK_STARTING_USDC_BASE_UNITS) / 100n
  if (standaloneAmount < 10_000n) throw new Error('LOCAL_FORK_STARTING_USDC_BASE_UNITS must be large enough for a separate 10-bps router-fee scenario.')
  const standaloneAcquisition = await buildLocalSwap({
    inputMint: debtToken.mint,
    outputMint: collToken.mint,
    inputAmountBaseUnits: String(standaloneAmount),
    wallet: String(signer.address),
    feeAccount: env.LOCAL_FORK_FEE_ACCOUNT_USDY,
    feeAccountMint: collToken.mint,
    slippageBps: 50,
  })
  if (!standaloneAcquisition.fee.routeDeltaVerified || !standaloneAcquisition.feeAccountMintVerified
    || !await localRouteProgramVerifier(standaloneAcquisition) || standaloneAcquisition.priceImpactPct > 1) {
    throw new Error('Standalone local-fork router acquisition is missing verified fee, treasury, route programs or price-impact limits.')
  }
  const standaloneBuy = await executeStandaloneRouterSwap({
    rpcClient: localRpc,
    signer,
    built: standaloneAcquisition,
    feeAccounts,
    tokenProgramByMint,
    label: 'standalone router acquisition',
    log,
  })

  const standaloneFollowUp = await buildLocalSwap({
    inputMint: collToken.mint,
    outputMint: debtToken.mint,
    inputAmountBaseUnits: standaloneBuy.outputDeltaBaseUnits,
    wallet: String(signer.address),
    feeAccount: env.LOCAL_FORK_FEE_ACCOUNT_USDC,
    feeAccountMint: debtToken.mint,
    slippageBps: 50,
  })
  if (!standaloneFollowUp.fee.routeDeltaVerified || !standaloneFollowUp.feeAccountMintVerified
    || !await localRouteProgramVerifier(standaloneFollowUp) || standaloneFollowUp.priceImpactPct > 1) {
    throw new Error('Standalone local-fork router follow-up sale is missing verified fee, treasury, route programs or price-impact limits.')
  }
  await executeStandaloneRouterSwap({
    rpcClient: localRpc,
    signer,
    built: standaloneFollowUp,
    feeAccounts,
    tokenProgramByMint,
    label: 'standalone router follow-up sale',
    log,
  })

  const flowAcquisition = await buildLocalSwap({
    inputMint: debtToken.mint,
    outputMint: collToken.mint,
    inputAmountBaseUnits: String(standaloneAmount),
    wallet: String(signer.address),
    feeAccount: env.LOCAL_FORK_FEE_ACCOUNT_USDY,
    feeAccountMint: collToken.mint,
    slippageBps: 50,
  })
  if (!flowAcquisition.fee.routeDeltaVerified || !flowAcquisition.feeAccountMintVerified
    || !await localRouteProgramVerifier(flowAcquisition) || flowAcquisition.priceImpactPct > 1) {
    throw new Error('Standalone supply and withdrawal acquisition lacks verified fee, treasury, route programs or price-impact limits.')
  }
  const flowBuy = await executeStandaloneRouterSwap({
    rpcClient: localRpc,
    signer,
    built: flowAcquisition,
    feeAccounts,
    tokenProgramByMint,
    label: 'vanilla-supply USDY acquisition',
    log,
  })

  const supplyAmountBaseUnits = flowBuy.outputDeltaBaseUnits
  const supplyObligation = await market.getObligationByWallet(signer.address, obligationType())
  const supplyAction = await KaminoAction.buildDepositTxns({
    kaminoMarket: market,
    amount: supplyAmountBaseUnits,
    reserveAddress: collReserve.address,
    owner: createNoopSigner(signer.address),
    obligation: supplyObligation ?? obligationType(),
    useV2Ixs: true,
    scopeRefreshConfig: undefined,
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
    currentLedgerInstant: await getCurrentLedgerInstant(localRpc),
  })
  const assertSupplyDeltas = (before, after) => assertTokenBalanceDeltasForAccounts({
    before, after, expectedByAddress: { [String(usdyAta)]: `-${supplyAmountBaseUnits}` }, label: 'Vanilla USDY supply',
  })
  const supplied = await executeStandaloneKaminoAction({
    rpcClient: localRpc, signer, action: supplyAction, tokenAccounts: lendingTokenAccounts,
    label: 'vanilla USDY supply', assertBalances: assertSupplyDeltas, log,
  })

  // Reload reserve and obligation state after the confirmed supply. The withdrawal amount comes from the fresh
  // Kamino max-withdraw calculation and is carried to the SDK builder as raw base units.
  market = await loadMarket(localRpc, marketConfig)
  collReserve = reserveOf(market, collToken)
  debtReserve = reserveOf(market, debtToken)
  const withdrawalInstant = await getCurrentLedgerInstant(localRpc)
  const withdrawalObligation = await market.getObligationByWallet(signer.address, obligationType())
  if (!withdrawalObligation) throw new Error('Vanilla USDY supply did not create a withdrawable obligation.')
  const suppliedPosition = withdrawalObligation.getDepositByReserve(collReserve.address)
  if (!suppliedPosition?.amount?.gt(0)) throw new Error('Vanilla USDY supply did not create a positive Kamino collateral position.')
  const freshWithdrawalAllowance = maxWithdrawFromObligation({
    obligation: withdrawalObligation,
    market,
    reserve: collReserve,
    instant: withdrawalInstant,
    suppliedAmountScaled: String(suppliedPosition.amount),
    mintFactor: String(collReserve.getMintFactor()),
    decimals: collReserve.stats.decimals,
  })
  if (BigInt(freshWithdrawalAllowance) <= 0n) throw new Error('Fresh local free-withdrawal allowance is not positive.')
  const withdrawalAmountBaseUnits = (BigInt(freshWithdrawalAllowance) / 2n).toString()
  if (BigInt(withdrawalAmountBaseUnits) <= 0n) throw new Error('Local vanilla-preservation withdrawal amount is below one base unit.')
  const withdrawalAction = await KaminoAction.buildWithdrawTxns({
    kaminoMarket: market,
    amount: withdrawalAmountBaseUnits,
    reserveAddress: collReserve.address,
    owner: createNoopSigner(signer.address),
    obligation: withdrawalObligation,
    useV2Ixs: true,
    scopeRefreshConfig: undefined,
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
    currentLedgerInstant: withdrawalInstant,
  })
  const withdrawalBefore = await snapshotTokenAccounts(localRpc, lendingTokenAccounts)
  const withdrawalActionResult = await executeStandaloneKaminoAction({
    rpcClient: localRpc, signer, action: withdrawalAction, tokenAccounts: lendingTokenAccounts,
    label: 'fresh free USDY withdrawal',
    assertBalances: (before, after) => {
      const received = assertPositiveBalanceIncreaseWithinMax({
        beforeBaseUnits: before.find((item) => String(item.address) === String(usdyAta)).amount,
        afterBaseUnits: after.find((item) => String(item.address) === String(usdyAta)).amount,
        maxIncreaseBaseUnits: withdrawalAmountBaseUnits,
        label: 'Fresh free USDY withdrawal',
      })
      assertTokenBalanceDeltasForAccounts({
        before, after,
        expectedByAddress: {
          ...Object.fromEntries(feeAccounts.map(({ account }) => [String(account), '0'])),
          [String(usdyAta)]: received,
        },
        label: 'Fresh free USDY withdrawal treasury',
      })
    },
    log,
  })
  const withdrawalAfter = withdrawalActionResult.after
  const withdrawalReceivedBaseUnits = assertPositiveBalanceIncreaseWithinMax({
    beforeBaseUnits: withdrawalBefore.find((item) => String(item.address) === String(usdyAta)).amount,
    afterBaseUnits: withdrawalAfter.find((item) => String(item.address) === String(usdyAta)).amount,
    maxIncreaseBaseUnits: withdrawalAmountBaseUnits,
    label: 'Fresh free USDY withdrawal',
  })
  const withdrawalSale = await buildLocalSwap({
    inputMint: collToken.mint,
    outputMint: debtToken.mint,
    inputAmountBaseUnits: withdrawalReceivedBaseUnits,
    wallet: String(signer.address),
    feeAccount: env.LOCAL_FORK_FEE_ACCOUNT_USDC,
    feeAccountMint: debtToken.mint,
    slippageBps: 50,
  })
  if (!withdrawalSale.fee.routeDeltaVerified || !withdrawalSale.feeAccountMintVerified
    || !await localRouteProgramVerifier(withdrawalSale) || withdrawalSale.priceImpactPct > 1) {
    throw new Error('Fresh withdrawal sale route lacks verified fee, treasury, route programs or price-impact limits.')
  }
  const withdrawalSaleResult = await executeStandaloneRouterSwap({
    rpcClient: localRpc,
    signer,
    built: withdrawalSale,
    feeAccounts,
    tokenProgramByMint,
    label: 'fresh withdrawal USDY sale',
    log,
  })
  log(`LOCAL RECOVERABLE FLOW PASS: supply ${supplied.signature}; fresh withdrawal allowance ${freshWithdrawalAllowance}; withdrawn ${withdrawalReceivedBaseUnits}; sale ${withdrawalSaleResult.signature}.`)

  market = await loadMarket(localRpc, marketConfig)
  collReserve = reserveOf(market, collToken)
  debtReserve = reserveOf(market, debtToken)
  const vanillaBeforeLoop = await market.getObligationByWallet(signer.address, obligationType())
  if (!vanillaBeforeLoop?.getDepositByReserve(collReserve.address)?.amount?.gt(0)) {
    throw new Error('Local pre-loop fixture must retain positive USDY collateral in the vanilla obligation.')
  }
  const loopStartingUsdyBaseUnits = (await readTokenAccount(localRpc, usdyAta)).amount
  if (BigInt(loopStartingUsdyBaseUnits) <= 0n) throw new Error('The local test wallet needs USDY for the Multiply loop funding amount.')
  const result = await executeLocalMultiplyScenario({
    rpcClient: localRpc,
    signer,
    market,
    collReserve,
    debtReserve,
    callbacks: makeLoopCallbacks(),
    validateRoute: validateLocalSwapInstructions,
    feeAccounts,
    initialUsdyBaseUnits: loopStartingUsdyBaseUnits,
    leverage,
    flashBorrowType,
    localSwapQuotes,
    composedSwapQuotes,
    localRouteProgramVerifier,
    log,
  })
  const slot = await readLocalSlot(localRpc)
  log(`LOCAL FORK OPEN/CLOSE PASS: slot ${slot}; open ${result.openSignature}; close ${result.closeSignature}; final debt ${result.finalDebt}; final collateral ${result.finalCollateral}.`)
  log(`LOCAL FEE DELTAS: open ${JSON.stringify(result.openFees)}; close ${JSON.stringify(result.closeFees)}; flash fees open=${result.openFlashLoanFee}, close=${result.closeFlashLoanFee}.`)
  log('LOCAL FAILURE ROLLBACK PASS: forced open and close failures preserved token balances and obligation state.')
  return result
}

// Local only: every transaction endpoint must pass the loopback guard before execution.
export async function verifyLoopFork({ env = process.env, fetcher = fetch, log = console.log } = {}) {
  let endpoint
  try { endpoint = assertLoopbackForkEndpoint(env.LOCAL_FORK_RPC) } catch (error) {
    log(`BLOCKED: ${error.message} No RPC request was sent.`)
    return 1
  }
  const missing = missingForkPrerequisites(env)
  if (missing.length) {
    log(`BLOCKED: Configure real local test inputs: ${missing.join(', ')}. No RPC request was sent.`)
    return 1
  }

  try {
    const [health, version, slot] = await Promise.all([
      localRpc(fetcher, endpoint, 'getHealth'),
      localRpc(fetcher, endpoint, 'getVersion'),
      localRpc(fetcher, endpoint, 'getSlot', [{ commitment: 'confirmed' }]),
    ])
    if (health !== 'ok' || !version || !Number.isSafeInteger(slot)) throw new Error('Local validator health, version or slot is invalid.')
    const [usdcFee, usdyFee] = await Promise.all([
      localRpc(fetcher, endpoint, 'getAccountInfo', [env.LOCAL_FORK_FEE_ACCOUNT_USDC, { encoding: 'base64', commitment: 'confirmed' }]),
      localRpc(fetcher, endpoint, 'getAccountInfo', [env.LOCAL_FORK_FEE_ACCOUNT_USDY, { encoding: 'base64', commitment: 'confirmed' }]),
    ])
    localTokenAccount(usdcFee?.value, TOKENS['svm-usdc'].mint, env.LOCAL_FORK_TREASURY_AUTHORITY, 'LOCAL_FORK_FEE_ACCOUNT_USDC')
    localTokenAccount(usdyFee?.value, TOKENS['svm-usdy'].mint, env.LOCAL_FORK_TREASURY_AUTHORITY, 'LOCAL_FORK_FEE_ACCOUNT_USDY')
    log(`LOCAL PREFLIGHT OK: validator ${version['solana-core'] ?? 'unknown'} at slot ${slot}; both disposable treasury token accounts are valid.`)
  } catch (error) {
    log(`BLOCKED: ${error.message}`)
    return 1
  }

  try {
    await runConfiguredLocalFork(env, endpoint, log)
  } catch (error) {
    log(`BLOCKED: ${error.message}`)
    return 1
  }
  log('PASS: Local fee-aware Multiply open/full-close, fee deltas, flash repayment and forced-failure rollback verified.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await verifyLoopFork()
}
