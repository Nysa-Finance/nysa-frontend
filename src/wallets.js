// Wallets on phones, where browsers have no wallet extensions:
// - Android (Chrome): Solana's Mobile Wallet Adapter. It registers as a Wallet Standard wallet; connecting and signing
//   open the wallet app (Phantom, Solflare, …) to approve, then return to the browser.
// - iOS (Safari): Phantom's and Solflare's deeplink protocol. The browser leaves for the wallet app to approve, and the
//   wallet sends the user back here with an encrypted answer (x25519 + XSalsa20-Poly1305, as in their reference app).
//   Transactions come back signed and our backend sends them.
import nacl from 'tweetnacl'
import { getBase58Decoder, getBase58Encoder } from '@solana/kit'

const b58 = (bytes) => getBase58Decoder().decode(bytes)
const fromB58 = (s) => new Uint8Array(getBase58Encoder().encode(s))
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes))

export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

export const MWA_NAME = 'Mobile Wallet Adapter' // the name it registers under

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

// ---- iOS deeplinks ----
export const DEEPLINK_WALLETS = [
  { name: 'Phantom', icon: '/wallets/phantom.svg', base: 'https://phantom.com/ul/v1', keyParam: 'phantom_encryption_public_key' },
  { name: 'Solflare', icon: '/wallets/solflare.svg', base: 'https://solflare.com/ul/v1', keyParam: 'solflare_encryption_public_key' },
]
const SESSION_KEY = 'nysaDeeplinkSession' // { wallet, secret, shared, session, address }
const MARK = 'nysa_dl' // our query marker on the redirect back: connect | sign
const WALLET_PARAMS = ['nonce', 'data', 'errorCode', 'errorMessage', ...DEEPLINK_WALLETS.map((w) => w.keyParam)]

const load = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) } catch { return null } }
const save = (s) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)) } catch { /* private mode */ } }
export const clearDeeplinkSession = () => { try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ } }
const walletOf = (name) => DEEPLINK_WALLETS.find((w) => w.name === name)

// The page to come back to: where the user is now, plus our marker.
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

// Connected deeplink wallet from a previous visit: { wallet, address } or null.
export function deeplinkSession() {
  const s = load()
  return s?.session && s.address ? { wallet: s.wallet, address: s.address } : null
}

// URL that asks the wallet app to connect (open it from a tap: iOS only opens apps on user gestures).
export function connectUrl(name) {
  const w = walletOf(name)
  const kp = nacl.box.keyPair()
  save({ wallet: name, secret: b58(kp.secretKey) })
  const q = new URLSearchParams({ app_url: location.origin, dapp_encryption_public_key: b58(kp.publicKey), redirect_link: redirectLink('connect'), cluster: 'mainnet-beta' })
  return `${w.base}/connect?${q}`
}

// URL that asks the wallet app to sign an unsigned transaction (base64, from /api/tx).
export function signUrl(txBase64) {
  const s = load()
  if (!s?.session) throw new Error('The wallet session expired, connect again')
  const w = walletOf(s.wallet)
  const { nonce, payload } = encrypt({ transaction: b58(fromBase64(txBase64)), session: s.session }, fromB58(s.shared))
  const q = new URLSearchParams({ dapp_encryption_public_key: b58(nacl.box.keyPair.fromSecretKey(fromB58(s.secret)).publicKey), nonce, redirect_link: redirectLink('sign'), payload })
  return `${w.base}/signTransaction?${q}`
}

// Called once on page load: if the wallet app just sent the user back, read its answer and clean the URL.
// Returns null, or { action: 'connect', wallet, address } | { action: 'sign', signed: base64 } | { action, error }.
export function readDeeplinkReturn() {
  const params = new URLSearchParams(location.search)
  const action = params.get(MARK)
  if (!action) return null
  const url = new URL(location.href)
  for (const p of [MARK, ...WALLET_PARAMS]) url.searchParams.delete(p)
  history.replaceState(history.state, '', url)
  if (params.get('errorCode')) return { action, error: params.get('errorMessage') || 'Request rejected in the wallet' }
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
