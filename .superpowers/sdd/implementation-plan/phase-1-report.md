# Phase 1 implementation report

Date: 2026-11-05

## Delivered

- Shared backend Jupiter V2 Build adapter uses provider-native 10-bps fees. It validates input/output mints, fee-account mint and authority, provider route deltas, exact expected base-unit fee, net output and minimum output. No custom SPL transfer fallback exists.
- Keyless prototype requests are limited to one every 2.1 seconds, with at most four pending requests, a ten-second wait/request bound, cancellation, and a safe busy error. Production API-key and rate configuration remain a readiness gate.
- The read-only /loop preview uses fee-aware Jupiter quotes and Kamino SDK position calculations for collateral, debt, LTV, health, liquidation threshold and known swap/origination/flash costs. Selected leverage, carry timestamp, rate assumptions, and acknowledgement metadata are included.
- Strategy eligibility requires an actual Nysa vault allocation to the USDC liability reserve in the selected market, with USDY collateral listed for the allocation. The actual local-fork feasibility flag stays false until atomic proof passes.
- Offline synthetic business simulator reports completed notional by source and input mint, fee income, declared costs, and net fees. Inputs remain labeled hypothetical.
- The local verifier now builds the real Jupiter swap instructions and installed Kamino SDK Multiply open/full-close instructions, composes the initial USDC acquisition and loop open into one atomic transaction, and contains fee-account delta checks plus forced-failure rollback checks. The ordinary v0 message exceeds the packet limit without address lookup compression; a temporary loopback-only table reduces the measured open to 741 bytes. The economic path remains unproven: a successful simulation caught a stale expected quote, the expected-fee source is now fixed to the composed route, and subsequent fresh-fork validation was blocked before completion. There is no split-transaction fallback.

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

After exact duplicate compute-budget deduplication, the ordinary fee-aware v0 open measured **1,453 bytes**, 221 bytes over Solana's 1,232-byte limit. A non-economic, temporary local address lookup table containing 38 unique non-signer addresses warmed and produced a 774-byte v0 message, but the first simulation rejected its lookup index. Round 3 removes upstream provider/SDK tables from the final open and validates the serialized v0 lookup references against the table's active length at the local bank slot; see the Round 3 result below.

> JSON-RPC error: Invalid method parameter(s) (invalid transaction: Transaction address table lookup uses an invalid index)

The verifier stopped before any economic open was submitted. Only local faucet/lookup-table setup transactions were submitted. No public-RPC transaction was signed or sent. The first ALT result did not constitute open simulation evidence; the fork proof remained blocked.

### Audit source status

Official audit-source links are recorded here and in README. Jupiter's [official audit index](https://developers.jup.ag/docs/resources/audits) lists the [Swap v6 Offside Labs October 2025 PDF](https://github.com/jup-ag/docs/blob/main/static/files/audits/swap-v6-offside-october-2025.pdf), the [April 2024 PDF](https://github.com/jup-ag/docs/blob/main/static/files/audits/swap-v6-offside-april-2024.pdf), and a Sec3 v3 report. The October 2025 PDF identifies audited repository commit `41d454b84058a9680441b779eb46dc2a00f7d4f1` in `jup-ag/jupiter-aggregator-program`; GitHub's API returns 404 for that commit now. Orca's [Whirlpools repository README](https://github.com/orca-so/whirlpools) lists [Sec3, August 22, 2025](https://github.com/orca-so/whirlpools/blob/main/.audits/2025-08-22.pdf), covering three PR commits: `6352a9b61a574fb62440a7dca9a933af02847db5`, `d5a8bfd83a11de7c1412fe68a2bd42e8f7359c0f`, and `19875ce6595c7e15ad07cd2ede3966b05d34ab62`. Current Whirlpools `main` is `cc683ec92acb5e7606caa3d8e514d9383e9c7c11`.

