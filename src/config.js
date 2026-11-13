// Static market configuration, shared by the frontend and the backend (server/).
// Live numbers, risk parameters, rate curves and oracle feeds come from chain via the backend (server/market.js); the
// risk values here are only shown until the first market update arrives (riskOf in store.js).
//
// Adding a market: one entry in LIVE (and a TOKENS entry for each token not listed yet, with its icon file in
// public/tokens/). Everything else follows from it: pages, URLs, live data, positions, transactions, Market Updates,
// Farm Points. `reserves` is the market's own Kamino reserve of each token: two markets lending the same token (USDC)
// each have their own. `npm test` checks the entry (src/config.test.js).
// Swaps between a pair's tokens need a fee token account per token: SWAP_FEE_ACCOUNT_<NAME> (e.g. SWAP_FEE_ACCOUNT_USDC)
// in .env and in docker-compose.yml; until every swap token has one, swap stays off. A route through a DEX not in
// server/program-policy.js is refused: review and add it there first.
export const TOS_URL = 'https://nysa-finance.gitbook.io/nysa/protocol-info/term-of-service'
// WalletConnect project id (Reown dashboard, cloud.reown.com). Public by design, it ships in the page; the project's
// allowed domains on Reown are what stop others from using it. Empty = WalletConnect is not offered.
export const WALLETCONNECT_PROJECT_ID = 'fe76c05c2791f7d71839bb257f55afb5'
// Multiply loop (Loop page, /api/loop-*, loop actions in /api/tx): off for everyone until it is released.
export const LOOP_ENABLED = false
export const explorer = (addr) => `https://solscan.io/account/${addr}`
export const txUrl = (sig) => `https://solscan.io/tx/${sig}`

// A token, wherever it is used. `price` is only shown until the first market update arrives. `icon`: a file in public/.
export const TOKENS = {
  'svm-usdy': { token_id: 'svm-usdy', name: 'USDY', icon: '/tokens/usdy.png', decimals: 6, price: 1.09, rwa: true, mint: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6' },
  'svm-usdc': { token_id: 'svm-usdc', name: 'USDC', icon: '/tokens/usdc.webp', decimals: 6, price: 1, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
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
    geoBlocked: true, // no supplying or borrowing from the US, Canada and sanctioned countries (server/main.js)
    kaminoMarket: 'F4uLsGZT4YnHDcemtoYDz2LBZKLmwTB1wzkwS6oqygvy',
    reserves: { 'svm-usdy': 'rpTGWR3JDjjPfXLCg5Fx1GpSdUxPt1pxW7fwXGUT6js', 'svm-usdc': 'GQr5hXuRgHAmguh6EqcpeJXrMyqCQch4P6XkSvawwNk2' },
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
// Tokens the Swap page trades: both sides of every market pair, loan tokens first (it opens on "sell USDC").
export const swapTokens = [...new Set(LIVE.flatMap((m) => m.pairs.map((p) => p.liability)).concat(LIVE.flatMap((m) => m.pairs.map((p) => p.collateral))))].map(tok)
