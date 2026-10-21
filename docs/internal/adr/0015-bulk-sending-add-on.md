# ADR-0015: Newsletters and bulk sending as a separate paid add-on

- **Status:** Accepted, 2026-10-21 (maintainer decision)
- **Related:** `11-bulk-sending.md`, `03-anti-spam-and-abuse.md`, `06-pricing-and-billing.md`, `packages/shared/src/plans.ts` (`ADDONS.bulk`), `sending.ts` (`BULK_MAIL`)

## Context

The original brief banned bulk/marketing mail on every plan (CASL risk, shared IP reputation). Customers with
small newsletters (clubs, families, small groups) are a real demand, and refusing them pushes them to tracking-heavy
ESPs. A mailbox host that lets personal accounts send bulk mail from the same IPs loses inbox placement for
everyone (`research/deliverability.md` §7).

## Decision

1. Base plans stay personal-mail only: `BULK_MAIL.allowedOnBasePlans = false`; the AUP prohibits bulk/marketing
   mail outside the add-on.
2. Bulk is a **paid add-on** for Plus/Supporter, reviewed before activation, with monthly recipient tiers.
3. **Full separation**: dedicated sending subdomain, our return-path, separate DKIM selectors, separate outbound
   IP pool and queue (Stalwart Community routing/throttles), submission only through our campaign sender.
4. **Compliance built in**: consent records (CASL s.10/s.13), sender identification, RFC 8058 one-click
   unsubscribe honoured immediately, double opt-in by default, automatic suppression of bounces and complaints,
   Gmail/Yahoo bulk-sender thresholds enforced as automatic pauses.
5. **No tracking** by default — no open pixels, no click rewriting; counts only.
6. Ships after launch (Phase 10), once the personal-mail pool has a clean reputation.

## Consequences

- Extra infrastructure cost: a second IP pool, warm-up, feedback-loop enrolment per pool — priced into the add-on.
- More control-plane surface (lists, consent, campaigns, suppression) and a Trust & Safety review queue.
- Personal-mail reputation is insulated; a bulk incident pauses only the add-on.

## Alternatives

- **Keep the blanket ban** — simpler, but loses a real use case and does nothing for users' newsletters.
- **Partner with an external ESP** — rejected: third-party processors and tracking conflict with the privacy brand.
- **Allow bulk on Supporter from the same pool** — rejected: shared reputation is the failure mode we exist to avoid.
