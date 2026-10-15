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
browser ── /api/events (SSE) ── market snapshot on connect and after every refresh (/api/market polled if refused)
        ── /api/account/:wallet  balances, positions, unclaimed rewards (cached 15s per wallet)
        ── POST /api/tx          unsigned, simulated transaction → wallet signAndSendTransaction
        ── GET  /api/tx/:sig     confirmation (a confirmed tx built or relayed here refreshes the market for everyone)
backend ── Solana RPC: market cache every 60s (~10 calls) + 3 calls per account read + tx builds
```

| Module | Role |
|---|---|
| `server/main.js` | HTTP server: static `dist/`, API routes, SSE, per-IP rate limits, daily snapshot schedule |
| `server/rpc.js` | The single RPC client (429 backoff, call counter for `/api/health`) |
| `server/market.js` | Market cache: reserves, oracle prices, risk params, rate curves, reward farms (`/api/market`, `/api/events`) |
| `server/refresh.js` | Market cache timer: every 60s, sooner after our transactions confirm (never postponed, at most every 10s) |
| `server/account.js` | A wallet's balances, Kamino positions and pending farm rewards |
| `server/tx.js` | Builds deposit / withdraw / borrow / repay / claim with klend-sdk + farms-sdk, simulates, returns unsigned |
| `server/relay.js` | Transactions built or relayed here: what `/api/tx/send` relays, which confirmations refresh the market |
| `server/updates.js` | Market index: admin changes (Market Updates), liquidations and every obligation (address + owner), from chain history |
| `server/analytics.js` | Open positions with health factor for the Analytics page |
| `server/snapshot.js` | Daily Farm Points + APY history snapshot |
| `server/storage.js` | Files in `DATA_DIR` (atomic writes) |

Sanctions screening (`server/screening.js`): every wallet is checked against the US Treasury's OFAC SDN list, which
names sanctioned crypto addresses (SOL, USDC, ETH, …). The full XML export is downloaded daily and saved in DATA_DIR
(the CSV export truncates remarks and drops addresses). A sanctioned wallet gets 403 on account data, transaction
builds and relays, and the frontend disconnects it with a notice. Until a list is loaded, viewing works but no
transaction is built (fail closed).

Validation and limits: wallet addresses and actions are checked, request bodies are capped at 4 KB, and the endpoints that
cost RPC calls are rate-limited per client IP (Cloudflare's `CF-Connecting-IP`). Each IP may hold 5 market streams
(`/api/events`); a browser turned away polls `/api/market` instead. The server never holds keys.

## Transactions
`POST /api/tx` builds the action against the market cache with a fresh read of the wallet's obligation, simulates it
(a failing transaction comes back as a readable error and is never sent) and returns it unsigned. A first deposit also
creates the user's Kamino accounts: that setup comes back first (`final: false`); the client sends it, waits for
confirmation, then asks again for the action itself.

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
  valid signature, when no signer is sanctioned and every instruction calls Kamino Lend/Farms, SPL Token, ATA,
  Compute Budget, System or Lighthouse (wallet guard) (`server/relay.js`, `server/relay.test.js`). Round trip covered by
  `src/wallets.test.js`.

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
klend-sdk's generated layouts. It indexes incrementally into `market-history/index-v3.json`: each refresh fetches only
transactions newer than the last one seen. Values are formatted at index time; after changing a formatter, delete that file to re-index.
Decoding is covered by `server/updates.test.js`.

## Liquidations
`/liquidations` lists open loans by health factor, with the collateral price at which each one is liquidated
(price / health factor: one collateral asset, stablecoin debt), and every liquidation in the market. The same index
decodes Kamino's `liquidateObligationAndRedeemReserveCollateral(V2)`: debt repaid = token transfers into the repay
reserve's liquidity vault, collateral seized = transfers out of the withdraw reserve's liquidity vault
(`/api/liquidations`, decoding covered by `server/updates.test.js`).

Anyone can liquidate an unhealthy loan from the page (`LiquidateModal.vue`, `kind: 'liquidate'` in `server/tx.js`):
`GET /api/liquidation/:market/:borrower` gives the repayable amount under Kamino's rules (close factor, per-transaction
cap, full liquidation of small loans); the quote is a simulation of the real transaction (the liquidator's token
balances after it), and the transaction sent pays out at least 99% of that quote or fails.

## License
[MIT](LICENSE) © 2026 Nysa Finance. The lending smart contracts are Kamino Lend's; this repository is the interface and its backend.
