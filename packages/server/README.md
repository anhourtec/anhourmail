# @anhourmail/server

Server-only building blocks shared by `apps/web` and `apps/worker`:

- `log` — structured JSON logger with key-based redaction (CLAUDE.md rule 12, 24). The only way server code logs.
- `health` — probe helper (timeout, never throws) and liveness payload for `/api/health` and `/api/health/ready`.
- `redis` — the ioredis singleton. Redis is an optimisation: callers fail open, except where
  `docs/internal/rate-limits.md` marks a tier fail-closed.

Secrets-at-rest (key ring + AES-256-GCM with AAD), the rate limiter and the `route()` wrapper land here in
Phase 3 — see `docs/internal/research/reference-patterns.md` patterns 1, 4 and 5 for the agreed changes.
