# 06 — Pricing and billing

Last updated: 2026-10-29. Research: `research/market-and-legal.md` (not legal or tax advice; confirm with an accountant).

## Plans

Plans, prices, storage and limits are defined once in `packages/shared/src/plans.ts` (`PLANS`, `BILLING`). The console, marketing pricing table and docs import them. **This document does not restate the numbers.** In outline:

- **Free:** one `@anhourmail.com` address (claimed once the sign-in email is confirmed; ADR-0021), self-service sign-up
  while `SIGNUP_MODE=open` (`08-operations.md` "Access control"), limited sending (`sending.ts` tier `new`).
- **Plus:** custom domains, unlimited aliases, catch-all, masked aliases, ten mailboxes sharing one storage pool per
  account (below), annual price in USD and CAD.
- **Supporter:** Plus plus a badge and early features, pay-what-you-want above a minimum, annual.
- Annual only. No lifetime deals. No trial on paid plans (Free is the trial). 14-day refund window. Prices are **tax-exclusive**.

### Pricing decision (maintainer, 2026-10-23)

Supersedes the open decision recorded on 2026-10-21 (founding price, soft quota, smaller free storage). The numbers live
in `plans.ts`; in outline:

- **Free:** $0, one `@<platform domain>` address, 1 GB (`storagePoolGb`).
- **Plus:** yearly, **per account** (covers everyone in it); up to 10 mailboxes included (`includedMailboxes`), **10 GB
  pooled for the whole account** (`storagePoolGb`), unlimited custom domains and aliases, catch-all, add people.
- **Supporter:** pay what you want above a lower minimum; everything in Plus plus the badge.
- **Paid extras (Phase 5, billing):** storage blocks of `storageBlockGb` (+10 GB) at `storageBlockPrice` per year, and
  mailboxes beyond the included ten at `extraMailboxPrice` per year. Never auto-charged. The pricing page and docs render
  the lines with `storageText()`. The earlier "fair use 30 GB, then $1/GB" line is withdrawn: at $9 it lost money for
  accounts storing 9–30 GB.
