# ADR-0034: Trust tiers stored on the customer account and enforced on every sending path

**Status:** Accepted 2026-11-11 (building: slices 1–20 built, review findings 2, 3, 5, 6 addressed, the relay hold
closes public JMAP for `new`, second review's F1, F2, F3, F4, F5, F8 addressed; open: slice 22 (migration C),
`trusted`; first Phase 6 slice)

## Context

Phase 6 starts with the main open risk while sign-up is open (`03-anti-spam-and-abuse.md` "Free-tier risk", maintainer
risk acceptance 2026-10-23): a free mailbox sends to the internet under the same limits as any other. What exists
(checked in the code, 2026-11-11):

- **Published limits** per tier in `packages/shared/src/sending.ts` (`TRUST_TIERS`: `new`, `standard`, `trusted`,
  `restricted`), rendered on the site by `apps/site/src/components/facts.tsx`.
- **A stored tier nobody writes:** `user_profile.trust_tier` (per person, default `new`). Its only reader is the
  importer's message cap (`imports.trustTier(requestedBy)`, ADR-0030), so every import gets the `new` cap.
- **Webmail enforcement with a stub tier:** `sendingTier()` in `apps/web/src/server/webmail/compose.ts` returns `new`
  for everyone; `sendCheck` refuses `restricted` and over-cap recipients; `sendWindows` charges each recipient to
  per-mailbox and per-session hour/day windows in Redis, and the send path **fails closed** when Redis is down
  (`WebmailUnavailableError`, service.ts send and delegated send). `settings.ts` uses the tier to refuse vacation,
  forwarding and forwarding rules while `restricted`. Delegated sends take the stricter of two mailboxes' tiers
  (ADR-0026 §6).
- **A verified send block on the mail server** (ADR-0029 §5–6, `research/stalwart.md` "Billing access states"):
  `SEND_BLOCKED_PERMISSIONS` (`emailSend` + `jmapEmailSubmissionCreate` denied) refuses SMTP AUTH on 465/587 and JMAP
  submission while sign-in, reading and delivery keep working; `emailSend` **alone** refuses SMTP AUTH and leaves JMAP
  submission working. `mailbox.ensure` writes the access state from billing; `accessOf()` reads it back.
- **Mail apps bypass the BFF:** SMTP submission (465/587) goes straight to Stalwart. Stalwart's HTTP/JMAP listener is
  internal only (01-architecture "Production exposure"), so the webmail BFF is the only JMAP sender.
- **What the pinned v0.16.27 offers for per-account limits** (schema and `x:*/get` on the dev server, 2026-11-11):
  `x:MtaInboundThrottle` (`key` ⊂ {listener, remoteIp, localIp, authenticatedAs, heloDomain, sender, senderDomain,
  rcpt, rcptDomain}, `match` expression, `rate {count, period ms}`; two defaults: remoteIp 5/s and senderDomain+rcpt
  25/h), `x:MtaQueueQuota` (concurrent queue size, not a rate), `x:MtaStageRcpt` (`allowRelaying`, `maxRecipients`,
  `script` expressions). There is **no way to make an expression read per-account data**: a server-side list
  (`x:MemoryLookupKey` + `key_exists`) was not readable from Sieve (ADR-0026 P9), and accounts carry no tier field.
  So Stalwart can enforce **per-account gates through permissions** (verified) and **one set of numbers for every
  authenticated sender** through throttles (shape verified, counting behaviour still to pin), not per-tier numbers.
- **Staff tools:** `platform.trust.manage` ("Change trust tiers and sending limits", critical; Global and Trust &
  Safety Administrators) and `platform.suspensionNotes.read` exist in the RBAC matrix; audit actions
  `trust.tier_changed`, `trust.limits_changed`, `trust.restricted` exist in the catalogue, unused.

## Decision

### 1. The tier lives on the customer account

`customer_account.trust_tier` is the one source. Reasons: plan, billing, age and staff suspension are account facts
(ADR-0002; `04-data-model.md` already lists `trust_tier` on the account); a person can belong to several accounts, so a
person's tier is ambiguous for any one mailbox; person-less shared mailboxes need a tier and have no person; the
mailbox is only Stalwart's sending principal. **A mailbox's effective tier** is its account's tier, made stricter by a
per-mailbox sending restriction (§6, for one compromised mailbox in an otherwise fine account). The delegated-send rule
(ADR-0026 §6, stricter of the two mailboxes) is unchanged; it now reads real tiers.

Columns (migration A, Safe):

| Column               | Type          | Notes                                                                                   |
| -------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `trust_tier`         | text not null | default `new`; check in (`new`, `standard`, `trusted`, `restricted`)                    |
| `trust_tier_since`   | timestamptz   | not null, default now()                                                                 |
| `trust_tier_source`  | text not null | default `default`; check in (`default`, `automatic`, `billing`, `staff`)                |
| `trust_reason`       | text          | a `SUSPENSION_REASONS` key (`packages/shared/src/platform.ts`) when staff set it; shown |
| `trust_note`         | text          | staff-only note (never to the customer; read with `platform.suspensionNotes.read`)      |
| `trust_set_by`       | text          | staff user id when `source = staff`                                                     |
| `last_restricted_at` | timestamptz   | set by any restriction and by a staff suspension of the account or one of its people    |

Index `customer_account_trust_promote_idx` on (`trust_tier`, `created_at`) where `trust_tier = 'new'`.
`mailbox` gets `sending_restricted_at`, `sending_restricted_reason`, `sending_restricted_note`, `sending_restricted_by`
(all nullable, Safe).

**Moving off `user_profile.trust_tier` (rule 15, three steps):** A adds the account columns and backfills (accounts
with billing state `active`/`past_due` → `standard`, source `billing`; an account whose owner's profile tier is
`restricted` → `restricted`, source `staff`; the rest stay `new`; the platform staff account → `standard`, source
`staff`). B moves the one reader (the importer) to the mailbox's effective tier and stops writing the old column
(nothing writes it today). C, a later release after a backup, drops `user_profile.trust_tier` (Destructive). The
backfill is a custom drizzle migration; rollback level for A and B: Safe (old code ignores the new columns).

### 2. Who changes it

All changes go through `packages/core/src/trust/service.ts`, which takes the actor, checks permission and scope, writes
the account row, the audit entry and the `mailbox.ensure` jobs for every mailbox of the account **in one unit of work**
(rules 26, 46).

- **Automatic promotion `new` → `standard`** — scheduler job `job:trust-promote` (worker, every hour). An account is
  promoted when all hold: `trust_tier = 'new'` and `trust_tier_source <> 'staff'`; `created_at` older than
  `TRUST_PROMOTE_MIN_AGE_HOURS`; `status = 'active'` (no staff suspension) and no person of it suspended; billing state
  not `restricted`/`lapsed`; the owner's console email confirmed; `last_restricted_at` is null; fewer than
  `TRUST_PROMOTE_MAX_HELD` `trust.send_held` entries for its mailboxes in the last `TRUST_PROMOTE_MIN_AGE_HOURS`.
  Thresholds are env values set in the ops repository (rule 44); `.env.example` carries obvious dev values and
  production refuses to start with them unset. Later detection signals (bounces, complaints, Phase 6 later slices) add
  conditions here. At most `TRUST_PROMOTE_BATCH` accounts per run. Audited `trust.tier_changed` by SYSTEM, source
  `automatic`. No email; the console card changes.
