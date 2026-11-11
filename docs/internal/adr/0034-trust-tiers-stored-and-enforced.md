# ADR-0034: Trust tiers stored on the customer account and enforced on every sending path

**Status:** Accepted 2026-11-11 (building: slices 1–12 built; first Phase 6 slice)

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
