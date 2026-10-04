// Deeplink protocol round trip (iOS Phantom/Solflare), with the wallet side simulated as in Phantom's reference app:
// connect → encrypted session back → sign request → signed transaction back. Run by `npm test`.
import assert from 'node:assert/strict'
import nacl from 'tweetnacl'
import { getBase58Decoder, getBase58Encoder } from '@solana/kit'

// Minimal browser globals for src/wallets.js.
const store = new Map()
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
let href = 'https://app.nysa.finance/market/sol-usdy-usdc?mode=lend'
globalThis.location = { get href() { return href }, get search() { return new URL(href).search }, origin: 'https://app.nysa.finance' }
globalThis.history = { state: null, replaceState: (_, __, url) => { href = String(url) } }
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'iPhone', maxTouchPoints: 5 }, configurable: true })

const { connectUrl, signUrl, readDeeplinkReturn, deeplinkSession } = await import('./wallets.js')
const b58 = (b) => getBase58Decoder().decode(b)
const fromB58 = (s) => new Uint8Array(getBase58Encoder().encode(s))
const walletKp = nacl.box.keyPair() // Phantom's side
const seal = (obj, shared) => { const nonce = nacl.randomBytes(24); return { nonce: b58(nonce), data: b58(nacl.box.after(new TextEncoder().encode(JSON.stringify(obj)), nonce, shared)) } }
const back = (redirect, params) => { const u = new URL(redirect); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); href = u.toString() }

// 1. Connect: Phantom derives the shared secret from our public key and answers with an encrypted session.
const c = new URL(connectUrl('Phantom'))
assert.equal(c.origin + c.pathname, 'https://phantom.com/ul/v1/connect')
assert.equal(c.searchParams.get('cluster'), 'mainnet-beta')
const shared = nacl.box.before(fromB58(c.searchParams.get('dapp_encryption_public_key')), walletKp.secretKey)
const user = '66pW72Fchnr34FGgXrxheGs3BbUsDSwJmGcK7m8Bz1Yv'
back(c.searchParams.get('redirect_link'), { phantom_encryption_public_key: b58(walletKp.publicKey), ...seal({ public_key: user, session: 'sess-1' }, shared) })
assert.deepEqual(readDeeplinkReturn(), { action: 'connect', wallet: 'Phantom', address: user })
assert.equal(href, 'https://app.nysa.finance/market/sol-usdy-usdc?mode=lend') // wallet params cleaned, page kept
assert.deepEqual(deeplinkSession(), { wallet: 'Phantom', address: user })

// 2. Sign: our payload decrypts on Phantom's side to the transaction + session; the signed one comes back.
const unsigned = Uint8Array.from({ length: 200 }, (_, i) => i)
const s = new URL(signUrl(Buffer.from(unsigned).toString('base64')))
assert.equal(s.origin + s.pathname, 'https://phantom.com/ul/v1/signTransaction')
const req = JSON.parse(new TextDecoder().decode(nacl.box.open.after(fromB58(s.searchParams.get('payload')), fromB58(s.searchParams.get('nonce')), shared)))
assert.deepEqual(fromB58(req.transaction), unsigned)
assert.equal(req.session, 'sess-1')
const signed = Uint8Array.from({ length: 264 }, (_, i) => 255 - (i % 256))
back(s.searchParams.get('redirect_link'), seal({ transaction: b58(signed) }, shared))
assert.deepEqual(readDeeplinkReturn(), { action: 'sign', signed: Buffer.from(signed).toString('base64') })

// 3. Refusal in the wallet comes back as an error; a page without our marker is ignored.
back(s.searchParams.get('redirect_link'), { errorCode: '4001', errorMessage: 'User rejected the request' })
assert.deepEqual(readDeeplinkReturn(), { action: 'sign', error: 'User rejected the request' })
assert.equal(readDeeplinkReturn(), null)

console.log('wallets ok')