Read-only mainnet RPC inspection found Jupiter's ProgramData account `4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT`, last deployed at slot `462802085`, with the raw SBF payload SHA-256 `53d53f447f594158a259cbdca1f5e613caf40bc14ce759ffd5953580dc2af8dd` (ProgramData bytes after the 45-byte loader metadata). Orca's ProgramData account is `CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD`, last deployed at slot `457152296`, raw payload SHA-256 `c422b22f3eefe86dd55878a4f505b9c68c26e241dc96af1573ca032b24b8ee3f`. Osec's [Jupiter status](https://verify.osec.io/status/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4) returns `is_verified:false` with no source repo/commit/hash. Osec's [Orca status](https://verify.osec.io/status/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc) returns `is_verified:false`, `on_chain_hash=75d0cbf14e39949d50656d581b2e0065ac9543588da96a1dc4c1091a939c605c`, and `commit=None`; this Osec hash is not the raw ProgramData payload hash recorded above. Neither deployed binary is publicly matched to an audited source commit/version. No program-evidence record is approved, and `PROGRAM_EVIDENCE` remains empty.

### Round 2 phase status

The atomic-open, audit-version, and successful local-fork evidence gates remain unresolved. No split economic transaction or v1 transaction path was added. The loop remains unavailable. Round 2 fixes are recorded with their tests and report updates; Phase 1 is still incomplete.

## Round 3 review fix and local retry

- The verifier now selects the temporary local ALT exclusively for the composed open, avoiding upstream tables whose warmup state may exceed the fork slot. Before every local simulation it decodes the signed v0 transaction and validates each table lookup index against its table's active address count at a fresh local bank slot. A table whose `lastExtendedSlot` is the simulation slot exposes only `lastExtendedSlotStartIndex`; otherwise all stored addresses are available. Tests decode the actual serialized v0 message, reject same-slot index 0 when active count is 0, accept it after warmup, reject out-of-range indexes, and assert upstream tables are excluded when the temporary table is present.
- TDD RED: table-selection regression observed both upstream and temporary tables instead of the temporary table alone. Active-index regression observed “Missing expected exception” with the old no-op check. Program-address diagnostic regression returned `null` rather than the compiled System Program ID. Each now passes after the corresponding fix.
- The exclusive-ALT open first serialized to **740 bytes**, with 38 temporary table entries. The message passed table-reference validation against the local confirmed bank slot. A bounded account-inventory retry cloned 122 existing state accounts, 10 upgradeable programs, 2 legacy executable programs, the exact provider-route pool dependencies and disposable borrower/treasury token accounts. That retry produced a **741-byte** open with 39 table entries; Whirlpool and Kamino flash-borrow instructions passed before InitObligation failed because the borrower's Kamino UserMetadata account was absent and system-owned.
- A new behavior test first failed because the verifier returned no distinct setup instruction (`actual: undefined`). The verifier now asks the installed Kamino SDK for only `initUserMetadata` with `skipInitialization:false` and `skipLutCreation:true`, validates the returned bundle has one metadata instruction and no lookup-table setup, signs and submits it as a separate loopback-only setup transaction, and checks the metadata account is initialized. The final bounded retry logged `LOCAL NON-ECONOMIC SETUP PASS` and confirmed that this instruction was excluded from the open transaction.
- The prior metadata-enabled run compiled the **741-byte** atomic open, validated its lookup references and simulated it with `err=null`. Runtime logs show the Jupiter and Whirlpool swaps, Kamino flash borrow, obligation initialization, deposit of 129,663,905 USDY base units, borrow of 49,875,922 USDC base units, second swap and flash repayment all succeeded in simulation. The verifier then caught a 75-base-unit USDY fee assertion discrepancy before sending the open: pre-balance 0, simulated post-balance/delta 130,008, but expected 129,933.
- Exact cause: the initial USDC→USDY acquisition route was 100,000,000 input, gross route output 86,744,379, net output 86,657,635, and 86,744 USDY fee. Kamino first quoted an open swap for 49,789,634 USDC input (gross 43,189,716 USDY, net 43,146,527, fee 43,189), then its swapper requoted the actual composed instruction for 49,875,922 USDC input (gross 43,264,566 USDY, net 43,221,302, fee 43,264). The transaction used the latter quote, so its exact total fee was 86,744 + 43,264 = 130,008. The previous expected amount incorrectly used stale `open.quote` from the first Kamino quote, giving 129,933. All three routes used the same disposable USDY fee account and the Whirlpool pool `AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD`; the adapter derived fee from the route delta because Jupiter omitted normalized fee metadata.
- TDD RED for the composition observer: without it, the regression saw `[]` instead of the provider quote used to build the swap instructions. Green: `node server/loop.test.js` passes after `createKaminoSwapCallbacks` reports the exact quote selected by the SDK swapper, including a replacement quote after amount changes. The verifier now computes expected open and close fees from those composed swapper quotes and includes route, pre/post/delta, simulation error and runtime logs in mismatch diagnostics. It no longer uses stale `open.quote` for the executed swap fee.
- One post-fix retry on the already-running fork could not revalidate the fee check: Kamino simulation failed at instruction 12 with `ReserveStale` error 6009 after cloned USDY/USDC oracle data aged 381/383 seconds, beyond the 180-second limit. A final fresh reset snapshot cloned the full account/program inventory and passed local fee-account preflight at slot 23, but the verifier then timed out waiting for a loopback setup transaction confirmation (`Local validator transaction confirmation timed out.`) before economic composition. No economic open was submitted. No production/mainnet transaction was signed or sent.
- Full close, post-open flash repayment, zero-debt close and forced-failure rollback remain unproven. The audit-to-deployed-version match also remains unresolved. Phase 1 cannot pass its proof gates.
- A one-click production execution phase must surface Kamino UserMetadata initialization as a separate wallet-approved setup transaction when the account is absent. This non-economic setup cannot be appended to the atomic economic open; Phase 1 still exposes only a read-only preview.
- Audit-to-deployed-version matching is not publicly verifiable in the checked sources: Osec reports both Jupiter and Orca unverified, Jupiter's audited repository commit now returns 404, and Orca's current main commit differs from the audited PR commits. Raw ProgramData fingerprints and audit commit scopes are recorded above; they do not establish a binary-to-audit match.

## Final verification after Round 3 setup fix

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

`npm run verify:loop-fork` without local configuration: exit 1 as expected, `BLOCKED: LOCAL_FORK_RPC is not set. No RPC request was sent.` Configured local-fork outcomes are detailed above: one pre-fix simulation reached successful open instruction effects but caught a stale expected quote; the corrected assertion is unit-tested, while subsequent fork checks were blocked by stale oracle state and local setup confirmation timeout. No economic open transaction was submitted, and the full-close/rollback proof remains incomplete.