- **Paid plan → `standard` at once:** `syncAccountBilling` promotes `new` → `standard` (source `billing`, same unit of
  work as the billing state change) when the account enters billing state `active` (Stripe, comp or staff grant).
  Promotion is sticky: a later downgrade to Free leaves `standard`. Never touches a `staff` source or `restricted`.
- **`trusted`:** reserved. Staff can't set it and nothing promotes to it until Stalwart can hold per-tier numbers
  (§4, probe P4); the setter answers `422 tier_unavailable`. Its published limits stay on the site.
- **Staff set or restrict** — `PUT /api/platform/accounts/:accountId/trust` with `{ tier: "new" | "standard" |
"restricted", reason, note, automatic?: boolean }`. Permission `platform.trust.manage` (Global, Trust & Safety
  Administrators), fresh step-up, never while acting as (403), reason category required for `restricted` and for any
  move off `restricted`, note required (1–2,000 chars, never logged or audited by value). Unknown account → 404.
  `automatic: true` (only with `new` or `standard`) sets source `automatic` so the job and billing may move it again;
  otherwise source `staff` freezes it. Rate-limit tier **`staffTrust`** (30 / 1 h per staff user, same fail mode as
  `staffSuspend`).
- **`restricted` leaves only by review:** only this staff route moves an account off `restricted`; the job and billing
  skip it. Automatic restriction by detection (bounce or complaint spikes, compromised-account signals) is a later
  Phase 6 slice and will call the same service as SYSTEM.
- **Staff suspension** (`platform/suspension.ts`) sets `last_restricted_at` in its own unit of work, so a suspended
  and lifted account is never promoted automatically.

**Audit** (catalogue `packages/core/src/audit/catalogue.ts` + `docs/internal/audit.md`): `trust.tier_changed` (meta
`from`, `to`, `source`, `reason?`), `trust.restricted` (instead of `tier_changed` when `to = restricted`; meta `from`,
`source`, `reason`), **new** `trust.unrestricted` (leaving `restricted`; meta `to`, `reason`), **new**
`trust.mailbox_restricted` / `trust.mailbox_unrestricted` (§6), **new** `trust.send_held` (§3; at most one per mailbox
per hour, meta `externalRecipients` count only — never addresses, rule 24), and denied attempts as usual. Every entry
carries the account id, so staff changes appear in the account's own audit log (rule 49); the note never does.
Customers see the reason category in plain words (`SUSPENSION_REASONS`), as for suspension.

### 3. The `new`-tier external-sending hold

**A mailbox whose effective tier is `new` sends only to addresses we host** (platform domains and verified customer
domains); internal delivery works from the first minute. Since paid accounts are promoted at once, this is in practice
the free-account hold from `03-anti-spam-and-abuse.md`.

- **Webmail (BFF):** before any draft is made or anything is charged, the send and delegated-send paths read the
  standing uncached — one core read `sendingStanding(address)` returning `{ tier, billingBlock }`, replacing
  `billingSendBlock` + the stub `sendingTier()` (which become async callers of it). Recipients' domains are checked
  with a new repository method `directory.hostedDomains(domains)` (platform domains from config + verified customer
  domains). Any external recipient while held → `403 sending_held`, nothing sent, `trust.send_held` (throttled as
  above). Delegated sends: held when either mailbox is held. Forwarding and forwarding rules to an outside target are
  refused while held (`422 sending_held` at set-up; an existing redirect is left out of the generated script, as for
  `restricted`); vacation replies stay on (one reply per sender per period, to people who wrote first).
- **Mail apps (SMTP 465/587):** Stalwart can't tell an internal from an external recipient per account (no readable
  per-account data in expressions), so a held mailbox gets a new access state **`smtp_blocked`** (`CUSTOMER_DENIALS`
  - `emailSend`): SMTP AUTH is refused (`550 5.7.1`, Stalwart's text), IMAP, POP3, CardDAV and webmail (JMAP
    submission) keep working, mail is delivered to it. Verified on v0.16.27 (2026-11-04, the `emailSend`-only column) and
    re-pinned in the slice's integration test. Users are told in the console Mail apps page and the docs that sending from
    mail apps opens with Standard.
- **Residual risk:** none on SMTP for held mailboxes (no submission at all). The cost is product-side: a new free
  account can't send from a mail app until promoted. Reversal cost is low (one access state).

### 4. Limits on every path, and how they reach Stalwart

- **Effective access per mailbox** (pure function `mailboxSendAccess()` in `packages/core/src/trust/access.ts`, used by
  `mailbox.ensure`): the most restrictive of staff suspension (`suspended`) > billing (`send_blocked`; a
  receive-blocked hold is still applied as `send_blocked`, ADR-0029) > tier `restricted` or a mailbox restriction
  (`send_blocked`) > tier `new` (`smtp_blocked`) > `active`. `stalwart-client` gains `SMTP_BLOCKED_PERMISSIONS`,
  `MailboxAccess` `smtp_blocked`, and `accessOf()` tells `send_blocked` (both denials) from `smtp_blocked` (only
  `emailSend`). No new management method: the provisioning key already writes these denials.
- **Webmail limits:** `TRUST_TIERS[effective tier]` through the existing `sendCheck` and `sendWindows` (fail closed,
  each recipient one unit). `MAX_RECIPIENTS` stays the input-validation ceiling.
- **Mail-server ceiling for every authenticated sender** (defence in depth, covers mail apps of `standard` accounts and
  any BFF bug): `applySendingPolicy(mgmt)` in `packages/stalwart-client/src/sending.ts` upserts by description two
  `x:MtaInboundThrottle` objects keyed `{ authenticatedAs }` with `rate` = `TRUST_TIERS.standard.limits`
  `messagesPerHour` / 3,600,000 ms and `messagesPerDay` / 86,400,000 ms, `match` = authenticated and not one of the
  platform's system accounts (`no-reply`, `postmaster`, `svc-*` on the platform domain: transactional mail must never
  be throttled by it), and sets `x:MtaStageRcpt.maxRecipients` to `standard.recipientsPerMessage` for authenticated
  sessions (100 otherwise, the current default), then `ReloadSettings`. Idempotent; numbers come only from
  `packages/shared`. Called by `infra/stalwart/dev-plan.ts` and by the ops bootstrap on every deploy.
- **Probes the first slice pins** (`packages/adapters/src/stalwart/sending-policy.int.test.ts`, real dev Stalwart):
  P1 `smtp_blocked`: 465/587 AUTH `550`, JMAP submission delivered, IMAP works, inbound delivered. P2 the
  `authenticatedAs` throttle: at which command it answers (expected MAIL FROM, `451 4.4.5`), that it counts messages,
  and what a JMAP submission over it reports in `deliveryStatus`. P3 `maxRecipients` for an authenticated session
  (the 51st RCPT refused) while port 25 keeps 100. P4 whether an MTA-stage expression (not Sieve) can read
  `x:MemoryLookupKey` with `key_exists`; recorded either way in `research/stalwart.md`. If P4 works, a later ADR update
  moves to per-tier throttles and opens `trusted`.
- **Residual risk on SMTP for `standard`:** the mail-server ceiling counts messages, not recipients, so a compromised
  standard mailbox on a mail app could reach `messagesPerHour × recipientsPerMessage` recipients an hour before the
  existing senderDomain+rcpt throttle and detection catch it. Accepted for this slice; the Phase 6 detection slice adds
  per-account recipient counting from Stalwart delivery events and automatic `restricted`.
