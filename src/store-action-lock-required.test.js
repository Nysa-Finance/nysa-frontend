import assert from 'node:assert/strict'
import { getBase58Decoder } from '@solana/kit'

const walletAddress = '11111111111111111111111111111111'
const account = { address: walletAddress, chains: ['solana:mainnet'] }
const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })

let buildCount = 0
let walletPromptCount = 0
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(1))
globalThis.fetch = async (path, init = {}) => {
  const requestPath = String(path)
  if (requestPath.startsWith('/api/account/')) {
    return { ok: true, status: 200, json: async () => ({ balances: {}, positions: {}, claimable: {} }) }
  }
  if (requestPath === '/api/tx' && init.method === 'POST') {
    buildCount++
    return { ok: true, status: 200, json: async () => ({ tx: 'AQ==', minContextSlot: 1, final: true }) }
  }
  if (requestPath === `/api/tx/${signature}`) {
    return { ok: true, status: 200, json: async () => ({ status: 'confirmed', slot: 1 }) }
  }
  throw new Error(`Unexpected test fetch: ${requestPath}`)
}

const store = await import('./store.js')
const wallet = {
  name: 'No-lock wallet',
  chains: ['solana:mainnet'],
  features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signAndSendTransaction': { signAndSendTransaction: async () => {
      walletPromptCount++
      return [{ signature: new Uint8Array(64).fill(1) }]
    } },
  },
}
await store.connectWallet(wallet)

const market = { id: 'sol-usdy-usdc' }
const token = { token_id: 'svm-usdc' }
await store.sendKaminoAction('deposit', { market, token, amount: '1' })
await store.sendVaultAction('vault-deposit', { id: 'rwa-prime' }, { amount: '1' })
await store.claimRewards(market)
assert.equal(buildCount, 3, 'ordinary lending, Earn, and claim actions remain available without Web Locks')
assert.equal(walletPromptCount, 3, 'ordinary actions continue through the existing wallet capability')

await assert.rejects(store.sendKaminoAction('deposit', {
  market, token, amount: '1', swapFlow: 'acquire-supply', swapFlowStage: 'supply',
}), (error) => {
  assert.equal(error.code, 'ACTION_RESERVATION_LOCK_UNAVAILABLE')
  assert.match(error.message, /secure browser with Web Locks enabled/i,
    'the surfaced error explains why the protected feature action is unavailable')
  return true
}, 'borrower flow fails closed when cross-tab Web Locks are unavailable')
await assert.rejects(store.signAndSendSwap({
  built: { tx: 'AQ==', intentId: 'intent', expiresAt: Date.now() + 10_000 },
  request: { wallet: walletAddress }, outputTokenId: 'svm-usdy',
}), (error) => error.code === 'ACTION_RESERVATION_LOCK_UNAVAILABLE',
'router actions fail closed when cross-tab Web Locks are unavailable')
assert.equal(buildCount, 3, 'protected borrower and router actions never build without Web Locks')
assert.equal(walletPromptCount, 3, 'protected feature actions never prompt the wallet without Web Locks')
assert.equal(values.has('nysaPendingTx'), false, 'completed ordinary actions release their reservation')

console.log('ordinary actions remain available; feature actions require cross-tab Web Locks')
