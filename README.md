# Nysa frontend (rebuild)

A from-scratch rebuild of https://app.nysa.finance: a Vue 3 + Vite frontend and a Node backend, deployed with Docker on a VPS.

```bash
npm install
npm run dev     # http://localhost:5173, /api proxied to the deployed backend (API_TARGET to override)
npm run server  # backend on :3000 (needs SOLANA_RPC in .env)
npm test        # formatter, lending/rewards math and instruction-decoding checks
npm run test:e2e  # transactions landed on a local mainnet fork (needs surfpool), ~1-2 min
```

`npm run test:e2e` (`e2e/fork.test.js`) starts a Surfpool fork of mainnet, funds throwaway wallets and lands every
transaction the backend builds against the real Kamino market and vault: supply, borrow, repay all, withdraw all;
vault deposit and withdraw all; withdraw of shares staked in the vault farm; the no-SOL message. It checks balances
and that each transaction keeps our compute limit and priority fee. Run it before merging changes to `server/tx.js`,
`server/vault.js` or `server/account.js`. It is not in CI: it depends on live mainnet state and the public RPC
(`E2E_UPSTREAM_RPC` to use another one). Install Surfpool with `brew install txtx/taps/surfpool`.

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
| `server/main.js` | HTTP server: static `dist/`, API routes, SSE, per-IP rate limits, snapshot schedule (hourly, random minute) |
| `server/rpc.js` | The single RPC client (429 backoff, call counter for `/api/health`) |
| `server/market.js` | Market cache: reserves, oracle prices, risk params, rate curves, reward farms (`/api/market`, `/api/events`) |
| `server/refresh.js` | Market cache timer: every 60s, sooner after our transactions confirm (never postponed, at most every 10s) |
| `server/account.js` | A wallet's balances, Kamino positions and pending farm rewards |
| `server/tx.js` | Builds deposit / withdraw / borrow / repay / claim with klend-sdk + farms-sdk, simulates, returns unsigned |
| `server/relay.js` | Transactions built or relayed here: what `/api/tx/send` relays, which confirmations refresh the market |
| `server/updates.js` | Market index: admin changes (Market Updates), liquidations and every obligation (address + owner), from chain history |
| `server/analytics.js` | Analytics page: open market positions with health factor, and each vault's depositors |
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

Liquidating a sanctioned borrower's loan is refused too. The liquidation bonus shown is what a liquidator can
actually get (`liquidationBonusRange` in `src/logic.js`), not the configured maximum. Docker images (by digest) and GitHub
Actions (by commit) are pinned; Dependabot proposes updates as pull requests.

Deploys without errors: `scripts/deploy.sh` builds the new image while the old container serves, then swaps them.
Meanwhile Caddy retries the app for up to 20 s instead of answering 502 (`lb_try_duration`), the new backend listens
only once it has the market and the saved sanctions list, and the old one drains on SIGTERM (ends the market streams,
finishes requests in flight, exits within 8 s). Measured under load on a local swap: 20× 502, 6× 503 and 6× "still
loading" before, none after (slowest response 2 s). A tunnel or Caddy update still drops connections for a few seconds.

## Transactions
`POST /api/tx` builds the action against the market cache with a fresh read of the wallet's obligation, simulates it
(a failing transaction comes back as a readable error and is never sent) and returns it unsigned. A first deposit also
creates the user's Kamino accounts: that setup comes back first (`final: false`); the client sends it, waits for
confirmation, then asks again for the action itself.

Borrow and withdraw limits come from Kamino and are rechecked against fresh prices and accrued interest before a
transaction is built. Withdrawals use the exact raw token allowance. Wallet funding and common Kamino simulation errors
are reported in plain language; transient 502/503/504 responses are retried once, except signed transaction sends.