- **Drift:** the reconciler gains `accessMismatch` (desired `mailboxSendAccess` vs `accessOf` on the server, for
  settled mailboxes; re-queued `mailbox.ensure`, never deletes) and `sendingPolicyMismatch` (the two throttles and the
  RCPT cap missing or with other numbers; reported, re-applied by the next deploy's bootstrap). Both feed
  `platform.reconciler_drift` meta counts.

### 5. What users see

- **Console** — Account overview gets a **Sending** card (`account.read`, so every account role and act-as can read):
  tier label and description, the published limits from `TRUST_TIERS`, and for `new` "Sending to addresses outside
  AnhourMail and from mail apps opens automatically once your account is established" (no date, no threshold; rule 33).
  `restricted` shows the reason category and the appeal address (`SUPPORT_EMAIL`). Route `GET /api/account/sending`
  (tier `read`) returns `{ tier, label, description, limits, externalHeld, mailAppsCanSend, reason? }`. Mail apps and
  App passwords pages show the mail-app notice while held.
- **Webmail** — Settings → Account shows the same card for the open mailbox (its effective tier, mailbox restriction
  included). Errors on send: `403 sending_held` "New accounts can send to addresses hosted on AnhourMail for now.
  Sending elsewhere opens automatically once your account is established."; `403 sending_paused` (restricted, existing
  text); `429 sending_limit` (existing text with the tier's numbers); `503` when the counters can't be checked.
- **Staff** — Platform → Customer accounts → account: a Trust card (tier, source, since, reason; note with
  `platform.suspensionNotes.read`) and Change tier dialog (step-up); the mailbox list gets Restrict sending / Lift.
- **Public docs** (`docs/public`, rule 31): sending limits page explains tiers by their published limits, the hold for
  new accounts and mail apps, the error messages, and how to appeal. No thresholds or signals.
- **Email:** an account moved to `restricted` (account or mailbox) emails the owners the reason category and the appeal
  address, like a suspension. Promotion sends nothing.

### 6. Mailbox-level restriction

`PUT /api/platform/accounts/:accountId/mailboxes/:mailboxId/sending` `{ restricted: boolean, reason, note }`, same
permission, step-up, act-as and rate-limit rules as §2; mailbox not in that account → 404. Sets the `mailbox.sending_*`
columns, sets the account's `last_restricted_at`, queues that mailbox's `mailbox.ensure`, audits
`trust.mailbox_restricted` / `trust.mailbox_unrestricted`. Lifting is review only, as for the account.

## Consequences

- One source for the tier; every path reads it: webmail send and delegated send, forwarding and vacation, the importer
  cap, and Stalwart permissions. `user_profile.trust_tier` goes away in step C.
- New free accounts send internally only and can't use SMTP until promoted. Pre-staging's existing young free accounts
  lose external sending at deploy until the first `job:trust-promote` run finds them old enough; the deploy notes say so.
- `trusted` is published but unreachable until P4 or another per-account mechanism exists.
- Each tier change rewrites every mailbox of the account through jobs; an account with many mailboxes changes over a
  few worker cycles (the BFF reads the tier uncached, so webmail enforcement is immediate).
- **Ops follow-ups** (private repository): the management proxy must allow `x:MtaInboundThrottle/get|set` and
  `x:MtaStageRcpt/get|set` (singleton update) for the bootstrap key and `x:MtaInboundThrottle/get` for the reconciler's
  key; the bootstrap calls `applySendingPolicy` and `ReloadSettings` on every deploy; set `TRUST_PROMOTE_MIN_AGE_HOURS`,
  `TRUST_PROMOTE_MAX_HELD`, `TRUST_PROMOTE_BATCH` in `.env`; check that the CardDAV host's NGINX location never
  proxies `/jmap` (an app password must not reach JMAP submission past the BFF); smoke checks for a held mailbox's
  `550` on 587.

## Alternatives

- **Tier on the person:** ambiguous for people in several accounts and undefined for shared mailboxes. Rejected.
- **Tier on each mailbox:** promotion and payment are account facts; every mailbox would need the same value kept in
  step. Rejected; only a restriction is per mailbox (§6).
- **SMTP external hold in Stalwart** (`allowRelaying` or a RCPT-stage Sieve that reads a list of held accounts): needs
  per-account data in expressions, not available on v0.16.27 as probed (P9); revisit with P4.
- **Per-account `x:MtaInboundThrottle` objects** (one per account, `match` naming its address): one compiled rule per
  account and a full reload per change; doesn't scale. Rejected.
- **SMTP off for every free account:** breaks the IMAP/SMTP promise for established free users. Rejected.

## Build plan (one concern per commit, rule 3; each with its tests and docs; checkpoint after each, rule 55)

1. **Probe and pin** — `sending-policy.int.test.ts` P1–P4 on the dev stack; results in `research/stalwart.md`
   ("Trust tiers on the mail server"). No product code.
2. **Shared facts** — `TRUST_TIER_SOURCES`, `isTrustTier`, staff-settable tiers (`new`, `standard`, `restricted`) in
   `packages/shared/src/sending.ts`; unit tests.
3. **Migration A** — account and mailbox columns, checks, index, backfill (custom SQL); `migration.md` (Safe);
   `04-data-model.md`.
4. **Repositories** — `trust` repository (get, set tier, promotion candidates, mailbox restriction, `last_restricted_at`),
   `directory.hostedDomains`, `sendingStanding` read; Postgres + in-memory + contract tests (incl. cross-account).
5. **Core: access function** — `mailboxSendAccess()` + exhaustive table tests.
6. **stalwart-client: `smtp_blocked`** — `SMTP_BLOCKED_PERMISSIONS`, `MailboxAccess`, `accessOf()`; unit tests.
7. **Provisioning** — `mailbox.ensure` applies `mailboxSendAccess`; provisioning tests; int test that a held mailbox's
   587 AUTH is refused and its webmail submission works.
8. **Core: trust service** — staff set / restrict / unrestrict, mailbox restriction, SYSTEM promotion, billing
   promotion hook; audit catalogue (`trust.unrestricted`, `trust.mailbox_*`, `trust.send_held`), `audit.md`; unit
   tests for success, 403, 404 cross-account, act-as 403, `restricted` exit rules, `trusted` 422.
9. **Billing hook** — `syncAccountBilling` promotes on `active`; suspension sets `last_restricted_at`; tests.
10. **Importer** — cap by the destination mailbox's effective tier (step B); remove `imports.trustTier`; tests; ADR-0030
    update note.
11. **Worker job `job:trust-promote`** — scheduler entry, env parsing and production guard, `.env.example`; tests.
12. **Webmail enforcement** — `sendingStanding` in send and delegated send, external hold, `trust.send_held`
    throttling, forwarding/rules refusal while held; `compose.ts` stub removed; unit tests (held internal ok, held
    external 403, restricted, delegated stricter, Redis down 503).
13. **Mail-server policy** — `applySendingPolicy` in stalwart-client, dev-plan call, reconciler `accessMismatch` and
    `sendingPolicyMismatch`; unit + int tests.
14. **Routes** — `GET /api/account/sending`, `PUT /api/platform/accounts/:id/trust`,
    `PUT /api/platform/accounts/:id/mailboxes/:mailboxId/sending`; `staffTrust` tier in `rate-limit.ts` and
    `rate-limits.md`; route tests.
15. **RBAC** — matrix descriptions, `roles.md` guard rail (trust changes: Global + Trust & Safety, step-up, never
    act-as; notes by `platform.suspensionNotes.read`), RBAC harness rows (every role × each route, 404 cross-account,
    403 act-as, 429).
16. **Console UI** — Sending card on the Account overview, mail-app notices; loading skeletons; Playwright MCP light/dark
    1440/390 as Owner, Member, act-as.
17. **Staff UI** — Trust card, Change tier dialog, mailbox Restrict sending; skeletons; MCP pass as Global, Trust &
    Safety, Support (read-only), Billing (no access).
18. **Webmail UI** — Settings → Account sending card, send error copy for `sending_held`.
19. **Restriction email** — transactional template and its test.
20. **Seed and e2e** — demo accounts in each tier (new free held, standard, restricted, mailbox-restricted) and
    `credentials.md` generator (rule 50); e2e: held external send refused and internal delivered, staff restricts then
    the webmail refuses, the console card in two places.
21. **Docs** — public sending-limits page and mail-apps note, changelog entry, `03-anti-spam-and-abuse.md`,
    `01-architecture.md`, `codemap.md`, `09-roadmap.md` Phase 6 status, this ADR's status line.
22. **Migration C (later release)** — drop `user_profile.trust_tier` after a backup (Destructive), logged.

## Open questions for the maintainer

1. The `TRUST_PROMOTE_MIN_AGE_HOURS` value, and whether to publish the waiting period (it is easy to learn by waiting;
   this ADR keeps it private, as `03-anti-spam-and-abuse.md` says, and the console shows no date).
2. Confirm the product trade-off in §3: new free accounts can't send from mail apps (SMTP) until promoted.

## Update 2026-11-11: probes P1–P4 (build slice 1)

Pinned in `packages/adapters/src/stalwart/sending-policy.int.test.ts`; details in `research/stalwart.md` "Trust tiers on
the mail server".

- **P1 holds:** `CUSTOMER_DENIALS` + `emailSend` refuses SMTP AUTH on 465 and 587 (`550 5.7.1`) and leaves JMAP
  submission, IMAP and delivery working; the provisioning key may write it.
- **P2 corrects one detail:** the `authenticatedAs` throttle answers at MAIL FROM with **`452 4.4.5`** (not 451), counts
  MAIL transactions (a `MAIL FROM` then `RSET` counts; recipients don't), and one allowance covers 465, 587 and JMAP.
  A JMAP submission over it is not created (`forbiddenMailFrom`), so the BFF sees a refusal, not a queued message.
  §4's ceiling therefore counts messages as assumed.
- **P3 holds:** `maxRecipients` for an authenticated session refuses the 51st RCPT (`455 4.5.3`); port 25 keeps 100.
- **P4 disproves a fact this ADR relied on.** The Context ("no way to make an expression read per-account data") and
  §3 ("Stalwart can't tell an internal from an external recipient per account") are wrong for MTA-stage expressions:
  they read `x:MemoryLookupKey` (`key_exists`) and `x:MemoryLookupKeyValue` (`key_get`) once `x:Action`
  `ReloadLookupStores` has run (ADR-0026 P9 only tried `ReloadSettings`, and only from Sieve). Verified: an
  `allowRelaying` branch on a lookup list refuses outside recipients for listed accounts (`550 5.1.2 Relay not allowed.`
  at RCPT; in JMAP `deliveryStatus`) while local delivery works, and a throttle `match` on the list limits listed
  accounts only. So the "SMTP external hold in Stalwart" alternative and per-tier throttles are technically possible.

**Decision for this build: unchanged.** Slices 2–22 go ahead as written (`smtp_blocked` for `new`, one ceiling for every
authenticated sender, `trusted` reserved). Reasons: permissions are stored on the account, apply at once and are
verified on every protocol, while a lookup list changes only after a server-wide reload, and three things are not
verified yet — that keys survive a restart and load without a reload, what expressions do when a reload fails, and the
reload's cost with thousands of keys. Writing keys also needs `sysMemoryLookupKey*` and `sysActionCreate`, and the latter allows every
`x:Action` (pausing the queue included), so it needs its own narrowly used key. A later update of this ADR, after those
checks, can replace `smtp_blocked` with a relay hold (held accounts keep sending to hosted addresses from mail apps),
move the ceiling to per-tier throttles and open `trusted`. That would also answer open question 2 differently: the
mail-app trade-off for new free accounts becomes avoidable rather than inherent.

## Update 2026-11-11: build slices 6–11

Built: `smtp_blocked` in `stalwart-client` (slice 6), `mailbox.ensure` applying `mailboxSendAccess` (7; pinned on the
real server in `packages/adapters/src/stalwart/trust-access.int.test.ts`), the trust service (8), billing's promotion
and suspension's `last_restricted_at` (9), the importer cap by the destination mailbox's tier (10, migration step B)
and `job:trust-promote` (11). The decision is unchanged (`smtp_blocked` for `new`; the lookup-list relay hold stays a
maintainer option, open question 2). Two facts above proved wrong and the build adapts:

- **§5 "`account.read`, so every account role and act-as can read":** the Member role doesn't hold `account.read`
  (every other account role and the act-as role do). The customer read (`accountSending`) keeps `account.read`, so a
  Member gets 403 there; Members see their own mailbox's tier in the webmail's Settings → Account card (slice 18),
  which reads the mailbox's effective tier. The console Sending card (slice 16) shows only to roles with `account.read`.
- **§2 "Audit" meta `from` / `to`:** both are redacted keys everywhere (mail headers), so they would be stored as
  `[redacted]`. The entries carry **`fromTier` / `toTier`** instead (as billing uses `fromState` / `toState`), plus
  `source`, `reason` (plain words), `reasonCategory` and `mailboxesQueued`; `audit.md` lists them.

Details the ADR left open, as built: every trust entry is in the account's log with a copy in the platform log, and
neither carries the staff note; a staff move to the tier and source the account already has is a 409; a tier change
that would change kind (into or out of `restricted`) between the first read and the lock is a 409; lifting a mailbox
restriction needs a reason and a note like restricting it. A person's suspension marks every account of theirs (those
holding their mailboxes and those they belong to). Billing promotes on any derivation that leaves the account
`active` (also one that was active before this release and still `new`), never lowering a tier. A mailbox the
importer can't match to its account reads `restricted`. `tier_unavailable` (422) needs its HTTP mapping with the
routes (slice 14). `.env.example` carries development `TRUST_PROMOTE_*` values; outside production all three unset
turns the job off, and production refuses to start the scheduler without them.

## Update 2026-11-11: build slice 12, and forwarding and automatic replies under a tier

Built: the webmail reads the stored standing uncached for every send and delegated send (`403 sending_paused`,
`403 sending_held` with `trust.send_held`, limits from the tier, `429 sending_limit`, 503 when the tier, the
hosted-domain check or the counters can't be read). A delegated send's tiers are read only after its grant is
confirmed (before that the draft is checked for shape only), so a refusal never tells anything about an address the
person can't use.

**A fact this ADR relied on was incomplete (security review of slices 1–11).** §3 said an existing redirect "is left out
of the generated script, as for `restricted`" and §4 that `mailbox.ensure`'s access state stops a restricted mailbox
sending. But the managed script is only written when the person saves their settings, and the mail server's send
block doesn't stop a Sieve `redirect` or `vacation` (`research/stalwart.md` "Billing access states": no account
permission stops Sieve execution). So an account restricted by staff kept forwarding and replying. Decision:

- **The script itself pauses what the tier doesn't allow:** every `redirect` and `vacation` while `restricted`, and
  only redirects to addresses we don't host while `new` (internal forwarding and automatic replies keep working, as
  §3 says). Each paused command is wrapped in `if false { … }` after a fixed marker line
  (`packages/core/src/webmail/sending-pause.ts`); the settings line is never touched, so lifting the tier gives back
  exactly the script that was written, without the person's contacts (which the control plane can't read). The
  transform only touches code, never a quoted string or a comment.
