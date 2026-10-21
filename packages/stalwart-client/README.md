# @anhourmail/stalwart-client

The only way our code manages Stalwart (CLAUDE.md rule 21). Stalwart v0.16+ has no REST management API:
configuration and directory objects are JMAP objects (`x:Domain`, `x:Account`, `x:MtaRoute`, …) under the
`urn:stalwart:jmap` capability at `POST /jmap` (docs/internal/research/stalwart.md §3).

- Internal network only. Production auth is a scoped API key (Bearer); dev uses the recovery admin (Basic).
- No mail content passes through this client — mailbox data goes through `@anhourmail/jmap-client`.
- `ensureTenant()` is a deliberate no-op seam: tenancy lives in our control plane (ADR-0002). If we ever buy
  Stalwart Enterprise, this is where `x:Tenant` provisioning goes.
- Object shapes are verified against the pinned server (v0.16.27). Re-check them on every Stalwart upgrade.
