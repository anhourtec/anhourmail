# ADR-0002: Tenancy and plan limits live in our control plane

Status: Accepted, 2026-10-21

## Context

Stalwart Community supports many domains but **not** tenants. `x:Tenant`, per-tenant quotas and isolation are Enterprise-only (`research/stalwart.md` §9). We need accounts that own domains, mailboxes and aliases, with plan limits.

## Decision

- Postgres is the source of truth for accounts, memberships, ownership, plans and limits (`04-data-model.md`).
- Services enforce limits before enqueuing provisioning jobs. Derived limits are **pushed** to Stalwart: `quotas.maxDiskQuota`, object-count quotas, and throttles keyed by `authenticatedAs`.
- `StalwartManagement.ensureTenant(accountId)` exists and is a **no-op**. It is the single place to map accounts to `x:Tenant` if we ever license Enterprise.
- The reconciler reports drift between Postgres and Stalwart and never deletes mail.

## Consequences

- Isolation correctness is ours. Every repository method is scoped by account; the RBAC harness and contract tests check cross-account access (404).
- A direct Stalwart admin action can create drift. Staff use the console, and the reconciler flags anything else.

## Alternatives

- Buy Enterprise now: unnecessary cost before product-market fit.
- One Stalwart instance per customer: an operational non-starter.
