// Deeplink wallets (Phantom/Solflare on iOS) sign but don't send, so /api/tx/send relays for them. GET /api/tx/:sig,
// which anyone can call with any signature, refreshes the market cache only for our own transactions.
import {
  address, getTransactionDecoder, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, verifySignature,
} from '@solana/kit'
import { isSanctioned } from './screening.js'

const WINDOW_MS = 10 * 60_000
const CLOCK_SLACK_MS = 60_000 // block time vs our clock
const MAX_ENTRIES = 10_000

// Our builders' programs (tx.js, klend-sdk, farms-sdk), plus Lighthouse: wallets add its assertions when signing
// (Phantom's guard). Every reserve token is SPL Token; add Token-2022 here with a Token-2022 reserve.
export const RELAY_PROGRAMS = new Set([
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', // Kamino Lend
  'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr', // Kamino Farms (reward claims)
  'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd', // Kamino Earn vaults (kVault)
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
  'ComputeBudget111111111111111111111111111111', // Compute Budget
  '11111111111111111111111111111111', // System
  'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', // Lighthouse
])

const built = new Map()
const relayed = new Map()
const counted = new Map() // its confirmation was already checked, so it refreshes at most once

function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value)
}

let lastBuild = -Infinity
export function noteBuilt(wallet) {
  lastBuild = Date.now()
  remember(built, wallet, lastBuild)
}

export const noteRelayed = (signature) => remember(relayed, signature, Date.now())
const builtAt = (wallet) => { const at = built.get(wallet); return at && Date.now() - at <= WINDOW_MS ? at : null }

// The fee payer is screened by the route too; a co-signer only here.
export async function relayRefusal(tx, wallet, { approvedProgramIds = [], intentStore, intentId, requireIntent = false } = {}) {
  if (!builtAt(wallet)) return 'Unknown transaction, please try again'
  let messageBytes, signatures, message
  try {
    ;({ messageBytes, signatures } = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64'))))
    message = getCompiledTransactionMessageDecoder().decode(messageBytes)
  } catch { return 'Invalid transaction' }
  const accounts = message.staticAccounts.map(String)
  const signature = signatures[wallet]
  if (accounts[0] !== wallet || !signature || !(await verifySignature(await getPublicKeyFromAddress(address(wallet)), signature, messageBytes))) {
    return 'The transaction is not signed by this wallet'
  }
  if (accounts.slice(0, message.header.numSignerAccounts).some(isSanctioned)) return 'A signer of this transaction is on a sanctions list, so Nysa cannot relay it.'
  // Program ids are always static accounts; an index past them is malformed and refused as well.
  const approved = new Set(approvedProgramIds)
  if (message.instructions.some((ix) => !RELAY_PROGRAMS.has(accounts[ix.programAddressIndex]) && !approved.has(accounts[ix.programAddressIndex]))) return 'This transaction calls a program Nysa doesn\'t use, so it cannot be relayed.'
  if (requireIntent) {
    if (typeof intentId !== 'string' || !intentId || !intentStore || typeof intentStore.assertAndConsume !== 'function') {
      return 'An exact transaction intent is required to relay this transaction.'
    }
    let intent
    try { intent = intentStore.assertAndConsume(intentId, wallet, messageBytes) }
    catch (error) { return error?.message ?? 'Transaction intent is invalid.' }
    if (intent?.metadata?.kind !== 'lending-build') return 'Transaction intent is invalid.'
  }
  return null
}

// Only relayed here, or landed after its fee payer had a transaction built here. lookup is called only when some
// wallet built recently.
export async function confirmedHere(signature, lookup) {
  if (counted.has(signature)) return false
  remember(counted, signature, true)
  if (relayed.has(signature)) return true
  if (Date.now() - lastBuild > WINDOW_MS) return false // no build in the window: no transaction can be ours, skip the lookup
  let tx = null
  try { tx = await lookup(signature) } finally { if (!tx) counted.delete(signature) } // not visible yet, or failed: a later poll retries
  if (!tx) return false
  const at = builtAt(tx.feePayer)
  return !!at && (tx.blockTime == null || tx.blockTime * 1000 >= at - CLOCK_SLACK_MS)
}
