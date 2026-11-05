import { pathToFileURL } from 'node:url'
import Decimal from 'decimal.js'
import {
  address, appendTransactionMessageInstructions, compressTransactionMessageUsingAddressLookupTables, lamports,
  createKeyPairSignerFromBytes, createTransactionMessage, fetchEncodedAccount, getBase64EncodedWireTransaction,
  none, signTransactionMessageWithSigners, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { fetchAddressLookupTable, getCreateLookupTableInstructionAsync, getExtendLookupTableInstruction } from '@solana-program/address-lookup-table'
import { getCurrentLedgerInstant, MultiplyObligation, ObligationTypeTag, PROGRAM_ID } from '@kamino-finance/klend-sdk'
import { TOKENS, marketById } from '../src/config.js'
import { ataOf } from '../server/account.js'
import { loadMarket, reserveOf } from '../server/market.js'
import { buildLoopPreview, buildMultiplyFullCloseIxs, buildMultiplyOpenIxs, createKaminoSwapCallbacks, sdkSlippagePctFromBps } from '../server/loop.js'
import { buildSwap, inspectFeeTokenAccount } from '../server/swap.js'
import { createRpc } from '../server/rpc.js'
import { PROGRAM_EVIDENCE, ROUTE_PROGRAM_IDS_BY_LABEL } from '../server/program-policy.js'

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
  if (before < 0n || after < 0n || expected < 0n || after - before !== expected) throw new Error(`${label} fee balance delta does not match the provider-reported amount.`)
}

export function assertTokenBalanceChange({ beforeBaseUnits, afterBaseUnits, expectedChangeBaseUnits, label }) {
  let before, after, expected
  try { before = BigInt(beforeBaseUnits); after = BigInt(afterBaseUnits); expected = BigInt(expectedChangeBaseUnits) } catch { throw new Error(`${label} balance change inputs are invalid.`) }
  if (before < 0n || after < 0n || after - before !== expected) throw new Error(`${label} token balance change does not match the expected amount.`)
}

export function forcedFailureInstruction() {
  return { programAddress: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), accounts: [], data: new Uint8Array([255]) }
}

const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111')
const FLASH_BORROW_DISCRIMINATOR = Uint8Array.from([135, 231, 52, 167, 7, 52, 212, 193])
const FLASH_REPAY_DISCRIMINATOR = Uint8Array.from([185, 117, 0, 203, 96, 245, 180, 186])

function hasDiscriminator(instruction, discriminator) {
  return String(instruction?.programAddress) === String(PROGRAM_ID)
    && instruction.data instanceof Uint8Array
    && instruction.data.length >= discriminator.length
    && discriminator.every((byte, index) => instruction.data[index] === byte)
}

function flashInstructionIndexes(instructions) {
  const borrowIndexes = [], repayIndexes = []
  instructions.forEach((instruction, index) => {
    if (hasDiscriminator(instruction, FLASH_BORROW_DISCRIMINATOR)) borrowIndexes.push(index)
    if (hasDiscriminator(instruction, FLASH_REPAY_DISCRIMINATOR)) repayIndexes.push(index)
  })
  return { borrowIndexes, repayIndexes }
}

function associatedAtaCreate(instruction) {
  return String(instruction?.programAddress) === ASSOCIATED_TOKEN_PROGRAM && instruction.data?.[0] === 1 && instruction.accounts?.[1]?.address
}