- **Who writes it:** every webmail save (`saveMailRules`), and for scripts nobody saves, the web app: in the
  background after a staff tier change or mailbox restriction (`scheduleSendingPause`, called by the slice-14
  routes), and once after start-up for every active mailbox (`applyAllSendingPauses`), which also brings back a
  `new` account's paused outside redirects after the worker promotes it. Each write is a compare-and-swap on the
  Sieve state read; a save that wins is checked again on the next pass.
- **Not in `mailbox.ensure`:** the worker's provisioning key has no `impersonate` and can't write Sieve, and only the
  web app's operations key may (ADR-0020 credential split). Giving the worker that key would undo the split, so the
  pause is written by the web app instead.
- **Drift:** the reconciler (audit key, read-only) counts a script that still redirects or replies against its tier
  (`unpausedSending` in `platform.reconciler_drift`); reported, not re-queued. Its other checks read a paused script
  as the script it was.
- **Open:** a tier change made outside the web app that restricts (the later automatic restriction by detection,
  which runs as SYSTEM in the worker) reaches scripts only at the next web start-up or save until it gets its own
  signal to the web app; it must add one before it ships. Pinned on the real server in
  `apps/web/src/server/adapters/webmail-settings.int.test.ts` (restricted: neither the forward nor the reply goes
  out; new with an outside target: the reply runs, the forward doesn't; lifted: the exact script, forwarding works).

## Update 2026-11-11: build slice 13

Built: `applySendingPolicy` / `sendingPolicyDrift` (`packages/stalwart-client/src/sending.ts`) with the facts from
`standardSendingPolicy` (`packages/shared/src/sending.ts`), called by the dev plan; the reconciler's `accessMismatch`
(re-queued) and `sendingPolicyMismatch` (reported). Pinned on the real server in
`packages/adapters/src/stalwart/sending-ceiling.int.test.ts`. Three details differ from §4 as written:

- **Exempt accounts are named whole:** the platform's system accounts are `SYSTEM_MAILBOX_LOCAL_PARTS` on the platform
  domain (`no-reply`, `postmaster`, the reporting addresses). `svc-*` is not in the expression: the expression language
  of the pinned server has no documented `starts_with`, and service accounts have no password, so they can't submit.
- **A changed throttle is replaced, not updated:** its `description` can't be written after creation.
- **The reconciler's key can't read the ceiling yet:** the worker's provisioning key holds neither
  `sysMtaInboundThrottleGet` nor `sysMtaStageRcptGet`, and keys are `Replace`-typed with exactly their set (adding them
  is a key change with a rotation, and the start-up scope check would refuse the old key). The check is wired and runs
  where the key can read (the dev admin, a future key); until the ops follow-up, the reconciler logs it as skipped and
  the deploy's bootstrap is what keeps the ceiling in place. The reconciler's `accessMismatch` compares settled
  `active` mailboxes only (a suspended one is compared by the suspension check).

## Update 2026-11-11: build slices 14–15

Built: `PUT /api/platform/accounts/:accountId/trust`, `PUT /api/platform/accounts/:accountId/mailboxes/:mailboxId/sending`
(tier `staffTrust`, 30 / h, fail closed), the staff read `GET /api/platform/accounts/:accountId/trust`
(`platform.accounts.read`; notes with `platform.suspensionNotes.read`) and the customer read; `tier_unavailable` → 422.
Both changes schedule the managed-script pause (update "forwarding and automatic replies under a tier") after they
commit. The RBAC registry lists the four routes; `roles.md` guard rail 24; the matrix keeps its grants and only
`platform.trust.manage`'s description changed. Two details differ from §2 and §5 as written:

- **The customer read is account-scoped:** `GET /api/accounts/:accountId/sending` (not `/api/account/sending`), like
  every other console read, so the account id is checked against the caller's memberships (another account's id 404).
