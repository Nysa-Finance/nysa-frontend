# Phase 1 implementation report

Date: 2026-11-05

## Delivered

- Shared backend Jupiter V2 Build adapter uses provider-native 10-bps fees. It validates input/output mints, fee-account mint and authority, provider route deltas, exact expected base-unit fee, net output and minimum output. No custom SPL transfer fallback exists.
- Keyless prototype requests are limited to one every 2.1 seconds, with at most four pending requests, a ten-second wait/request bound, cancellation, and a safe busy error. Production API-key and rate configuration remain a readiness gate.
- The read-only /loop preview uses fee-aware Jupiter quotes and Kamino SDK position calculations for collateral, debt, LTV, health, liquidation threshold and known swap/origination/flash costs. Selected leverage, carry timestamp, rate assumptions, and acknowledgement metadata are included.
- Strategy eligibility requires an actual Nysa vault allocation to the USDC liability reserve in the selected market, with USDY collateral listed for the allocation. The actual local-fork feasibility flag stays false until atomic proof passes.
- Offline synthetic business simulator reports completed notional by source and input mint, fee income, declared costs, and net fees. Inputs remain labeled hypothetical.
- The local verifier now builds the real Jupiter swap instructions and installed Kamino SDK Multiply open/full-close instructions, composes the initial USDC acquisition and loop open into one atomic transaction, and contains fee-account delta checks plus forced-failure rollback checks. This path is not proven: the real v0 composition exceeds the transaction limit before simulation or submission. There is no split-transaction fallback.

## TDD evidence

Round 1 behavior tests were run red before the corresponding fixes, then green:

| Behavior | Red evidence | Green evidence |
|---|---|---|
| Match the Nysa vault's USDC loan reserve to the USDY collateral market pair | Strategy test failed with false instead of true when the fixture used the actual USDC allocation reserve. | node server/strategy.test.js: strategy ok |
| Convert Kamino slippage basis points correctly | SDK regression expected 0.5 for 50 bps but received undefined before the helper existed. | node server/loop.test.js: installed SDK returns factor 0.995 for 0.5 percent |
| Derive exposure and known costs from fee-adjusted SDK output | Adverse-route test expected 108 collateral value but received the target estimate 150. | node server/loop.test.js: actual net-route exposure, LTV, health, origination fee, flash fee and swap fees pass |
| Pass selected leverage and expose carry provenance | Carry test expected an asOf timestamp but received undefined. | node server/strategy.test.js: selected 1.2x leverage, timestamp, assumptions, and acknowledgement metadata pass |
| Group completed input notional by source and input mint | Simulator test failed while reading the missing standalone source group. | node scripts/simulate-swap-fees.test.js: source and mint totals pass |
| Bound keyless queue, deadline and cancellation | Concurrent test expected saturation rejection but the old limiter did not reject. | node server/swap.test.js: bounded wait, cancellation, deadline and safe saturation error pass |

Earlier module-import and missing-export errors were setup failures, not valid behavioral RED evidence. They are not counted as red tests here.

The local-fork test does not have a green economic execution result. The configured local validator accepted preflight and fee-account checks, but compilation produced a 1,443-byte atomic open transaction against the 1,232-byte v0 limit. The larger 1.5x run using the alternate debt flash-borrow mode measured 1,443 bytes; the collateral flash-borrow mode measured 1,475 bytes. No economic transaction was simulated or submitted. The failure is the unresolved atomic-feasibility gate, not a passing fork proof.

## Verification

Focused Round 1 tests passed:

- node server/strategy.test.js
- node server/loop.test.js
- node scripts/simulate-swap-fees.test.js
- node scripts/verify-loop-fork.test.js
- node server/swap.test.js

Full suite, npm test: exit 0.

> logic ok
> wallets ok
> swap-fees ok
> loop-policy ok
> swap-fee-simulator ok
> loop fork guard ok
> strategy ok
> program-policy ok
> swap adapter ok
> loop preview ok
> market-updates ok
> screening ok
> relay ok
> refresh ok
> bigint-buffer ok

Production build, npm run build: exit 0. Vite 8.3.1 transformed 293 modules and built the Loop JS/CSS chunks.

Offline simulator, npm run simulate:swap-fees -- --scenario scripts/scenarios/swap-fees.synthetic.json: exit 0.

