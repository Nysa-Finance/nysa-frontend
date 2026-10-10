# Nysa frontend (rebuild)

A from-scratch rebuild of https://app.nysa.finance: a Vue 3 + Vite frontend and a Node backend, deployed with Docker on a VPS.

```bash
npm install
npm run dev     # http://localhost:5173, /api proxied to the deployed backend (API_TARGET to override)
npm run server  # backend on :3000 (needs SOLANA_RPC in .env)
npm test        # formatter, lending/rewards math and instruction-decoding checks
```

## Architecture
The browser never talks to the Solana RPC. The backend (`server/`) does every on-chain read and builds transactions;
the wallet only signs and sends them. So the RPC key stays server-side, RPC usage doesn't grow with each visitor, and
klend-sdk stays out of the browser bundle.

```
browser ── /api/events (SSE) ── market snapshot on connect and after every refresh
        ── /api/account/:wallet  balances, positions, unclaimed rewards (cached 15s per wallet)
        ── POST /api/tx          unsigned, simulated transaction → wallet signAndSendTransaction
        ── GET  /api/tx/:sig     confirmation (a confirmed tx refreshes the market for everyone)
backend ── Solana RPC: market cache every 60s (~10 calls) + 3 calls per account read + tx builds
```

| Module | Role |
|---|---|
| `server/main.js` | HTTP server: static `dist/`, API routes, SSE, per-IP rate limits, daily snapshot schedule |
| `server/rpc.js` | The single RPC client (429 backoff, call counter for `/api/health`) |
| `server/market.js` | Market cache: reserves, oracle prices, risk params, rate curves, reward farms (`/api/market`, `/api/events`) |
| `server/account.js` | A wallet's balances, Kamino positions and pending farm rewards |
| `server/tx.js` | Builds deposit / withdraw / borrow / repay / claim with klend-sdk + farms-sdk, simulates, returns unsigned |
| `server/updates.js` | Market index: admin changes (Market Updates) and every obligation address, from chain history |
| `server/analytics.js` | Open positions with health factor for the Analytics page |
| `server/snapshot.js` | Daily Farm Points + APY history snapshot |
| `server/storage.js` | Files in `DATA_DIR` (atomic writes) |

Sanctions screening (`server/screening.js`): every wallet is checked against the US Treasury's OFAC SDN list, which
names sanctioned crypto addresses (SOL, USDC, ETH, …). The full XML export is downloaded daily and saved in DATA_DIR
(the CSV export truncates remarks and drops addresses). A sanctioned wallet gets 403 on account data, transaction
builds and relays, and the frontend disconnects it with a notice. Until a list is loaded, viewing works but no
transaction is built (fail closed).

Validation and limits: wallet addresses and actions are checked, request bodies are capped at 4 KB, and the endpoints that
cost RPC calls are rate-limited per client IP (Cloudflare's `CF-Connecting-IP`). The server never holds keys.

## Pages
`/` Markets · `/lend` · `/borrow` · `/portfolio` · `/market/:id?mode=lend|borrow&tab=&asset=` · `/analytics` · 404.
Market-detail and Analytics sections are collapsible cards (`src/components/Section.vue`, native `<details>`).
The app also has a Terms of Service gate (stored in localStorage), a wallet connect modal (Wallet Standard), and a Farm Points leaderboard.

SEO: the page renders under the Terms of Service dialog (inert until accepted) so crawlers index real content;
`src/seo.js` sets title, description, canonical and Open Graph tags per route; the server answers 404 for unknown
routes, serves `/sitemap.xml` (pages + live markets from config.js) and `public/robots.txt`. Fonts are self-hosted
(`@fontsource/*`, imported in `src/main.js`).

## Transactions
`POST /api/tx` builds the action against the market cache with a fresh read of the wallet's obligation, simulates it
(a failing transaction comes back as a readable error and is never sent) and returns it unsigned. A first deposit also
creates the user's Kamino accounts: that setup comes back first (`final: false`); the client sends it, waits for
confirmation, then asks again for the action itself — two wallet prompts, like the original app.

## Wallets on phones
Mobile browsers have no wallet extensions (`src/wallets.js`):
- **Android (Chrome)**: Solana's Mobile Wallet Adapter (`@solana-mobile/wallet-standard-mobile`, loaded only on Android)
  registers as a Wallet Standard wallet; connecting and signing open the wallet app (Phantom, Solflare, …) to approve, then
  return to the browser. It talks to the app over `ws://localhost`, allowed in the CSP. Its React Native peers are
  replaced by empty packages in `vendor/` (the web build never imports them).
- **iOS (Safari)**: Phantom's and Solflare's deeplink protocol (connect + `signTransaction`, x25519/XSalsa20-Poly1305 via
  tweetnacl). The page leaves for the wallet app and comes back with the answer; the pending action survives the reload
  in localStorage, the handoff card (`WalletHandoff.vue`) asks for a tap before each trip (iOS opens apps only on user
  gestures), and `POST /api/tx/send` relays the signed transaction — only for a wallet that just had one built, with its
  valid signature. Round trip covered by `src/wallets.test.js`.
Logos in `public/wallets/` are the official icons shipped in `@solana/wallet-adapter-phantom` / `-solflare`.

## Supply rewards (boosted APY)
The USDC reserve's Kamino collateral farm pays USDC incentives. `server/market.js` reads the farm with the market and
returns each token's reward APR (yearly emission value over the staked value; shown as APR because rewards don't compound).
The Lend table, asset data and Lend panel show supply APY + rewards APR; the market page has a Claim card for the
wallet's unclaimed rewards (`kind: 'claim'`, one transaction harvesting every pending reward).

