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

## Market Updates
`/api/market-updates` lists admin changes to the market and its reserves (LTVs, rate curve, oracles, caps, status, market settings…),
decoded from Kamino Lend instructions (`updateReserveConfig`, `updateLendingMarket`, `initReserve`, … incl. CPI/multisig calls) using
klend-sdk's generated layouts. It indexes incrementally into `market-history/updates.json` (private Blob): each call fetches only
transactions newer than the last one seen. Values are formatted at index time; after changing a formatter, delete that blob to re-index.
Decoding is covered by `api/_market-updates.test.js` (underscore: not deployed as a function).

## VPS deploy (Docker)
Same app, without Vercel: `server.js` serves `dist/` and the `/api` handlers and runs the daily snapshot at 00:00 UTC;
state is written as files in `DATA_DIR` (a Docker volume) instead of Vercel Blob (`api/_storage.js` picks one or the other).
- `docker-compose.yml`: `app` (Node 24) + `caddy` (CSP and security headers from `Caddyfile`) + `tunnel` (cloudflared).
  No port is published: Cloudflare does HTTPS/WAF/geoblocking and reaches Caddy only through the tunnel
  (public hostname `DOMAIN` -> `http://caddy:80`, set in the Cloudflare dashboard).
- `.env` next to the compose file (never committed): `VITE_SOLANA_RPC`, `CRON_SECRET`, `DOMAIN`, `RPC_ORIGIN`, `TUNNEL_TOKEN`,
  `PLAUSIBLE_SECRET_KEY_BASE`, `PLAUSIBLE_TOTP_VAULT_KEY` (see `.env.example`). The app container only receives the variables it uses.
- Analytics: self-hosted Plausible CE (`plausible` + Postgres + ClickHouse, configs in `plausible/clickhouse/` from the upstream
  community-edition repo) on its own Docker network, published as `analytics.nysa.finance` -> `http://plausible:8000` in the tunnel.
  The site sends cookie-less pageviews with `@plausible-analytics/tracker` (`src/main.js`, production builds only).
- Auto-deploy: `.github/workflows/deploy.yml` SSHes to the `deploy` user, whose key may only run `scripts/deploy.sh`
  (git reset to `origin/main` + `docker compose up -d --build`; a failing build/test leaves the running version up).
  Secrets: `VPS_SSH_KEY`, `VPS_HOST`, `VPS_KNOWN_HOSTS`. Until they exist the workflow skips.
- Migrating state from Vercel Blob: `BLOB_READ_WRITE_TOKEN=… node scripts/export-blob.mjs`, then
  `docker compose cp data-export/. app:/data/` and `docker compose exec -u root app chown -R node:node /data`.
- `/api/points-snapshot` is not public on the VPS (Caddy answers 404). To run a snapshot by hand:
  `docker compose exec app node -e "fetch('http://localhost:3000/api/points-snapshot',{headers:{authorization:'Bearer '+process.env.CRON_SECRET}}).then(r=>r.text()).then(console.log)"`

## Not done yet
- **Liquidations page.** The original reads a liquidation indexer that is offline; open positions and health factors are shown in Analytics instead.
- **Geo-block and sanctions screening.** These need a backend (`/api/geo` on the original).