> Hypothetical scenario — not a forecast
> Attempted swaps: 1315
> Completed swaps: 1312 (standalone 1012, loop 300)
> Excluded swaps: 2 failed, 1 rejected
> Completed input notional by source: standalone USDC 110100.009; loop USDY 30000
> Gross fees: 140.1 USD equivalent
> Net after declared direct costs: 50.71 USD equivalent

All simulator amounts, traffic, token prices, and costs are synthetic assumptions.

Guarded verifier without a configured local endpoint, npm run verify:loop-fork: exit 1 as expected.

> BLOCKED: LOCAL_FORK_RPC is not set. No RPC request was sent.

Configured local-fork attempt used only http://127.0.0.1:8899, a disposable local signer, and local disposable USDC/USDY fee token accounts. Validator preflight passed on Agave 2.2.16; fee token accounts were verified. The SDK built the real route and Multiply instructions, then failed closed before sending the economic transaction:

> BLOCKED: Local Multiply transaction is 1443 bytes; Solana limit is 1232 bytes.

No mainnet transaction was signed or sent. The local scenario's economic transaction was not simulated, and forced-failure rollback checks were not reached.

A keyless read-only Jupiter observation for 10 USDC returned gross route-plan output 8,674,418 raw USDY, net output 8,665,744, and an 8,674 raw USDY fee. The fee equals floor(gross route output × 10 / 10,000). Jupiter did not return normalized fee amount/mint metadata; the adapter derives it from the route delta and requires simulated account-balance verification before production composition.

## Deferred v1 path assessment

Jupiter documents transaction v1 as a possible size remedy: it permits up to 4,096 bytes and requires transactionVersion=1, @solana/kit v8 or later, v1 compute configuration, an RPC that accepts v1, and a wallet that can sign it. The current app and installed Kamino SDK use @solana/kit 2.3.0. The current Android Mobile Wallet Adapter browser integration advertises only legacy and v0. The iOS Phantom/Solflare deeplink flow has no transaction-version capability negotiation, and the relay uses the Kit 2 legacy/v0 transaction-envelope decoder. The local validator is Agave 2.2.16; Solana's v1 size activation requires Agave 4.2.2 or later. Adopting v1 therefore needs separate scope for transaction compilation, wallet capability/fallback behavior, iOS relay parsing, and validator upgrades. It was not implemented under this plan.