- **Pooled enforcement (revised 2026-10-23 evening):** the mail server enforces quotas per mailbox only, so the sum of an
  account's mailbox quotas can never exceed its pool (`accountPoolBytes(plan, blocks)` — blocks are 0 until billing).
  `packages/core/src/mailboxes/service.ts`: a new mailbox defaults to an even share of the unassigned pool over the
  plan's remaining included mailboxes (`defaultShareBytes`, whole GB, at least 1 GB) or a chosen 1 GB … unassigned; it
  is refused when the pool is fully assigned ("All 10 GB of this account's storage is assigned. Lower another mailbox's
  storage or add more."). Changing storage allows from the mailbox's measured usage rounded up (`minQuotaBytes`) to its
  quota plus the unassigned pool, under the account lock. Every mailbox counts toward the pool, suspended or being
  deleted too (they still hold mail).
- **Existing data:** `job:quota-cap` (`rebalanceStoragePools`) scales an over-assigned account's quotas down in
  proportion, never below each mailbox's usage rounded up, records `keptAbovePool`, audits `mailbox.quota_changed` with
  reason `storage_pooled` and queues `mailbox.ensure`. Never deletes mail.
- **Published now, enforced in Phase 6** (`ACCOUNT_POLICY`): external recipients per mailbox per day Free 50 / paid
  500 (lower in the first 14 days); message size 25 MB send / 50 MB receive; a full mailbox refuses mail ("mailbox
  full"), warnings at 80/95%; free inactivity 12 months → warnings → suspension, mail kept 90 days, the name never
  reissued.

**Cost model per paying account (rough, USD per year):** card fee about $0.56 on the Plus price; storage about $3 for a
typical account (a few GB, three copies, backups); about $5.40 left as margin. At that margin about **210 paying
accounts** cover the production topology's fixed costs (`09-roadmap.md` "Path to production"). With the pool fully used
(10 GB ≈ $10 of storage) a Plus account is about −$1.56; typical use (3–5 GB) is +$3.40 to +$5.40. Each +10 GB block at
$10 is roughly break-even after card fees (bundle it with the renewal to avoid a second fee), so heavy accounts pay for
their own storage and the worst case is bounded rather than absorbed.

## Stripe design

- **Products:**
  - `Plus`: one yearly Price with USD default plus CAD `currency_options`, `tax_behavior=exclusive`.
  - `Supporter`: a **separate product** (a Customer Portal rule). Its price is created at checkout with inline `price_data` (`recurring.interval=year`) from an amount the user picks on our page, validated server-side against the minimum (`custom_unit_amount` does not work for subscriptions).
- **Checkout** in subscription mode with `automatic_tax`, billing address collection and the customer's currency.
- **Customer Portal** for card updates, invoices and cancellation. Plan switching to Supporter is disabled in the portal; we handle it in our own flow.
- **Stripe Tax** is on from day one for calculation and records. Registration is tracked by us (Stripe does not warn about Canadian thresholds).
- **Smart Retries** (8 tries over 2 weeks), renewal reminder email 7 days before renewal (CASL transactional), receipts from Stripe.
- **Webhooks** (idempotent on `stripe_event_id`, processed by the worker): `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.upcoming`, `charge.refunded`, `charge.dispute.created`.
- **Refunds:** automatic within 14 days of first purchase or renewal via the console (Billing Administrator or Owner). Stripe fees are not returned, which is accepted.
- **Fees:** Stripe fees are absorbed, not surcharged. Add a USD bank account to avoid the 2% conversion on USD sales.
- Stripe secrets go in the key ring (rule 16) and are never logged.

## Account lifecycle

```
active ──invoice.payment_failed──► past_due (full service, banners, retries for 14 days)
past_due ──paid──► active
past_due ──retries exhausted──► receive_only (30 days: receive + read + export; no sending, no new aliases/domains)
receive_only ──paid──► active
receive_only ──30 days──► suspended (sign-in to export/pay only; inbound mail still accepted for 14 days, then rejected 4xx → 5xx)
suspended ──90 days──► closed (data deleted after notice; domains released)
any ──user cancels──► active until period end ──► downgrade to Free if eligible (custom domains detached, receive-only on them for 30 days) or closed
```

Abuse suspension is a separate path (`03-anti-spam-and-abuse.md`) and does not mix with billing states.

## Canadian tax

| Tax                            | Status                                                                                                                       | Action                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GST/HST                        | Small-supplier threshold CA$30k over four consecutive quarters                                                               | Not registered at launch. Track monthly. Register before crossing. Prices are already tax-exclusive. |
| **BC PST**                     | Email is listed as a taxable telecommunication service at 7%. Out-of-province/small-seller registration threshold is CA$10k. | **Urgent:** confirm with an accountant before paid launch. Track BC revenue separately from day one. |
| QST and other provinces        | Thresholds for out-of-province digital suppliers                                                                             | Track. Revisit at CA$30k total.                                                                      |
| Foreign (EU/UK VAT, US states) | EU/UK may require registration from the first sale for digital services (secondary sources)                                  | Decide before paid launch: geo-restrict, register via OSS, or use Stripe Managed Payments (+3.5%)    |

## Unit economics (fill in with real quotes)

| Line                                                | Per year      | Source / assumption                                |
| --------------------------------------------------- | ------------- | -------------------------------------------------- |
| VPS (primary)                                       |               | provider quote (private ops repo)                  |
| Additional IPs                                      |               |                                                    |
| Backup storage (object)                             |               | ~US$0.083/GB-yr list (B2), region TBD              |
| Domain, DNS, status page                            |               |                                                    |
| Stripe fixed + % per Plus sale                      | ~US$0.83–1.07 | `research/market-and-legal.md` §6.1                |
| Storage per paying user (typical 3–5 GB, 3× copies) | ~US$1         | assumption                                         |
| Storage per free user (typical)                     |               | assumption                                         |
| Support and abuse time                              |               | owner estimate                                     |
| **Break-even paying users**                         |               | = fixed costs / (net per user − variable per user) |

The public transparency page (Phase 2) publishes the filled-in version.

## Add-on: Newsletters and bulk sending (planned, `11-bulk-sending.md`, ADR-0015)

- Defined in `packages/shared/src/plans.ts` `ADDONS.bulk`: requires Plus or Supporter, monthly recipient tiers
  `monthlyRecipientTiers`, `price: null` while `status: "planned"` — the console, site and docs render "coming
  later" until a price is set there (rule 32: never hard-code it elsewhere).
- Billing: a separate Stripe Product with one annual Price per tier and currency (USD, CAD), added to the
  existing subscription as a second item; buying/cancelling needs `billing.manage`; activation also needs Trust &
  Safety approval, so the item starts in `pending_review` and is not charged until approved.
- Overage: none — sending stops at the tier limit for the month (no surprise bills); upgrade is prorated.
- Cost lines to price in (fill with quotes before launch):

| Line                                                                      | Per year | Note                                                 |
| ------------------------------------------------------------------------- | -------- | ---------------------------------------------------- |
| Bulk IP pool (≥ 2 dedicated IPv4 + IPv6 /64)                              |          | separate from personal mail; warm-up period unbilled |
| Feedback-loop and postmaster enrolment, blocklist monitoring for the pool |          | mostly time                                          |
| Trust & Safety review time per new sender                                 |          | first 3 campaigns reviewed                           |
| Bounce/complaint processing (worker capacity)                             |          | small                                                |
| Stripe fees on the add-on                                                 |          | same structure as plans                              |

- Pricing principle: the add-on must cover the bulk pool on its own; base-plan revenue never subsidises bulk.
