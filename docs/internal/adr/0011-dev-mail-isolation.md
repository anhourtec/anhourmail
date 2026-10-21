# ADR-0011: Dev mail isolation — internal network + relay to Mailpit

Status: Accepted, 2026-10-21

## Context

Dev, tests and CI must never send real mail to external addresses (rule 19). A config mistake in a route must not be able to leak mail.

## Decision

- Stalwart and Mailpit run on the Compose network `mailnet` with `internal: true`, so there is no route to the internet. Published ports don't work on internal networks, so a `mail-edge` container (alpine/socat, pinned) attached to both networks forwards host ports (bound to `DEV_BIND_ADDRESS`, default `127.0.0.1`) into `mailnet`. It carries inbound connections only.
- The dev plan (`infra/stalwart/dev-plan.ts`) also routes every non-local recipient to a `mailpit` Relay route.
- Consequences of no egress, handled in the dev plan:
  - Pyzor (a network lookup) is disabled in dev only.
  - The admin WebUI bundle is downloaded once on the host (pinned version + sha256) and served via a `file://` `resourceUrl`.
- `npm run stack:verify` asserts both layers, including a failing `curl` from inside the Stalwart container.

## Consequences

- Two independent guards against leaks.
- Spam-rule updates and other network features of Stalwart don't run in dev. Integration tests that need them use staging.

## Alternatives

- Relay route only: rejected (one config error from a leak).
- Firewall rules on the host: not portable across developer machines.