## Swap fees and loop preview
The shared backend adapter uses Jupiter V2 Build's native `platformFeeBps=10` and configured fee token account. It
validates the provider's route-based fee amount, net output and fee-account mint; it never adds a separate fee transfer.
Keyless Jupiter access is available for prototype/read-only requests at 0.5 requests per second. Production use needs a
provider key and approved rate limit, a configured USDC and USDY fee account, an authorized treasury, reviewed route
program evidence and successful local-fork verification. Set these values in `.env`; never put them in browser config.

`/swap` requests and displays a sanitized USDY/USDC provider route. The server-side execution pipeline validates a narrow
Jupiter V2 `route_v2` single-hop `WhirlpoolSwapV2` shape: exact 27-account positions/roles, classic SPL mint/token state,
wallet ATAs, pool/vault relationships, and Orca static or dynamic tick-array/oracle PDA and account relationships. The
route is covered by encoded-account fixtures and is revalidated against confirmed account state before build. Legacy
`route` / `sharedAccountsRoute`, multihop, Token-2022/hooks, and extra route metadata remain fail-closed. A route label or
presence of the Whirlpool program key in remaining accounts is not sufficient. A validated route still does not make
economic execution ready: transaction build/sign/relay requires exact program/deployment evidence, complete local-fork
proof, production fee accounts, and validated wallet paths. Provider instructions and unsigned transactions are never
returned by the quote endpoint. Production readiness remains disabled until those release gates are accepted.
The borrower flows use fresh raw wallet balances and protocol withdrawal allowance, and carry only the confirmed raw
amount into an optional next action. Locked collateral is never treated as wallet balance.

`/loop` previews USDY collateral / USDC debt strategies and includes guarded separate Kamino metadata setup, atomic
Multiply open/full-close builders, identified position management, signed-intent relay, and pending-close reconciliation.
The economic actions remain unavailable while the supported-route, program evidence, complete local-fork, fee-account,
and wallet-acceptance gates are open. A confirmed close is not reported as complete until a fresh account read proves
zero raw debt and collateral. Metadata initialization is a separate non-economic transaction and does not charge the
Nysa swap fee.

Run `npm run simulate:swap-fees -- --scenario scripts/scenarios/swap-fees.synthetic.json` for a network-free,
hypothetical fee business scenario. Edit the synthetic inputs to compare sizes, frequency and direct costs; outputs are
not a forecast. Append `--json` for a machine-readable report. `npm run verify:loop-fork` is a separate local-only check.
It rejects non-loopback endpoints and needs a configured local mainnet fork, an ephemeral test wallet funded with local-fork
USDC, and initialized disposable USDC/USDY treasury token accounts. After the loopback guard passes, the verifier may sign
and submit test transactions only to that local validator to check the SDK Multiply open/full-close path, fee deltas, flash
repayment, and forced-failure rollback. Never point it at a public RPC or put a production key in its inputs. The ordinary
fee-aware v0 open measures 1,453 bytes without lookup compression. The verifier prepares a temporary local address lookup
table in separate setup transactions and uses it exclusively for the atomic open; the latest composed v0 open is 741 bytes,
below Solana's 1,232-byte limit, and its lookup indexes pass local bank-slot validation. If Kamino UserMetadata is absent,
the verifier also sends the SDK's metadata initialization in a separate non-economic setup transaction. Neither setup
transaction is included in the open. An earlier local simulation completed the atomic open instructions and measured the
exact USDY fee, but the verifier compared it with a stale SDK quote. The verifier now checks the fee for the actual
composed swapper quote. Follow-up fork runs could not revalidate it: one had stale cloned oracle data and a fresh reset
snapshot timed out while confirming local setup. No economic open was submitted.

The loop implementation remains guarded until all release evidence below is recorded. Keep the economic open and full
close atomic; acquisition and leverage swaps use the shared 10-bps Nysa fee policy. Do not split either economic action
into a sequence that can leave a partially opened or closed Multiply position.