- **The restriction email** (§5 "Email") isn't sent by these routes yet; the services already return who to tell
  (`notify`), and build slice 19 adds the template and sends it.

## Update 2026-11-11: security review of slices 1–11 (findings 2, 3, 5, 6)

A security-reviewer pass over slices 1–11 found four issues in the promotion and restriction logic; the coordinator's
decisions are built as follows. §2 "Promotion is sticky: a later downgrade to Free leaves `standard`" is replaced by
the rule below.

- **Finding 2 (high): pay → `standard` → refund kept `standard`**, and a stolen card's dispute paused billing but never
  marked the account, so once the dispute cleared or the plan lapsed the account was `standard` and could be promoted
  again. Now billing takes its own promotion back (`revokeBillingPromotion` in `trust/service.ts`): a tier whose
  source is `billing` goes back to `new` (source `default`), its mailboxes queued for `mailbox.ensure`, audited
  `trust.tier_changed` (meta `cause` `refund`, `dispute` or `plan_ended`) by the system, never touching a staff-set,
  automatic or restricted tier. It runs on a refund (the console's self-service and staff refunds in their own unit
  of work, actor `billing-refund`; a refund made at the provider in the sync), on any dispute open or lost (the sync,
  which also moves `last_restricted_at` to when the account was first disputed, so neither the job nor billing ever
  promotes it again, whatever the dispute's outcome; staff can still set `standard`), and when the paid plan ends
  (cancelled, lapsed, a comp or grant ended) within `BILLING.refundWindowDays` of the promotion. A plan that ran past
  the window keeps `standard` when it ends. Billing now promotes only when the account **enters `active` or pays a new
  invoice** (no longer on every derivation that leaves it `active`), so a refund that leaves the subscription live
  isn't undone by the next sync. The managed scripts follow: the console routes (refunds, grants, comp redemption)
  schedule the sending pause after they commit, and a billing sync in the worker that moves a tier signals the web
  app through a Redis set (`@anhourmail/server/account-signals`, polled every 15 s by `startSendingPauseSignals`; a
  lost signal is caught by the start-up pass). The worker needs `REDIS_URL` for the signal (it warns at start without
  it).
- **Finding 3 (medium, accepted): comp codes and staff grants reach `standard` without `platform.trust.manage`.**
  Accepted as a staff vouch: both need `platform.billing.manage` ★ and a fresh step-up, and codes are single use.
  Decision on revocation: a grant or comp that ends (staff end it, or it runs out) within the refund window of the
  promotion takes it back, like a payment that ends that early; one that ran longer keeps `standard`. Recorded in
  `roles.md` guard rail 24.
- **Finding 5 (low): suspension and promotion could interleave.** A person's suspension marked the accounts they
  belong to without locking them, and `promoteEstablished` didn't re-check a member's suspension, the owners'
  confirmed email or the held count under its lock. Now `suspendPerson` locks every account of the person (their
  mailboxes' and their memberships', in id order) before any write (409 when one is added meanwhile), and
  `promoteEstablished` asks `TrustRepository.qualifiesForPromotion` (the same conditions as `promotionCandidates`, for
  one account) after taking the lock. Pinned on Postgres in `packages/adapters/src/db-postgres/trust-race.int.test.ts`.
- **Finding 6 (low):** `promoteForPayment` now needs the account `active` (a suspended account isn't promoted by
  paying, a comp or a grant); a mailbox with `sending_restricted_at` set always reads as restricted in both adapters
  (`storedRestriction`; a reason the code no longer knows reads as `other`, where Postgres used to read no
  restriction); and the log redaction list gains backstop keys for staff notes (`trustNote`,
  `sendingRestrictedNote`, `suspensionNote`, `staffNote`), chosen not to touch `internalNote`, which the staff
  suspension's platform audit entry keeps on purpose (audit meta shares the list).

Out of scope here (a separate mail-infra batch): the public-JMAP route around `smtp_blocked` and a relay hold.

## Update 2026-11-11: the relay hold closes public JMAP (security finding, high)

**Two claims above were wrong.** The Context says "Stalwart's HTTP/JMAP listener is internal only … so the webmail BFF
is the only JMAP sender", and §3 says "Residual risk: none on SMTP for held mailboxes". But `deploy/README.md` proxies
`/jmap` on the public `imap.` host for mail, contact and calendar apps, `packages/shared/src/platform.ts` advertises
JMAP there, and the `jmap` app-password scope allows `jmapEmailSubmissionCreate`. `smtp_blocked` denies only
`emailSend`, so a `new` free mailbox could send to anyone over public JMAP (with its password or a `jmap` app password)
past the BFF: no hold, no counters, no `trust.send_held`, and still promoted on schedule.
`trust-access.int.test.ts` already showed a held mailbox submitting over `/jmap` with Basic auth.

**Decision (coordinator): fix it on the mail server with the P4 relay hold.** Probes R1–R6 (`research/stalwart.md`
"Relay hold", `relay-hold.int.test.ts`) verified what P4 left open:

- Keys survive a restart and are in force at start, even one never reloaded; a refused or failed reload changes
  nothing loaded; adding fails open until `ReloadLookupStores`, removing fails safe; 3,000 keys reload in 2 ms.
- The hold covers SMTP and JMAP with the password and every app-password scope, and sign-ins by alias or in upper
  case; a relay expression that fails to evaluate refuses.
- The reload needs `actionReloadLookupStores` on top of `sysActionCreate`, so the key can't pause the queue (the worry
  in the P1–P4 update was unfounded); but the lookup-key permissions cover the spam filter's lists too.

