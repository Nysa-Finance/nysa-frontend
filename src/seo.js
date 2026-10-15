// Per-page title, description and canonical URL (the app renders client-side, so these are set on every navigation;
// Google runs the JavaScript). Defaults for crawlers that don't are in index.html.
import { marketById, vaultById } from './config.js'

const SITE = 'https://app.nysa.finance'
const DEFAULT = 'Lend and borrow against tokenized real-world assets on Solana: supply USDC or borrow against USDY in curated Kamino markets.'

const PAGES = {
  earn: ['Nysa — Transparent curation of Lending Markets for the Tokenized Economy', 'Earn yield on USDC in Nysa-curated Kamino vaults, lent against tokenized real-world assets like Ondo USDY on Solana.'],
  borrow: ['Borrow · Nysa', 'Borrow USDC against tokenized real-world assets like Ondo USDY on Solana.'],
  portfolio: ['Portfolio · Nysa', 'Your deposits, loans and health factor across Nysa markets.'],
  analytics: ['Analytics · Nysa', 'Live protocol metrics, oracle health and open positions of the Nysa markets, read on-chain.'],
  liquidations: ['Liquidations · Nysa', 'Loans close to liquidation and every liquidation in the Nysa markets, read on-chain from Kamino Lend.'],
  'not-found': ['Page not found · Nysa', DEFAULT],
}

function setMeta(attr, key, content) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

export function applySeo(route) {
  let [title, description] = PAGES[route.name] ?? PAGES.earn
  if (route.name === 'market-detail') {
    const m = marketById(route.params.id)
    if (m) [title, description] = [`Borrow · ${m.name} · Nysa`, `${m.blurb ?? DEFAULT}`]
  }
  if (route.name === 'vault') {
    const v = vaultById(route.params.id)
    if (v) [title, description] = [`${v.name} · Earn · Nysa`, v.description]
  }
  const url = SITE + (route.name === 'not-found' ? '/' : route.path) // canonical: path only, no ?mode=… variants
  document.title = title
  setMeta('name', 'description', description)
  setMeta('property', 'og:title', title)
  setMeta('property', 'og:description', description)
  setMeta('property', 'og:url', url)
  setMeta('name', 'robots', route.name === 'not-found' || route.meta.noindex ? 'noindex' : 'index, follow')
  document.head.querySelector('link[rel="canonical"]')?.setAttribute('href', url)
}
