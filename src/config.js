// Static market configuration, shared by the frontend and the backend (server/).
// Live numbers, risk parameters and rate curves come from chain via the backend (server/market.js); the risk values
// and IRM here are only shown until the first market update arrives (riskOf / irmOf in store.js).
export const TOS_URL = 'https://nysa-finance.gitbook.io/nysa/protocol-info/term-of-service'
// WalletConnect project id (Reown dashboard, cloud.reown.com). Public by design, it ships in the page; the project's
// allowed domains on Reown are what stop others from using it. Empty = WalletConnect is not offered.
export const WALLETCONNECT_PROJECT_ID = 'fe76c05c2791f7d71839bb257f55afb5'
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
    priceFeed: '3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C', feedNote: 'Scope · index 20',
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

export const LIVE = [
  {
    id: 'sol-usdy-usdc', name: 'USDY Ondo Market', farmPoints: true,
    kaminoMarket: 'F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy',
    blurb: 'Lend against USDY, a yield-bearing token backed by short-term US Treasuries with over $2B in AUM. Borrow USDC on Solana in a market curated by Nysa.',
    collateral: ['svm-usdy'], loans: ['svm-usdc'],
    pairs: [{ collateral: 'svm-usdy', liability: 'svm-usdc', maxLtv: 90, liqLtv: 95, maxDiscount: 5, minDiscount: 2, supplyCap: 250_000, borrowCap: 250_000 }],
    dueDiligence,
  },
]

// Kamino Earn vaults curated by Nysa (Earn page). Name, token, allocations and exposure are read on-chain
// (server/vault.js); only the address, the URL id and the description live here.
export const VAULTS = [
  {
    id: 'rwa-prime', name: 'RWA Prime', address: '2Qxsj1hi95avkp7sANDmbVT5TwqRPGsutuvJasJK9xL7', farmPoints: true,
    description: "RWA Prime is a USDC vault on Kamino curated by Nysa, allocating deposits to carefully selected lending markets backed by high-quality, lower-risk tokenized real-world assets.",
  },
]
export const vaultById = (id) => VAULTS.find((v) => v.id === id)
export const tok = (id) => TOKENS[id]
export const marketById = (id) => LIVE.find((m) => m.id === id)
export const tokensOf = (m) => [...new Set([...m.collateral, ...m.loans])].map(tok)
