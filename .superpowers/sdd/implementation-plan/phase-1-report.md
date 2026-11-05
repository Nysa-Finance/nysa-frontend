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
