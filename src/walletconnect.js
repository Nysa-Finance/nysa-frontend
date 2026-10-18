// WalletConnect (Reown) for Solana: any wallet app that speaks WalletConnect (Trust Wallet, Exodus, OKX, Bitget, Ledger
// Live, …) connects by scanning a QR code on a computer, or through a link on the same phone. It is shaped like a Wallet
// Standard wallet so the store treats it as any other; transactions are signed in the wallet app and sent by our
// backend (/api/tx/send), as for the iOS deeplink wallets. The library is loaded only when someone picks it.
import { reactive } from 'vue'
import { getBase58Encoder } from '@solana/kit'
import { WALLETCONNECT_PROJECT_ID } from './config.js'
import { withSignature } from './wallets.js'

export const WC_NAME = 'WalletConnect'
const CHAIN = 'solana:mainnet' // Wallet Standard id, as the store uses
const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' // CAIP-2 id WalletConnect uses (genesis hash)
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// While connecting: the pairing link, shown as a QR code (computer) or opened in the wallet app (phone).
export const wcState = reactive({ uri: null })

// The library retries forever when the relay refuses it (e.g. an unknown project id): give up after this long.
const START_TIMEOUT_MS = 15_000
const UNAVAILABLE = 'WalletConnect is unavailable right now, please try again later or use another wallet.'
const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(UNAVAILABLE)), ms))])

let providerP = null
const provider = () => (providerP ??= within(import('@walletconnect/universal-provider').then(({ UniversalProvider }) => UniversalProvider.init({
  projectId: WALLETCONNECT_PROJECT_ID,
  metadata: { name: 'Nysa', description: 'Earn and borrow against tokenized real-world assets', url: location.origin, icons: [`${location.origin}/favicon.png`] },
  telemetryEnabled: false,
})), START_TIMEOUT_MS).catch((e) => { providerP = null; throw e }))

// The session's Solana mainnet account ("solana:<genesis>:<address>"), as a Wallet Standard account.
const accountsOf = (session) => (session?.namespaces?.solana?.accounts ?? [])
  .filter((a) => a.startsWith(`${SOLANA_MAINNET}:`))
  .map((a) => ({ address: a.slice(SOLANA_MAINNET.length + 1), chains: [CHAIN], features: [] }))

// send(signedBase64) -> signature (base58): the store's relay through our backend.
export function createWalletConnectWallet(send) {
  const listeners = new Set()
  const emit = (accounts) => listeners.forEach((fn) => fn({ accounts }))
  let watching = false
  const watch = (p) => {
    if (watching) return
    watching = true
    p.on('session_delete', () => emit([])) // disconnected from the wallet app
  }
  return {
    name: WC_NAME,
    icon: '/wallets/walletconnect.svg',
    walletconnect: true,
    chains: [CHAIN],
    get accounts() { return [] },
    features: {
      'standard:connect': {
        // silent: only restore a session saved by the library (page reload); never show a QR code.
        async connect({ silent } = {}) {
          const p = await provider()
          watch(p)
          if (p.session) return { accounts: accountsOf(p.session) }
          if (silent) return { accounts: [] }
          // Waiting for the wallet's approval has no limit; getting a pairing link to show does.
          let shown, timer
          const uriShown = new Promise((resolve, reject) => { shown = resolve; timer = setTimeout(() => { p.abortPairingAttempt?.(); reject(new Error(UNAVAILABLE)) }, START_TIMEOUT_MS) })
          const onUri = (uri) => { clearTimeout(timer); shown(); wcState.uri = uri }
          p.on('display_uri', onUri)
          try {
            const approved = p.connect({ optionalNamespaces: { solana: { chains: [SOLANA_MAINNET], methods: ['solana_signTransaction', 'solana_signMessage'], events: [] } } })
            approved.catch(() => {}) // after a timeout it may still settle: nothing waits for it then
            const session = await Promise.race([approved, uriShown.then(() => approved)])
            const accounts = accountsOf(session)
            if (!accounts.length) { await p.disconnect().catch(() => {}); throw new Error('The wallet did not share a Solana account') }
            return { accounts }
          } finally {
            clearTimeout(timer)
            p.removeListener?.('display_uri', onUri)
            wcState.uri = null
          }
        },
      },
      'standard:disconnect': { async disconnect() { const p = await provider(); if (p.session) await p.disconnect() } },
      'standard:events': { on(event, fn) { if (event === 'change') listeners.add(fn); return () => listeners.delete(fn) } },
      // Signed in the wallet app (solana_signTransaction), sent by our backend; returns the signature like the standard.
      'solana:signAndSendTransaction': {
        async signAndSendTransaction({ account, transaction }) {
          const p = await provider()
          const res = await p.request({ method: 'solana_signTransaction', params: { transaction: toBase64(transaction), pubkey: account.address } }, SOLANA_MAINNET)
          const signed = res?.transaction ? fromBase64(res.transaction) : withSignature(transaction, account.address, base58Bytes(res?.signature))
          const signature = await send(toBase64(signed))
          return [{ signature: base58Bytes(signature) }]
        },
      },
    },
  }
}

// Stop waiting for a QR code to be scanned (the user closed the connect window).
export async function cancelWalletConnect() {
  wcState.uri = null
  if (providerP) (await providerP).abortPairingAttempt?.()
}

function base58Bytes(s) {
  if (typeof s !== 'string' || !s) throw new Error('The wallet returned no signature')
  return new Uint8Array(getBase58Encoder().encode(s))
}