References: [Jupiter Build](https://developers.jup.ag/docs/swap/build), [Jupiter transaction versions](https://developers.jup.ag/docs/swap/advanced/transaction-versions), [Solana larger transaction sizes](https://solana.com/upgrades/larger-transaction-sizes).

## Blockers and self-review

Phase 1 cannot be marked complete. The plan requires a single atomic USDC-funded open and full close with real local-fork fee deltas, flash repayment, zero-debt close, and forced-failure rollback. The tested v0 open is 211 bytes over Solana's limit even after deduplicating idempotent ATA initialization and testing the debt-flash variant. The local close, fee deltas, flash repayment and rollback path exist in the verifier but remain unproven because the open transaction cannot be simulated. The USDY/USDC loop stays unavailable: production feasibility is false, and no swap/open actions are exposed in the UI. Standalone swap acquisition remains independent; it is not used as a loop fallback.

There is also no approved audit-to-deployed-version evidence for the exact Jupiter and DEX programs. PROGRAM_EVIDENCE remains empty. The read-only /loop preview is not an execution flow.

Self-review found no fixture-only fork success, no transaction split, no production RPC request in the fork verifier, and no production transaction signing or submission. The hard atomic-feasibility acceptance item remains unresolved and should be resliced before Phase 1 can pass review.

## Round 2 review fixes and evidence

- Kamino flash-repay rebasing is tested with the installed SDK's `flashBorrowReserveLiquidity` and `flashRepayReserveLiquidity` builders. The tests cover both missing ATA setup and preexisting ATA states, assert that the final repay ABI byte points to the final composed borrow index, and prove the SDK-owned instruction is not mutated. The setup/ordering scenario initially failed with `3 !== 6`; after rebasing, it passed. Exact duplicate compute-budget setup instructions are now emitted once; that regression initially observed three copies instead of one. Final borrow indices are 5 with ATA setup and 3 with both ATAs preexisting.
- Negative-carry acknowledgement keys are now created only after the final SDK-backed preview includes funding base units, selected leverage, both full provider route identities, fee and cost results, exposure/risk/limits, carry timestamps and rate assumptions, and `nysa-loop-ack-v1`. Tests prove changes to funding, leverage, route, fee, flash cost, rate assumption, or policy version change the key. The initial preview test failed because the old prequote key remained `stale-pre-quote-key`; the fixed preview emits a 64-character hash and binds each tested change.
- `/api/loop-preview` passes a disconnect signal through `buildReadOnlyLoopPreview`, the Kamino quote callbacks, and provider build/limiter. The real HTTP disconnect test first failed because the provider did not observe client disconnect; it now passes. The adapter test confirms an already-aborted signal reaches the provider build.
- `readLocalSlot` now reads the direct `getSlot().send()` result and normalizes either a safe number or bigint. The regression first failed with `undefined` instead of slot `987654` when treating the direct value as `{ value }`. The installed local Kit RPC in this run returned a direct bigint (`326` at the first probe); both numeric result forms now pass, and object-shaped results reject.
- README and `.env.example` now document that the verifier uses an ephemeral local test wallet and can sign/submit only to loopback after checking the endpoint. They describe the local inputs and state that no production key or public RPC is allowed.

### Local v0 size and fork retry

The local mainnet fork used a disposable signer and test treasury accounts injected into Agave 2.2.16 at `http://127.0.0.1:8899`. The repo-configured USDC mint is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; the earlier candidate address missing the extra `G` returned no account. Fee-account preflight passed for both local test token accounts.

After exact duplicate compute-budget deduplication, the ordinary fee-aware v0 open measured **1,453 bytes**, 221 bytes over Solana's 1,232-byte limit. I also attempted a non-economic, temporary local address lookup table containing 38 unique non-signer addresses. The table creation/extensions were submitted only to the loopback validator; the table warmed, was re-fetched, and contained all required addresses. The atomic open serialized to **774 bytes**, but local simulation rejected it with:

> JSON-RPC error: Invalid method parameter(s) (invalid transaction: Transaction address table lookup uses an invalid index)

The verifier stopped before any economic open was submitted. Only local faucet/lookup-table setup transactions were submitted. No public-RPC transaction was signed or sent. The ALT result does not constitute open simulation evidence; the fork proof remains blocked.

### Audit source status

Official audit-source links are recorded here and in README. Jupiter's [official audit index](https://developers.jup.ag/docs/resources/audits) lists the [Swap v6 Offside Labs October 2025 PDF](https://github.com/jup-ag/docs/blob/main/static/files/audits/swap-v6-offside-october-2025.pdf), the [April 2024 PDF](https://github.com/jup-ag/docs/blob/main/static/files/audits/swap-v6-offside-april-2024.pdf), and a Sec3 v3 report. Orca's [Whirlpools repository README](https://github.com/orca-so/whirlpools) lists multiple audit reports, including [Sec3, August 22, 2025](https://github.com/orca-so/whirlpools/blob/main/.audits/2025-08-22.pdf), and links an [Osec verifiable-build status for the mainnet program ID](https://verify.osec.io/status/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc). The source indexes establish report existence and Orca's verifiable-build status; exact correspondence between every route program ID, current deployed binary, source commit, and audit scope is not verified. No program-evidence record is approved, and `PROGRAM_EVIDENCE` remains empty.

### Round 2 phase status

The atomic-open, audit-version, and successful local-fork evidence gates remain unresolved. No split economic transaction or v1 transaction path was added. The loop remains unavailable. Round 2 fixes are recorded with their tests and report updates; Phase 1 is still incomplete.

## Round 2 final verification

`npm test`: exit 0. Decisive final lines:

> loop fork guard ok
> strategy ok
> swap adapter ok
> loop preview ok
> request disconnect cancellation ok
> market-updates ok
> screening ok
> relay ok
> refresh ok
> bigint-buffer ok

`npm run build`: exit 0; Vite 8.3.1 transformed 293 modules and built the Loop JS/CSS chunks.

`npm run simulate:swap-fees -- --scenario scripts/scenarios/swap-fees.synthetic.json`: exit 0; attempted 1,315, completed 1,312, excluded 2 failed and 1 rejected; completed notional was 110,100.009 USDC standalone and 30,000 USDY loop; gross fees were $140.10 and net after declared direct costs was $50.71 under the labeled synthetic assumptions.

`npm run verify:loop-fork` without local configuration: exit 1 as expected, `BLOCKED: LOCAL_FORK_RPC is not set. No RPC request was sent.` The configured loopback attempt and its ALT simulation failure are detailed above.
