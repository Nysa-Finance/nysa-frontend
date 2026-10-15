# Security policy

## Reporting a vulnerability

Report security issues **only** through GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/Nysa-Finance/nysa-frontend/security/advisories/new)**
(repository → **Security** → **Report a vulnerability**; a GitHub account is needed).

The report is visible only to you and the maintainers, and the discussion and fix stay private until an advisory is
published. This is the only channel for vulnerability reports: don't use public issues, pull requests, discussions,
or direct messages.

Include what you found, where (URL, endpoint or file), how to reproduce it, and the impact you expect. Don't send
secrets or private keys, yours or anyone else's.

## Scope

- The Nysa interface at [app.nysa.finance](https://app.nysa.finance) and its backend: the code in this repository
  (transaction building and relay, market data, analytics, sanctions screening, deployment configuration).
- The Nysa Kamino market's configuration (oracles, LTVs, caps, admin authority).

Out of scope: the Kamino Lend, Kamino Farms, Scope and Solana programs themselves (report those to their teams),
third-party wallets, and the Cloudflare and Plausible services.

## Testing in good faith

Use your own wallets and small amounts, and stop as soon as you've shown the issue. Don't access or move other
users' funds or data, don't run denial-of-service or volume tests against production, and don't use social
engineering. Give us reasonable time to fix an issue before disclosing it.
