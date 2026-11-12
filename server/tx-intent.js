import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { getCompiledTransactionMessageDecoder, getTransactionDecoder, isAddress } from '@solana/kit'

const MAX_ENTRIES = 10_000
const MAX_MESSAGE_BYTES = 1232
const clone = (value) => structuredClone(value)

export class TransactionIntentError extends Error {}

const LENDING_BUILD_ACTIONS = new Set(['deposit', 'withdraw', 'borrow', 'repay', 'claim', 'liquidate', 'vault-deposit', 'vault-withdraw'])
const LIGHTHOUSE_PROGRAM_ID = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'
// Borsh variants from Lighthouse programs/lighthouse/src/instruction.rs. 0 and 1 are MemoryWrite/MemoryClose;
// only assertion variants with explicit account lists are admitted. Variant 15 (AssertSysvarClock) is accountless,
// so it is deliberately outside the wallet guard allowance.
const LIGHTHOUSE_ASSERTION_ACCOUNT_COUNTS = new Map([
  [2, 1], [3, 1], [4, 2], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1],
  [10, 1], [11, 1], [12, 1], [13, 1], [14, 1], [16, 3], [17, 1],
])
const LIGHTHOUSE_LOG_LEVELS = new Set([0, 1, 2, 3, 16, 17, 18])

const BORROWER_FLOW_ACTIONS = new Map([
  ['acquire-supply:supply', 'deposit'],
  ['withdraw-sell:withdraw', 'withdraw'],
])

function validateBorrowerFlowMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.kind !== 'borrower-flow') {
    throw new TransactionIntentError('Invalid borrower flow transaction intent metadata.')
  }
  const expectedAction = BORROWER_FLOW_ACTIONS.get(`${metadata.flow}:${metadata.stage}`)
  if (!expectedAction || metadata.action !== expectedAction) {
    throw new TransactionIntentError('Borrower flow stage does not match its Kamino action.')
  }
  if (typeof metadata.marketId !== 'string' || !metadata.marketId.trim()
    || typeof metadata.tokenId !== 'string' || !metadata.tokenId.trim()) {
    throw new TransactionIntentError('Borrower flow intent requires a market and token.')
  }
  if (metadata.amountBaseUnits != null && (typeof metadata.amountBaseUnits !== 'string' || !/^\d+$/.test(metadata.amountBaseUnits)
    || BigInt(metadata.amountBaseUnits) <= 0n)) {
    throw new TransactionIntentError('Invalid borrower flow amount.')
  }
}

function messageDigest(messageBytes) {
  if (!(messageBytes instanceof Uint8Array) || messageBytes.length === 0 || messageBytes.length > MAX_MESSAGE_BYTES) {
    throw new TransactionIntentError('Invalid transaction message bytes.')
  }
  return createHash('sha256').update(messageBytes).digest()
}