Loop risk defaults are conservative: leverage is at most 1.5×; projected LTV is capped at the lower of 50% of the
market's current maximum borrow LTV and 40% of its current liquidation LTV; swap slippage is at most 50 bps; price
impact is at most 1%; quotes expire after 15 seconds; and every oracle must be no older than its reported heartbeat.
Tighter approved market/Nysa limits apply. Fresh prices, market limits, and quote/oracle ages are rechecked when building
and relaying an action. A non-positive carry estimate requires explicit acknowledgement and does not override any risk
limit.

Multiply collateral contributes to Farm Points through the existing supplied-USD snapshot formula. A loop therefore
increases counted gross supplied deposits while the formula remains unchanged; this points effect is disclosed and is
not a promise of rewards. For rollback, disable new loop opens first, keep identified positions visible, and preserve the
verified full-close and pending-signature reconciliation paths until every Nysa Multiply position is closed. Do not
remove or revert the only exit path while a position or unresolved close signature remains.

### Wallet acceptance record

Automated fixtures cover desktop sign-only relay handling and iOS deeplink return/recovery behavior. These fixtures do
not count as acceptance of a real wallet. No dated real-wallet acceptance is recorded yet, and Android Mobile Wallet
Adapter acceptance remains unverified. Keep new economic actions unavailable on every wallet family until the matrix is
completed against the supported route and final application builders.

| Wallet family | Required acceptance | Current record |
|---|---|---|
| Desktop Wallet Standard | Swap, buy then optional supply, free withdraw then optional sale, loop setup/open/full close; cancel/resume optional steps; pending/unknown, reload, confirmation, and exact close-state reconciliation | Not run; record date, browser, wallet/version, action results, and transaction references after acceptance |
| Android Mobile Wallet Adapter | Same swap, borrower, optional-step, setup, open/close, cancellation, pending, reload, and confirmation cases through MWA, including app return and wallet switching | Not run; MWA real-wallet acceptance is unverified |
| iOS deeplink wallet | Same swap, borrower, optional-step, setup, open/close, cancellation, pending, reload, and confirmation cases through each supported deeplink wallet, including repeated returns, refusal, and timeout | Fixtures only; real-wallet acceptance not recorded |

For each run, record the date, app commit, browser/OS, wallet name/version, action and recovery cases exercised, result,
and test transaction references from the approved test environment. Never include wallet secrets or production signatures.

