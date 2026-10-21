# 09 — Roadmap

Last updated: 2026-10-21. Each phase ends with its exit criteria met, the full test suite green (rule 37), docs current, and a handoff entry.

## Phase 0 — Research, docs, scaffold (this phase)

- Research in `research/`; internal docs, ADRs, roles, audit; agent definitions; repo scaffold with ports-and-adapters, the Waitlist example slice, RBAC matrix stubs, audit module, CI workflow.
- Dev stack: Postgres, Redis, Stalwart v0.16.27, Mailpit; `dev.test` seeded; mail between mailboxes visible via JMAP; nothing relays outside Mailpit.
- **Exit:** owner review of docs and open questions; `stack:verify`, lint, typecheck, unit, `test:rbac` and `test:e2e` green on the scaffold.

## Phase 1 — Dev stack hardening + Stalwart prototypes

Prototypes (each ends in a short ADR or a doc update):

1. **DKIM `selectorTemplate`** with fixed `am1`/`am2` selectors behind customer CNAMEs, plus our rotation flow (`02-mail-infrastructure.md`). — **Answered 2026-10-21 (ADR-0017):** a fixed template creates `am1` but never rotates without automatic DNS; the worker rotates with manual `x:DkimSignature` keys through `pending → active → retiring → retired` (verified signing selector in Mailpit). Manual keys must list signed `headers`.
2. **API key as Bearer on `/jmap`** for management only. Confirm that it cannot read mail data, and use it instead of the dev admin outside dev. — **Answered (ADR-0017):** key owned by an admin service account, `Replace` permissions `authenticate` + `sys*` domain/account/DKIM; manages domains/accounts; `Mailbox/get`/`Email/query` on users → `forbidden`.
3. **Stalwart `x:WebHook`** delivering auth and delivery events to the worker (IMAP/SMTP/JMAP sign-ins for audit, bounces for abuse).
4. **Push vs `maxConcurrentRequests`:** does a long-lived WebSocket/EventSource count? Size the BFF accordingly. — **Answered (ADR-0018):** channels don't count; the limit of 4 is enforced on requests (`jmap:error:limit`), so the BFF queues ≤ 4 in flight per user + one upstream WebSocket.
5. **BFF session acquisition:** the headless OAuth code flow (`/api/auth` → `/auth/token`) end to end, and where the mailbox secret comes from on first webmail open. — **Answered (ADR-0018, `05-webmail.md` "Session acquisition"):** works with PKCE; 1 h access + refresh tokens; password change revokes both; the mailbox secret comes from the user at webmail sign-in and is never stored.
6. Outbound spam scanning for authenticated mail: behaviour and actions.
7. **Folder depth and Archive** (ADR-0014): confirm `maxMailboxDepth` is ignored for batched creates and report
   upstream; Archive folder created at provisioning; BFF limits in place. — **Answered:** limit 10 enforced for single creates, bypassed by a 14-level batched chain (BFF enforces depth; upstream report still to file); no Archive by default, `role: archive` create works.
8. **Disclaimer path** (ADR-0014): appended in our submission path before DKIM; optional DATA-stage Sieve
   (`x:MtaStageData.script`) experiment for IMAP/SMTP-client mail, kept off unless MIME and DKIM stay intact.

9. **Transport hardening + zero-access** (ADR-0016): AEAD-only cipher list, AUTH refused before STARTTLS on 143/110/587, MTA-STS `testing` + TLS-RPT, REQUIRETLS on; an automated integration test that enables per-user encryption at rest and asserts the stored blob is encrypted and decryptable only with the user key. — **Answered (ADR-0018):** TLS 1.2/1.3 only; 143/110/25 refuse clear-text auth by default; 587 offered OAUTHBEARER/XOAUTH2 before STARTTLS — removed in the dev plan + `stack:verify` check; MTA-STS default `testing`/7 d; REQUIRETLS on by default; per-user encryption at rest verified self-service end to end (automated test lands with the BFF setting in Phase 4).

