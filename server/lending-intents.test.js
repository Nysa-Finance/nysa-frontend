import assert from 'node:assert/strict'
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables, generateKeyPairSigner, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, partiallySignTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { relayRefusal, noteBuilt, RELAY_PROGRAMS } from './relay.js'
import { createLendingTransactionIntentStore } from './tx-intent.js'
import { createLendingTransactionIntentService } from './lending-intents.js'

const signer = await generateKeyPairSigner()
const wallet = String(signer.address)
const victimSigner = await generateKeyPairSigner()
const victimWallet = String(victimSigner.address)
const recipientOne = await generateKeyPairSigner()
const recipientTwo = await generateKeyPairSigner()
const extraSigner = await generateKeyPairSigner()
const alternateBlockhash = await generateKeyPairSigner()
const system = address('11111111111111111111111111111111')
const klend = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD')
const lighthouse = address('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95')
const tokenProgram = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const lookupTable = address('AddressLookupTab1e1111111111111111111111111')
const alternateLookupTable = address('SysvarRent111111111111111111111111111111111')

function transaction(instructionData = Uint8Array.of(1), payer = signer, {
  recipient = recipientOne.address, withUnrelated = false, withLighthouse = false, withTokenProgramReadonly = false,
  withLookup = false, lookupAddress = lookupTable, guardSigner = null, blockhash = system,
  lighthouseData = Uint8Array.from([5, 0, 6, 0, 0]), lighthouseAccounts = [{ address: tokenProgram, role: AccountRole.READONLY }],
} = {}) {
  const accounts = [
    { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: recipient, role: AccountRole.WRITABLE },
  ]
  if (withTokenProgramReadonly) accounts.push({ address: tokenProgram, role: AccountRole.READONLY })
  const instructions = [{
    programAddress: klend,
    accounts,
    data: instructionData,
  }]
  if (withUnrelated) instructions.push({ programAddress: system, accounts: [], data: Uint8Array.of(7) })
  if (withLighthouse) instructions.push({
    programAddress: lighthouse,
    accounts: guardSigner ? [{ address: guardSigner.address, role: AccountRole.WRITABLE_SIGNER }] : lighthouseAccounts,
    data: lighthouseData,
  })
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(payer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: String(blockhash), lastValidBlockHeight: 2n }, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  )
  if (withLookup) message = compressTransactionMessageUsingAddressLookupTables(message, { [String(lookupAddress)]: [recipient] })
  return compileTransaction(message)
}

async function signedMessage(transactionBase64, payer = signer) {
  const compiled = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(transactionBase64, 'base64')))
  const signed = await partiallySignTransaction([payer.keyPair], compiled)
  return getBase64EncodedWireTransaction(signed)
}

let now = 1_000
let nextId = 0
const intentStore = createLendingTransactionIntentStore({ now: () => now, ttlMs: 100, idFactory: () => `lending-${++nextId}` })
let buildIndex = 0
const relayedMessages = []
const service = createLendingTransactionIntentService({
  intentStore,
  onBuild: (owner) => noteBuilt(owner),
  build: async (request) => ({
    tx: getBase64EncodedWireTransaction(transaction(
      request.includeTokenProgramReadonly ? Uint8Array.of(99)
        : request.includeLookup ? Uint8Array.of(101)
          : Uint8Array.of(++buildIndex),
      request.wallet === victimWallet ? victimSigner : signer,
      { withTokenProgramReadonly: request.includeTokenProgramReadonly, withLookup: request.includeLookup },
    )),
    minContextSlot: 1, final: true,
  }),
  relay: async ({ tx, wallet: owner, intentId, intentStore: store, requireIntent }) => {
    const refusal = await relayRefusal(tx, owner, { intentStore: store, intentId, requireIntent })
    if (refusal) throw new Error(refusal)
    relayedMessages.push(tx)
    return { signature: `sig-${relayedMessages.length}` }
  },
})

noteBuilt(wallet)
const flowRequest = {
  wallet, kind: 'deposit', market: 'sol-usdy-usdc', token: 'svm-usdy', amountBaseUnits: '25000000',
  swapFlow: 'acquire-supply', swapFlowStage: 'supply', flowAmountBaseUnits: '25000000',
}
const borrowerBuild = await service.build(flowRequest)
assert.equal(borrowerBuild.intentId, 'lending-1')
assert.equal(borrowerBuild.intentExpiresAt, now + 100)
const borrowerSigned = await signedMessage(borrowerBuild.tx)
await assert.rejects(service.send({ tx: borrowerSigned, wallet }), /exact transaction intent is required/i,
  'borrower-built transaction cannot fall back to legacy relay when its id is omitted')
