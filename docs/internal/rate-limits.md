# Rate limits

Last updated: 2026-10-22. Rule 14: **every endpoint has a rate limit**. Code: `packages/server/src/rate-limit.ts` (tiers) + the `route()` wrapper in `apps/web`. When the code lands, the tier names and numbers there are canonical; this table is updated in the same change.

## How it works

- Redis fixed window (`INCR` + `EXPIRE`), key `am:rl:<tier>:<endpoint>:<caller>:<window>`. Per-account send quotas use a sliding window (sorted set) so a burst at a window edge can't double the limit.
- **Caller:**
  - signed in: `s:<hash of session id>` (or `u:<user id>` for per-user tiers);
  - otherwise `ip:<client ip>`.
  - The client IP comes from `X-Forwarded-For` **only when `TRUST_PROXY=true`**. NGINX overwrites that header in production. Otherwise the socket address is used, which fixes the portal's spoofable limiter (`research/reference-patterns.md` pattern 4).
- Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. Over the limit: **429** `{ error: { code: "rate_limited" } }` + `Retry-After`.
- **Fail mode** per tier:
  - _open_ = a Redis error allows the request (logged at warn);
  - _closed_ = a Redis error returns 503 for that request.
  - Anything that costs money or reputation is fail-closed.
- `/api/health*` is exempt. Better-auth's own per-endpoint limits sit inside the `auth` tier.

## Tiers

| Tier          | Limit / window                                                                                 | Key               | Fail       | Used by                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------- | ----------------- | ---------- | -------------------------------------------------------------------------------------- |
| `read`        | 600 / 60 s                                                                                     | caller            | open       | GET/HEAD default                                                                       |
| `write`       | 120 / 60 s                                                                                     | caller            | open       | Non-GET default; domain add/remove, mailbox create, quota change                       |
| `auth`        | 30 / 60 s per IP; 10 failed sign-ins / 15 min per account → lockout 15 min                     | ip + account      | closed     | Sign-in, 2FA verify, password reset request, SSO handoff exchange                      |
| `signup`      | 5 / hour per IP; 3 / day per phone number                                                      | ip, phone hash    | closed     | Account creation, phone OTP send                                                       |
| `publicForm`  | 10 / 15 min per IP                                                                             | ip                | closed     | Generic tier for unauthenticated forms; no current users                               |
| `invite`      | 30 / hour per user; 60 / 15 min per IP for redemption                                          | user, ip          | closed     | Create, send and redeem invites                                                        |
| `dnsVerify`   | 20 / hour per domain; 60 / hour per account                                                    | domain, account   | open       | "Check now" on DNS records                                                             |
| `export`      | 3 / day per account                                                                            | account           | closed     | Data export requests, audit export                                                     |
| `sending`     | Published trust-tier limits (`packages/shared/src/sending.ts`); recipients counted per message | account + mailbox | **closed** | Webmail send (BFF), alias creation burst (20 / hour), masked alias creation (50 / day) |
| `sensitive`   | 30 / hour                                                                                      | caller            | closed     | App password creation, 2FA changes, member invites, role changes                       |
| `webhook`     | 120 / 60 s                                                                                     | ip                | open       | Stripe webhooks (signature verified first), Stalwart WebHook (internal network only)   |
| `staff`       | 300 / 60 s                                                                                     | user              | open       | Staff console reads; act-as start is under `sensitive`                                 |
| `publicAsset` | 600 / 60 s                                                                                     | ip                | open       | Image proxy (`mail.` host, also capped per message), well-known files                  |

Abuse-detection thresholds are **not** rate limits and are not published here (rule 33, `03-anti-spam-and-abuse.md`).

## Adding an endpoint

Pick a tier in `route(handler, { limit: LIMITS.<tier> })`. If none fits, add a tier here and in code in the same change. The RBAC harness checks that each route returns 429 after its limit with the expected headers.
