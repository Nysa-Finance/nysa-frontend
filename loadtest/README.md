# Load test (VPS)

`vps.js` ramps virtual users against the deployed app: 10 → 50 → 100 → 200 → 400 at once over about 11 minutes. Each one,
about every 10 seconds, opens Earn, reads `/api/market`, checks its own wallet (`/api/account`, a random address per
user) and prepares a deposit into RWA Prime (`/api/tx`: build and simulate, **nothing is signed or sent**). It stops by
itself if more than 5% of requests fail, if 95% of them take longer than 3 s, or if the API's rate limits answer 429.

Cost: about 250 Alchemy CU per round (account 50, deposit build 120, plus the market refresh every minute), so roughly
1.5M CU for a full run, under $1 on Pay As You Go. Rate-limited (429) answers cost nothing.

## Before

1. Install k6: `brew install k6`.
2. On the VPS, put your public IP (`curl -s https://ifconfig.me`) in `.env`, then restart the app:
   `RATE_LIMIT_EXEMPT_IPS=<your IP>` and `docker compose up -d app`. The log shows `rate limits off for 1 IP(s)`.
3. On Cloudflare, a temporary WAF custom rule: *IP Source Address equals <your IP>* → **Skip** (all remaining custom
   rules, rate limiting rules, Super Bot Fight Mode / bot challenges).
4. Pick a quiet hour, and keep `docker stats` open on the VPS.

## Run

```sh
k6 run -e WALLET=<a wallet of yours holding at least 1 USDC> loadtest/vps.js
```

`-e AMOUNT=` changes the deposit amount (default 1 USDC, at least the vault's minimum deposit), `-e BASE=` the target.

## After

Remove `RATE_LIMIT_EXEMPT_IPS` from `.env` (then `docker compose up -d app`) and delete the Cloudflare rule.