Security-source review is recorded, but deployment approval is still blocked. Jupiter's official audit index lists the
[Swap v6 Offside Labs October 2025 report](https://github.com/jup-ag/docs/blob/main/static/files/audits/swap-v6-offside-october-2025.pdf)
and the [April 2024 report](https://github.com/jup-ag/docs/blob/main/static/files/audits/swap-v6-offside-april-2024.pdf).
Orca's [Whirlpools repository](https://github.com/orca-so/whirlpools) lists its
[Sec3 August 2025 report](https://github.com/orca-so/whirlpools/blob/main/.audits/2025-08-22.pdf). The
[Osec verification endpoint for Orca](https://verify.osec.io/status/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc)
currently reports the deployed program as unverified. Jupiter's Osec endpoint also reports unverified with no source
repository or commit. Report scope and current on-chain binary are not matched for either program, so program evidence
remains unapproved.

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

## WalletConnect
Wallet apps that support WalletConnect for Solana (Trust Wallet, Exodus, OKX, Bitget, Ledger Live, …) connect from any
device (`src/walletconnect.js`): Reown's AppKit modal shows the QR code and the list of 160+ wallets (on a phone it opens
the chosen app), as on Kamino.
- Shown only when `WALLETCONNECT_PROJECT_ID` (`src/config.js`) is set (Reown project; allowed domain `app.nysa.finance`).
- The connection is ours (`manualWCControl`): one `@walletconnect/universal-provider`, the same version AppKit uses (both
  pinned), wrapped as a Wallet Standard wallet so the store treats it like the others; the session survives reloads.
  Both Solana mainnet ids are accepted (the genesis hash and the truncated one some wallets still use). Loaded only
  when someone picks WalletConnect; telemetry and AppKit analytics off (its `pulse` beacon is blocked by the CSP).
- Transactions are signed in the wallet app (`solana_signTransaction`) and sent by `POST /api/tx/send`, the same relay
  as the iOS deeplink wallets. A wallet that returns only the signature gets it placed at its signer slot
  (`withSignature`, tested in `src/wallets.test.js`).
- CSP (Caddyfile): WalletConnect relay/verify/rpc, `api.web3modal.org` (wallet list, icons as `blob:`), `fonts.reown.com`.

## Earn vaults
Lending goes through Nysa-curated Kamino Earn vaults (kVaults), e.g. **RWA Prime** (`VAULTS` in `src/config.js`: address,
URL id and description only). `server/vault.js` reads each vault with the market cache: allocations, holdings, value per
share, utilization and APY; its **exposure** (the markets it is allocated to and their collateral) comes from the on-chain allocation.
- APY = supply APY (invested share × each reserve's supply APY, `getVaultActualAPY`) + rewards APY: the vault's
  auto-compounding rewards (`rewardInfo`, paid per second into the vault while the funded balance lasts) over its AUM,
  as on Kamino. Utilization = Σ invested × reserve utilization / AUM.
- Allocations are targets (`getVaultComputedReservesAllocation`): weights plus the unallocated weight (a liquidity
  buffer kept uninvested for instant withdrawals), capped per reserve. Kamino's bot syncs vaults to them about every
  15 minutes; the Exposure donut splits uninvested tokens into the buffer and what is awaiting sync.
- `/earn`: vaults with network, infra (Kamino), APY (⚡ breakdown), exposure (collateral icons), Total Deposits (the
  vault's AUM: invested in its markets or waiting in the vault); a row (a card on mobile) opens the vault.
- `/earn/:id`: Exposure (allocation donut, `pieSlices`/`arcPath` in `src/logic.js`, and markets), Realized APY from the vault's
  share value, Market Updates of the vault and its exposure markets, Fees (management, performance, withdrawal) and
  Addresses (vault, admin, allocation admin, oracle); rewards boost card; Deposit / Withdraw panel (`VaultPanel.vue`).
- Transactions `vault-deposit` (min shares out, then `invest` into the allocated reserves in the same transaction, sized
  on-chain, as fallback for Kamino's crank) and `vault-withdraw` (shares worth the amount, or all).
- `/borrow/:id` is a market's borrow page (risk parameters, rate model, addresses, due diligence). `?mode=withdraw`
  withdraws collateral, or USDC lent to the market directly before the vaults (Portfolio links there).
- Shares staked in the vault farm (Kamino's UI stakes deposits there) count everywhere: Portfolio, Farm Points,
  Analytics (`vaultShares` in `server/account.js`), and `vault-withdraw` unstakes them in the same transaction.
- Old links redirect: `/` and `/lend` → `/earn`, `/market/:id?mode=lend` → the vault, other `/market/:id` → `/borrow/:id`.
Covered by `npm run test:e2e` (deposit + invest, withdraw all, staked shares).

## Supply rewards (boosted APY)
The USDC reserve's Kamino collateral farm pays USDC incentives. `server/market.js` reads the farm with the market and
returns each token's reward APR (yearly emission value over the staked value; shown as APR because rewards don't compound).
The Lend table, asset data and Lend panel show supply APY + rewards APR; the market page has a Claim card for the
wallet's unclaimed rewards (`kind: 'claim'`, one transaction harvesting every pending reward).

## Farm Points
Points accrue as **supplied USD × days**: each snapshot (every 12 hours, 00:00 and 12:00 UTC) adds `last_supplied_usd × days since last snapshot` to every wallet's total,
then records its current vanilla and Multiply deposits (including USDY collateral) in the Nysa Kamino market and its Earn
vault shares (valued at the vault's share value; depositors found by the market index). Multiply collateral increases
counted gross supplied deposits under this unchanged formula. Logic: `snapshotPoints` in `src/logic.js` (tested).
Only wallets with deposits in the Nysa market(s) and vaults listed in `src/config.js` are tracked. Run a snapshot by hand:
`docker compose exec app node server/snapshot.js`.

Backup: `.github/workflows/points-backup.yml` copies the points CSV to Cloudflare R2 every 6 hours, read from the VPS over
SSH (Cloudflare's Bot Fight Mode blocks `/api/points` for the Actions runners): `farm-points/latest.csv`
plus a dated copy per change (`farm-points/YYYY/MM/DD/HHMMSSZ.csv`). The run fails, and GitHub emails it, if the site is
unreachable or the total points went down (the last good copy is kept). Setup: an R2 bucket and an R2 API token with Object Read &
Write on that bucket only; in the repo settings, secrets `R2_ENDPOINT` (the bucket's S3 API URL without the bucket name:
`https://<account id>.eu.r2.cloudflarestorage.com` for an EU bucket), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
variable `R2_BUCKET`; and secret `VPS_POINTS_SSH_KEY`, a key the VPS lets run only the read (in `/home/deploy/.ssh/authorized_keys`:
`command="cd /home/deploy/nysa && docker compose exec -T app cat /data/farm-points/points_state.csv",restrict ssh-ed25519 …`).
To restore: download `latest.csv` (Cloudflare dashboard → R2 → bucket → farm-points), copy it to the
VPS project directory, then
`docker compose exec -T app sh -c 'cat > /data/farm-points/points_state.csv' < latest.csv`.
An older copy loses no accrual: the next snapshot credits the whole gap since its `last_snapshot_ts` (on the lower balance).

## Realized APY
The first snapshot of each 12-hour UTC block also appends, per reserve, the value of one deposit share (liquidity per Kamino cToken), the APYs and the
utilization to `market-history/history.json`, plus the reserve's creation time (share value is exactly 1 then); and per
Earn vault, its tokens per share (`vaults` in that file). The vault page shows 30D / 7D realized APY (share-value growth over the window, annualised) next to the live APY, and a daily chart.
Math: `realizedApy` / `windowApy` / `dailyApySeries` in `src/logic.js` (tested).

## Market Updates
`/api/market-updates` lists admin changes to the market and its reserves (LTVs, rate curve, oracles, caps, status, market settings…),
decoded from Kamino Lend instructions (`updateReserveConfig`, `updateLendingMarket`, `initReserve`, … incl. CPI/multisig calls), and
to the Earn vaults (allocations, fees, caps, admin, farm… from kVault instructions), using klend-sdk's generated layouts. Each
update has a `source` (market or vault address): the vault page shows the vault's and its exposure markets', the borrow page
the market's. It indexes incrementally into `market-history/index-v4.json`: each refresh fetches only
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

## Deployment guides

- [Local Mainnet fork and readiness guide](docs/deployment/local-mainnet-fork-and-readiness.md) — includes `npm run setup:loop-fork` to seed ten disposable Surfpool wallets and local-only USDY/USDC balances, plus frontend routing and Mainnet release requirements.
- [Devnet staging guide](docs/deployment/testnet-staging-guide.md) — explains why Devnet is the app-integration target
  (Solana Testnet is for validator/network stress), and which cluster/dependency work is required before staging.
- [Production Mainnet guide](docs/deployment/production-mainnet-guide.md) — release gates, production configuration,
  deploy workflow, monitoring, and rollback. Swap and loop economics remain disabled until the recorded fork, program,
  treasury, risk, and wallet evidence is accepted.

## License
[MIT](LICENSE) © 2026 Nysa Finance. The lending smart contracts are Kamino Lend's; this repository is the interface and its backend.
