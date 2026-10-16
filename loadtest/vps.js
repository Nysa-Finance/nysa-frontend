// Load test of the deployed app (k6, https://k6.io): virtual users that browse, check a wallet and prepare a vault
// deposit, ramping up to 400 at once. Nothing is signed or sent: /api/tx only builds and simulates. See README.md.
//   k6 run -e WALLET=<address holding AMOUNT USDC> loadtest/vps.js
import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { Counter } from 'k6/metrics'
import { randomBytes } from 'k6/crypto'

const BASE = __ENV.BASE || 'https://app.nysa.finance'
const WALLET = __ENV.WALLET // builds its deposit for this wallet: it must hold AMOUNT USDC, or the simulation fails
const AMOUNT = Number(__ENV.AMOUNT || 1)
if (!WALLET) throw new Error('Set -e WALLET=<a wallet holding at least AMOUNT USDC>')

const rateLimited = new Counter('rate_limited') // 429s: RATE_LIMIT_EXEMPT_IPS is not set for this IP

export const options = {
  stages: [
    { duration: '1m', target: 10 },
    { duration: '2m', target: 50 },
    { duration: '2m', target: 100 },
    { duration: '2m', target: 200 },
    { duration: '3m', target: 400 },
    { duration: '1m', target: 0 },
  ],
  // Stop early, not after the damage: too many errors, slow answers, or our own rate limits kicking in.
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' }],
    // Evaluated after a minute: the first deposit builds after a (re)start are slow while caches warm up.
    http_req_duration: [{ threshold: 'p(95)<3000', abortOnFail: true, delayAbortEval: '1m' }],
    rate_limited: [{ threshold: 'count<20', abortOnFail: true }],
    'http_req_duration{name:account}': ['p(95)<2000'],
    'http_req_duration{name:tx}': ['p(95)<3000'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
}

// Base58 (Bitcoin alphabet) of 32 bytes: a random wallet address, so each virtual user is a different wallet.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(bytes) {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0 }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let out = ''
  for (const byte of bytes) { if (byte !== 0) break; out += '1' }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]]
  return out
}
const me = base58(new Uint8Array(randomBytes(32))) // init code runs once per virtual user

const ok = (res, name) => {
  if (res.status === 429) rateLimited.add(1)
  return check(res, { [`${name} 200`]: (r) => r.status === 200 })
}

export default function () {
  group('browse', () => {
    ok(http.get(`${BASE}/earn`, { tags: { name: 'page' } }), 'page')
    ok(http.get(`${BASE}/api/market`, { tags: { name: 'market' } }), 'market')
  })
  group('wallet', () => {
    ok(http.get(`${BASE}/api/account/${me}`, { tags: { name: 'account' } }), 'account')
  })
  group('deposit', () => {
    const body = JSON.stringify({ kind: 'vault-deposit', vault: 'rwa-prime', amount: AMOUNT, wallet: WALLET })
    ok(http.post(`${BASE}/api/tx`, body, { headers: { 'content-type': 'application/json' }, tags: { name: 'tx' } }), 'tx')
  })
  sleep(8 + Math.random() * 4) // a person, not a script: about one round every 10 seconds
}