Also: worker + scheduler containers, provisioning job runner, reconciler skeleton, seeded demo world complete.
**Done 2026-10-21:** provisioning queue (`provisioning_job`, SKIP LOCKED claims, backoff, give-up + audit),
worker process, Stalwart MailServer adapter, hourly reconciler (reports drift, never deletes), integration test
provisioning domain + mailbox + alias against the compose stack (runs in the CI integration job).

**Exit:** prototypes answered; provisioning a domain + mailbox + alias from a job works and is reconciled; integration tests run against the compose stack in CI.

Phase 1 also probes collaboration (`10-collaboration.md` open items): header-From enforcement for authenticated submissions (a non-member could send as a group address in the Phase 0 probe — must be closed with a regression test), send-as identity removal on group exit, per-folder share inheritance, list fan-out duplicates.

Answered 2026-10-21: **header-From enforcement** — closed (ADR-0019, `sender-identity` script, regression checks in
`stack:verify`); **outbound scanning (item 6)** — inconclusive in dev because the spam rule set can't download;
pin the rules bundle locally and re-test; **`x:WebHook` (item 3)** — events, payload shape and HMAC verified with
the dev `event-sink`; receiver design in `audit.md` "Ingesting Stalwart events". Still open from item 3: a live DSN
capture (Mailpit accepts everything; an unknown local recipient produced no DSN — see `03-anti-spam-and-abuse.md`).

## Phase 2 — Marketing site + waitlist + invites

- Landing page in the BookYourPTO style (`branding.md` marketing scale), pricing from `packages/shared`, FAQ, trust page (privacy policy PIPEDA/BC PIPA, AUP with CASL, transparency report, cost breakdown), waitlist with double opt-in, invite codes with source/UTM tracking, changelog/blog content folder, `/credits`.
- **Exit:** waitlist live behind rate limits and fail-closed checks; legal pages reviewed by counsel; zero third-party requests (verified in Playwright); Lighthouse ≥ 95 on all marketing pages.
- **Status (2026-10-21):** built — site pages, waitlist with double opt-in, staff invites from the waitlist, invite-only sign-up, zero third-party requests (e2e). Open: counsel review; mobile Lighthouse is 90–94 (desktop ≥ 98); paid-user invite codes move to Phase 5.

## Phase 3 — Control plane