/** Permit a wallet to refresh only the recent blockhash on the non-economic Kamino metadata setup message. */
export function loopSetupMessageMatchesIgnoringBlockhash(expectedBytes, candidateBytes, metadata) {
  if (metadata?.kind !== 'loop-setup') return false
  if (messageMatchesWithLighthouse(expectedBytes, candidateBytes, { ignoreLifetimeToken: true })) return true
  try {
    const decode = getCompiledTransactionMessageDecoder()
    const expected = decode.decode(expectedBytes)
    const candidate = decode.decode(candidateBytes)
    const accountKeys = (message) => message.staticAccounts.map(String)
    const lookups = (message) => (message.addressTableLookups ?? []).map((item) => ({
      address: String(item.lookupTableAddress),
      writable: [...(item.writableIndexes ?? item.writableIndices ?? [])],
      readonly: [...(item.readonlyIndexes ?? item.readableIndices ?? [])],
    }))
    const instructions = (message) => (message.instructions ?? []).map((item) => ({
      programIndex: item.programAddressIndex,
      accounts: [...(item.accountIndices ?? [])],
      data: Buffer.from(item.data ?? []).toString('hex'),
    }))
    return expected.version === candidate.version
      && JSON.stringify(expected.header) === JSON.stringify(candidate.header)
      && JSON.stringify(accountKeys(expected)) === JSON.stringify(accountKeys(candidate))
      && JSON.stringify(lookups(expected)) === JSON.stringify(lookups(candidate))
      && JSON.stringify(instructions(expected)) === JSON.stringify(instructions(candidate))
  } catch { return false }
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameBytes(left, right) {
  return left instanceof Uint8Array && right instanceof Uint8Array
    && left.length === right.length && left.every((value, index) => value === right[index])
}

function lookupTables(message) {
  return (message.addressTableLookups ?? []).map((lookup) => ({
    address: String(lookup.lookupTableAddress),
    writable: [...(lookup.writableIndexes ?? lookup.writableIndices ?? [])],
    readonly: [...(lookup.readonlyIndexes ?? lookup.readableIndices ?? [])],
  }))
}

function validStaticRoles(message) {
  const { staticAccounts, header } = message
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = header
  if (![numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts].every(Number.isSafeInteger)
    || numSignerAccounts < 0 || numReadonlySignerAccounts < 0 || numReadonlyNonSignerAccounts < 0
    || numReadonlySignerAccounts > numSignerAccounts || numSignerAccounts > staticAccounts.length
    || numReadonlyNonSignerAccounts > staticAccounts.length - numSignerAccounts) return null
  const writableSignerEnd = numSignerAccounts - numReadonlySignerAccounts
  const writableNonSignerEnd = staticAccounts.length - numReadonlyNonSignerAccounts
  return new Map(staticAccounts.map((account, index) => [String(account),
    index < writableSignerEnd ? 'writable-signer'
      : index < numSignerAccounts ? 'readonly-signer'
        : index < writableNonSignerEnd ? 'writable' : 'readonly']))
}

function loadedAccountKeys(message) {
  const lookups = lookupTables(message)
  const writable = []
  const readonly = []
  for (const lookup of lookups) {
    for (const index of lookup.writable) writable.push(`lookup:${lookup.address}:${index}`)
  }
  for (const lookup of lookups) {
    for (const index of lookup.readonly) readonly.push(`lookup:${lookup.address}:${index}`)
  }
  return [...writable, ...readonly]
}

function messageAccountKeys(message) {
  return [
    ...message.staticAccounts.map((key) => `static:${String(key)}`),
    ...loadedAccountKeys(message),
  ]
}

function instructionMatches(left, leftKeys, right, rightKeys) {
  const leftProgram = leftKeys[left.programAddressIndex]
  const rightProgram = rightKeys[right.programAddressIndex]
  const leftAccounts = left.accountIndices ?? []
  const rightAccounts = right.accountIndices ?? []
  return !!leftProgram && leftProgram === rightProgram
    && leftAccounts.length === rightAccounts.length
    && leftAccounts.every((index, position) => !!leftKeys[index] && leftKeys[index] === rightKeys[rightAccounts[position]])
    && sameBytes(left.data, right.data)
}

function isReadOnlyLighthouseAssertion(instruction, accountKeys) {
  const data = instruction.data
  if (!(data instanceof Uint8Array) || data.length < 3 || !LIGHTHOUSE_LOG_LEVELS.has(data[1])) return false
  const expectedAccounts = LIGHTHOUSE_ASSERTION_ACCOUNT_COUNTS.get(data[0])
  const accountIndices = instruction.accountIndices ?? []
  return expectedAccounts != null && accountIndices.length === expectedAccounts
    && accountIndices.every((index) => Number.isSafeInteger(index) && !!accountKeys[index])
}

/** Compare a wallet-modified message (Phantom appends Lighthouse guard instructions when signing) while allowing only
 * appended read-only Lighthouse assertions. */
export function messageMatchesWithLighthouse(originalBytes, candidateBytes, { ignoreLifetimeToken = false } = {}) {
  let original, candidate
  try {
    const decode = getCompiledTransactionMessageDecoder().decode
    original = decode(originalBytes)
    candidate = decode(candidateBytes)
  } catch { return false }
  if (original.version !== candidate.version || (!ignoreLifetimeToken && original.lifetimeToken !== candidate.lifetimeToken)
    || original.staticAccounts[0] !== candidate.staticAccounts[0]
    || JSON.stringify(lookupTables(original)) !== JSON.stringify(lookupTables(candidate))) return false
  const originalHeader = original.header
  const candidateHeader = candidate.header
  if (candidateHeader.numSignerAccounts !== originalHeader.numSignerAccounts
    || candidateHeader.numReadonlySignerAccounts !== originalHeader.numReadonlySignerAccounts) return false

  const originalStatic = original.staticAccounts.map(String)
  const candidateStatic = candidate.staticAccounts.map(String)
  if (new Set(originalStatic).size !== originalStatic.length || new Set(candidateStatic).size !== candidateStatic.length) return false
  const originalStaticSet = new Set(originalStatic)
  const addedStatic = candidateStatic.filter((account) => !originalStaticSet.has(account))
  if (addedStatic.length > 1 || addedStatic.some((account) => account !== LIGHTHOUSE_PROGRAM_ID)) return false
  if (!sameArray(candidateStatic.filter((account) => !addedStatic.includes(account)), originalStatic)) return false
  if (candidateHeader.numReadonlyNonSignerAccounts !== originalHeader.numReadonlyNonSignerAccounts + addedStatic.length) return false

  const originalRoles = validStaticRoles(original)
  const candidateRoles = validStaticRoles(candidate)
  if (!originalRoles || !candidateRoles) return false
  for (const [account, role] of originalRoles) if (candidateRoles.get(account) !== role) return false
  for (const account of addedStatic) if (candidateRoles.get(account) !== 'readonly') return false

  if (candidate.instructions.length < original.instructions.length) return false
  const originalKeys = messageAccountKeys(original)
  const candidateKeys = messageAccountKeys(candidate)
  for (let index = 0; index < original.instructions.length; index++) {
    if (!instructionMatches(original.instructions[index], originalKeys, candidate.instructions[index], candidateKeys)) return false
  }
  const appendedInstructions = candidate.instructions.slice(original.instructions.length)
  if (!appendedInstructions.length || appendedInstructions.some((instruction) =>
    candidate.staticAccounts[instruction.programAddressIndex] !== LIGHTHOUSE_PROGRAM_ID
      || !isReadOnlyLighthouseAssertion(instruction, candidateKeys))) return false
  return true
}

export function transactionMessageBytesFromBase64(transactionBase64) {
  if (typeof transactionBase64 !== 'string' || !transactionBase64 || transactionBase64.length > 100_000) {
    throw new TransactionIntentError('Invalid built transaction.')
  }
  try {
    const transaction = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(transactionBase64, 'base64')))
    messageDigest(transaction.messageBytes)
    return transaction.messageBytes
  } catch (error) {
    if (error instanceof TransactionIntentError) throw error
    throw new TransactionIntentError('Invalid built transaction.')
  }
}

function validateLendingBuildMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.kind !== 'lending-build'
    || !LENDING_BUILD_ACTIONS.has(metadata.action)) {
    throw new TransactionIntentError('Invalid lending build intent metadata.')
  }
  if (metadata.flow == null && metadata.stage == null) return
  const expectedAction = BORROWER_FLOW_ACTIONS.get(`${metadata.flow}:${metadata.stage}`)
  if (!expectedAction || metadata.action !== expectedAction || metadata.marketId !== 'sol-usdy-usdc' || metadata.tokenId !== 'svm-usdy') {
    throw new TransactionIntentError('Borrower flow stage does not match its Kamino action or configured market token.')
  }
  if (metadata.flowAmountBaseUnits != null && (typeof metadata.flowAmountBaseUnits !== 'string'
    || !/^\d+$/.test(metadata.flowAmountBaseUnits) || BigInt(metadata.flowAmountBaseUnits) <= 0n)) {
    throw new TransactionIntentError('Invalid borrower flow amount.')
  }
}

/** Keep short-lived authorization for an exact server-built transaction message. */
export function createSwapIntentStore({ ttlMs = 15_000, maxEntries = MAX_ENTRIES, now = Date.now, idFactory = randomUUID, messageMatcher = null } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0
    || typeof now !== 'function' || typeof idFactory !== 'function'
    || messageMatcher != null && typeof messageMatcher !== 'function') throw new TypeError('Invalid transaction intent store settings.')
  const intents = new Map()
  function prune(at) {
    for (const [id, intent] of intents) if (at >= intent.expiresAt) intents.delete(id)
  }
  return {
    issue({ wallet, messageBytes, metadata = null, expiresAt = Infinity } = {}) {
      const at = now()
      if (!Number.isFinite(at)) throw new TransactionIntentError('Invalid transaction intent clock.')
      if (typeof wallet !== 'string' || !isAddress(wallet)) throw new TransactionIntentError('Invalid wallet for transaction intent.')
      if (expiresAt !== Infinity && (!Number.isFinite(expiresAt) || expiresAt <= at)) throw new TransactionIntentError('Transaction intent quote has expired.')
      const digest = messageDigest(messageBytes)
      let safeMetadata
      try { safeMetadata = clone(metadata) } catch { throw new TransactionIntentError('Invalid transaction intent metadata.') }
      if (safeMetadata != null && (typeof safeMetadata !== 'object' || Array.isArray(safeMetadata))) {
        throw new TransactionIntentError('Invalid transaction intent metadata.')
      }
      prune(at)
      while (intents.size >= maxEntries) intents.delete(intents.keys().next().value)
      const id = idFactory()
      if (typeof id !== 'string' || !id || intents.has(id)) throw new TransactionIntentError('Could not create a unique transaction intent.')
      const record = {
        id, wallet, digest, messageBytes: messageMatcher ? Uint8Array.from(messageBytes) : null,
        expiresAt: Math.min(at + ttlMs, expiresAt), metadata: safeMetadata,
      }
      intents.set(id, record)
      return { id, wallet, expiresAt: record.expiresAt, metadata: clone(safeMetadata) }
    },
    assertAndConsume(id, wallet, messageBytes) {
      const at = now()
      if (!Number.isFinite(at)) throw new TransactionIntentError('Invalid transaction intent clock.')
      const intent = intents.get(id)
      if (!intent) throw new TransactionIntentError('Unknown or already used transaction intent.')
      if (at >= intent.expiresAt) {
        intents.delete(id)
        prune(at)
        throw new TransactionIntentError('Transaction intent expired.')
      }
      prune(at)
      if (wallet !== intent.wallet) throw new TransactionIntentError('Transaction intent wallet does not match.')
      const digest = messageDigest(messageBytes)
      const exactMatch = digest.length === intent.digest.length && timingSafeEqual(digest, intent.digest)
      let normalizedMatch = false
      if (!exactMatch && messageMatcher) {
        try { normalizedMatch = messageMatcher(intent.messageBytes, messageBytes, intent.metadata) === true } catch { normalizedMatch = false }
      }
      if (!exactMatch && !normalizedMatch) {
        throw new TransactionIntentError('Signed transaction changed after authorization.')
      }
      intents.delete(id)
      return { id: intent.id, wallet: intent.wallet, expiresAt: intent.expiresAt, metadata: clone(intent.metadata) }
    },
    size() {
      const at = now()
      if (!Number.isFinite(at)) throw new TransactionIntentError('Invalid transaction intent clock.')
      prune(at)
      return intents.size
    },
  }
}

/** Short-lived exact-message authorization for server-built ordinary and borrower-flow lending transactions. */
export function createLendingTransactionIntentStore(options = {}) {
  const store = createSwapIntentStore({ ...options, messageMatcher: messageMatchesWithLighthouse })
  return {
    issue(input = {}) {
      validateLendingBuildMetadata(input.metadata)
      return store.issue(input)
    },
    assertAndConsume(id, wallet, messageBytes) {
      const intent = store.assertAndConsume(id, wallet, messageBytes)
      validateLendingBuildMetadata(intent.metadata)
      return intent
    },
    size() { return store.size() },
  }
}

/** Exact-message intents for the optional acquire/supply and withdraw/sell Kamino steps. */
export function createBorrowerFlowIntentStore(options = {}) {
  const store = createSwapIntentStore(options)
  return {
    issue(input = {}) {
      validateBorrowerFlowMetadata(input.metadata)
      return store.issue(input)
    },
    assertAndConsume(id, wallet, messageBytes) {
      const intent = store.assertAndConsume(id, wallet, messageBytes)
      validateBorrowerFlowMetadata(intent.metadata)
      return intent
    },
    size() { return store.size() },
  }
}