Built:

- **The list.** A mailbox whose effective tier is `new` or `restricted` (a mailbox restriction included) is a key in
  `x:MemoryLookupKey` namespace `anhourmail-relay-hold` (its address, lower case), and `x:MtaStageRcpt.allowRelaying`
  starts with `if key_exists('anhourmail-relay-hold', authenticated_as) then false`, else the default
  (`desiredRelaying`, written by `applySendingPolicy` with the ceiling: dev plan and the deploy's bootstrap). Local
  delivery is never relaying, so held mailboxes keep sending to hosted addresses on every path; an outside recipient
  gets `550 5.1.2 Relay not allowed.` (SMTP RCPT, or `deliveryStatus` over JMAP). `restricted` is listed as defence in
  depth behind `send_blocked`.
- **`new` keeps `smtp_blocked`.** The plan was to drop it once restarts were shown to keep the keys (they do), so mail
  apps of new accounts could send to hosted addresses. Not done: every relay refusal counts towards Stalwart's abuse
  ban of the client's address and of the recipient (`abuseBanRate`, 35 a day, permanent; the counters survive
  restarts), so a new person's phone or desktop mail app retrying outside recipients would get their address, or a
  shared carrier or office address, banned from every protocol, webmail sign-in included. An SMTP AUTH refusal for a
  missing permission doesn't count. Mail apps over SMTP stay closed for `new` (no change for users: §3's mail-app
  notice stands); JMAP is closed to outside recipients by the hold. Revisit if the maintainer prefers mail-app sending
  to hosted addresses and accepts a finite `abuseBanPeriod`.
- **Who writes it: a new narrow key, `STALWART_HOLD_KEY` (account `svc-hold`, worker and scheduler).** Exactly
  `sysMemoryLookupKey{Get,Query,Create,Destroy}`, `sysActionCreate`, `actionReloadLookupStores`, `sysMtaStageRcptGet`
  (`HOLD_KEY_PERMISSIONS`). Not the provisioning key: adding permissions to it is a key change with a rotation (its
  start-up scope check refuses the old key), and keeping lookup keys off the key that controls every account lets the
  management proxy give this key one rule (the hold namespace, plain keys, that one action) without loosening the
  provisioning key's. It is still used only through the worker's job path (rule 26): `mailbox.ensure` writes the list,
  the reconciler reads it.
- **`mailbox.ensure`, fail closed** (`stalwartMailServer(…, { hold })` in `packages/adapters/src/stalwart/index.ts`). A
  mailbox going onto the list is listed (not yet in force), made `send_blocked` first if it could send, the list
  reloaded and the relaying policy checked, and only then given its access (`smtp_blocked` for `new`). A new account is
  created only after those steps, so a failure leaves nothing on the mail server and the retry starts clean (an account
  created and then left unrecorded by a failed job would be refused as "already exists" by every retry; the first
  integration run caught exactly that). A failure at any step leaves the mailbox unable to send at all and the job
  retries (and in the end fails as usual); a retry that finds it short of its access reloads again. A listing that
  fails also tightens it.
  Coming off the list (promotion), the key is destroyed and the list reloaded before the new access is written, so a
  failed reload is retried rather than forgotten. Without the hold key a held mailbox's job fails. Reloads are skipped
  when nothing changed (a mailbox already listed and at its access) and coalesced within a process (`RelayHoldList`).
  A purged mailbox's key is removed with it.
- **Drift:** the reconciler compares the list with the tiers of settled mailboxes (`relayHoldMismatch`: `missing` and
  `extra` of ours re-queued; strangers on our domains reported) and checks the policy is exactly the hold's (reported;
  the bootstrap applies it). Not checked without the hold key.
- **Residual:** a delegated send is held on the server by the signed-in (own) mailbox only; the BFF still holds it when
  either mailbox is `new`. Between a promotion and its `mailbox.ensure` (seconds) the BFF already lets outside
  recipients through while the server still holds them, so such a send is refused in `deliveryStatus` and counts
  towards the visitor's abuse ban. Sieve redirects aren't authenticated sessions, so the hold doesn't apply to them (the
  managed-script pause does).