const changedMessage = await signedMessage(getBase64EncodedWireTransaction(transaction(Uint8Array.of(0xff))))
await assert.rejects(service.send({ tx: changedMessage, wallet, intentId: borrowerBuild.intentId }), /changed after authorization/i,
  'a changed amount cannot reuse the borrower intent')
const changedRecipient = await signedMessage(getBase64EncodedWireTransaction(transaction(Uint8Array.of(1), signer, { recipient: recipientTwo.address })))
await assert.rejects(service.send({ tx: changedRecipient, wallet, intentId: borrowerBuild.intentId }), /changed after authorization/i,
  'a changed recipient cannot reuse the borrower intent')
const changedInstructions = await signedMessage(getBase64EncodedWireTransaction(transaction(Uint8Array.of(1), signer, { withUnrelated: true })))
await assert.rejects(service.send({ tx: changedInstructions, wallet, intentId: borrowerBuild.intentId }), /changed after authorization/i,
  'an added unrelated instruction cannot reuse the borrower intent')
assert.deepEqual(await service.send({ tx: borrowerSigned, wallet, intentId: borrowerBuild.intentId }), { signature: 'sig-1' },
  'the exact server-built borrower message relays once')
await assert.rejects(service.send({ tx: borrowerSigned, wallet, intentId: borrowerBuild.intentId }), /unknown or already used/i)

// iOS wallet adds its Lighthouse assertion after signing. Adding the readonly program key can reorder other readonly
// static accounts, while the original fee payer, blockhash, lookup tables, accounts, and instructions stay equivalent.
const ordinaryIosBuild = await service.build({
  wallet, kind: 'deposit', market: 'sol-usdy-usdc', token: 'svm-usdy', includeTokenProgramReadonly: true,
})
const ordinaryIosGuarded = await signedMessage(getBase64EncodedWireTransaction(transaction(
  Uint8Array.of(99), signer, { withTokenProgramReadonly: true, withLighthouse: true },
)))
const ordinaryIosBaseMessage = getCompiledTransactionMessageDecoder().decode(
  getTransactionDecoder().decode(Uint8Array.from(Buffer.from(ordinaryIosBuild.tx, 'base64'))).messageBytes,
)
const ordinaryIosGuardedMessage = getCompiledTransactionMessageDecoder().decode(
  getTransactionDecoder().decode(Uint8Array.from(Buffer.from(ordinaryIosGuarded, 'base64'))).messageBytes,
)
assert.notDeepEqual(ordinaryIosGuardedMessage.staticAccounts.slice(0, ordinaryIosBaseMessage.staticAccounts.length), ordinaryIosBaseMessage.staticAccounts,
  'canonical compilation inserts Lighthouse before a later readonly static key, so raw static prefix is not stable')
assert.deepEqual(ordinaryIosGuardedMessage.staticAccounts.filter((key) => key !== String(lighthouse)), ordinaryIosBaseMessage.staticAccounts,
  'removing only the appended Lighthouse program key restores the original static account ordering')
const mutatedGuardedAmount = await signedMessage(getBase64EncodedWireTransaction(transaction(
  Uint8Array.of(100), signer, { withTokenProgramReadonly: true, withLighthouse: true },
)))
await assert.rejects(service.send({ tx: mutatedGuardedAmount, wallet, intentId: ordinaryIosBuild.intentId }), /changed after authorization/i,
  'Lighthouse cannot authorize changed amount or original instruction data')
const mutatedGuardedRecipient = await signedMessage(getBase64EncodedWireTransaction(transaction(
  Uint8Array.of(99), signer, { recipient: recipientTwo.address, withTokenProgramReadonly: true, withLighthouse: true },
)))
await assert.rejects(service.send({ tx: mutatedGuardedRecipient, wallet, intentId: ordinaryIosBuild.intentId }), /changed after authorization/i,
  'Lighthouse cannot authorize a changed recipient')
const mutatedGuardedInstructions = await signedMessage(getBase64EncodedWireTransaction(transaction(
  Uint8Array.of(99), signer, { withUnrelated: true, withTokenProgramReadonly: true, withLighthouse: true },
)))
await assert.rejects(service.send({ tx: mutatedGuardedInstructions, wallet, intentId: ordinaryIosBuild.intentId }), /changed after authorization/i,
  'Lighthouse cannot authorize added unrelated instructions')
const mutatedGuardedBlockhash = await signedMessage(getBase64EncodedWireTransaction(transaction(
  Uint8Array.of(99), signer, { blockhash: alternateBlockhash.address, withTokenProgramReadonly: true, withLighthouse: true },
)))
await assert.rejects(service.send({ tx: mutatedGuardedBlockhash, wallet, intentId: ordinaryIosBuild.intentId }), /changed after authorization/i,
  'Lighthouse cannot authorize a changed blockhash')
