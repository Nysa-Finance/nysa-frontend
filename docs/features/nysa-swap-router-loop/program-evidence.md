# Swap route program evidence

Evidence captured 2026-11-05. This is a review record, not a deployment approval. `server/program-policy.js`
intentionally exports an empty `PROGRAM_EVIDENCE` list, so all provider routes remain unavailable for execution.

## Observed route and deployment identities

| Item | Observed evidence | Decision |
|---|---|---|
| Jupiter V2 Build swap program | Mainnet account `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` was executable and owned by `BPFLoaderUpgradeable`. ProgramData account `4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT`, deployment slot `462802085`, data length `2,892,269` bytes. | Exact deployed code version/hash has not been matched to an audit. Not approved. |
| Orca Whirlpool route | Mainnet program `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` was executable and owned by `BPFLoaderUpgradeable`. ProgramData account `CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD`, deployment slot `457152296`, data length `10,485,760` bytes. Sample routed pool `AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD` is owned by this program. | Exact deployed code version/hash has not been matched to a relevant audit. Not approved. |
| USDY mint | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6`; owner Tokenkeg `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; 6 decimals. | Mint identity confirmed; this does not approve a route. |
| USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; owner Tokenkeg `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; 6 decimals. | Mint identity confirmed; this does not approve a route. |

Program IDs and owners were read from mainnet account data. Jupiter's provider response identifies the candidate route by
label `Whirlpool`; the sample pool owner independently resolves that label to the Orca program above. Labels alone are not
admission evidence. The code still requires exact program IDs and an evidence record covering each invoked program and
route label.

## Audit and provider references

- Jupiter's [Swap audits page](https://developers.jup.ag/docs/resources/audits) lists third-party audit material for
  Jupiter swap programs, including Offside and Sec3. The published listing does not establish that a particular audit
  covers the exact ProgramData deployed at slot `462802085` or this V2 Build fee path. It is therefore not recorded as
  coverage of the observed deployment.
- Orca's [Whirlpools repository](https://github.com/orca-so/whirlpools) links its security review materials, including
  Kudelski, Neodyme, OtterSec and Sec3 reports. The material reviewed here does not establish that a report covers the
  exact ProgramData deployed at slot `457152296`. It is therefore not recorded as coverage of the observed deployment.
- Jupiter's [V2 Build documentation](https://developers.jup.ag/docs/swap/build) documents provider-native
  `platformFeeBps` and `feeAccount` request parameters. V2 Build responses expose route input/output amounts; the tested
  response did not include normalized `platformFee` amount/mint metadata. The adapter checks the route delta against
  shared 10-bps integer arithmetic and still requires a local simulated fee-account balance delta before execution.

## Read-only route observation

A keyless read-only Jupiter V2 Build request succeeded on 2026-11-05 at `2026-11-05T11:39:42.757Z`, using the
repository's USDY/USDC mints, a 1,000,000 base-unit USDC exact input, `platformFeeBps=10`, and no API key. The relevant
provider output was:

```json
{
  "status": 200,
  "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "outputMint": "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6",
  "inAmount": "1000000",
  "platformFeeBps": 10,
  "outAmount": "866575",
  "otherAmountThreshold": "862243",
  "slippageBps": 50,
  "priceImpactPct": "0",
  "platformFee": null,
  "routePlan": [{
    "label": "Whirlpool",
    "ammKey": "AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD",
    "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "outputMint": "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6",
    "inAmount": "1000000",
    "outAmount": "867442"
  }]
}
```

The route delta was `867` base units, equal to `floor(867442 × 10 / 10,000)`. The output's 50-bps slippage threshold
was provider-reported separately. The response omitted normalized platform-fee metadata. Jupiter keyless access is
documented at 0.5 requests per second; the backend serializes keyless build calls at a maximum of one per 2.1 seconds.
Production credential and rate-limit configuration remains a release gate.

That request used a non-token-account placeholder solely to check read-only quote/build behavior. It was never submitted,
signed, or simulated and is not fee-account or transaction evidence. Production/test transaction checks must use a real,
initialized token account for the selected fee mint, owned by the expected disposable test treasury on the local fork.
No fee was collected by the read-only request.

## Approval state

- Exact program versions/hashes have not been matched to reports in audit scope.
- No approved Jupiter/DEX evidence record exists; no routed swap is execution-eligible.
- No local mainnet fork, real disposable test treasury token accounts, or actual fee balance deltas have been validated.
- No actual Multiply open/full-close transaction has been simulated. The Phase 1 verifier fails closed until those
  prerequisites and an SDK transaction composition path exist.
- No blanket audit assurance is made for Jupiter, Orca, or the combined route.
