# 11 — Newsletters and bulk sending (paid add-on)

Decision 2026-10-21 (maintainer): newsletters and bulk mail are **never allowed on the base plans** and are offered
only through the paid add-on **"Newsletters and bulk sending"** (`ADDONS.bulk` in `packages/shared/src/plans.ts`,
`BULK_MAIL = { allowedOnBasePlans: false, addOnId: "bulk" }` in `sending.ts`). Status: **planned**, after
deliverability on personal mail is proven (Phase 10, `09-roadmap.md`). ADR-0015.

The rule that keeps everything else working: **bulk mail never shares reputation with personal mail** —
separate sending domain, separate return-path, separate outbound IP pool, separate queue.

## Who can buy it

- Plus or Supporter accounts only (`ADDONS.bulk.requires`), in good standing for ≥ 60 days, trust tier
  `standard` or better, no open abuse cases.
- Activation is **reviewed by Trust & Safety** (`bulk_addon.status = pending_review`): sender identity, the
  website and sign-up form behind the list, the first campaign.
- Volume tiers: monthly recipients from `ADDONS.bulk.monthlyRecipientTiers` (5k / 25k / 100k). Every recipient
  counts once per message. Price: TBD (`06-pricing-and-billing.md`).

## Separation from personal mail

| Layer                       | Personal mail                             | Bulk add-on                                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| From domain                 | customer domain apex or `@anhourmail.com` | a **dedicated subdomain** the customer delegates (e.g. `news.example.org`); never `@anhourmail.com`                                                                                                                                                |
| Return-path / bounce domain | per customer domain                       | `bounces.<bulk-domain>.anhourmail.com` (ours), so bounces reach our processor                                                                                                                                                                      |
| DKIM                        | `am1`/`am2` selectors                     | separate `ab1`/`ab2` selectors on the bulk subdomain, aligned with From (DMARC)                                                                                                                                                                    |
| Outbound IPs                | main pool                                 | **separate bulk IP pool**, warmed separately; a block never touches personal mail                                                                                                                                                                  |
| Stalwart routing            | `MtaOutboundStrategy` default routes      | an `MtaRoute` + `MtaOutboundThrottle` keyed to the bulk return-path / authenticated bulk sender, and its own virtual queue (Community: routing expressions, throttles and queue strategies are all Community features — `research/stalwart.md` §7) |
| Submission                  | user's mail client / webmail              | **only the campaign sender in our worker** (no SMTP AUTH for bulk), so every message passes our checks                                                                                                                                             |

## CASL (`research/market-and-legal.md` §4)

- **Consent**: express (opt-in with purpose, sender identity and how to withdraw — s.10(1)) or implied
  (existing business relationship, with expiry). The **sender proves consent** (s.13): every subscriber carries a
  `bulk_consent` record (kind, source, wording version, timestamp, IP/user agent) — append-only.
- **Identification and unsubscribe in every message** (s.6(2)): sender name, mailing address, contact; an
  unsubscribe link valid for at least **60 days** (s.6(3)); unsubscribes take effect **within 10 business days**
  (s.11(3)) — ours take effect **immediately** (suppression on click).
- Purchased, rented, scraped or appended lists are prohibited (AUP).

## Mailbox-provider rules (Gmail / Yahoo bulk-sender requirements; `research/deliverability.md` §3)

- SPF and DKIM pass with **DMARC alignment** on the bulk subdomain; the organisational domain has a DMARC record.
- **One-click unsubscribe**: `List-Unsubscribe: <https://…/u/<token>>, <mailto:…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058); the HTTPS endpoint suppresses on POST without
  login, and the visible link in the body does the same.
- **Spam complaints < 0.1 %, hard ceiling 0.3 %** (Google Postmaster Tools); bounce rate < 2 %.
- Valid forward and reverse DNS on bulk IPs; TLS on every connection.

## List quality

- **Double opt-in** for sign-up forms (default and recommended).
- **Imports**: either double opt-in confirmation sent by us, or a written consent attestation per import plus
  hygiene checks — syntax, role addresses (`postmaster@`, `abuse@`), known spam traps/disposable domains, global
  and account suppression, duplicate removal. Imports over the tier limit or with a high reject rate go to review.
- Re-engagement: subscribers with no positive signal for 12 months (we don't track opens, so: no reply and no
  preference-centre visit) are flagged for re-confirmation, not silently mailed forever.

## Bounces, complaints, suppression

- Bounces arrive at our return-path → parsed by the worker (DSN, RFC 3464) → hard bounces suppressed at once;
  soft bounces suppressed after 3 in 14 days.
- Complaints from feedback loops (Yahoo CFL, Microsoft JMRP; Gmail via Postmaster Tools aggregates) →
  immediate suppression + `bulk.suppression_added`.
- Suppressions are per account and global (hard bounces, spam traps); checked before every send.

## Tracking: none by default

Consistent with the brand: **no open pixels, no click-tracking link rewriting, no per-recipient analytics**.
Stats are counts only: sent, delivered, bounced, complained, unsubscribed (`bulk_delivery_stat`). If customers
ask for opens/clicks later, it is a separate decision (ADR), off by default and disclosed to recipients.

## Volume, warm-up and review

- New bulk senders start at 10 % of their tier in week 1, doubling weekly while complaints < 0.1 % and bounces
  < 2 % (`research/deliverability.md` §6 warm-up table, applied to the bulk pool).
- **Per-campaign review** for the first 3 campaigns of a new sender, and for any campaign to > 2× the previous
  audience or from a new list (`bulk.campaign_held` → `bulk.campaign_approved`).
- Hourly send rate per account throttled in Stalwart (`MtaOutboundThrottle`) and in the worker.

## Abuse escalation

1. Automatic pause (`bulk.sending_paused`) when complaints ≥ 0.3 % or bounces ≥ 5 % on a campaign, or a spam-trap
   hit, or a blocklist listing of the bulk pool.
2. Trust & Safety review: resume, require list cleaning/re-confirmation, or cancel the add-on.
3. Personal mail of the account is unaffected unless the abuse also involves personal sending (separation above).

## What Stalwart Community does vs what we build

| Stalwart (Community)                                                                                                                                            | AnhourMail control plane + worker                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DKIM signing for the bulk subdomain, routing to the bulk IP pool via `MtaRoute` + strategy expressions, outbound throttles, virtual queues, DSN generation, TLS | Lists, subscribers, consent records, imports and hygiene, campaign composer and scheduler, per-recipient rendering with unsubscribe tokens, `List-Unsubscribe(-Post)` headers, suppression, bounce/complaint processing, review workflow, stats (counts only), billing tiers |

## Permissions and audit

- Permissions (`packages/shared/src/rbac`): `bulk.read` (Owner, User Admin, Auditor), `bulk.list.manage`
  (Owner, User Admin), `bulk.campaign.send` **critical** (Owner only). Buying/cancelling the add-on is
  `billing.manage`.
- Audit actions (catalogue): `bulk.addon_enabled`, `bulk.addon_disabled`, `bulk.sender_domain_verified`,
  `bulk.list_created`, `bulk.list_imported`, `bulk.list_deleted`, `bulk.campaign_scheduled`, `bulk.campaign_held`,
  `bulk.campaign_approved`, `bulk.campaign_sent`, `bulk.campaign_cancelled`, `bulk.suppression_added`,
  `bulk.suppression_removed`, `bulk.sending_paused`. Never subscriber lists or message bodies in audit `meta`.

## Data model

`04-data-model.md` "Newsletters and bulk sending add-on". Campaign bodies are kept only until sent.
