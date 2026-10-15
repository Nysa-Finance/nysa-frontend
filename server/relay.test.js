// What /api/tx/send relays and which confirmations refresh the market (server/relay.js), with real signed transactions
// and a stubbed sanctions list. Run by `npm test`.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'node:test'
import {
  address, AccountRole, generateKeyPairSigner, pipe, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction,
  partiallySignTransaction, getBase64EncodedWireTransaction,
} from '@solana/kit'
import { PROGRAM_ID as KLEND } from '@kamino-finance/klend-sdk'

const require = createRequire(import.meta.url)
const { FARMS_PROGRAM_ADDRESS } = require('@kamino-finance/farms-sdk')

// Well-known program ids, written out: @solana-program/* are not direct dependencies of this repo.
const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nysa-relay-'))
const [user, sanctioned, other] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()])
const entry = (addr) => `<id><idType>Digital Currency Address - SOL</idType><idNumber>${addr}</idNumber></id>`
const sdn = [entry(sanctioned.address), ...Array.from({ length: 150 }, (_, i) => entry(`Filler${i}`))].join('\n')
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => `<sdnList>${sdn}</sdnList>` })
const { refreshSanctions } = await import('./screening.js')
await refreshSanctions()
const { RELAY_PROGRAMS, noteBuilt, noteRelayed, relayRefusal, confirmedHere } = await import('./relay.js')

// The allow-list matches the SDKs' program ids (Compute Budget and Lighthouse were checked on mainnet: executable).
for (const id of [KLEND, FARMS_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS]) assert.ok(RELAY_PROGRAMS.has(String(id)), String(id))
assert.equal(RELAY_PROGRAMS.size, 7)

const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const ix = (program, signers = []) => ({
  programAddress: address(program), data: new Uint8Array([1]),
  accounts: signers.map((s) => ({ address: s.address, role: AccountRole.WRITABLE_SIGNER, signer: s })),
})
// Fee payer `payer`, signed by every signer in `signWith`.
async function signed(payer, ixs, signWith = [payer]) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  )
  return getBase64EncodedWireTransaction(await partiallySignTransaction(signWith.map((s) => s.keyPair), compileTransaction(msg)))
}
const lending = [ix('ComputeBudget111111111111111111111111111111'), ix('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), ix(String(KLEND))]

// Only for a wallet that just had a transaction built here.
const ok = await signed(user, lending)
assert.equal(await relayRefusal(ok, user.address), 'Unknown transaction, please try again')
noteBuilt(user.address)
assert.equal(await relayRefusal(ok, user.address), null)
// A guard instruction added by the wallet is fine.
assert.equal(await relayRefusal(await signed(user, [...lending, ix(LIGHTHOUSE)]), user.address), null)

// F-4: any other program is refused (the relay used to carry anything the fee payer signed).
assert.match(await relayRefusal(await signed(user, [...lending, ix(MEMO)]), user.address), /program Nysa doesn't use/)
assert.match(await relayRefusal(await signed(user, [ix(MEMO)]), user.address), /program Nysa doesn't use/)
// F-4: every signer is screened, not only the fee payer.
const cosigned = await signed(user, [ix(String(SYSTEM_PROGRAM_ADDRESS), [sanctioned])], [user, sanctioned])
assert.match(await relayRefusal(cosigned, user.address), /sanctions list/)
assert.equal(await relayRefusal(await signed(user, [ix(String(SYSTEM_PROGRAM_ADDRESS), [other])], [user, other]), user.address), null)

// The wallet must be the fee payer and its signature valid.
assert.equal(await relayRefusal(await signed(other, [ix(String(KLEND), [user])], [other, user]), user.address), 'The transaction is not signed by this wallet')
assert.equal(await relayRefusal(await signed(user, lending, []), user.address), 'The transaction is not signed by this wallet')
const tampered = Buffer.from(ok, 'base64')
tampered[1] ^= 1 // first byte of the signature
assert.equal(await relayRefusal(tampered.toString('base64'), user.address), 'The transaction is not signed by this wallet')
assert.equal(await relayRefusal('AAAA', user.address), 'Invalid transaction')

// F-1: a confirmation refreshes the market only for our transactions, once each. Anything else costs one lookup.
const now = Math.floor(Date.now() / 1000)
let lookups = 0
const landed = (tx) => async () => (lookups++, tx)
noteRelayed('RelayedSig')
assert.equal(await confirmedHere('RelayedSig', landed(null)), true)
assert.equal(await confirmedHere('RelayedSig', landed(null)), false) // polled again
assert.equal(lookups, 0)
assert.equal(await confirmedHere('BuiltSig', landed({ feePayer: user.address, blockTime: now })), true)
assert.equal(await confirmedHere('BuiltSig', landed({ feePayer: user.address, blockTime: now })), false)
assert.equal(await confirmedHere('StrangerSig', landed({ feePayer: other.address, blockTime: now })), false)
assert.equal(await confirmedHere('OldSig', landed({ feePayer: user.address, blockTime: now - 3600 })), false) // landed before the build
assert.equal(lookups, 3)
// Not visible on the RPC node yet, or the lookup failed: a later poll tries again.
assert.equal(await confirmedHere('LateSig', landed(null)), false)
await assert.rejects(confirmedHere('LateSig', async () => { throw new Error('rpc down') }))
assert.equal(await confirmedHere('LateSig', landed({ feePayer: user.address, blockTime: null })), true)

// A build is relayable (and its transactions count) for 10 minutes.
mock.timers.enable({ apis: ['Date'], now: Date.now() + 11 * 60_000 })
assert.equal(await relayRefusal(ok, user.address), 'Unknown transaction, please try again')
const before = lookups
assert.equal(await confirmedHere('LaterSig', landed({ feePayer: user.address, blockTime: null })), false)
assert.equal(lookups, before) // no build in the window: not even looked up
mock.timers.reset()

console.log('relay ok')
