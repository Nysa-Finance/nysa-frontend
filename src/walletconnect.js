// WalletConnect (Reown) for Solana: any wallet app that speaks WalletConnect (Trust Wallet, Exodus, OKX, Bitget, Ledger
// Live, …) connects from a computer (QR code) or the same phone (the wallet list opens the app). Reown's AppKit modal
// shows the QR code and the wallet list, as on Kamino; the connection itself is ours (manualWCControl): one
// UniversalProvider, shaped like a Wallet Standard wallet so the store treats it as any other. Transactions are signed
// in the wallet app and sent by our backend (/api/tx/send), as for the iOS deeplink wallets. Loaded only when picked.
import { getBase58Encoder } from '@solana/kit'
import { WALLETCONNECT_PROJECT_ID } from './config.js'
import { withSignature } from './wallets.js'

export const WC_NAME = 'WalletConnect'
const CHAIN = 'solana:mainnet' // Wallet Standard id, as the store uses
// Solana mainnet in WalletConnect (CAIP-2): the genesis hash, and the truncated id some wallets still use.
const SOLANA_IDS = ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ']
const METADATA = () => ({ name: 'Nysa', description: 'Earn and borrow against tokenized real-world assets', url: location.origin, icons: [`${location.origin}/favicon.png`] })
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// The library retries forever when the relay refuses it (e.g. an unknown project id): give up after this long.
const START_TIMEOUT_MS = 15_000
const UNAVAILABLE = 'WalletConnect is unavailable right now, please try again later or use another wallet.'
const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(UNAVAILABLE)), ms))])

let providerP = null
const provider = () => (providerP ??= within(import('@walletconnect/universal-provider').then(({ UniversalProvider }) => UniversalProvider.init({
  projectId: WALLETCONNECT_PROJECT_ID, metadata: METADATA(), telemetryEnabled: false,
})), START_TIMEOUT_MS).catch((e) => { providerP = null; throw e }))

// Reown's modal, driven by us: it only displays the pairing link (QR code, wallet list with links to the apps).
let modalP = null
const modal = () => (modalP ??= (async () => {
  const p = await provider()
  const [{ createAppKit }, { solana }] = await Promise.all([import('@reown/appkit/core'), import('@reown/appkit/networks')])
  return createAppKit({
    projectId: WALLETCONNECT_PROJECT_ID, metadata: METADATA(), networks: [solana], universalProvider: p, manualWCControl: true,
    themeMode: 'dark', themeVariables: { '--w3m-accent': '#EC008C', '--w3m-z-index': 1000 },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, history: false },
    enableWalletGuide: false,
  })
})().catch((e) => { modalP = null; throw e }))

// The session's Solana mainnet accounts ("solana:<chain>:<address>"), as Wallet Standard accounts.
const accountsOf = (session) => (session?.namespaces?.solana?.accounts ?? [])
  .map((a) => ({ chain: a.slice(0, a.lastIndexOf(':')), address: a.slice(a.lastIndexOf(':') + 1) }))
  .filter((a) => SOLANA_IDS.includes(a.chain))
  .map((a) => ({ address: a.address, chains: [CHAIN], features: [] }))
// The chain id the wallet used for this address, to address our requests the same way.
const chainOf = (session, address) => (session?.namespaces?.solana?.accounts ?? []).find((a) => a.endsWith(`:${address}`))?.slice(0, -address.length - 1) ?? SOLANA_IDS[0]

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
        // silent: only restore a session saved by the library (page reload); never open the modal.
        async connect({ silent } = {}) {
          const p = await provider()
          watch(p)
          if (p.session) return { accounts: accountsOf(p.session) }
          if (silent) return { accounts: [] }
          const m = await within(modal(), START_TIMEOUT_MS)
          // Waiting for the wallet's approval has no limit; getting a pairing link to show does. Closing the modal cancels.
          let shown = false, done = false, timer, ready, cancel
          const uriShown = new Promise((resolve, reject) => { ready = resolve; timer = setTimeout(() => reject(new Error(UNAVAILABLE)), START_TIMEOUT_MS) })
          const cancelled = new Promise((_, reject) => { cancel = reject })
          const onUri = (uri) => { clearTimeout(timer); shown = true; ready(); m.open({ uri }) }
          const unsubscribe = m.subscribeState(({ open }) => { if (shown && !open && !done) cancel(new Error('Connection cancelled')) })
          p.on('display_uri', onUri)
          const approved = p.connect({ optionalNamespaces: { solana: { chains: SOLANA_IDS, methods: ['solana_signTransaction', 'solana_signMessage'], events: [] } } })
          for (const pr of [approved, uriShown, cancelled]) pr.catch(() => {}) // whichever loses the race may settle later
          try {
            const session = await Promise.race([approved, uriShown.then(() => approved), cancelled])
            const accounts = accountsOf(session)
            if (!accounts.length) {
              // e.g. a phone camera opened MetaMask, which approves with its Ethereum accounts only.
              const wallet = session?.peer?.metadata?.name || 'The wallet'
              await p.disconnect().catch(() => {})
              throw new Error(`${wallet} connected without a Solana account. Use a wallet app with Solana (e.g. Trust Wallet) and scan the QR code from inside that app, not with the phone camera.`)
            }
            return { accounts }
          } catch (e) {
            p.abortPairingAttempt?.()
            throw e
          } finally {
            done = true
            clearTimeout(timer)
            unsubscribe()
            p.removeListener?.('display_uri', onUri)
            if (shown) m.close()
          }
        },
      },
      'standard:disconnect': { async disconnect() { const p = await provider(); if (p.session) await p.disconnect() } },
      'standard:events': { on(event, fn) { if (event === 'change') listeners.add(fn); return () => listeners.delete(fn) } },
      // Signed in the wallet app (solana_signTransaction), sent by our backend; returns the signature like the standard.
      'solana:signAndSendTransaction': {
        async signAndSendTransaction({ account, transaction }) {
          const p = await provider()
          const res = await p.request({ method: 'solana_signTransaction', params: { transaction: toBase64(transaction), pubkey: account.address } }, chainOf(p.session, account.address))
          const signed = res?.transaction ? fromBase64(res.transaction) : withSignature(transaction, account.address, base58Bytes(res?.signature))
          const signature = await send(toBase64(signed))
          return [{ signature: base58Bytes(signature) }]
        },
      },
    },
  }
}

function base58Bytes(s) {
  if (typeof s !== 'string' || !s) throw new Error('The wallet returned no signature')
  return new Uint8Array(getBase58Encoder().encode(s))
}