- better-auth (email + password, TOTP, WebAuthn security keys/passkeys, recovery codes; admins can require a passkey), accounts, memberships and roles, act-as, domains with guided DNS and live per-record verification, mailboxes, aliases, catch-all, masked aliases (ADR-0009), app passwords (via the user's Stalwart session), quotas, audit UI, Security activity page, data export and account deletion. Collaboration (Plus/Supporter): shared mailboxes/groups, static distribution lists with members-only posting, full-access delegation, forwarding (`10-collaboration.md`).
- **Exit:** RBAC harness covers every route × role; cross-account tests return 404; audit entries asserted for every mutation; a custom domain goes from add to active in ≤ 15 min in staging; a non-member can neither post to a members-only list nor send with a shared mailbox's From (integration tests); the reconciler reports ACL/membership drift.

## Phase 4 — Webmail v1 on JMAP

- `05-webmail.md` v1 scope, BFF proxy and push fan-out, sanitiser + sandbox, image proxy. Folders: nested, favourites, archive (Archive folder created at provisioning), empty Trash/Junk, BFF-enforced depth/count limits; one signature per identity (sanitised, mirrored to JMAP Identity).
- **Exit:** performance budgets met in Playwright perf tests; XSS corpus (HTML email test suite) passes; Playwright MCP pass light/dark at 1440/390 as every role that can open webmail.

## Phase 5 — Billing

- Stripe Checkout, Portal, Tax, Supporter flow, webhooks, account lifecycle, refunds, invoices (`06-pricing-and-billing.md`). Pricing decision made.
- **Exit:** every lifecycle transition tested with Stripe test clocks; BC PST/GST position confirmed by an accountant.

## Phase 6 — Abuse controls, monitoring, backups

- Encryption at rest for the provider layer: LUKS on the mail volume (key off-disk), client-side encrypted off-server backups, DNSSEC + DANE on `mx1`, MTA-STS `enforce` after clean TLS-RPT (ADR-0016).
- Trust tiers enforced end to end, outbound counters fail-closed, Stalwart throttles pushed from the control plane, detection signals, abuse queue, `abuse@` workflow, FBL ingestion, monitoring and alerts, backups + first restore drill.
- **Decision required:** the free-tier launch posture (`03-anti-spam-and-abuse.md` "Free-tier risk").
- **Exit:** a red-team run (scripted spam attempts from new free and paid accounts) is stopped within the published limits; restore drill passes; `security-reviewer` pass on all abuse logic.

## Phase 7 — Dogfood (2–4 weeks)

- Production VPS (port 25 tested on day one), IP and /24 screening, DNS for `anhourmail.com`, Postmaster/SNDS/Yahoo registration, warm-up weeks −4 to −1 (`research/deliverability.md` "Warm-up schedule"), staff mail on AnhourMail.
- **Exit:** mail-tester 10/10; seed placement ≥ 95% inbox at Gmail/Outlook/Yahoo; zero blocklist listings; DMARC reports clean.

## Phase 8 — Invite-only beta

- Waitlist invites in waves (≤ 100, then ≤ 250, then ≤ 500), paid signups, support process, transparency page live.
- **Exit:** independent penetration test done and its summary published; spam rate < 0.1% for 4 consecutive weeks; no P1 incidents open; full `standard` security audit done; MTA-STS `enforce`; DMARC `quarantine`.

## Phase 9 — Public launch

- Paid signups open, free stays invite-gated per the Phase 6 decision, community launch posts (external marketing agents use the waitlist, invite codes and changelog only).
- **Exit:** DMARC `reject`; on-call and runbooks exercised; external pentest findings resolved.

## Phase 4.1 — Zero-access mode

- Opt-in per-user encryption at rest in the console + webmail (browser key generation, local decryption, device-side body search, recovery flow) — `12-encryption-and-security-posture.md` §4.
- **Exit:** integration test proves stored bodies are encrypted; webmail decrypts locally; key-loss warning and backup flow tested with users.

## Phase 3.1 / 4.1 — Collaboration, second wave

- Dynamic lists, send on behalf, personal send-as delegation, mail flow rules builder (compiled system Sieve), filters on shared mailboxes, admin message trace (Phase 6 mail-flow log).
- Folders and signatures second wave (ADR-0014): several signatures with new/reply defaults, signature images (embedded, no remote URLs), admin signature templates, account disclaimer (webmail/JMAP submission), search folders, folder colours, archive by year, folder rules, account clean-up policies.
- **Exit:** rules compile and validate in CI with a corpus; send-on-behalf shows correct `Sender`/`From`; all grants visible to mailbox owners; signature HTML passes the XSS corpus and remote images are refused; disclaimers are inside the DKIM-signed body (verified in Mailpit).

## Phase 10 — Newsletters and bulk sending add-on (post-launch)

- Only after personal-mail deliverability is proven (≥ 8 weeks post-launch with complaints < 0.1 %). Separate bulk IP pool + warm-up, bulk subdomain onboarding, lists/consent/imports, campaign sender in the worker, RFC 8058 one-click unsubscribe, bounce/complaint processing and suppression, Trust & Safety review queue, pricing tiers (`11-bulk-sending.md`, ADR-0015).
- **Exit:** a reviewed test sender reaches Gmail/Outlook/Yahoo inboxes from the bulk pool with DMARC alignment; one-click unsubscribe suppresses within seconds; automatic pause triggers in staging at the configured thresholds; zero tracking pixels or rewritten links in sent mail (tested).

## Later

Resource mailboxes (rooms/equipment) with calendars, calendar/contacts delegation, CalDAV/CardDAV UI, Sieve editor (v1.1), per-user encryption at rest, crypto payments, second MX, separate outbound IP pool for free vs paid (earlier if free opens wider), PGP.
