# Nysa frontend (rebuild)

A from-scratch rebuild of https://app.nysa.finance in Vue 3 + Vite (the original uses the same stack).

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # formatter and lending-math checks
```

Put `VITE_SOLANA_RPC=<keyed RPC url>` in `.env` (gitignored; also set it in the Vercel project env). The public RPC often returns 403 to browsers.

## Pages
`/` Markets · `/lend` · `/borrow` · `/portfolio` · `/market/:id?mode=lend|borrow&tab=&asset=` · 404.
The app also has a Terms of Service gate (stored in localStorage), a wallet connect modal, and a Farm Points leaderboard.

## Data sources
- Reserve metrics come from `api.kamino.finance/kamino-market/{market}/reserves/metrics`.
- Wallet balances come from Solana RPC `getTokenAccountsByOwner`.
- Positions (supplied, borrowed, max withdraw) come from klend-sdk (`getObligationByWallet`), loaded lazily in `src/kamino.js`.
- Wallets are discovered via Wallet Standard (Phantom first, then Solflare/Backpack/etc.).
- Farm Points come from `/api/points`, proxied to the original deployment (see `vite.config.js` and `vercel.json`).
- The IRM curve, risk parameters, addresses and due diligence are static, in `src/config.js`.

## Transactions
`src/kamino.js` builds deposit / withdraw / borrow / repay with klend-sdk, simulates, then signs and sends through the wallet's `solana:signAndSendTransaction` and polls for confirmation.
A first deposit also creates the user's obligation: that setup goes in its own transaction first (two wallet prompts), the same way the original app does it.
`@orca-so/whirlpools-core` (WASM, only used by Kamino liquidity strategies) is aliased to `src/orca-stub.cjs`.

## Not done yet
- **Analytics / Liquidations.** On the original these read a hidden Euler/Sepolia cluster and a liquidation indexer that is offline, so they were not rebuilt.
- **Geo-block and sanctions screening.** These need a backend (`/api/geo` on the original).