/** Deduplicate only idempotent ATA initialization; keep one create before either swap if the ATA is absent. */
export function composeAtomicOpenInstructions(acquisitionInstructions, sdkOpenInstructions, existingTokenAccounts = new Set()) {
  if (!Array.isArray(acquisitionInstructions) || !Array.isArray(sdkOpenInstructions)) throw new TypeError('Atomic open instructions must be arrays.')
  const sdkFlash = flashInstructionIndexes(sdkOpenInstructions)
  if (sdkFlash.borrowIndexes.length || sdkFlash.repayIndexes.length) {
    if (sdkFlash.borrowIndexes.length !== 1 || sdkFlash.repayIndexes.length !== 1) throw new Error('SDK Multiply open must contain exactly one flash borrow and repay instruction.')
    const originalBorrowIndex = sdkOpenInstructions[sdkFlash.repayIndexes[0]].data[16]
    if (originalBorrowIndex !== sdkFlash.borrowIndexes[0]) throw new Error('SDK flash repay instruction does not point to its borrow instruction before composition.')
  }
  const allInstructions = [...acquisitionInstructions, ...sdkOpenInstructions]
  const computeBudget = []
  const seenComputeBudget = new Set()
  for (const instruction of allInstructions) {
    if (String(instruction.programAddress) !== COMPUTE_BUDGET_PROGRAM) continue
    const identity = JSON.stringify({
      accounts: instruction.accounts ?? [],
      data: Buffer.from(instruction.data ?? []).toString('hex'),
    })
    if (seenComputeBudget.has(identity)) continue
    seenComputeBudget.add(identity)
    computeBudget.push(instruction)
  }
  const setup = []
  const seen = new Set(existingTokenAccounts)
  for (const instruction of allInstructions) {
    if (!associatedAtaCreate(instruction)) continue
    const ata = String(instruction.accounts[1].address)
    if (seen.has(ata)) continue
    seen.add(ata)
    setup.push(instruction)
  }
  const economic = allInstructions.filter((instruction) =>
    String(instruction.programAddress) !== COMPUTE_BUDGET_PROGRAM && !associatedAtaCreate(instruction))
  const ordered = [...computeBudget, ...setup, ...economic]
  const finalFlash = flashInstructionIndexes(ordered)
  if (sdkFlash.borrowIndexes.length) {
    if (finalFlash.borrowIndexes.length !== 1 || finalFlash.repayIndexes.length !== 1) throw new Error('Composed Multiply open lost its flash borrow or repay instruction.')
    const borrowInstructionIndex = finalFlash.borrowIndexes[0]
    const repayInstructionIndex = finalFlash.repayIndexes[0]
    if (borrowInstructionIndex >= repayInstructionIndex || borrowInstructionIndex > 255) throw new Error('Composed Multiply open has an invalid flash-loan instruction order.')
    const repay = ordered[repayInstructionIndex]
    const data = Uint8Array.from(repay.data)
    data[16] = borrowInstructionIndex
    ordered[repayInstructionIndex] = { ...repay, data }
  }
  return ordered
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

/** Prepare a temporary lookup table with non-economic setup transactions on the loopback fork only. */
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
  message = appendTransactionMessageInstructions(instructions, message)
  if (lookupTables.length) {
    const contents = Object.fromEntries(lookupTables.map((table) => [String(table.address), table.data.addresses]))
    message = compressTransactionMessageUsingAddressLookupTables(message, contents)
  }
  const tx = getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message))
  const transactionBytes = Buffer.from(tx, 'base64').byteLength
  if (transactionBytes > 1232) throw new Error(`Local Multiply transaction is ${transactionBytes} bytes; Solana limit is 1232 bytes.`)
  return tx
}

