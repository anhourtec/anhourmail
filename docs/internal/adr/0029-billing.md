# ADR-0029: Billing — Stripe behind a port, state fetched not trusted, nothing deleted for non-payment

**Status:** Accepted 2026-11-04 (designed under the maintainer's standing decisions: annual only, no trial, Free is the
trial, 14-day refunds, tax-exclusive prices, extras never auto-charged, the public repo holds only code and public plan
facts; prices stay the maintainer's call, open item 3).

- Related: ADR-0002 (tenancy and plan limits in the control plane), ADR-0008 (ports and adapters), ADR-0010 (audit),
  ADR-0016 (key ring), ADR-0021 (free platform addresses), ADR-0023 (act-as is read-only), ADR-0025 (account
  deletion), ADR-0026 (delegation plan flag), ADR-0028 (password step-up); `../06-pricing-and-billing.md` (the product
  rules; this ADR replaces its "Account lifecycle" diagram), `packages/shared/src/plans.ts` (`PLANS`, `BILLING`,
  `accountPoolBytes`, `storageText`), `../04-data-model.md` "Billing", `../roles.md`, `../audit.md`,
  `../rate-limits.md`, `../research/market-and-legal.md` §6 (Stripe facts: `custom_unit_amount` can't recur,
  Portal rules, Tax).
- Roadmap: "Path to production" step 9, Phase 5; handoff "Next phases" 0h (address ceiling, Plus → Free alias
  behaviour) and open items 3, 6, 7.

## Context

Plans, prices, pools and limits already exist as facts (`plans.ts`) and the console enforces them from
`customer_account.plan`, which today only the seed or staff can change. Phase 5 has to let people pay: Plus, Supporter
(pay what you want above a minimum), storage blocks and extra mailboxes, refunds within 14 days, invoices and tax, and
a lifecycle for failed payments and cancellation. Constraints that shape the design:

1. **Open source.** The repository is public. It may hold the integration code and plan facts already on the pricing
   page; it may not hold Stripe keys, the webhook secret, product or price ids, or account settings (rule 44,
   maintainer 2026-10-29).
2. **Ports and adapters** (ADR-0008, rule 38): `packages/core` never imports a vendor SDK; ESLint already reserves
   `stripe` for `packages/adapters`.
3. **Provisioning is a job** (rule 26): anything that touches Stalwart (quotas, send/receive permissions, catch-all)
   is written as intent and applied by the worker.
4. **Mail is never deleted automatically** (reconciler rule, rule 26). The 2026-10-21 lifecycle in `06` ended in
   "closed (data deleted after notice)" on a timer; that conflicts and is replaced below.
5. **Webhooks are untrusted input arriving out of order**, retried for up to three days, sometimes duplicated.
6. Dev, unit tests, the RBAC harness and CI have no Stripe account and must never need one.

## Decision

### 1. One port, two adapters; no Stripe SDK

`packages/core/src/billing/ports.ts` defines `BillingProvider`. Two adapters:

- `packages/adapters/src/billing-stripe/` — **plain `fetch`** against `https://api.stripe.com/v1`. No `stripe` npm
  package. Reasons: we call about ten endpoints; the SDK's types are compile-time only, so untrusted responses and
  webhook bodies must be parsed with zod anyway; every SDK major moves the default API version, which we want pinned
  in one constant we control; webhook verification is ~20 lines and must also be shared with the fake (below). The SDK
  (MIT, no dependencies, would pass `check:licenses`) stays a drop-in alternative: switching is adapter-internal,
  reversal cost low. The ESLint restriction on `stripe` stays as a backstop.
  - Requests: `Authorization: Bearer <STRIPE_SECRET_KEY>`, `Stripe-Version: <STRIPE_API_VERSION>` (a constant in the
    adapter, set to the version current when slice 3 is built; the webhook endpoint in the dashboard is created with
    the same version so payloads match), `application/x-www-form-urlencoded` with a small nested encoder
    (`items[0][price]=…`, `metadata[account_id]=…`) unit-tested against Stripe's documented examples.
  - Every `POST` carries an `Idempotency-Key` derived from our intent (`sha256(accountId:action:intentId)`), so a
    retried request never double-charges. Timeout 10 s (`AbortSignal.timeout`); retry twice with jittered backoff on
    network errors, `429` and `5xx` only. Responses are zod-parsed to the fields we read; anything else is ignored.
  - Errors map to `BillingProviderError` with `code`: `unavailable` | `rate_limited` | `card_declined` |
    `invalid_request` | `not_found` | `catalogue_drift`. Stripe's `message` is logged only for `invalid_request`
    (never request bodies; the logger's redaction list gains `stripe-signature`, `client_secret`, `idempotency-key`).
- `packages/adapters/src/billing-fake/` — the same port with state in a `FakeBillingStore`: in memory for unit tests,
  in Redis (`am:billing-fake:*`, dev only) so the web app and the worker see the same fake "Stripe". It has its own
  clock offset (the test-clock analogue), emits events **signed with the real Stripe signature scheme** using a dev
  secret, and posts them to our real webhook route. Never constructible in production (§3).

```ts
// packages/core/src/billing/ports.ts (shape; names are binding, field lists may grow)
export type PaidPlanId = "plus" | "supporter";
export type ProviderSubStatus =
  "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "paused" | "trialing";

export type ProviderSubscription = {
  subscriptionId: string;
  customerId: string;
  status: ProviderSubStatus;
  plan: PaidPlanId; // mapped from the item's Price/Product; unknown item → catalogue_drift
  currency: Currency;
  planAmountMinor: number; // Plus price or the Supporter amount, per year, tax-exclusive
  storageBlocks: number; // quantity on the storage-block item (0 if none)
  extraMailboxes: number; // quantity on the extra-mailbox item (0 if none)
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAt: Date | null; // set when cancelling at period end
  latestInvoice: {
    id: string;
    status: "paid" | "open" | "uncollectible" | "void";
    amountMinor: number;
    paidAt: Date | null;
    billingReason: "subscription_create" | "subscription_cycle" | "other";
    refundedMinor: number;
  } | null;
  disputed: boolean; // an open dispute on the latest invoice's charge
};

export type CheckoutInput = {
  accountId: string;
  customerId: string;
  currency: Currency;
  plan: PaidPlanId;
  supporterAmountMinor?: number; // Supporter only; validated by the service
  storageBlocks: number;
  extraMailboxes: number;
  successUrl: string;
  cancelUrl: string;
  intentId: string; // intentId feeds the idempotency key
};

export type SubscriptionChange = {
  subscriptionId: string;
  intentId: string;
  plan?: PaidPlanId;
  supporterAmountMinor?: number;
  storageBlocks?: number;
  extraMailboxes?: number;
  proration: "charge_now" | "none";
};

export type ProviderEvent = {
  id: string;
  type: string;
  createdAt: Date;
  livemode: boolean;
  customerId: string | null;
  objectId: string;
  accountIdHint: string | null; // metadata.account_id, cross-check only
};

export interface BillingProvider {
  readonly kind: "stripe" | "fake";
  ensureCustomer(i: { accountId: string; email: string; name: string }): Promise<{ customerId: string }>;
  createCheckout(i: CheckoutInput): Promise<{ url: string }>;
  createPortalSession(i: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  getSubscription(customerId: string): Promise<ProviderSubscription | null>; // the one live, non-terminal one
  previewChange(c: SubscriptionChange): Promise<{ amountDueNowMinor: number; currency: Currency }>;
  changeSubscription(c: SubscriptionChange): Promise<ProviderSubscription>;
  cancel(i: { subscriptionId: string; when: "period_end" | "now"; intentId: string }): Promise<void>;
  undoCancel(i: { subscriptionId: string; intentId: string }): Promise<void>;
  refundInvoice(i: { invoiceId: string; intentId: string }): Promise<{ amountMinor: number; currency: Currency }>;
  verifyWebhook(rawBody: string, signatureHeader: string | null, now: Date): ProviderEvent; // throws WebhookRejected
  checkCatalogue(): Promise<readonly CatalogueDrift[]>; // Stripe Prices vs plans.ts; empty = in sync
}
```

The contract suite `packages/adapters/src/contract/billing-provider.contract.ts` runs against the fake in every unit
run and against Stripe test mode only in the manual live suite (§10).

### 2. Stripe objects (created in the dashboard by the maintainer; ids only in env)

- **Plus:** one Product, one yearly Price, USD default with CAD `currency_options`, `tax_behavior=exclusive`, amounts
  equal to `PLANS.plus.price`.
- **Supporter:** a separate Product (Portal rule) with **no fixed Price**: Checkout and subscription updates use inline
  `price_data { product, currency, unit_amount, recurring: { interval: "year" }, tax_behavior: "exclusive" }`
  (`custom_unit_amount` can't recur; research §6). The amount is chosen on our page in whole currency units and
  validated server-side: `PLANS.supporter.price[currency] ≤ amount ≤ BILLING.supporterMaximum[currency]` (a new
  public fact; placeholder 100 × the minimum, to stop typos).
- **Storage block** and **extra mailbox:** one Product each, one yearly Price each (USD + CAD options, exclusive),
  amounts equal to `storageBlockPrice` / `extraMailboxPrice`; sold as **quantities** on the same subscription.
  Upper bounds are public facts added to `plans.ts`: `MAX_STORAGE_BLOCKS` and `MAX_EXTRA_MAILBOXES` (placeholders 10
  and 40, to confirm).
- **Catalogue check** (`checkCatalogue`): at worker start and daily, the adapter fetches each configured Price and
  compares amount per currency, interval `year`, `tax_behavior`, and product `active` against `plans.ts`. Drift writes
  `billing.catalogue_drift` (platform scope), shows a banner on Platform billing, and **refuses new checkouts and
  plan/add-on changes** (`503 billing_unavailable`) until fixed; existing subscriptions keep syncing. `plans.ts` stays
  the one source of the numbers (rule 32); Stripe must match it, never the reverse.
- **Price changes:** the maintainer edits `plans.ts` and creates new Stripe Prices; each `STRIPE_PRICE_*` variable is a
  comma-separated list, **first = current** (used for new checkouts and the drift check), the rest = legacy prices still
  accepted when mapping existing subscriptions. Moving existing subscribers is a deliberate, separate operation.
- **Checkout:** `mode=subscription`, `customer` (always ours, created first, `metadata.account_id`),
  `client_reference_id=<accountId>`, `subscription_data.metadata.account_id`, `currency`, `automatic_tax.enabled=true`,
  `billing_address_collection=required`, `customer_update[address]=auto`, `tax_id_collection.enabled=true`,
  `expires_at` = now + 1 h, success URL `https://<app host>/accounts/<id>/billing?checkout=done`, cancel URL
  `…/billing?checkout=cancelled`. No trial (`BILLING.trialDays` 0). No promotion codes in v1.
- **Customer Portal** (one configuration, id optional in env): payment method, billing address and tax ids, invoice
  history and PDFs, cancel **at period end**. Subscription update and plan switching **off** (we own them, because
  Supporter prices are inline and add-ons have ceilings).
- **Tax:** Stripe Tax on from day one; registrations (GST/HST, BC PST, others) are dashboard settings decided with the
  accountant (Phase 5 exit) — no code depends on which are active.
- **Dashboard settings the code relies on** (recorded in the private ops runbook, not here): Smart Retries; "if all
  retries fail → **mark the subscription unpaid**" (not cancel — §5 needs `unpaid`); Stripe sends receipts,
  failed-payment and upcoming-renewal emails (CASL-transactional; we don't build our own reminder); Radar default
  rules; webhook endpoint with the events in §4 at the pinned API version.
- **We never load Stripe.js** and never embed Stripe in our pages: the console fetches a URL from our API and navigates
  with `window.location.assign` (a top-level navigation, so no third-party request from our pages, rule 29; and no
  `form-action` CSP change, since a form POST that redirects off-site would be blocked). The server accepts the
  provider's URL only if its origin is `https://checkout.stripe.com` or `https://billing.stripe.com` (fake: our own
  `/dev/billing/…` path) — no open redirect.
- **Egress:** the web and worker containers need HTTPS egress to `api.stripe.com` in production (ops repo). Stalwart's
  network is untouched.

### 3. Configuration (env only; nothing in the repo)

| Variable                      | Meaning                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`            | `off` (default when unset in production) · `fake` (default in dev/test) · `stripe`                                                                                     |
| `STRIPE_SECRET_KEY`           | A **restricted key** (`rk_…`) with only: Customers, Checkout Sessions, Customer Portal, Subscriptions, Invoices (read), Prices/Products (read), Refunds, Events (read) |
| `STRIPE_WEBHOOK_SECRET`       | `whsec_…`; comma-separated during rotation (any one may verify)                                                                                                        |
| `STRIPE_PRICE_PLUS`           | Price id list (first = current)                                                                                                                                        |
| `STRIPE_PRICE_STORAGE_BLOCK`  | Price id list                                                                                                                                                          |
| `STRIPE_PRICE_EXTRA_MAILBOX`  | Price id list                                                                                                                                                          |
| `STRIPE_PRODUCT_SUPPORTER`    | Product id for inline Supporter prices                                                                                                                                 |
| `STRIPE_PORTAL_CONFIGURATION` | Optional Portal configuration id                                                                                                                                       |
| `ACCOUNT_ADDRESS_CEILING`     | §7; abuse ceiling, not published (rule 33); default 5000 in dev                                                                                                        |

- `apps/web/src/server/env.ts` and the worker's env validate them with zod: `BILLING_PROVIDER=stripe` requires every
  `STRIPE_*` except the Portal id; `STRIPE_SECRET_KEY` must start `sk_`/`rk_`; the key's mode (`_live_`/`_test_`)
  must agree with `NODE_ENV=production` unless `BILLING_ALLOW_TEST_KEYS=true` (pre-staging uses test keys).
  `BILLING_PROVIDER=fake` with `NODE_ENV=production` **fails boot**.
- `.env.example` lists the names with empty values and `BILLING_PROVIDER=fake`. Real values live in `.env` (local) or
  the ops repo's secret store. Never in `credentials.md`, logs, audit or the database.
- Rule 16: these secrets are env-only in v1, so nothing is stored. If a staff screen to set them is ever built, values
  go in `integration_secret` through the key ring (AES-256-GCM, AAD `integration_secret:value_enc:<id>`), write-only,
  `platform.secret_changed` audited without the value. Not part of this ADR's slices.
- `BILLING_PROVIDER=off`: the Billing page shows the current plan and "Paid plans open soon"; billing mutations answer
  `503 billing_unavailable`; the webhook route answers 404; `storageText()` keeps its "(coming with billing)" suffix.
  A new public fact `BILLING.status: "planned" | "open"` drives that copy on the site and docs (rule 32); it flips to
  `open` in the launch change, not by env.

**Dev without Stripe.** `BILLING_PROVIDER=fake`: Checkout returns `/dev/billing/checkout/<fakeSessionId>` and the Portal
`/dev/billing/portal/<fakeCustomerId>` — plain pages in `apps/web` with buttons (Pay, Decline card, Exhaust retries,
Cancel at period end, Refund, Open dispute, Advance clock N days). Each calls `POST /api/dev/billing/simulate`, which
mutates the fake store and emits signed events to `POST /api/billing/webhook`, so dev exercises signature checks,
ingestion, the worker sync and Stalwart jobs end to end. **Unreachable in production, three layers:** (1) the
container refuses to build the fake when `NODE_ENV=production` (boot fails); (2) the `/dev/billing/*` pages and
`/api/dev/*` routes check `env.BILLING_PROVIDER === "fake" && NODE_ENV !== "production"` per request and answer 404
otherwise (`notFound()`); (3) `proxy.ts` answers 404 for `/dev/` and `/api/dev/` on production builds before routing
(and the ops NGINX path guard blocks them as a backstop). A unit test covers each layer.

### 4. Webhooks: verify, record, trigger; the worker fetches the truth

Route `POST /api/billing/webhook` on the app host (`apps/web`), outside the session guard, tier `webhook` (120 / 60 s per
IP, fail open — the signature is the real gate). Steps:

1. Read the **raw** body with `await request.text()`, capped at 512 KiB (`413` beyond). Never parse before verifying.
2. `provider.verifyWebhook(raw, header, clock.now())` — shared `verifyStripeSignature` in
   `packages/adapters/src/billing-stripe/signature.ts`, used by both adapters:
   - parse `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]` (ignore `v0` and unknown keys; missing `t` or `v1` → reject);
   - reject if `|now − t| > 300 s`;
   - for each configured secret and each `v1`: `expected = HMAC-SHA256(secret, `${t}.${raw}`)` hex; compare with
     `crypto.timingSafeEqual` on equal-length buffers (length mismatch = no match, no early string compare);
   - any match passes; then zod-parse the minimal event shape; reject if `livemode` disagrees with the key's mode.
   - Rejection → `400 { error: { code: "bad_signature" } }`, a `warn` log with the request id and reason only (no
     body, no header value). Not audited (unauthenticated noise would flood the chain); counted for Phase 6 metrics.
3. Ignore types outside the handled set (`200`, nothing stored). Handled: `checkout.session.completed`,
   `customer.subscription.created|updated|deleted|paused|resumed`, `invoice.paid`, `invoice.payment_failed`,
   `invoice.payment_action_required`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`,
   `customer.deleted`.
4. In **one transaction** (`packages/core/src/billing/ingest.ts`, not a service; see Audit): resolve the account by
   `account_billing.provider_customer_id` (the metadata hint must agree or the event is `orphan`), `INSERT …
billing_event ON CONFLICT (provider_event_id) DO NOTHING`, and if inserted and the account is known, enqueue
   `billing.sync` for it (coalesced: no second queued job for the same account). Unknown customer → stored as
   `orphan` (no job), shown on Platform billing.
5. Answer `200 { data: { received: true } }` within milliseconds. A database failure answers `500` so Stripe retries
   (it does so for up to three days). Duplicates answer `200` and do nothing.

**Ordering is not a problem because events are triggers, not data.** `billing.sync` (a new job kind on the existing
`provisioning_job` queue and its claim/lock-token machinery, subject = account id) calls
`provider.getSubscription(customerId)` and reconciles our state to it. Stale or reordered events just cause a
redundant sync. Event-specific facts that the subscription doesn't carry (a dispute opening or closing, a refund made
in the dashboard) are read from the pending `billing_event` rows for that account, processed oldest `createdAt` first,
each marked `processed_at` in the same transaction as its effect. The sync:

- fetches outside any lock; then takes the account row lock (`SELECT … FOR UPDATE` on `customer_account`, the same
  lock mailbox and alias services use), computes the new `account_billing` row with the pure function
  `deriveBilling(previous, providerSubscription, pendingEvents, now)` in `packages/core/src/billing/lifecycle.ts`,
  writes it and `customer_account.plan` (the effective plan the rest of the code already reads), applies or lifts
  plan holds (§6), writes the audit entries for every change, and enqueues the Stalwart work (`mailbox.ensure` for
  each mailbox whose access changes, `domain.ensure` for catch-all, `job:quota-cap` for the account) — all in one
  transaction;
- on `BillingProviderError.unavailable`/`rate_limited`: the job retries with the queue's backoff and **nothing
  changes** (our outage never restricts a customer); on `catalogue_drift` or two live subscriptions for one customer:
  the job fails with that error, `billing.sync_failed` is audited in platform scope, staff see it; state unchanged.

A scheduler job `billing.reconcile` (worker, rule 17) runs nightly over every account with a provider customer and
enqueues a sync for any whose `last_synced_at` is over 24 h old, so a lost webhook heals within a day. `billing.timers`
(hourly) runs our own deadlines (§5). Processed `billing_event` rows are pruned after 35 days (beyond Stripe's retry
window); orphans are kept until staff dismiss them.

### 5. Account billing states

Billing state is **separate from** `customer_account.status` (staff suspension, ADR-0023-era) and from abuse/trust
(Phase 6). A sync never lifts a staff suspension; a mailbox's effective access is the most restrictive of all sources.

| State        | Entered when                                                                                                                  | Sending        | Receiving                                          | Read / export / sign-in | New domains, mailboxes, aliases, people, add-ons | Plan limits  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------- | ----------------------- | ------------------------------------------------ | ------------ |
| `free`       | Never paid, or no live subscription and no holds                                                                              | yes            | yes                                                | yes                     | within Free                                      | Free         |
| `active`     | Stripe `active` (or `trialing`, never configured), or a comp/staff grant (§8)                                                 | yes            | yes                                                | yes                     | within the plan + add-ons                        | paid         |
| `past_due`   | Stripe `past_due` (Smart Retries running)                                                                                     | yes            | yes                                                | yes                     | yes                                              | paid         |
| `restricted` | Stripe `unpaid` or `paused`; or an open dispute (any Stripe status)                                                           | **no**         | yes                                                | yes                     | **no** (settings and deletions still allowed)    | paid         |
| `lapsed`     | No live subscription after having one (cancelled at period end, refunded, `restricted` timed out, comp ended) and holds exist | Free part only | Free part; held part for `BILLING.heldReceiveDays` | yes, everything         | within Free                                      | Free + holds |

`incomplete` / `incomplete_expired` subscriptions (3-D Secure abandoned) grant nothing and change nothing.

Transitions (each audited `billing.state_changed` with `from`, `to`, `reason`):

```
free ──checkout paid──► active
active ──invoice.payment_failed──► past_due ──paid──► active
past_due ──retries exhausted (Stripe marks unpaid)──► restricted ──open invoice paid──► active
restricted ──BILLING.restrictedDays (30) without payment: billing.timers cancels the subscription now──► lapsed
active|past_due ──dispute opened──► restricted ──dispute won or staff clears──► (Stripe-derived state)
active ──cancel at period end──► active (cancelAt set; "Undo" until then) ──period end──► lapsed
active ──self-service refund (§9)──► lapsed (subscription cancelled now)
active(comp) ──comp_until passes──► lapsed
lapsed ──holds all resolved by the owner (deleted or within Free)──► free
lapsed|free ──checkout paid──► active (all holds lifted, everything restored)
```

- `past_due` and `restricted` keep the paid plan's limits so nothing is held while someone fixes a card.
- **Restricted sending** is enforced twice (rule 27): the webmail send and every control-plane send path refuse with
  `403 billing_restricted`, and `mailbox.ensure` gives every mailbox in the account Stalwart permissions
  `Merge { disabledPermissions: CUSTOMER_DENIALS ∪ { emailSend } }` (new `SEND_BLOCKED_PERMISSIONS` beside
  `SUSPENDED_PERMISSIONS` in `packages/stalwart-client/src/management.ts`; the client's `suspended?: boolean` input
  becomes `access?: "active" | "send_blocked" | "receive_blocked" | "suspended"`). `emailSend` denial is known to stop
  SMTP AUTH submission (research `stalwart.md`, app passwords); slice 6 must verify on v0.16.27 that it also stops JMAP
  `EmailSubmission` and 465/587 for the account while IMAP and JMAP reads keep working, before relying on it.
- **Nothing in this table deletes mail, mailboxes, aliases or domains.** The old "suspended → closed after 90 days,
  data deleted" step is withdrawn. A lapsed account with holds stays as it is until its Owner resolves the holds,
  resubscribes, or deletes the account (ADR-0025). Storage cost of abandoned lapsed accounts is bounded by the pinned
  quotas (§6); if it ever needs a cleanup, that is a separate staff-reviewed process with notice, its own ADR, never a
  timer. The free-account inactivity policy (`ACCOUNT_POLICY`, Phase 6) is unaffected.
- New public facts in `BILLING`: `restrictedDays: 30`, `heldReceiveDays: 30` (the docs render them; they are customer
  policy, not abuse thresholds).

### 6. Downgrade to Free: holds, not deletion (handoff 0h)

When an account becomes `lapsed`, the sync computes **plan holds** with the pure function
`computeHolds(account, resources)`; each hold is a `plan_hold` row (§11). Default choice (deterministic, then the Owner
can swap on the Billing page, "Choose what stays on", audited `billing.holds_changed`, as long as the result fits Free):

- **Mailboxes:** Free keeps one platform-domain mailbox (`platformMailboxes` 1, no custom domains). Kept: the Owner's
  own platform-domain mailbox, else the oldest platform-domain mailbox in the account. Every other mailbox (custom
  domains, other people's, shared) is held: sending off at once; receiving on for `heldReceiveDays`, then off
  (`receive_blocked` = `SEND_BLOCKED_PERMISSIONS ∪ { emailReceive }`, mail at RCPT refused; slice 6 verifies the
  SMTP reply); sign-in, webmail reading, IMAP/POP reading and export stay on for good. A held mailbox's quota is
  pinned to its usage rounded up (`minQuotaBytes`) and it **leaves the pool arithmetic** while held, so the kept
  mailbox gets Free's pool on its own; `job:quota-cap` rebalances the rest (never below usage, `keptAbovePool`).
  If no platform mailbox exists the Owner can claim one (ADR-0021) and keep it.
- **Custom domains:** held, not detached. They stay on the mail server (DKIM keys kept, verified state kept, the
  pending-domain removal rules don't apply), catch-all is turned off (`domain.ensure`), no new mailboxes or aliases on
  them. The Owner may remove a domain themselves.
- **Aliases and masked aliases:** those on held mailboxes or domains are held with them. On the kept mailbox, the 10
  oldest enabled of each kind stay (Free's at-a-time limits `aliases`/`maskedAliases`); the rest are held — not
  synced to Stalwart (like disabled aliases), so mail to them is refused, nothing deleted. Swapping which ten are on is
  not a creation. **Creations made while paid count against Free's yearly cap** with no special code:
  `alias_creation_day` already counts every creation regardless of plan, so a freshly downgraded account usually has
  no yearly slots until its rolling window frees them. No reset on downgrade or upgrade.
- **People and invites:** members stay members (their mailboxes are held; they can still sign in, read and export).
  Pending invites are revoked (Free can't add people; `account.invite_revoked` with reason `plan_lapsed`).
- **Delegation:** grants are kept and inert (the existing `Plan.delegation` gate refuses opens); restored on upgrade.
- **Supporter badge** off. **App passwords** kept (reading over IMAP is how many people export).
- **Upgrade** (any checkout or comp while lapsed) deletes every `plan_hold` row for the account in the sync's
  transaction and enqueues `mailbox.ensure`/`domain.ensure`/`job:quota-cap`; `billing.holds_lifted` audits counts.

The Billing page shows held items with what each still does ("Receiving until <date>", "Read and export only").
`lapsed` becomes `free` when no holds remain.

### 7. Ceilings: extra mailboxes and the account-wide address ceiling

- **Mailboxes:** `mailboxCeiling(plan, extraMailboxes) = PLANS[plan].includedMailboxes + (paid ? extraMailboxes : 0)`
  replaces the constant `MAX_MAILBOXES` in the mailbox services (`MAX_MAILBOXES` stays as the included count). The
  people ceiling follows it: `peopleCeiling = max(MAX_PEOPLE, mailboxCeiling)`.
- **Storage:** `accountPoolBytes(plan, storageBlocks)` already takes blocks; the services pass the entitled value.
- **Entitlement vs renewal quantity.** An increase is charged now, prorated (`proration: "charge_now"`; the page shows
  `previewChange` first and the person confirms the amount — "never auto-charged"). A decrease costs nothing now and
  renews lower (`proration: "none"`); the capacity paid for stays until period end:
  `entitled = max(currentQuantity, periodPaidQuantity)`, where `periodPaid*` is set from the quantities on the last
  paid `subscription_create`/`subscription_cycle` invoice. A decrease is refused while it would leave the account
  over the new figure at renewal (`409 addon_in_use`: "Delete a mailbox first" / "Lower mailbox storage first"), so a
  renewal never strands anything; lapse is the only path that can (§6).
- **Address ceiling** (handoff 0h): mailboxes + aliases + masked aliases per account ≤ `ACCOUNT_ADDRESS_CEILING`
  (env, from config; production value in the ops repo; not published, rule 33). Checked in mailbox and alias creation
  under the account row lock, **fails closed** (`409 address_ceiling`, audited `denied`). The per-mailbox
  `ALIASES_PER_MAILBOX` and the daily caps stay. Public docs say only that very large accounts have a ceiling and
  support can raise it; a per-account override column (`account_billing.address_ceiling_override`, staff only,
  audited `billing.ceiling_changed`) is how.

### 8. Invite codes (Phase 2 leftover)

Staff-created codes for beta waves and comped accounts. **What a code grants** (one or both, fixed at creation):

- `signup`: create a personal Free account at `/sign-up?code=…` while `SIGNUP_MODE=closed` (with `open` it is
  accepted but adds nothing). Same email confirmation and proof-of-work as normal sign-up.
- `comp`: `comp_plan` (`plus` or `supporter`) for `comp_days` (1–365), no card. Redeemable at sign-up or later from
  Billing → "Redeem a code" by someone with `billing.manage` on an account in `free` or `lapsed`. The account becomes
  `active` with `plan_source = comp`, `comp_until`; at the end it lapses (§5) unless the Owner subscribed meanwhile
  (a subscription replaces the comp at once; the remaining comp days are not credited).

Rules: 128-bit random, shown **once** as `XXXX-XXXX-…` base32 (Crockford), stored as `sha256` only; single-use (the
redemption claims the row with `UPDATE … WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
RETURNING`); `expires_at` required, ≤ 90 days; optionally bound to one email (redeemer's verified console email must
match, citext); revocable while unused. A wrong, used, expired or revoked code gets the same `404 invite_code_invalid`
(no oracle). Creating `signup`-only codes needs `platform.invites.manage` (Global, Support); any code with `comp` needs
`platform.billing.manage` (Global, Billing). No codes issued by customers in v1. No matrix change.

### 9. Console flows and API (all under `apps/web`, services in `packages/core/src/billing/service.ts`)

Services take the actor and check permission and scope themselves (out-of-scope account → 404, missing permission →
403). Every mutation that calls the provider is ordered **provider call first, then our transaction**; our state
changes come from the sync, so a crash between the two heals on the next sync. `billing.manage` is critical: refunds
and cancellation require the password step-up (ADR-0028); act-as sessions are read-only (ADR-0023), so staff in act-as
see the Billing page and nothing else. Checkout also requires the actor's console email to be verified.

| Route                                                     | Permission                            | Tier                 | Does                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/accounts/:id/billing`                           | `billing.read`                        | `read`               | Our row only (no provider call): plan, state, currency, amount, renewal, cancelAt, entitlements, usage vs ceilings, holds, refund eligibility                                   |
| `POST /api/accounts/:id/billing/checkout`                 | `billing.manage`                      | `billingProvider`    | `{ plan, currency, supporterAmountMinor?, storageBlocks, extraMailboxes }` → `{ url }`; refused unless `free`/`lapsed`, `409 checkout_pending` within an hour of a previous one |
| `POST /api/accounts/:id/billing/portal`                   | `billing.manage`                      | `billingProvider`    | `{ url }`                                                                                                                                                                       |
| `POST /api/accounts/:id/billing/preview`                  | `billing.manage`                      | `billingProvider`    | Amount due now for a proposed add-on/plan change                                                                                                                                |
| `POST /api/accounts/:id/billing/change`                   | `billing.manage`                      | `billingProvider`    | Add-on quantities; Plus ↔ Supporter (features switch now, price at renewal, `proration: "none"`); Supporter amount (at renewal)                                                 |
| `POST /api/accounts/:id/billing/cancel` / `…/undo-cancel` | `billing.manage` ★                    | `sensitive`          | Cancel at period end / undo; step-up                                                                                                                                            |
| `POST /api/accounts/:id/billing/refund`                   | `billing.manage` ★                    | `sensitive`          | §9 refund; step-up                                                                                                                                                              |
| `PUT /api/accounts/:id/billing/holds`                     | `billing.manage`                      | `write`              | Swap which mailbox/aliases stay on (must fit Free)                                                                                                                              |
| `POST /api/accounts/:id/billing/redeem`                   | `billing.manage`                      | `inviteCodeRedeem`   | Redeem a comp code                                                                                                                                                              |
| `POST /api/billing/webhook`                               | signature                             | `webhook`            | §4                                                                                                                                                                              |
| `GET/POST /api/platform/billing/…`                        | `platform.billing.manage` (codes: §8) | `read` / `sensitive` | Lists, re-sync, staff grant/revoke, refund outside the window, clear a dispute, codes create/revoke, orphans                                                                    |
| `POST /api/dev/billing/simulate`                          | dev only (§3)                         | `write`              | Fake provider actions                                                                                                                                                           |

New rate-limit tiers (added to `packages/server/src/rate-limit.ts` and `rate-limits.md` in slice 4):
`billingProvider` 30 / 10 min per user, **fail closed** (each call costs a Stripe API request and Checkout creation is a
card-testing surface); `inviteCodeRedeem` 10 / hour per IP **and** per user, **fail closed** (guessing surface; the
sign-up path uses the IP bucket).

**Self-service refund** (`BILLING.refundWindowDays` 14): allowed when the latest invoice is paid, its
`billingReason` is `subscription_create` or `subscription_cycle`, it was paid ≤ 14 days ago and nothing is refunded
yet. Effect: `refundInvoice` (full amount; Stripe reverses the tax), then `cancel { when: "now" }` → sync → `lapsed`.
Add-on proration invoices and anything outside the window are refunded only by staff (`platform.billing.manage`),
which writes the same `billing.refunded` with `staff: true` in the account's scope (rule 49).

**Account deletion** (ADR-0025): requesting deletion cancels the subscription at period end; when removal starts,
the worker cancels it now (no refund unless the Owner took one) and deletes the `account_billing` row with the account.
The Stripe customer and its invoices remain at Stripe (tax records). The data export gains a `billing.json` (plan,
state, dates, entitlements; no provider secrets).

**Pages** (each with `loading.tsx`, rule 11):

- `accounts/[accountId]/billing` (nav item exists, phase 5): plan card (name, state badge, renewal date and amount
  `formatPrice`, currency, "Cancels on …" with Undo), usage against ceilings (mailboxes, storage assigned vs pool,
  addresses), Change plan (Free → Plus/Supporter with currency toggle, Supporter amount field showing the minimum),
  add-on steppers with preview-then-confirm, "Manage payment and invoices" (Portal), Refund (only when eligible),
  Redeem a code, held items after a lapse. Banners on every console page for `past_due`/`restricted` to
  `billing.read` roles; `restricted` also tells every member that sending is paused and who can fix it.
- `platform/billing` (nav item exists): accounts by state (`past_due`, `restricted`, `lapsed`, disputed), orphan
  events, sync failures and catalogue drift, invite codes (create — shown once —, list, revoke). The platform account
  page gains a Billing panel (state, provider customer id in mono, last sync, actions).

### 10. Testing

- **Unit (core, ≥ 90 %):** `deriveBilling` table-driven over every row of §5 and each Stripe status; `computeHolds`
  (owner's mailbox kept, no platform mailbox, alias oldest-ten, masked separately, shared mailboxes, swaps that
  break Free refused); entitlement max-rule and decrease refusals; refund eligibility edges (day 14 vs 15, renewal vs
  proration invoice, already refunded); Supporter min/max and currency; invite code claim races (two redeemers, one
  wins), expiry, bound email, revoked; permission denial (403) and cross-account (404) for every service method;
  act-as refusal; audit entries in the same unit of work for success and denied.
- **Signature fixtures (adapters):** fixtures generated with the real algorithm (HMAC-SHA256 over `t.body`) at fixed
  timestamps — valid; tampered body; wrong secret; second secret during rotation; `t` outside ±300 s; several `v1`;
  missing parts; length-mismatched hex; livemode mismatch. Plus Stripe's own published example vector, so our
  verifier matches theirs, not only itself.
- **Contract suite** for `BillingProvider`: fake always; Stripe test mode only in the live suite. Repository contract
  tests (memory + Postgres) for `BillingRepository` and `InviteCodeRepository`, including the scoping rule.
- **Integration (compose stack, CI-safe):** webhook route → `billing_event` → `billing.sync` → `mailbox.ensure` on the
  real Stalwart: a `restricted` account's mailbox is refused on 587 and JMAP submission, still reads over IMAP; a held
  mailbox past its window refuses inbound; upgrade restores both. Duplicate event ids processed once; reordered events
  end in the same state; Stripe-down retries change nothing.
- **RBAC harness:** every new route × every role (Owner, Billing Admin manage; Auditor read; Domain/User Admin and
  Member 403; staff per permission; act-as read-only); 429 per tier.
- **E2E (local, fake provider):** Free → Plus checkout through the dev checkout page; add a storage block (preview,
  confirm, pool grows on Mailboxes); payment failure → past_due banner → exhaust retries → restricted (send refused
  in the webmail) → pay → active; cancel → advance clock → lapsed with holds → choose what stays on → resubscribe
  restores; refund within the window; redeem a comp code at sign-up with `SIGNUP_MODE=closed`. Light/dark, 1440/390.
- **Stripe test clocks (Phase 5 exit) — local and manual only.** `npm run test:billing-live` runs
  `tests/billing-live/*.live.test.ts` and **skips** unless `STRIPE_SECRET_KEY` (test mode, `sk_test_`/`rk_test_`; a
  live key aborts the run) and the price variables are set in `.env`. It needs no webhook forwarding: for each
  transition it creates a Test Clock and a customer on it, subscribes with Stripe's test payment methods (success,
  decline after attach, 3-D Secure required), advances the clock (renewal, retries, Smart Retries exhaustion → `unpaid`,
  period end after cancel), waits for the clock to be `ready`, runs `billing.sync` for the account directly, and
  asserts our state, holds and audit entries; then deletes the clock. Every arrow in §5 has a case. Optionally the
  maintainer runs it with `stripe listen --forward-to localhost:43200/api/billing/webhook` to see real deliveries
  verified. The run's date, key mode and results go in the handoff; CI never has the secret and never runs the job.
  **CI-safe equivalent:** the fake provider with its clock offset drives the same transition table through the same
  `billing.sync` path in unit, integration and e2e tests.

### 11. Data model (Postgres; `04-data-model.md` "Billing" replaced)

The never-built `subscription` table and the unused `customer_account.status` values `past_due`/`receive_only`/`closed`
in `04-data-model.md` are removed from the doc; `customer_account.status` stays staff suspension only.

- `account_billing` — one row per account. `account_id` (pk, → `customer_account`, cascade), `state`
  (`free`/`active`/`past_due`/`restricted`/`lapsed`), `state_since`, `plan_source` (`none`/`stripe`/`comp`/`staff`),
  `paid_plan` (`plus`/`supporter`, null on Free), `provider_customer_id` (unique, null), `provider_subscription_id`
  (unique, null), `currency` (null until first checkout, then fixed — Stripe locks a customer's currency),
  `plan_amount_minor`, `storage_blocks`, `extra_mailboxes`, `period_paid_storage_blocks`,
  `period_paid_extra_mailboxes`, `current_period_end`, `cancel_at`, `restricted_at`, `disputed_at`, `lapsed_at`,
  `comp_until`, `last_invoice_id`, `last_invoice_status`, `checkout_pending_until`, `address_ceiling_override`,
  `last_synced_at`, `updated_at`. Column names say `provider_`, not `stripe_` (ADR-0008). No card data, no
  addresses, no tax ids (Stripe holds them).
- `billing_event` — `id`, `provider_event_id` (unique), `type`, `account_id` (null for orphans; → `customer_account`,
  cascade), `object_id`, `provider_created_at`, `status` (`queued`/`processed`/`orphan`/`dismissed`), `error` (an
  error name), `received_at`, `processed_at`. **No payload** (it carries names, emails and addresses).
- `plan_hold` — `id`, `account_id` (cascade), `subject_type` (`mailbox`/`domain`/`alias`), `subject_id`,
  `held_at`, `receive_until` (mailboxes), unique (`subject_type`, `subject_id`). Read by the mailbox, domain and alias
  services and by `mailbox.ensure`/`domain.ensure` when deriving desired state.
- `invite_code` — `id`, `code_hash` (unique), `label` (staff note ≤ 200), `grants_signup`, `comp_plan`, `comp_days`,
  `email` (citext, null), `created_by`, `created_at`, `expires_at`, `redeemed_at`, `redeemed_by` (→ `auth_user`, set
  null), `redeemed_account_id` (set null), `revoked_at`, `revoked_by`. Platform-owned (not account-scoped);
  redemption is the only customer path and reads by hash.
- Job kind `billing.sync` added to `JobKind`; scheduler jobs `billing.reconcile`, `billing.timers`,
  `billing.catalogue`, `billing.events-prune`.

Migrations (numbers are the next free ones when built; other work may land first). All additive; nothing dropped, so
no three-step change is needed:

| Name                       | What                                                                                                                                                                                                                                   | Rollback |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `account_billing`          | Create `account_billing`, `billing_event`                                                                                                                                                                                              | Safe     |
| `account_billing_backfill` | One row per existing account: `free`/`none`; accounts already on `plus`/`supporter` (seeded or set by staff) → `active`/`staff`, no end. Idempotent (`ON CONFLICT DO NOTHING`); new accounts get their row in the create's transaction | Safe     |
| `plan_hold`                | Create `plan_hold`                                                                                                                                                                                                                     | Safe     |
| `invite_code`              | Create `invite_code`                                                                                                                                                                                                                   | Safe     |

Rolling back the code leaves unused tables behind (harmless). Old code serving after the backfill ignores the rows.

### 12. Audit (catalogue `packages/core/src/audit/catalogue.ts` + `audit.md`, rule 46)

Account scope unless noted; the actor is the person, the staff member (with `staff`) or the system (`billing-sync`,
`billing-timers`). Meta never holds card details, addresses, tax ids, emails of the payer, secrets or full provider
payloads; provider ids (customer, subscription, invoice) are allowed.

`billing.checkout_started` (plan, currency, amountMinor, storageBlocks, extraMailboxes) · `billing.portal_opened` ·
`billing.plan_changed` (from, to, source) · `billing.addons_changed` (storageBlocks, extraMailboxes from/to, chargedNowMinor) ·
`billing.supporter_amount_changed` (from, to, currency) · `billing.payment_succeeded` / `billing.payment_failed`
(invoice id, amountMinor, currency) · `billing.state_changed` (from, to, reason) · `billing.cancel_scheduled` /
`billing.cancel_undone` · `billing.refunded` (amountMinor, currency, withinWindow, staff) · `billing.dispute_opened` /
`billing.dispute_closed` (outcome) · `billing.holds_applied` / `billing.holds_lifted` / `billing.holds_changed`
(counts by kind) · `billing.comp_redeemed` (plan, days) · `billing.staff_plan_granted` / `billing.staff_plan_revoked` ·
`billing.ceiling_changed` · `billing.resynced` · platform scope: `billing.sync_failed`, `billing.catalogue_drift`,
`platform.invite_code_created` (grants, comp plan and days, expiry, bound — never the code), `platform.invite_code_revoked`,
`platform.invite_code_redeemed` (plus `billing.comp_redeemed` in the account when it comps).

The unused catalogue entries `billing.suspended` and `billing.reactivated` are retired in favour of
`billing.state_changed` (labels updated; nothing in code writes them today). Denied attempts write the same action
with `result: denied`. Webhook ingestion (`billing/ingest.ts`) writes no audit row: it records a provider event id and
queues a job; every change it leads to is audited by the sync. `audit.md` says so explicitly.

### 13. Roles

No new roles or permissions. `billing.read`: Owner, Billing Administrator, Auditor. `billing.manage` ★: Owner, Billing
Administrator. `platform.billing.manage` ★: Global and Billing Administrators (staff). `platform.invites.manage`:
signup-only codes. `roles.md` gains the Billing page and Platform billing rows' detail (refund rules, step-up, act-as
read-only); the RBAC harness and the e2e role journeys add the new routes (rule 35).

## Consequences

- Stripe can be replaced by another processor by writing one adapter; the core, data model and UI don't say "Stripe".
- Our database never holds card data, addresses, tax ids or webhook payloads; PCI scope stays Stripe-hosted (SAQ A).
- Webhooks can arrive late, twice or out of order without effect; a lost one heals within 24 h. The price is one Stripe
  API read per sync.
- Non-payment and cancellation never delete anything; storage held by lapsed accounts is bounded but not reclaimed.
  If that cost matters at scale, a reviewed cleanup ADR is needed.
- Pre-staging can run real Stripe test mode (`BILLING_ALLOW_TEST_KEYS`), production starts at `off` and opens with
  the launch change that flips `BILLING.status`.
- The prices remain the maintainer's decision (open item 3; Supporter minimum, open item 7). This design reads every
  number from `plans.ts`; changing them is a facts change plus new Stripe Prices, no code.
- More moving parts in the worker (sync, reconcile, timers, catalogue). They reuse the provisioning queue and scheduler.

## Alternatives

- **Stripe Node SDK in the adapter:** acceptable (MIT, no dependencies) and the obvious fallback; not chosen because
  responses need runtime validation anyway, API-version drift is easier to control with one constant, and we use few
  endpoints. Reversible inside the adapter.
- **Trust webhook payloads as state (apply each event's object):** needs ordering logic and stores personal data;
  rejected for fetch-on-event.
- **Stripe Checkout with `custom_unit_amount` for Supporter:** doesn't support recurring prices.
- **Customer Portal for plan and add-on changes:** can't enforce our ceilings or handle inline Supporter prices.
- **Deleting data after a long lapse on a timer** (the 2026-10-21 lifecycle): conflicts with "never delete mail
  automatically"; rejected.
- **Trials on paid plans:** Free is the trial (`BILLING.trialDays` 0).
- **Storing keys in the database from the start:** env is enough for one operator; the key-ring path exists if needed.

## Slice plan (small commits, rule 3; each slice ships with its tests and docs)

1. **Facts and pure lifecycle** — `plans.ts` additions (`BILLING.status`, `restrictedDays`, `heldReceiveDays`,
   `supporterMaximum`, `MAX_STORAGE_BLOCKS`, `MAX_EXTRA_MAILBOXES`, `mailboxCeiling`, `storageText` keyed on status);
   `packages/core/src/billing` types, `deriveBilling`, `computeHolds`, entitlement and refund-eligibility functions with
   table tests.
2. **Port, fake provider and contract suite** — `BillingProvider`, memory + Redis fake store with clock offset, the
   shared signature signer/verifier with fixtures and Stripe's example vector.
3. **Stripe adapter over fetch** — form encoder, idempotency keys, retries, zod response parsing, error mapping,
   catalogue check; env validation and boot refusals; redaction keys.
4. **Data model and repositories** — migrations `account_billing`, backfill, `plan_hold`, `invite_code`; memory +
   Postgres repositories with contract tests; account creation writes its billing row; `migration.md`, `04`.
5. **Webhook ingestion and `billing.sync`** — the route (tier `webhook`), `ingest.ts`, the job kind, sync with
   account lock, audit entries, `billing.reconcile`, events prune; integration tests for duplicates and reordering.
6. **Stalwart access states** — `access` input in `stalwart-client` (`SEND_BLOCKED_PERMISSIONS`, receive-blocked),
   verified on v0.16.27 (`GET /api/schema`, live probes: 587/465, JMAP submission, IMAP read, inbound RCPT);
   `mailbox.ensure`/`domain.ensure` derive access from billing state and holds; webmail send refusal.
7. **Ceilings** — `mailboxCeiling` and people ceiling in the mailbox/people services, `ACCOUNT_ADDRESS_CEILING`
   (fail closed) with the staff override, held mailboxes out of the pool arithmetic, `job:quota-cap` follow-up.
8. **Checkout, portal and dev simulation** — billing service (checkout, portal), new rate-limit tiers, routes, the
   `/dev/billing/*` pages and simulate route with the three production guards and their tests.
9. **Plan and add-on changes, cancel, refund** — preview/change/cancel/undo/refund services and routes, step-up,
   entitlement rule, decrease refusals.
10. **Lapse and holds** — `billing.timers` (restricted timeout, comp end, receive windows), holds applied/lifted,
    "Choose what stays on", invite revocation on lapse, delegation inert, account-deletion hook and `billing.json`.
11. **Billing page** — console page, banners, skeletons, Playwright MCP pass as Owner, Billing Admin, Auditor, Member,
    act-as.
12. **Platform billing and invite codes** — staff page and account panel, codes create/list/revoke, redemption at
    sign-up and on Billing (`inviteCodeRedeem` tier), orphans, drift banner, RBAC harness rows.
13. **Docs and site** — `docs/public` billing guide (plans, add-ons, paying, failed payments with the published day
    counts, cancelling, refunds, downgrade holds, codes), pricing page copy from facts, changelog, `roles.md`,
    `audit.md`, `rate-limits.md`, `01-architecture.md`, `codemap.md`, `06` lifecycle section pointing here.
14. **Live verification** — `tests/billing-live` test-clock suite run locally with test keys, results in the handoff;
    full e2e lifecycle on the fake; `security-reviewer` pass (rule 27: sending restriction and signup codes).
