import {
  address, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from '@solana/kit'

const base58 = getBase58Decoder()

export class DefiniteSendRefusal extends Error {
  constructor(message) {
    super(message)
    this.status = 400
    this.definite = true
  }
}

export class SendOutcomeUnknownError extends Error {
  constructor(signature, cause) {
    super('The RPC send response was lost; transaction outcome is unknown.', { cause })
    this.signature = signature
    this.status = 502
    this.ambiguous = true
  }
}

function signedTransactionSignature(tx, wallet) {
  let decoded
  try { decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64'))) }
  catch { throw new DefiniteSendRefusal('Invalid signed transaction.') }
  let owner
  try { owner = String(address(wallet)) } catch { throw new DefiniteSendRefusal('Invalid transaction wallet.') }
  const message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)
  const signature = decoded.signatures?.[owner]
  if (String(message.staticAccounts?.[0]) !== owner || !(signature instanceof Uint8Array)
    || signature.length !== 64 || signature.every((byte) => byte === 0)) {
    throw new DefiniteSendRefusal('The transaction is not signed by this wallet.')
  }
  return base58.decode(signature)
}

/** Only failures before invoking the RPC are definite refusals; any send exception preserves the derived signature. */
export async function relaySignedTransaction({ tx, wallet, refuse, send, onSuccess = () => {} } = {}) {
  if (typeof tx !== 'string' || typeof wallet !== 'string' || typeof refuse !== 'function' || typeof send !== 'function') {
    throw new DefiniteSendRefusal('Invalid signed transaction request.')
  }
  const refusal = await refuse(tx, wallet)
  if (refusal) throw new DefiniteSendRefusal(refusal)
  const signature = signedTransactionSignature(tx, wallet)
  let returned
  try { returned = await send(tx) }
  catch (error) {
    // The RPC simulates before forwarding; a failed simulation means the transaction was never sent.
    if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
      const hint = (error.context?.logs ?? []).find((line) => /error|failed/i.test(line))
      throw new DefiniteSendRefusal(`The network refused the transaction in simulation, so nothing was sent${hint ? `: ${hint.replace(/^Program log: /, '')}` : '.'}`)
    }
    throw new SendOutcomeUnknownError(signature, error)
  }
  if (returned !== signature) throw new SendOutcomeUnknownError(signature, new Error('RPC returned a different signature.'))
  onSuccess(signature)
  return { signature }
}
