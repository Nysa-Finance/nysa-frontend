# Phase 1 implementation report

Date: 2026-11-05

## Delivered

- Shared server-side Jupiter V2 Build adapter with native `platformFeeBps=10` and `feeAccount` parameters, one fee per economic swap, integer base-unit fee checks, route-derived fee validation, net output/minimum output, exact route program admission, fee-account mint/authority verification, and safe provider errors. No custom SPL transfer fallback was added.
- Keyless prototype quotes remain available and are serialized to one request per 2.1 seconds. Production API-key/rate configuration is a separate strategy readiness gate.
- Fee-aware Kamino SDK quote callbacks and `/loop` read-only preview, strategy gates, LTV/carry/risk and fee reporting, plus SPA navigation and backend API wiring. No loop transaction signing or submission is exposed.
- Offline synthetic fee simulator and deterministic tests; configurable local-fork preflight that rejects non-loopback RPC and checks real local test fee token accounts. The verifier never signs or sends transactions.
- Program identity/audit record with exact gaps. `PROGRAM_EVIDENCE` remains empty, so no provider route is execution-eligible.

## TDD evidence

New behavior checks were written before their implementations and run red first:

| Behavior | Red evidence | Green evidence |
|---|---|---|
| Keep keyless prototype quoting while making production credentials an explicit readiness gate | `node server/strategy.test.js` failed at `server/strategy.test.js:53`: expected `production-provider-key-missing`. | `strategy ok` |
| Enforce the documented keyless Jupiter request rate | `node server/swap.test.js` failed during module loading: `The requested module './swap.js' does not provide an export named 'createKeylessRateLimiter'`. | `swap adapter ok`; deterministic limiter test confirms 2.1-second intervals. |
| Prevent SDK composition unless fee-account balance delta has been simulated | `node server/loop.test.js` failed at line 67: `Missing expected rejection.` | `loop preview ok` |
| Refuse public RPC endpoints in the local-fork gate | `node scripts/verify-loop-fork.test.js` initially failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created verifier. | `loop fork guard ok`; public mainnet endpoint test confirms zero fetch calls. |

Earlier Phase 1 tests also reproduced expected red behavior before their modules were implemented: the adapter test failed when the mocked provider response was not yet normalized; the loop test failed to import the absent `server/loop.js`; and exact program evidence tests failed when route labels alone were accepted. All focused tests passed after implementation.

## Verification

`npm test` — exit 0. Decisive output:

```text
logic ok
wallets ok
swap-fees ok
loop-policy ok
swap-fee-simulator ok
loop fork guard ok
strategy ok
program-policy ok
swap adapter ok
loop preview ok
market-updates ok
screening ok
relay ok
refresh ok
bigint-buffer ok
```

`npm run build` — exit 0; Vite 8.3.1 transformed 293 modules and emitted the Loop JS/CSS chunks.

`npm run simulate:swap-fees -- --scenario scripts/scenarios/swap-fees.synthetic.json` — exit 0, offline. Result excerpt:

```text
Hypothetical scenario — not a forecast
Attempted swaps: 1315
Completed swaps: 1312 (standalone 1012, loop 300)
Excluded swaps: 2 failed, 1 rejected
Gross fees: 140.1 USD equivalent
Net after declared direct costs: 50.71 USD equivalent
```

All USD prices, traffic, size/frequency and costs in this report are synthetic assumptions from the editable scenario.
Appending `--json` also exited 0 and emitted the normalized machine-readable result; it reports 1,312 completed swaps,
USDC gross fees of `140100000` base units, and net after declared costs of `50710000` base units.

`npm run verify:loop-fork` — exit 1 as an expected hard gate:

```text
BLOCKED: LOCAL_FORK_RPC is not set. No RPC request was sent.
```

One bounded `solana-test-validator --url https://api.mainnet-beta.solana.com` probe was attempted with Jupiter and Orca upgradeable-program clone flags and a temporary ledger at `/tmp/nysa-phase1-loop-validator`. Agave 2.2.16 booted at `http://127.0.0.1:8899`, reached processed slot 63 / confirmed slot 63 in about 31 seconds, and was stopped with Ctrl-C (exit 130). This showed the validator binary and public clone source could start; it did not validate that all required program state had cloned, and it did not load the Nysa market, reserve liquidity, a funded test wallet, or disposable fee accounts. No transaction was signed, simulated, or submitted.

Jupiter read-only provider observation and public account evidence are recorded in [`docs/features/nysa-swap-router-loop/program-evidence.md`](../../../docs/features/nysa-swap-router-loop/program-evidence.md). The route returned gross USDY route-plan output `867442` and net `outAmount=866575` for 1,000,000 raw USDC input with `platformFeeBps=10`; fee delta `867` equals integer floor at 10 bps. Provider metadata omitted normalized fee amount/mint. The read-only call used a placeholder fee account only to test quote access; it is explicitly not transaction or treasury evidence.

## Blockers and self-review

Phase 1 cannot be marked complete against its plan. Actual fee balance delta validation and fee-aware Multiply open/full-close local-fork simulation are not proven. There is no approved exact router/DEX audit-to-deployment match (`PROGRAM_EVIDENCE` is empty), and the workspace has no configured local fork, test wallet, or real disposable USDC/USDY fee token accounts. The guarded verifier exits closed and documents those conditions; it does not substitute fixture-only success.

Review notes: fee arithmetic shares `src/swap-fees.js`; adapter validates provider output against route deltas and optional provider metadata; composition refuses to proceed without simulation and exact route evidence; non-local RPC is rejected before any request. Provider credentials, treasury addresses, risk approval and production route admission stay server-side and disabled until operators configure and verify them. Read-only `/loop` exposes no execution path. No direct transaction signing or sending code was added.

Dependency note: the first direct-dependency install attempt used the latest Solana program packages and failed `ERESOLVE` because they require `@solana/kit ^3.0`, while this app uses Kit 2.x. Direct dependencies now use Kit-2-compatible versions (`address-lookup-table 0.7.x`, `token 0.5.x`, `token-2022 0.4.x`). The final install completed; npm still printed peer-override warnings for newer transitive Solana packages brought by the installed Kamino SDK. Full tests and build pass with the resolved lockfile.
