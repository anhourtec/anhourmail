# ADR-0010: Append-only, hash-chained audit log in the same unit of work

Status: Accepted, 2026-10-21

## Context

Section 11 requires full auditing that is tamper-evident, searchable, visible to the right people (including staff actions shown to customers), and never contains mail content or secrets.

## Decision

- An audit module in `packages/core/src/audit`: an `AuditRepository` port, `recordAudit()` used by every mutating service, and a redaction step that reuses the logger's key list.
- Every mutation writes its entry **in the same `UnitOfWork`** as the change. If the audit write fails, the change fails. Denied attempts are audited too.
- **Tamper evidence:** a chain per scope (`account:<id>` or `platform`). `hash = sha256(prev_hash ‖ canonical JSON of the entry)` with a monotonically increasing `seq`. A scheduled job verifies each chain and alerts on a break.
- **Append-only:** the app's DB role has INSERT and SELECT only on `audit_log`. No code path updates or deletes audit rows. Retention purges run as a separate privileged maintenance role and are themselves audited.
- `scripts/check-audit.mjs` fails if a service mutation lacks an audit call.

Details: `audit.md`.

## Consequences

- Writes serialize per scope (to get the previous hash). Contention is per account, which is acceptable at our scale.
- Retention deletion breaks the chain prefix by design. The verifier starts from a recorded checkpoint hash.

## Alternatives

- Log-only audit (stdout): rejected (not queryable, not tamper-evident).
- An external append-only store (e.g. an immutable bucket): later, as an off-site copy of chain checkpoints.