**Ops follow-ups (private repository):** issue `STALWART_HOLD_KEY` (`ensureServiceAccount` / `issueServiceKey` role
`hold`) and give it to the worker and scheduler before deploying (the worker and scheduler refuse to start in
production without it; held mailboxes' jobs fail without it); the management proxy allows that key only
`x:MemoryLookupKey/set` create with `namespace: "anhourmail-relay-hold"`, `isGlobPattern: false` and a plain address,
`destroy` of keys in that namespace, `x:MemoryLookupKey/get|query` filtered to that namespace, `x:Action/set` create of
`ReloadLookupStores` only, and `x:MtaStageRcpt/get`; the bootstrap credential's `x:MtaStageRcpt/set` now also writes
`allowRelaying`; make NGINX set `X-Forwarded-For` to the address it saw on `/jmap` and `/dav/*`, replacing a
client's own (Stalwart trusts it, and a passed-on header would let a held account aim relay refusals, which count
towards a permanent abuse ban, at someone else's address); run `job:mailbox-backfill` after the deploy so
existing `new` and `restricted` mailboxes are listed; smoke checks: a held mailbox gets `550 5.7.1` at AUTH on 587,
`550 5.1.2` for an outside recipient over public `/jmap` with its password and with a `jmap` app password, and its
mail to a hosted address is delivered.

## Update 2026-11-11: build slices 16–18 (the cards and the composer)

Built: the console Sending card on the home page (`account.read`) and the mail-app notice on App passwords; the staff
Trust card with Change tier and each mailbox's Restrict sending / Lift on Platform → account; the webmail's Settings →
Account → Sending and the composer's message for each refusal. No route, permission or migration changed. Details that
differ from §5 or that it left open:

- **Who sees the Trust card:** every staff role that reads accounts (the staff read is `platform.accounts.read`), read
  only; the notes with `platform.suspensionNotes.read`; the changes with `platform.trust.manage`. Not while acting as.
- **Outside recipients of a held send are named in the browser,** from the draft, against the platform domains and the
  domains of the person's own addresses; the server never names them (rule 24). Another customer's verified domain
  can't be known there, so the composer says "may be outside" and the server's check is the one that counts.
- **The webmail card shows the tier only** (`sendingTier`), not the restriction's reason: the reason stays on the
  console card for `account.read` holders, with the appeal address on both.
- **`App passwords`** reads each own mailbox's effective tier (`sendingStanding`) for its notice; the Mail apps page
  §5 named is that page.

## Update 2026-11-11: second security review (findings F1, F2, F3, F5)

A second security-reviewer pass found four issues in the relay hold and the managed-script pause; the coordinator's
decisions are built as follows, with one premise disproved by a probe. F4 and F8 are handled separately.

**F1: the webmail's mail-server requests carried no client address.** Only OAuth sign-in and refresh sent
X-Forwarded-For; the concern was that a held mailbox's refused outside recipients over JMAP would count against the
web container's address (35 a day, permanent) and ban the webmail for everyone, hidden in dev by the allow-list.

- **The probe disproved that premise** (`ban-attribution.int.test.ts`, opt-in; `research/stalwart.md` "Which address
  a refusal counts against"). A JMAP submission runs as a local SMTP session from 127.0.0.1, which Stalwart always
  allows, so its refused recipients (relay refused, unknown hosted address) count towards **no** ban: not the web
  container's, not the visitor's, not the recipient's. Verified with the dev allow-list off and the rate at 2. So the
  relay-hold update's residual "such a send … counts towards the visitor's abuse ban" was wrong: it counts towards
  nothing. Failed sign-ins on `/jmap` do count, against the X-Forwarded-For address; a malformed bearer token doesn't.
  Recipients refused in a real SMTP session (mail apps) still count per client address and per recipient.
- **Built anyway, because the rest of the HTTP counting still lands on the BFF's address:** the webmail forwards the
  visitor's trusted address on every request to the mail server (JMAP calls, session reads, uploads, downloads, the
  push socket), through `withClientAddress` in `@anhourmail/jmap-client/client-address` and `currentClientAddress()`
  in the web app (`route()`'s address, or the page request's headers under `TRUST_PROXY`). Stalwart's anonymous rate
  limit on each first use of a token and its failed sign-in ban then count per visitor.
- **Held until applied:** the webmail treats a mailbox as held while the `mailbox.ensure` queued for its account's last
  tier change hasn't succeeded (`SendingStanding.heldOnServer`, from `ProvisioningRepository.progressSince`, read once
  per send with the tier). A send in that window is refused as `sending_held` instead of going out with its outside
  recipients refused one by one. Unrelated ensures queued later (an alias, a backfill) don't hold a mailbox whose
  change has applied. Not covered: a mailbox restriction lifted by staff (it carries no timestamp); its few seconds are
  refused per recipient by the mail server. At the deploy that adds the hold, standard mailboxes with no ensure since
  migration 0044 read held until their `job:mailbox-backfill` ensure runs (minutes, fail safe).
- **A finite abuse ban in production:** `applyAbuseBanPeriod(mgmt, ms)` (`x:Security.abuseBanPeriod`, the only field it
  writes; Stalwart's default is null, permanent) with the value from `STALWART_ABUSE_BAN_PERIOD_MS` (required in
  production by `abuseBanPeriodFromEnv` and the scheduler's start-up check; `.env.example` carries a one-hour dev
  value; the dev plan applies it when set). The deploy's bootstrap calls it, plus `assertNoPrivateAllowedIps`.
- **No private ranges on production's allow-list:** `privateAllowedIps` flags any `x:AllowedIp` entry that overlaps RFC
  1918, unique-local or link-local ranges (an IPv4-mapped IPv6 address included); the bootstrap refuses to go on and the
  reconciler reports `banPolicyMismatch` (`allowed-ip-private`, and `abuse-ban-period` when the server's period isn't
  the configured one). The reconciler's key can't read `x:Security` or `x:AllowedIp` yet, so it reports "not checked"
  until the ops follow-up gives a reading key `sysSecurityGet` and `sysAllowedIpGet`.
- **Integration run without the dev allow-list:** the ten webmail suites (50 tests, the JMAP send to an unknown hosted
  address included) passed with every `x:AllowedIp` entry removed, and no address was banned; the entries were put back.

**F2: a failed `mailbox.ensure` left a restricted or demoted mailbox open**, and the reconciler's access and relay-hold
checks skipped `failed` mailboxes. Now an ensure that may have left the account looser than wanted never gives up:
`ensureMailbox` throws `EnsureIncompleteError` with `looserThanWanted` (true: it can still send, relay or sign in where
it shouldn't; false: at least as strict as wanted; null: the account couldn't be read), and the runner keeps retrying
when it is true, or unknown while the run asked for a restriction, hold or suspension of an existing account — at most
`TIGHTEN_RETRY_MAX_MS` (5 minutes) apart, the mailbox's status untouched, `ProcessedJob.overdue` on every run past
`MAX_ATTEMPTS`, which the worker logs at error level as `mailbox_restriction_overdue` (ids only) for alerting.
Loosening ensures give up as before. The reconciler compares failed mailboxes that have a mail-server id
(`accessMismatch`, `relayHoldMismatch`) and re-queues them; failed ones never created there still have their own job.
A suspension or deletion whose ensure keeps failing is now one of these: it keeps retrying instead of being marked.

