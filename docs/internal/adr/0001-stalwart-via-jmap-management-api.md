# ADR-0001: Drive Stalwart through its JMAP management API; never fork it

Status: Accepted, 2026-10-21

## Context

We need a full mail server (SMTP, IMAP, JMAP, spam filtering, DKIM, DMARC, MTA-STS). Stalwart (AGPL-3.0) covers all of it in one binary. The original plan assumed its REST management API (`/api/principal`, `/api/settings`, …). Research found that **v0.16.0 (April 2026) removed the REST API and TOML config**. All management is now JMAP objects (`x:Domain`, `x:Account`, `x:MtaRoute`, …) at `POST /jmap` under `urn:stalwart:jmap` (`research/stalwart.md`).

## Decision

- Run the official image **unmodified**, pinned by tag + digest: `stalwartlabs/stalwart:v0.16.27@sha256:c429b311…`.
- All management goes through `packages/stalwart-client` (MIT), which speaks JMAP management with idempotent upserts by natural key. Mailbox data goes through `packages/jmap-client`.
- Production auth is a scoped API key. The management HTTP listener is internal-network only.
- Upgrades follow `08-operations.md`. Object shapes are re-verified against `/api/schema` on every upgrade.

## Consequences

- No fork to maintain. AGPL obligations stay minimal: running unmodified triggers no source-disclosure duty, and our code talks over the network at arm's length.
- We depend on Stalwart's object model, which changed incompatibly once (0.15 → 0.16). The client isolates that risk in one package.
- Some features are Enterprise-only (masked email, undelete, multi-tenancy, full metrics, delivery history). See ADR-0002 and ADR-0009.
- The official image contains dormant Enterprise-licensed code. Counsel should confirm that running it unlicensed is fine (the vendor says it is), or we build an AGPL-only image from source.

## Alternatives

- **Fork Stalwart:** rejected. Maintenance cost, and AGPL §13 obligations for a modified network service.
- **Postfix + Dovecot + Rspamd:** rejected for v1. Three systems, no JMAP (Dovecot JMAP is immature), more ops.
- **Stalwart Enterprise:** possible later. The `ensureTenant()` seam is kept.
