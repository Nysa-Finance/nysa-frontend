import { address, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit'

const base58 = getBase58Decoder()

/** Derive the first signature from the wallet-returned bytes before attempting backend relay. */
export function signatureFromSignedTransaction(signedBytes, wallet) {
  if (!(signedBytes instanceof Uint8Array)) throw new TypeError('Signed transaction bytes are required.')
  let decoded
  try { decoded = getTransactionDecoder().decode(signedBytes) }
  catch { throw new Error('Wallet returned an invalid signed transaction.') }
  const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)
  let signer
  try { signer = String(address(wallet)) } catch { throw new Error('Signed transaction wallet is invalid.') }
  if (String(message.staticAccounts?.[0]) !== signer) throw new Error('Signed transaction fee payer does not match this wallet.')
  const signature = decoded.signatures?.[signer]
  if (!(signature instanceof Uint8Array) || signature.length !== 64 || signature.every((byte) => byte === 0)) {
    throw new Error('Wallet returned a transaction without this wallet’s signature.')
  }
  return base58.decode(signature)
}

/** Save the signed transaction and derived signature before relay; ambiguous transport remains a blocking pending state. */
export async function persistSignedSwapBeforeRelay({ pending, signedTransaction, persist, relay } = {}) {
  if (typeof persist !== 'function' || typeof relay !== 'function') throw new TypeError('Swap persistence and relay functions are required.')
  const signature = signatureFromSignedTransaction(signedTransaction, pending?.wallet)
  let binary = ''
  for (let index = 0; index < signedTransaction.length; index += 0x8000) binary += String.fromCharCode(...signedTransaction.subarray(index, index + 0x8000))
  let saved = { ...pending, signature, signedTransactionBase64: btoa(binary), status: 'signed-pending' }
  await persist(saved)
  try {
    const relayed = await relay({ signature, signedTransaction })
    if (relayed?.signature !== signature) {
      const error = new Error('Relay response did not match the wallet signature.')
      error.code = 'RELAY_SIGNATURE_MISMATCH'
      throw error
    }
    saved = { ...saved, status: 'submitted' }
    const persisted = await persist(saved)
    if (persisted?.terminalOutcome) return { pending: saved, error: null, terminalOutcome: persisted.terminalOutcome }
    return { pending: saved, error: null }
  } catch (error) {
    const definitelyNotRelayed = [400, 403, 429, 503].includes(error?.status)
    const relayErrorCode = error?.code === 'RELAY_SIGNATURE_MISMATCH'
      ? 'RELAY_SIGNATURE_MISMATCH'
      : definitelyNotRelayed ? 'RELAY_DEFINITE_REJECTION' : 'RELAY_TRANSPORT_UNKNOWN'
    saved = { ...saved, status: definitelyNotRelayed ? 'rejected' : 'relay-unknown', relayErrorCode }
    try {
      const persisted = await persist(saved)
      if (persisted?.terminalOutcome) {
        return { pending: { ...saved, status: 'submitted' }, error: null, terminalOutcome: persisted.terminalOutcome }
      }
    } catch { /* the first signed-pending record still enables status reconciliation */ }
    return { pending: saved, error }
  }
}

/** Sum token balance changes reported in this confirmed transaction for one wallet and mint only. */
export function confirmedSwapAmountFromDeltas(tokenDeltas, wallet, mint) {
  if (!Array.isArray(tokenDeltas) || typeof wallet !== 'string' || typeof mint !== 'string') {
    throw new Error('Confirmed transaction token deltas are unavailable.')
  }
  let amount = 0n
  for (const item of tokenDeltas) {
    if (item?.owner !== wallet || item?.mint !== mint) continue
    if (typeof item.deltaBaseUnits !== 'string' || !/^-?\d+$/.test(item.deltaBaseUnits)) {
      throw new Error('Confirmed transaction token delta is invalid.')
    }
    amount += BigInt(item.deltaBaseUnits)
  }
  if (amount <= 0n) throw new Error('Confirmed transaction did not receive a positive amount of the expected token.')
  return String(amount)
}

export function confirmedSwapAmountFromTransaction(transaction, wallet, mint) {
  if (transaction?.status !== 'confirmed' || !Number.isSafeInteger(transaction.slot)
    || !Number.isSafeInteger(transaction.transactionSlot) || transaction.slot !== transaction.transactionSlot) {
    throw new Error('Confirmed transaction token balances are not bound to the confirmed slot.')
  }
  return confirmedSwapAmountFromDeltas(transaction.tokenDeltas, wallet, mint)
}

/** Keep a confirmed swap pending until its transaction-specific output amount can be attributed. */
export function pendingSwapChainOutcome(pending, chain) {
  if (chain?.status === 'failed') return { status: 'failed', signature: pending.signature, error: chain.error ?? 'Transaction failed on-chain.' }
  if (chain?.status !== 'confirmed') return { status: 'pending', signature: pending.signature }
  return {
    status: 'confirmed',
    signature: pending.signature,
    amountBaseUnits: confirmedSwapAmountFromTransaction(chain, chain.wallet, chain.outputMint),
  }
}
