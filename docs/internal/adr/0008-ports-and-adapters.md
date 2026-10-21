# ADR-0008: Ports-and-adapters — code is database-independent

Status: Accepted, 2026-10-21

## Context

The owner requires that business code is not designed around the database (section 9.4). Swapping a database or an external provider must not touch services or UI. Tests must run fast without infrastructure.

## Decision

- `packages/core`: domain types, rules and services as plain TypeScript. It depends only on **port interfaces**: `WaitlistRepository`, `AuditRepository`, `UnitOfWork`, `Clock`, `IdGenerator`, `Hasher`, and later `MailboxRepository`, `DomainRepository`, `MailServer` (Stalwart), `Payments` (Stripe), `OtpSender`, `DnsResolver`.
- `packages/adapters`: `db-postgres` (drizzle; mapping between rows and domain objects happens only here), `memory` (for unit tests and the RBAC harness), and `contract` (a shared test suite every adapter must pass).
- External systems (Stalwart, Stripe, SMS/OTP, DNS) each sit behind a port with a fake.
- **Enforced by ESLint `no-restricted-imports`:** only `packages/adapters`, `packages/server`, `packages/stalwart-client`, `apps/*/src/server/adapters` and composition roots (`apps/*/src/server/container.ts`) may import `drizzle-orm`, `pg`, `ioredis`, `better-auth`, `stripe` or `@anhourmail/stalwart-client`. `packages/core` may import none of them.
- Composition roots wire adapters to services. Tests inject the memory container.

## Consequences

- Services are unit-tested in milliseconds against memory adapters. Postgres behaviour is pinned down by the contract suite in integration runs.
- More files per feature (port + 2 adapters + contract), which is accepted as the cost of the guarantee.

## Alternatives

- Services call drizzle directly (the portal's style): rejected by requirement.
- A full DDD framework: rejected as unnecessary weight.