**F3: a hold key stored but not loaded was invisible.** The held path of `ensureMailbox` now reloads the list on every
run (coalesced; the pre-hold tightening still only when it's needed, so a held mailbox's access doesn't flap); the
reconciler runs `ReloadLookupStores` first (`MailServer.reloadRelayHold`; a failure is drift,
`relayHoldReloadFailed`); and `RelayHoldList.remove` reloads after destroying a lookup key it wrote itself, so another
process's reload in between can never leave it loaded (and throws if that reload fails). The lookup-by-create stays:
reading the whole namespace instead would cost every non-held mailbox's ensure a page of every held address. Pinned
with fakes (a reload elsewhere between the create and the destroy) and on the real server (a key written without a
reload relays until the reconciler's reload, then holds; the next ensure clears it).

**F5: the Sieve sending pause was best effort.** The reconciler (audit key) now returns the accounts behind
`unpausedSending` (ids only, never logged or audited) and the reconcile job adds each to the web app's signal set every
run; and the web app runs a catch-up pass every five minutes (`startSendingPauseCatchUp`) over every account whose tier
changed or that was restricted, the account or a mailbox, since its last pass (`TrustRepository.changedSince`, two
minutes of overlap for clock skew), retrying accounts a pass couldn't finish. Together these close this ADR's open item
"a tier change made outside the web app that restricts … reaches scripts only at the next web start-up or save": any
worker-made change, the later detection job included, reaches the scripts within about five minutes without a signal
of its own, and within seconds when the signal arrives. Only the signal depends on Redis (fail open); the catch-up
pass reads Postgres.

**Ops follow-ups (private repository)** are in `08-operations.md` "Trust tiers": the abuse-ban period and the bootstrap
checks, the hold key's proxy rules (now spelled out per method), NGINX setting X-Forwarded-For on every location that
proxies to Stalwart, `REDIS_URL` for the scheduler too, the alert on `mailbox_restriction_overdue`, reading
permissions for the reconciler's ban check, and the smoke checks.

## Update 2026-11-11: second security review, findings F4 and F8

**F4 (medium): a `new` account's automatic replies reached outside senders with no limit.** §3 kept `vacation` on for
`new` ("one reply per sender per period, to people who wrote first"), but a Sieve reply isn't an authenticated session:
the relay hold, the mail-server ceiling and the webmail's counters never see it, and a forged envelope sender aims it
at anyone. Decision: while the mailbox's effective tier is `new`, automatic replies are paused.

- **Which option:** the coordinator's first choice was "replies only to senders in the mailbox's contacts". The pinned
  v0.16.27 has no extlists (`research/stalwart.md` "Sieve and automatic replies": `externalLists` null), so "in
  contacts" can only be a list written into the script, as the existing "Only reply to my contacts" option does at save
  time. The pause transform runs where the person's address book isn't available (the start-up, catch-up and staff
  passes), and the contacts are chosen by the account's owner anyway (up to `MAX_CONTACT_ADDRESSES`), so they don't
  bound a hostile owner. So the fallback is built: **every `vacation` is paused while `new`, contacts-only ones
  included.**
- **Where:** in the pause transform (`packages/core/src/webmail/sending-pause.ts`): mode `external` now pauses every
  `vacation` as well as redirects outside our addresses. Same marker and wrapper, so lifting gives back the exact
  script; the reconciler's `unpausedSending` counts an unpaused reply under `new`. Saving automatic replies stays
  allowed while `new` (they start as saved once the account is established); `restricted` still refuses them at set-up.
- **What users see:** the console and webmail Sending cards and Settings → Automatic replies say "Automatic replies are
  paused until your account is established"; public docs `sending-limits` and `webmail-settings`.
- **Pinned on the real server** (`apps/web/src/server/adapters/webmail-settings.int.test.ts`): with the `new` pause, mail
  from an outside sender over port 25 gets no reply (nothing in Mailpit), nor does a hosted sender; lifted, the same
  reply to another outside sender is caught by Mailpit.
- **Deploy:** the web app's start-up pass rewrites every active mailbox's script, so existing `new` accounts' replies
  pause at the deploy; promotion lifts them through the catch-up pass.

**F8 (low): billing promoted on invoices with no real money.** `syncAccountBilling` promoted on entering `active` or on
any newly paid invoice, so a 100 %-off code, an invoice paid from the credit balance, an add-on bought after a refund,
a trial (`trialing` maps to `active`), a comp and a staff grant all promoted. Decision: promote only on a real charge.

- `ProviderInvoice.chargedMinor` (port): what the invoice's payments took from a payment method through a succeeded
  charge (the processor adapter sums `amount_captured` of each payment intent's latest charge; 0 when paid from the
  credit balance or out of band). `realChargePaid` (`packages/core/src/billing/lifecycle.ts`) needs all of: the
  subscription `active` (never `trialing`), its latest invoice newly paid with `billingReason` `subscription_create`
  or `subscription_cycle`, `amountMinor > 0`, and `chargedMinor - refundedMinor > 0`. `Derivation.realCharge` carries
  it; `tierAfterBilling` promotes only on it.
- **Comps, staff grants and comp codes no longer promote** (§2 said "Stripe, comp or staff grant"): no money changes
  hands, and Billing Administrators shouldn't move a trust tier; staff give `standard` with `platform.trust.manage`.
  The grant and redeem routes no longer schedule the managed-script pass; ending a grant still does (it can take back a
  promotion an earlier payment earned).
- The take-backs are unchanged (refund, dispute, plan ending within `BILLING.refundWindowDays` of the promotion). The
  public docs say so, with the refund window from `packages/shared` (already published on the pricing page).
- Tests: `realChargePaid` cases and the four attack scenarios in `sync.test.ts` (a 100 %-off code, a credit-paid
  invoice, an add-on after a refund, a trial), plus a real renewal that does promote.

## Update 2026-11-11: build slices 19–20 (the restriction email, the demo seed)

**Slice 19, the restriction email (§5 "Email").** When staff restrict an account, or one of its mailboxes, its Owners
and administrators (the services' existing `notify`: Owner, Domain, User and Billing Administrators) get a
transactional email from the platform's no-reply sender (rule 62): what was paused (the account, or the named mailbox),
the reason category in plain words, that receiving and reading keep working and forwarding and automatic replies are
paused too, and the appeal address (`SUPPORT_EMAIL`). Never the staff note, a threshold, a signal or mail content.

- **At most one per account per day:** the trust service checks the account's audit log for a
  `trust.restriction_notice_sent` in the last `RESTRICTION_NOTICE_EVERY_MS` (24 h) under the account lock; when there is
  one, `notify` is empty. Otherwise it records `trust.restriction_notice_sent` (meta `restricted`, `reason`,
  `reasonCategory`, `notified` — a count) with `also` in the restriction's own unit of work. Durable and transactional,
  so a Redis outage neither repeats nor drops it; an account restricted, lifted and restricted again the same day is
  told once.
- **Sent by the routes** after the commit (`sendRestrictionNotices`, `apps/web/src/server/mail/restriction-email.ts`),
  like the suspension notices; a failed send is logged by error name only and the change still answers 200.
- **Billing never restricts:** a refund, a dispute or an early plan end takes billing's promotion back to `new` (and a
  dispute marks the account), but no billing path sets `restricted`, so no billing change sends this email. The
  billing banner and the billing emails cover those cases.
- Pinned by unit tests (the service, the routes) and `restriction-email.int.test.ts` (the notice lands in Mailpit, once).

**Slice 20, the demo seed.** `npm run db:seed -- --demo` now resets one account per tier state on every run
(`TRUST_DEMO`, `RESTRICTED_MAILBOX` in `scripts/seed/people.ts`, `scripts/seed/trust.ts`): Free user at `new` (source
`staff`, so the hourly promotion job leaves it), Demo Family, Demo Group and Supporter at `standard` (source
`automatic`), a new "Restricted sending" account restricted for spam, and a new "Restricted mailbox" account at
`standard` whose one mailbox is restricted for abuse. Each mailbox's `mailbox.ensure` is queued so the mail server
follows; the staff restrictions appear in each account's own log; `credentials.md` lists every state. The Trust &
Safety Administrator was already seeded (`trust@anhourtec.test`). Before this, a fresh `dev:reset` left every demo
account at `new` (only migration 0044's backfill had made the existing ones `standard`).