const addedGuardSigner = await signedMessage(getBase64EncodedWireTransaction(transaction(
  Uint8Array.of(99), signer, { guardSigner: extraSigner, withTokenProgramReadonly: true, withLighthouse: true },
)), signer)
await assert.rejects(service.send({ tx: addedGuardSigner, wallet, intentId: ordinaryIosBuild.intentId }), /changed after authorization/i,
  'Lighthouse guard cannot change signer counts or add signers')
for (const [name, lighthouseData, lighthouseAccounts] of [
  ['MemoryWrite', Uint8Array.from([0, 0, 0, 0]), []],
  ['MemoryClose', Uint8Array.from([1, 0, 0]), []],
  ['empty data', new Uint8Array(), []],
  ['unknown instruction', Uint8Array.from([255, 0, 0]), []],
  ['assertion missing target account', Uint8Array.from([5, 0, 6, 0, 0]), []],
  ['accountless clock assertion', Uint8Array.from([15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), []],
]) {
  const maliciousGuard = await signedMessage(getBase64EncodedWireTransaction(transaction(
    Uint8Array.of(99), signer, { withTokenProgramReadonly: true, withLighthouse: true, lighthouseData, lighthouseAccounts },
  )))
  await assert.rejects(service.send({ tx: maliciousGuard, wallet, intentId: ordinaryIosBuild.intentId }), /changed after authorization/i,
    `Lighthouse ${name} cannot use an appended-program intent allowance`)
}
await assert.doesNotReject(service.send({ tx: ordinaryIosGuarded, wallet, intentId: ordinaryIosBuild.intentId }),
  'ordinary iOS transaction accepts only the appended Lighthouse guard while preserving the built message')

const ordinaryIosLookupBuild = await service.build({
  wallet, kind: 'deposit', market: 'sol-usdy-usdc', token: 'svm-usdy', includeLookup: true,
  includeTokenProgramReadonly: true,
})
const ordinaryIosLookupGuarded = await signedMessage(getBase64EncodedWireTransaction(transaction(
  Uint8Array.of(99), signer, { withLookup: true, withTokenProgramReadonly: true, withLighthouse: true },
)))
const mutatedGuardedLookup = await signedMessage(getBase64EncodedWireTransaction(transaction(
  Uint8Array.of(99), signer, { withLookup: true, lookupAddress: alternateLookupTable, withTokenProgramReadonly: true, withLighthouse: true },
)))
await assert.rejects(service.send({ tx: mutatedGuardedLookup, wallet, intentId: ordinaryIosLookupBuild.intentId }), /changed after authorization/i,
  'Lighthouse cannot authorize a changed lookup table')
await assert.doesNotReject(service.send({ tx: ordinaryIosLookupGuarded, wallet, intentId: ordinaryIosLookupBuild.intentId }),
  'Lighthouse normalization preserves and checks the exact original lookup table')

// An unsubmitted flow intent for an attacker-named wallet is scoped to its message, so it cannot poison a later ordinary action.
const victimFlowBuild = await service.build({ ...flowRequest, wallet: victimWallet })
const victimOrdinaryBuild = await service.build({ wallet: victimWallet, kind: 'withdraw', market: 'sol-usdy-usdc', token: 'svm-usdy', all: true })
const victimOrdinarySigned = await signedMessage(victimOrdinaryBuild.tx, victimSigner)
await assert.doesNotReject(service.send({ tx: victimOrdinarySigned, wallet: victimWallet, intentId: victimOrdinaryBuild.intentId }),
  'an abandoned flow build for another wallet cannot block a new exact ordinary build')
assert.ok(RELAY_PROGRAMS.has(String(klend)))
assert.ok(victimFlowBuild.intentId)

// An expired abandoned intent also has no wallet-wide effect.
const expiredBuild = await service.build(flowRequest)
now += 101
await assert.rejects(service.send({ tx: await signedMessage(expiredBuild.tx), wallet, intentId: expiredBuild.intentId }), /expired/i)
const ordinaryAfterExpiry = await service.build({ wallet, kind: 'deposit', market: 'sol-usdy-usdc', token: 'svm-usdy', amountBaseUnits: '1000000' })
await assert.doesNotReject(service.send({ tx: await signedMessage(ordinaryAfterExpiry.tx), wallet, intentId: ordinaryAfterExpiry.intentId }))

// Preview responses have no transaction and must not mint relay authorization.
const previewService = createLendingTransactionIntentService({
  intentStore,
  build: async () => ({ quote: { repaid: 1 } }),
  relay: async () => assert.fail('preview cannot relay'),
})
assert.deepEqual(await previewService.build({ wallet, kind: 'liquidate', market: 'sol-usdy-usdc', borrower: wallet, preview: true }), { quote: { repaid: 1 } })

console.log('lending build and exact relay intent integration ok')
