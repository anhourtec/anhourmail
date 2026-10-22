# ADR-0009: Masked aliases in our control plane; undelete via trash retention

Status: Accepted, 2026-10-21

## Context

Masked aliases are a v1 must-have. Stalwart's `x:MaskedEmail` is **Enterprise-only**, and it is not the vendor-specific MaskedEmail JMAP extension another provider publishes. Undelete (`ArchivedItem`) is also Enterprise (`research/stalwart.md` §4, §9).

## Decision

- A masked alias is a random local part on `anhourmail.com` (or the customer's domain), provisioned as a Stalwart **account alias** (`Account.aliases[] {name, domainId, enabled, description}`, all Community features).
- Our `alias` table holds the metadata: `kind = masked`, `for_site`, `created_by`, `enabled`, and per-alias stats from delivery events. Toggling sets `enabled` on the Stalwart alias (disabled = rejected at SMTP).
- Our API exposes masked-alias operations. Third-party clients that expect that vendor-specific MaskedEmail API are not supported in v1.
- Undelete: the webmail moves deletes to Trash with a retention policy (30 days, then purge). There is no server-side archive in v1.

## Consequences

- Works on Community. Alias counts are limited by our plan rules, plus Stalwart's per-account alias handling (we watch performance at high alias counts).
- If we buy Enterprise later, we can migrate to `x:MaskedEmail` behind the same API.

## Alternatives

- Buy Enterprise for this feature alone: rejected for now.
- A separate alias-forwarding service: rejected (another system, double hop).
