// Phones have no wallet extensions. Android: Solana's Mobile Wallet Adapter. iOS: Phantom's and Solflare's deeplink
// protocol, whose answers are encrypted (x25519 + XSalsa20-Poly1305, as in their reference app).
import nacl from 'tweetnacl'
import { getBase58Decoder, getBase58Encoder } from '@solana/kit'

const b58 = (bytes) => getBase58Decoder().decode(bytes)
const fromB58 = (s) => new Uint8Array(getBase58Encoder().encode(s))
export const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
export const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes))

export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

export const MWA_NAME = 'Mobile Wallet Adapter'

// Android Chrome only: the library is loaded just there (it also checks the environment itself).
export async function registerMobileWalletAdapter() {
  if (!/android/i.test(navigator.userAgent)) return
  const { registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector, createDefaultWalletNotFoundHandler } = await import('@solana-mobile/wallet-standard-mobile')
  registerMwa({
    appIdentity: { name: 'Nysa', uri: location.origin, icon: 'favicon.png' },
    authorizationCache: createDefaultAuthorizationCache(),
    chains: ['solana:mainnet'],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  })
}

export const DEEPLINK_WALLETS = [
  { name: 'Phantom', icon: '/wallets/phantom.svg', base: 'https://phantom.com/ul/v1', keyParam: 'phantom_encryption_public_key' },
  { name: 'Solflare', icon: '/wallets/solflare.svg', base: 'https://solflare.com/ul/v1', keyParam: 'solflare_encryption_public_key' },
]
const SESSION_KEY = 'nysaDeeplinkSession'
const MARK = 'nysa_dl'
const WALLET_PARAMS = ['nonce', 'data', 'errorCode', 'errorMessage', ...DEEPLINK_WALLETS.map((w) => w.keyParam)]
// Our own text for the wallet's error codes: the wallet's errorMessage is never shown, since anyone can put text in a
// link to the app and it would appear in our UI as if Nysa said it.
const WALLET_ERRORS = {
  4001: 'Request rejected in the wallet',
  4100: 'The wallet did not authorize this request',
  '-32003': 'Transaction rejected by the wallet',
}

const load = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) } catch { return null } }
const save = (s) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)) } catch { /* private mode */ } }
export const clearDeeplinkSession = () => { try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ } }
const walletOf = (name) => DEEPLINK_WALLETS.find((w) => w.name === name)

function redirectLink(action) {
  const url = new URL(location.href)
  for (const p of [MARK, ...WALLET_PARAMS]) url.searchParams.delete(p)
  url.searchParams.set(MARK, action)
  return url.toString()
}

const encrypt = (payload, shared) => {
  const nonce = nacl.randomBytes(24)
  return { nonce: b58(nonce), payload: b58(nacl.box.after(new TextEncoder().encode(JSON.stringify(payload)), nonce, shared)) }
}
const decrypt = (data, nonce, shared) => {
  const plain = nacl.box.open.after(fromB58(data), fromB58(nonce), shared)
  if (!plain) throw new Error('Could not read the wallet response')
  return JSON.parse(new TextDecoder().decode(plain))
}

export function deeplinkSession() {
  const s = load()
  return s?.session && s.address ? { wallet: s.wallet, address: s.address } : null
}

// Open it from a tap: iOS only opens apps on user gestures.
export function connectUrl(name) {
  const w = walletOf(name)
  const kp = nacl.box.keyPair()
  save({ wallet: name, secret: b58(kp.secretKey) })
  const q = new URLSearchParams({ app_url: location.origin, dapp_encryption_public_key: b58(kp.publicKey), redirect_link: redirectLink('connect'), cluster: 'mainnet-beta' })
  return `${w.base}/connect?${q}`
}

export function signUrl(txBase64) {
  const s = load()
  if (!s?.session) throw new Error('The wallet session expired, connect again')
  const w = walletOf(s.wallet)
  const { nonce, payload } = encrypt({ transaction: b58(fromBase64(txBase64)), session: s.session }, fromB58(s.shared))
  const q = new URLSearchParams({ dapp_encryption_public_key: b58(nacl.box.keyPair.fromSecretKey(fromB58(s.secret)).publicKey), nonce, redirect_link: redirectLink('sign'), payload })
  return `${w.base}/signTransaction?${q}`
}

export function readDeeplinkReturn() {
  const params = new URLSearchParams(location.search)
  const action = params.get(MARK)
  if (!action) return null
  const url = new URL(location.href)
  for (const p of [MARK, ...WALLET_PARAMS]) url.searchParams.delete(p)
  history.replaceState(history.state, '', url)
  if (params.get('errorCode')) return { action, error: WALLET_ERRORS[params.get('errorCode')] ?? 'The wallet could not complete the request' }
  const s = load()
  try {
    if (action === 'connect') {
      const w = walletOf(s?.wallet)
      const walletKey = w && params.get(w.keyParam)
      if (!walletKey || !s?.secret) throw new Error('Unexpected wallet response, please connect again')
      const shared = nacl.box.before(fromB58(walletKey), fromB58(s.secret))
      const { public_key, session } = decrypt(params.get('data'), params.get('nonce'), shared)
      save({ ...s, shared: b58(shared), session, address: public_key })
      return { action, wallet: s.wallet, address: public_key }
    }
    if (action === 'sign') {
      if (!s?.shared) throw new Error('The wallet session expired, connect again')
      const { transaction } = decrypt(params.get('data'), params.get('nonce'), fromB58(s.shared))
      return { action, signed: toBase64(fromB58(transaction)) }
    }
  } catch (e) {
    return { action, error: e.message }
  }
  return null
}

// solana_signTransaction may return only the signature: it goes into the unsigned transaction at the signer's slot.
// Wire format: compact-u16 signature count, the 64-byte signatures, then the message (v0: a 0x80 version byte, the
// 3-byte header, compact-u16 key count, the 32-byte keys; signers first).
export function withSignature(tx, address, signature) {
  const out = new Uint8Array(tx)
  const [nSigs, sigsAt] = compactU16(out, 0)
  let m = sigsAt + 64 * nSigs
  if (out[m] & 0x80) m++ // versioned message
  const required = out[m]
  const [nKeys, keysAt] = compactU16(out, m + 3)
  const key = fromB58(address)
  for (let i = 0; i < Math.min(required, nKeys); i++) {
    if (key.every((b, j) => out[keysAt + 32 * i + j] === b)) {
      out.set(signature, sigsAt + 64 * i)
      return out
    }
  }
  throw new Error('This transaction does not need a signature from the connected wallet')
}
function compactU16(bytes, at) {
  let value = 0, i = 0
  for (;;) { const b = bytes[at + i]; value |= (b & 0x7f) << (7 * i); i++; if (!(b & 0x80)) return [value, at + i] }
}
