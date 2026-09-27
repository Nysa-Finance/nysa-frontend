# Nysa frontend (rebuild)

A from-scratch rebuild of https://app.nysa.finance in Vue 3 + Vite (the original uses the same stack).

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # formatter and lending-math checks
```

Put `VITE_SOLANA_RPC=<keyed RPC url>` in `.env` (gitignored; also set it in the Vercel project env). The public RPC often returns 403 to browsers.

## Pages
`/` Markets · `/lend` · `/borrow` · `/portfolio` · `/market/:id?mode=lend|borrow&tab=&asset=` · `/analytics` · 404.
Market-detail and Analytics sections are collapsible cards (`src/components/Section.vue`, native `<details>`).
The app also has a Terms of Service gate (stored in localStorage), a wallet connect modal, and a Farm Points leaderboard.

## Data sources
- Reserve metrics come from `api.kamino.finance/kamino-market/{market}/reserves/metrics`.
- Wallet balances come from Solana RPC `getTokenAccountsByOwner`.
- Positions (supplied, borrowed, max withdraw) come from klend-sdk (`getObligationByWallet`), loaded lazily in `src/kamino.js`.
- Wallets are discovered via Wallet Standard (Phantom first, then Solflare/Backpack/etc.).
- Farm Points come from `/api/points` (see below).
- Realized APY history comes from `/api/apy-history` (see Farm Points: recorded by the same daily snapshot).
- Analytics (oracle freshness, caps, APYs, open positions with health factor) is read live with klend-sdk in the browser, only on that page.
- The IRM curve, risk parameters, addresses and due diligence are static, in `src/config.js`.

## Transactions
`src/kamino.js` builds deposit / withdraw / borrow / repay with klend-sdk, simulates, then signs and sends through the wallet's `solana:signAndSendTransaction` and polls for confirmation.
A first deposit also creates the user's obligation: that setup goes in its own transaction first (two wallet prompts), the same way the original app does it.
`@orca-so/whirlpools-core` (WASM, only used by Kamino liquidity strategies) is aliased to `src/orca-stub.cjs`.

## Farm Points
Points accrue as **supplied USD × days**: each daily snapshot adds `last_supplied_usd × days since last snapshot` to every wallet's total,
then records its current deposits (USDC lent + USDY collateral) in the Nysa Kamino market. Logic: `snapshotPoints` in `src/logic.js` (tested).
- `api/points-snapshot.js` — Vercel Cron, daily at 00:00 UTC (`vercel.json`). Requires `Authorization: Bearer $CRON_SECRET`.
  Only wallets with deposits in the Nysa market(s) listed in `src/config.js` (`LIVE`) are tracked; nothing is imported from elsewhere.
- `api/points.js` — serves the leaderboard CSV from a private Vercel Blob (empty until the first snapshot).

Vercel setup: create a **Blob** store and connect it to the project (adds `BLOB_READ_WRITE_TOKEN`), add `CRON_SECRET`, deploy, then run the first snapshot:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/points-snapshot
```

## Realized APY
The daily snapshot also appends, per reserve, the value of one deposit share (liquidity per Kamino cToken), the APYs and the
utilization to `market-history/history.json` (private Blob), plus the reserve's creation time (share value is exactly 1 then).
The market page shows 30D / 7D realized APY (share-value growth over the window, annualised) next to the live APY, and a daily chart.
Kamino's API has no history for this market, so history starts at the first snapshot: "30D" is exact since launch while the reserve
is younger than 30 days, "7D" fills in after 7 days of snapshots. Math: `realizedApy` / `windowApy` / `dailyApySeries` in `src/logic.js` (tested).

## Not done yet
- **Liquidations page.** The original reads a liquidation indexer that is offline; open positions and health factors are shown in Analytics instead.
- **Geo-block and sanctions screening.** These need a backend (`/api/geo` on the original).