async function simulateLocalTransaction(rpcClient, tx, accounts) {
  const { value } = await rpcClient.simulateTransaction(tx, {
    encoding: 'base64', sigVerify: true, commitment: 'confirmed',
    accounts: { addresses: accounts, encoding: 'base64' },
  }).send()
  return value
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

async function assertFeeSimulationDeltas(rpcClient, simulation, feeAccounts, before, expectedByMint) {
  if (!Array.isArray(simulation.accounts) || simulation.accounts.length !== feeAccounts.length) throw new Error('Local simulation omitted fee-account post-state.')
  for (let index = 0; index < feeAccounts.length; index++) {
    const mint = feeAccounts[index].mint
    const afterBaseUnits = tokenAmountBaseUnits(simulation.accounts[index], `fee account for ${mint}`)
    assertTokenBalanceDelta({ beforeBaseUnits: before[index].amount, afterBaseUnits, expectedBaseUnits: expectedByMint[mint] ?? '0', label: `Mint ${mint}` })
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
  for (const account of before) {
    const after = await readTokenAccount(rpcClient, account.address, true)
    if (after.amount !== account.amount) throw new Error(`${label} changed token balance ${account.address} despite transaction failure.`)
  }
}

async function executeLocalMultiplyScenario({ rpcClient, signer, market, collReserve, debtReserve, callbacks, acquisition, feeAccounts, initialUsdcBaseUnits, leverage, flashBorrowType, log }) {
  const multiplyType = new MultiplyObligation(collReserve.getLiquidityMint(), debtReserve.getLiquidityMint(), address(PROGRAM_ID))
  const usdcAta = await ataOf(signer.address, address(TOKENS['svm-usdc'].mint), debtReserve.getLiquidityTokenProgram())
  const usdyAta = await ataOf(signer.address, address(TOKENS['svm-usdy'].mint), collReserve.getLiquidityTokenProgram())
  const allTokenAccounts = [...feeAccounts.map(({ account }) => account), usdcAta, usdyAta]
  const beforeOpen = await snapshotTokenAccounts(rpcClient, allTokenAccounts)
  if (BigInt(beforeOpen.find((x) => x.address === usdcAta)?.amount ?? '0') < BigInt(initialUsdcBaseUnits)) {
    throw new Error('Local test wallet lacks the configured starting USDC amount.')
  }

  const currentLedgerInstant = await getCurrentLedgerInstant(rpcClient)
  const collateralPrice = new Decimal(String(collReserve.getOracleMarketPrice()))
  const debtPrice = new Decimal(String(debtReserve.getOracleMarketPrice()))
  const openInputs = {
    owner: signer,
    kaminoMarket: market,
    debtReserveAddress: debtReserve.address,
    collReserveAddress: collReserve.address,
    depositAmount: new Decimal(acquisition.outputAmountBaseUnits).div(new Decimal(10).pow(collReserve.stats.decimals)),
    priceDebtToColl: debtPrice.div(collateralPrice),
    slippagePct: sdkSlippagePctFromBps(50),
    obligation: null,
    referrer: none(),
    currentLedgerInstant,
    targetLeverage: leverage,
    selectedTokenMint: collReserve.getLiquidityMint(),
    obligationTypeTagOverride: ObligationTypeTag.Multiply,
    scopeRefreshIx: [],
    budgetAndPriorityFeeIxs: [],
    quoteBufferBps: new Decimal(0),
    useV2Ixs: true,
    flashBorrowType,
    logger: () => {},
  }
  const openResponses = await buildMultiplyOpenIxs(openInputs, callbacks)
  if (openResponses.length !== 1) throw new Error('Multiply open must fit one atomic economic transaction.')
  const open = openResponses[0]
  const existingSetupAccounts = new Set()
  for (const instruction of [...acquisition.instructions, ...open.ixs].filter(associatedAtaCreate)) {
    const ata = address(String(instruction.accounts[1].address))
    const { value } = await rpcClient.getAccountInfo(ata, { encoding: 'base64', commitment: 'confirmed' }).send()
    if (value) existingSetupAccounts.add(String(ata))
  }
  const openInstructions = composeAtomicOpenInstructions(acquisition.instructions, open.ixs, existingSetupAccounts)
  const openLookupTables = [...new Map([...(await localLookupTables(rpcClient, acquisition)), ...open.lookupTables].map((table) => [String(table.address), table])).values()]
  const localSetupTable = await prepareLocalAddressLookupTable(rpcClient, signer, openInstructions)
  if (localSetupTable) openLookupTables.push(localSetupTable)
  const openTransaction = await compileSignedLocalTransaction(rpcClient, signer, openInstructions, openLookupTables)
  log(`LOCAL ATOMIC OPEN SIZE: ${Buffer.from(openTransaction, 'base64').byteLength} bytes with ${localSetupTable?.data.addresses.length ?? 0} temporary local ALT entries.`)
  const expectedOpenFees = {}
  addExpectedFee(expectedOpenFees, acquisition.fee)
  addExpectedFee(expectedOpenFees, open.quote?.fee)
  const openSimulation = await simulateLocalTransaction(rpcClient, openTransaction, feeAccounts.map(({ account }) => account))
  if (openSimulation.err) throw new Error(`Local Multiply open simulation failed: ${JSON.stringify(openSimulation.err)}`)
  await assertFeeSimulationDeltas(rpcClient, openSimulation, feeAccounts, beforeOpen.slice(0, feeAccounts.length), expectedOpenFees)

  // Add an invalid token-program instruction after the complete atomic open path. The local validator must reject the transaction
  // atomically: neither router fees, user tokens nor the Multiply obligation may persist.
  const failedOpen = await compileSignedLocalTransaction(rpcClient, signer, [...openInstructions, forcedFailureInstruction()], openLookupTables)
  const failedOpenSimulation = await simulateLocalTransaction(rpcClient, failedOpen, [])
  if (!failedOpenSimulation.err) throw new Error('Forced-failure open simulation unexpectedly succeeded.')
  const failedOpenResult = await submitAndConfirmLocal(rpcClient, failedOpen, true)
  if (!failedOpenResult.failed) throw new Error('Forced-failure open did not roll back on the local validator.')
  await assertNoTokenBalanceChanges(rpcClient, beforeOpen, 'Forced-failure open')
  const failedOpenObligation = await market.getObligationByWallet(signer.address, multiplyType)
  if (failedOpenObligation) throw new Error('Forced-failure open left a Multiply obligation on the local validator.')

  const openResult = await submitAndConfirmLocal(rpcClient, openTransaction)
  const openFeesAfter = await snapshotTokenAccounts(rpcClient, feeAccounts.map(({ account }) => account))
  for (const before of beforeOpen.slice(0, feeAccounts.length)) {
    const after = openFeesAfter.find((item) => item.address === before.address)
    const mint = feeAccounts.find((item) => item.account === before.address).mint
    assertTokenBalanceDelta({ beforeBaseUnits: before.amount, afterBaseUnits: after.amount, expectedBaseUnits: expectedOpenFees[mint] ?? '0', label: `Open fee account ${mint}` })
  }
  const opened = await market.getObligationByWallet(signer.address, multiplyType)
  if (!opened) throw new Error('Local Multiply open did not create an obligation.')
  const depositedPosition = opened.getDepositByReserve(collReserve.address)
  const borrowedPosition = opened.getBorrowByReserve(debtReserve.address)
  if (!depositedPosition?.amount?.gt(0) || !borrowedPosition?.amount?.gt(0)) throw new Error('Local Multiply open did not create both collateral and debt.')

  const closeInstant = await getCurrentLedgerInstant(rpcClient)
  const deposited = depositedPosition.amount.div(depositedPosition.mintFactor)
  const borrowed = borrowedPosition.amount.div(borrowedPosition.mintFactor)
  const closeInputs = {
    owner: signer,
    kaminoMarket: market,
    debtReserveAddress: debtReserve.address,
    collReserveAddress: collReserve.address,
    obligation: opened,
    deposited,
    borrowed,
    withdrawAmount: deposited,
    priceCollToDebt: collateralPrice.div(debtPrice),
    slippagePct: sdkSlippagePctFromBps(50),
    isClosingPosition: true,
    selectedTokenMint: collReserve.getLiquidityMint(),
    referrer: none(),
    currentLedgerInstant: closeInstant,
    budgetAndPriorityFeeIxs: [],
    scopeRefreshIx: [],
    quoteBufferBps: new Decimal(0),
    useV2Ixs: true,
    flashBorrowType,
    userSolBalanceLamports: 0,
  }
  const closeResponses = await buildMultiplyFullCloseIxs(closeInputs, callbacks)
  if (closeResponses.length !== 1) throw new Error('Multiply full close must fit one atomic economic transaction.')
  const close = closeResponses[0]
  const closeInstructions = close.ixs
  const closeTransaction = await compileSignedLocalTransaction(rpcClient, signer, closeInstructions, close.lookupTables)
  const beforeClose = await snapshotTokenAccounts(rpcClient, allTokenAccounts)
  const expectedCloseFees = {}
  addExpectedFee(expectedCloseFees, close.quote?.fee)
  const closeSimulation = await simulateLocalTransaction(rpcClient, closeTransaction, feeAccounts.map(({ account }) => account))
  if (closeSimulation.err) throw new Error(`Local Multiply full-close simulation failed: ${JSON.stringify(closeSimulation.err)}`)
  await assertFeeSimulationDeltas(rpcClient, closeSimulation, feeAccounts, beforeClose.slice(0, feeAccounts.length), expectedCloseFees)

  const failedClose = await compileSignedLocalTransaction(rpcClient, signer, [...closeInstructions, forcedFailureInstruction()], close.lookupTables)
  const failedCloseSimulation = await simulateLocalTransaction(rpcClient, failedClose, [])
  if (!failedCloseSimulation.err) throw new Error('Forced-failure full-close simulation unexpectedly succeeded.')
  const failedCloseResult = await submitAndConfirmLocal(rpcClient, failedClose, true)
  if (!failedCloseResult.failed) throw new Error('Forced-failure full close did not roll back on the local validator.')
  await assertNoTokenBalanceChanges(rpcClient, beforeClose, 'Forced-failure full close')
  const stillOpen = await market.getObligationByWallet(signer.address, multiplyType)
  if (!stillOpen?.getBorrowByReserve(debtReserve.address)?.amount?.gt(0)) throw new Error('Forced-failure full close changed the live debt position.')

  const closeResult = await submitAndConfirmLocal(rpcClient, closeTransaction)
  const closeFeesAfter = await snapshotTokenAccounts(rpcClient, feeAccounts.map(({ account }) => account))
  for (const before of beforeClose.slice(0, feeAccounts.length)) {
    const after = closeFeesAfter.find((item) => item.address === before.address)
    const mint = feeAccounts.find((item) => item.account === before.address).mint
    assertTokenBalanceDelta({ beforeBaseUnits: before.amount, afterBaseUnits: after.amount, expectedBaseUnits: expectedCloseFees[mint] ?? '0', label: `Full-close fee account ${mint}` })
  }
  const closed = await market.getObligationByWallet(signer.address, multiplyType)
  const finalDebt = closed?.getBorrowByReserve(debtReserve.address)?.amount ?? new Decimal(0)
  if (!finalDebt.isZero()) throw new Error('Local Multiply full close left a nonzero debt balance.')
  const finalCollateral = closed?.getDepositByReserve(collReserve.address)?.amount ?? new Decimal(0)
  if (!finalCollateral.isZero()) throw new Error('Local Multiply full close left a nonzero collateral balance.')

  return {
    openSignature: openResult.signature,
    closeSignature: closeResult.signature,
    openFlashLoanFee: open.flashLoanInfo.flashLoanFee.toString(),
    closeFlashLoanFee: close.flashLoanInfo.flashLoanFee.toString(),
    openFees: expectedOpenFees,
    closeFees: expectedCloseFees,
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
  const market = await loadMarket(localRpc, marketConfig)
  const collToken = TOKENS['svm-usdy']
  const debtToken = TOKENS['svm-usdc']
  const collReserve = reserveOf(market, collToken)
  const debtReserve = reserveOf(market, debtToken)
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
    evidence: PROGRAM_EVIDENCE,
  })
  const callbacks = createKaminoSwapCallbacks({
    wallet: String(signer.address),
    buildSwapFn: buildLocalSwap,
    getFeeAccount: async (mint) => feeAccountForMint(mint),
    tokenDecimals: { [debtToken.mint]: debtToken.decimals, [collToken.mint]: collToken.decimals },
    lookupTableResolver: fetchLocalTables,
    localForkSimulation: true,
    localForkRpcUrl: endpoint.href,
    localRouteProgramVerifier,
  })

  const acquisition = await buildLocalSwap({
    inputMint: debtToken.mint,
    outputMint: collToken.mint,
    inputAmountBaseUnits: env.LOCAL_FORK_STARTING_USDC_BASE_UNITS,
    wallet: String(signer.address),
    feeAccount: env.LOCAL_FORK_FEE_ACCOUNT_USDY,
    feeAccountMint: collToken.mint,
    feeBps: 10,
    platformFeeBps: 10,
    slippageBps: 50,
  })
  if (!acquisition.fee.routeDeltaVerified || !acquisition.feeAccountMintVerified || !await localRouteProgramVerifier(acquisition)) {
    throw new Error('Initial local-fork acquisition route lacks a verified 10-bps fee, test treasury, or cloned executable program.')
  }
  if (acquisition.priceImpactPct > 1) throw new Error('Local-fork acquisition route exceeds the 1% price-impact limit.')
  const result = await executeLocalMultiplyScenario({
    rpcClient: localRpc,
    signer,
    market,
    collReserve,
    debtReserve,
    callbacks,
    acquisition,
    feeAccounts,
    initialUsdcBaseUnits: env.LOCAL_FORK_STARTING_USDC_BASE_UNITS,
    leverage,
    flashBorrowType,
    log,
  })
  const slot = await readLocalSlot(localRpc)
  log(`LOCAL FORK OPEN/CLOSE PASS: slot ${slot}; open ${result.openSignature}; close ${result.closeSignature}; final debt ${result.finalDebt}; final collateral ${result.finalCollateral}.`)
  log(`LOCAL FEE DELTAS: open ${JSON.stringify(result.openFees)}; close ${JSON.stringify(result.closeFees)}; flash fees open=${result.openFlashLoanFee}, close=${result.closeFlashLoanFee}.`)
  log('LOCAL FAILURE ROLLBACK PASS: forced open and close failures preserved token balances and obligation state.')
  return result
}

/** Local-only fee-aware Multiply proof. Every transaction endpoint must pass the loopback guard before execution. */
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
  if (!PROGRAM_EVIDENCE.length) {
    log('BLOCKED: Local fork execution passed, but no exact deployed router/DEX audit-version evidence is approved for production route admission.')
    return 1
  }
  log('PASS: Local fee-aware Multiply open/full-close, fee deltas, flash repayment and forced-failure rollback verified.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await verifyLoopFork()
}
