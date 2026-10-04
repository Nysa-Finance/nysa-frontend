// Static market configuration, shared by the frontend and the backend (server/).
// Live numbers, risk parameters and rate curves come from chain via the backend (server/market.js); the risk values
// and IRM here are only shown until the first market update arrives (riskOf / irmOf in store.js).
export const TOS_URL = 'https://nysa-finance.gitbook.io/nysa/protocol-info/term-of-service'
export const explorer = (addr) => `https://solscan.io/account/${addr}`
export const txUrl = (sig) => `https://solscan.io/tx/${sig}`

export const TOKENS = {
  'svm-usdy': {
    token_id: 'svm-usdy', name: 'USDY', icon: '/tokens/usdy.png', decimals: 6, price: 1.09, rwa: true,
    mint: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', reserve: 'rpTGWR3JDjjPfXLCg5Fx1GpSdUxPt1pxW7fwXGUT6js',
    priceFeed: '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH', feedNote: 'Scope · index 406',
    irm: null, // collateral only
  },
  'svm-usdc': {
    token_id: 'svm-usdc', name: 'USDC', icon: '/tokens/usdc.webp', decimals: 6, price: 1,
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', reserve: 'GQr5hXuRgHAmguh6EqcpeJXrMyqCQch4P6XkSvawwNk2',
    priceFeed: '3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C', feedNote: 'Scope · index 20 → 230',
    // Kamino borrow-rate curve points: [utilization %, borrow APR %]
    irm: { points: [[0, 0], [50, 2.05], [90, 3.07], [100, 11.33]], fee: 0 },
  },
}

const dueDiligence = {
  subject: 'USDY (Ondo)',
  safetyScore: 10,
  rows: [
    { label: 'Rated by', value: 'RWAting', href: 'https://www.rwating.com/ratings/ondo-usdy' },
    { label: 'Entity Name', value: 'Ondo Global Markets (BVI) Limited' },
    { label: 'Jurisdiction', value: 'British Virgin Islands' },
    { label: 'Legal Form', value: 'BVI Business Company' },
    { label: 'Registration Number', value: 'N/A' },
    { label: 'Bankruptcy Remote', value: 'Yes' },
    { label: 'Attestation Reports', value: 'View Reports', href: 'https://www.dropbox.com/scl/fo/375wdvar3rbc7o23nxsgp/AOFY8jhpENaNx9WAw-WPnbY?rlkey=4icqn1z9bez725wywr30fx52a&st=bsxeh8j5&e=1&dl=0' },
    { label: 'Auditor', value: 'Ankura Trust Company' },
  ],
}

export const MARKETS = [
  {
    id: 'sol-usdy-usdc', name: 'USDY Ondo Market', infra: 'Kamino', chain: 'svm', visible: true, farmPoints: true,
    kaminoMarket: 'F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy',
    blurb: 'Lend against USDY, a yield-bearing token backed by short-term US Treasuries with over $2B in AUM. Borrow USDC on Solana in a market curated by Nysa.',
    collateral: ['svm-usdy'], loans: ['svm-usdc'],
    pairs: [{ collateral: 'svm-usdy', liability: 'svm-usdc', maxLtv: 90, liqLtv: 95, maxDiscount: 5, supplyCap: 250_000, borrowCap: 250_000 }],
    dueDiligence,
  },
  { id: 'equities-usdc', name: 'Tokenized Equities / USDC', infra: 'Euler', visible: false },
  { id: 'rwa-usdt', name: 'RWA / USDT', infra: 'Euler', visible: false },
  { id: 'rwa-crypto', name: 'RWA / Crypto', infra: 'Euler', visible: false },
]

export const LIVE = MARKETS.filter((m) => m.visible)
export const tok = (id) => TOKENS[id]
export const marketById = (id) => LIVE.find((m) => m.id === id)
export const tokensOf = (m) => [...new Set([...m.collateral, ...m.loans])].map(tok)
