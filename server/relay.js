// Transactions this server built or relayed. Wallets reached by deeplink (Phantom/Solflare on iOS) sign but don't
// send, so /api/tx/send relays their signed transaction; and a confirmed one of ours refreshes the market cache for
// everyone (GET /api/tx/:sig, which anyone can call with any signature).
import {
  address, getTransactionDecoder, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, verifySignature,
} from '@solana/kit'
import { isSanctioned } from './screening.js'

const WINDOW_MS = 10 * 60_000 // a wallet's build stays relayable this long
const CLOCK_SLACK_MS = 60_000 // block time vs our clock
const MAX_ENTRIES = 10_000

// Programs a relayed transaction may call at the top level: the ones our builders use (tx.js, klend-sdk, farms-sdk),
// plus Lighthouse, whose assertion instructions wallets add when signing (Phantom's transaction guard).
// Every reserve token is SPL Token (USDY, USDC); add Token-2022 here with a Token-2022 reserve.
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

const built = new Map() // wallet -> when it last had a transaction built here
const relayed = new Map() // signature -> when it was relayed here
const counted = new Map() // signature -> true: its confirmation was already checked, so it refreshes at most once

// Map with insertion-order eviction past MAX_ENTRIES.
function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value)
}

let lastBuild = -Infinity // when any wallet last had a transaction built here
export const noteBuilt = (wallet) => { lastBuild = Date.now(); remember(built, wallet, lastBuild) }
export const noteRelayed = (signature) => remember(relayed, signature, Date.now())
const builtAt = (wallet) => { const at = built.get(wallet); return at && Date.now() - at <= WINDOW_MS ? at : null }

// Why a signed transaction (base64) can't be relayed for `wallet`, or null when it can: the wallet just had one built
// here, it is the fee payer and its signature is valid, no signer is on the sanctions list (the fee payer is
// screened by the route too, a co-signer only here), and every instruction calls an allowed program.
export async function relayRefusal(tx, wallet) {
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
  if (message.instructions.some((ix) => !RELAY_PROGRAMS.has(accounts[ix.programAddressIndex]))) return 'This transaction calls a program Nysa doesn\'t use, so it cannot be relayed.'
  return null
}

// Whether a confirmed signature should refresh the market cache: at most once per signature, and only when it was
// relayed here or landed after its fee payer had a transaction built here. lookup(signature) -> { feePayer,
// blockTime (s) } | null, called only when some wallet built recently.
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
