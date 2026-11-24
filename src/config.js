// Live numbers, risk parameters, rate curves and oracle feeds come from chain; the risk values here only show until
// the first market update arrives.
//
// Adding a market: one entry in LIVE, plus a TOKENS entry (and its icon in public/tokens/) for each new token.
// `reserves` is the market's own Kamino reserve of each token: two markets lending USDC each have their own.
// Swaps need a fee token account per token, SWAP_FEE_ACCOUNT_<NAME>, in .env and docker-compose.yml (swap stays off
// until every swap token has one); a route through a DEX not in server/program-policy.js is refused.
export const TOS_URL = 'https://nysa-finance.gitbook.io/nysa/protocol-info/term-of-service'
// Public by design (it ships in the page): the project's allowed domains on Reown stop others from using it.
export const WALLETCONNECT_PROJECT_ID = 'fe76c05c2791f7d71839bb257f55afb5'
// Loops are released to everyone (once NYSA_LOOP_RISK_OWNER / _APPROVED_AT are set); a betaOnly loop stays with LOOP_WALLETS
export const LOOP_ENABLED = true
export const explorer = (addr) => `https://solscan.io/account/${addr}`
export const txUrl = (sig) => `https://solscan.io/tx/${sig}`

// `price` only shows until the first market update arrives.
export const TOKENS = {
  'svm-usdy': { token_id: 'svm-usdy', name: 'USDY', icon: '/tokens/usdy.svg', decimals: 6, price: 1.09, rwa: true, mint: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6' },
  'svm-otfy': { token_id: 'svm-otfy', name: 'oTFY', icon: '/tokens/otfy.png', decimals: 9, price: 1.03, rwa: true, mint: 'BwB3tNH92jKw6naNGDYDbDwRo8bvYxZVvZjRZRcoWR2h' },
  'svm-nopal': { token_id: 'svm-nopal', name: 'nOPAL', icon: '/tokens/nopal.svg', decimals: 6, price: 1.12, rwa: true, mint: 'GArhnnDj3GYhmQeApKVXaRv4TQFwhPcs3SNF6FXsTeXq' },
  'svm-susdai': { token_id: 'svm-susdai', name: 'sUSDai', icon: '/tokens/susdai.svg', decimals: 6, price: 1.13, rwa: true, token2022: true, mint: 'sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE' },
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

// One entry per loop (Kamino Multiply): USDC funds it and buys `collateral`, `debt` is borrowed against it.
// Adding a loop: its market in LIVE, or in LOOP_ONLY_MARKETS when Nysa doesn't curate it (the server reads its reserves), the tokens in TOKENS, a frozen lookup table from
// scripts/create-loop-lut.js (without it an open is over Solana's transaction size limit), then the mainnet-fork
// check of open and close. A route through a DEX not in server/program-policy.js is refused.
// ponytail: one loop per market, the API names a loop by its market; key it by loop id when a market needs two.
export const LOOPS = [
  {
    id: 'usdy', market: 'sol-usdy-usdc', collateral: 'svm-usdy', debt: 'svm-usdc',
    maxLeverage: 9, // Kamino lends up to 90% LTV on USDY (10x); 9x leaves room for swap costs
    lookupTable: 'BUu4Txt3UbRAEF5rFu3x1VMTUHuJr4ChAoGpWMwcwVVx',
    priceYield: true, // earns through its price rising, not Kamino's supply APR (server/main.js)
    fullName: 'Ondo US Dollar Yield',
    blurb: "USDY is Ondo's tokenized note backed by short-term US Treasuries: its price rises as it earns.",
  },
  {
    id: 'susdai', market: 'sol-susdai-usdc', collateral: 'svm-susdai', debt: 'svm-usdc',
    maxLeverage: 4, // Kamino lends up to 80% LTV on sUSDai (5x); 4x leaves room for swap costs and the thinner pool
    lookupTable: 'DqFBX36Vq9Zb8n7ydQif9UhyoQnU3mXkjJmDvASQkBYJ',
    priceYield: true,
    fullName: 'Staked USDai',
    blurb: "sUSDai is USD.AI's staked dollar, earning from loans backed by AI compute hardware: its price rises as it earns.",
  },
  {
    id: 'otfy', market: 'sol-otfy-usdc', collateral: 'svm-otfy', debt: 'svm-usdc',
    maxLeverage: 3, // Kamino lends up to 75% LTV on oTFY (4x); 3x for its single, thin Raydium pool
    lookupTable: 'G8Y5htkw6mo79suEmJwsHYdmg5LLbDXK8goCs6WdWUcS',
    priceYield: true,
    // Only LOOP_WALLETS see and open it, even once loops are released to everyone, and it needs no Nysa vault
    // allocation in its market (server/strategy.js).
    betaOnly: true,
    fullName: 'Obligate yield token',
    blurb: "oTFY is a yield-bearing token issued by Obligate: its price rises as it earns.",
  },
]
export const loopById = (id) => LOOPS.find((l) => l.id === id)
export const loopByMarket = (marketId) => LOOPS.find((l) => l.market === marketId)

// Kamino markets Nysa doesn't curate where a loop runs: the server reads them like LIVE ones (reserves, positions,
// price history), but they have no page, no Borrow row and no supply or borrow through Nysa.
const LOOP_ONLY_MARKETS = [
  {
    id: 'sol-susdai-usdc', name: 'sUSDai Market',
    kaminoMarket: 'BVJ1FvFfYuLbGX4qDNezqU6z2N3p8M2XNeGzabm86BzE',
    reserves: { 'svm-susdai': '5vq24eGz45YWt4x8ub4eiJHU952UgFKpCTyW7rLb8wF2', 'svm-usdc': 'EfMKdLdPKooewofAcGSNTw9FNjc98oDMjbRMHXLJ6QqS' },
    collateral: ['svm-susdai'], loans: ['svm-usdc'],
    pairs: [{ collateral: 'svm-susdai', liability: 'svm-usdc', maxLtv: 80, liqLtv: 85 }],
  },
  {
    id: 'sol-otfy-usdc', name: 'Obligate Market',
    kaminoMarket: '3hd61ZpG35tBwrmDvdmYVJoazC2mjJxHb6rEYEWs4QhH',
    reserves: { 'svm-otfy': '6nk5K3PiV3EHtW4LLFhfMc1uR4kNwEfibvTdWqxCm6WF', 'svm-usdc': 'Au2Cg9CNNTX1KfzVhNnpi1ouHX74CwMMBvmSchmqS5ZW' },
    collateral: ['svm-otfy'], loans: ['svm-usdc'],
    pairs: [{ collateral: 'svm-otfy', liability: 'svm-usdc', maxLtv: 75, liqLtv: 80 }],
  },
]
export const MARKETS = [...LIVE, ...LOOP_ONLY_MARKETS]
export const loopMarket = (loop) => MARKETS.find((m) => m.id === loop.market)

// Kamino markets a vault may allocate to that Nysa doesn't curate (no page here), for the vault's exposure.
export const OTHER_MARKETS = [
  { kaminoMarket: 'HMNm3ZrAvG4zKVv5zpMDA6DKduc612156RUsdAAZf4TC', name: 'Plume Vaults Market', collateral: ['svm-nopal'] },
]

// Name, token, allocations and exposure are read on-chain (server/vault.js).
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
// loan tokens first: the Swap page opens on "sell USDC"
export const swapTokens = [...new Set(LIVE.flatMap((m) => m.pairs.map((p) => p.liability)).concat(LIVE.flatMap((m) => m.pairs.map((p) => p.collateral))))].map(tok)