## Farm Points
Points accrue as **supplied USD × days**: each daily snapshot adds `last_supplied_usd × days since last snapshot` to every wallet's total,
then records its current deposits (USDC lent + USDY collateral) in the Nysa Kamino market. Logic: `snapshotPoints` in `src/logic.js` (tested).
Only wallets with deposits in the Nysa market(s) listed in `src/config.js` (`LIVE`) are tracked. Run a snapshot by hand:
`docker compose exec app node server/snapshot.js`.

## Realized APY
The daily snapshot also appends, per reserve, the value of one deposit share (liquidity per Kamino cToken), the APYs and the
utilization to `market-history/history.json`, plus the reserve's creation time (share value is exactly 1 then).
The market page shows 30D / 7D realized APY (share-value growth over the window, annualised) next to the live APY, and a daily chart.
Math: `realizedApy` / `windowApy` / `dailyApySeries` in `src/logic.js` (tested).

## Market Updates
`/api/market-updates` lists admin changes to the market and its reserves (LTVs, rate curve, oracles, caps, status, market settings…),
decoded from Kamino Lend instructions (`updateReserveConfig`, `updateLendingMarket`, `initReserve`, … incl. CPI/multisig calls) using
klend-sdk's generated layouts. It indexes incrementally into `market-history/index-v2.json`: each refresh fetches only
transactions newer than the last one seen. Values are formatted at index time; after changing a formatter, delete that file to re-index.
Decoding is covered by `server/updates.test.js`.

## VPS deploy (Docker)
- `docker-compose.yml`: `app` (Node 24: site + backend) + `caddy` (CSP and security headers from `Caddyfile`) + `tunnel` (cloudflared)
  + Plausible. No port is published: Cloudflare does HTTPS/WAF/geoblocking and reaches Caddy only through the tunnel
  (public hostname `DOMAIN` -> `http://caddy:80`, set in the Cloudflare dashboard).
- `.env` next to the compose file (never committed): `SOLANA_RPC`, `DOMAIN`, `TUNNEL_TOKEN`, `PLAUSIBLE_SECRET_KEY_BASE`,
  `PLAUSIBLE_TOTP_VAULT_KEY` (see `.env.example`). The app container only receives the variables it uses.
- Analytics: self-hosted Plausible CE (`plausible` + Postgres + ClickHouse, configs in `plausible/clickhouse/` from the upstream
  community-edition repo) on its own Docker network, published as `analytics.nysa.finance` -> `http://plausible:8000` in the tunnel.
  The site sends cookie-less pageviews and custom events with `@plausible-analytics/tracker` (`src/analytics.js`).
- Auto-deploy: `.github/workflows/deploy.yml` SSHes to the `deploy` user, whose key may only run `scripts/deploy.sh`
  (git reset to `origin/main` + `docker compose up -d --build`; a failing build/test leaves the running version up).
  Secrets: `VPS_SSH_KEY`, `VPS_HOST`, `VPS_KNOWN_HOSTS`.
- Monitoring: `GET /api/health` → `{ ok, marketAgeSec, sseClients, rpcCallsLastHour }` (503 if market data is over 5 minutes old).
