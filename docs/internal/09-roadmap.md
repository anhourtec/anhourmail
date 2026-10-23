# 09 — Roadmap

Last updated: 2026-10-23. Each phase ends with its exit criteria met, the full test suite green (rule 37), docs current, and a handoff entry.

## Path to production (as of 2026-10-23)

Where we are: Phases 0–2 done; Phase 3 control plane and Phase 4 webmail built for local dev (see the phase status
lines below and the handoff's "Current state"); the private staging setup (`anhourmail-ops`) is rehearsed end to
end locally — three scoped Stalwart keys behind an internal management proxy, NGINX path/host guards, backups,
key rotation, smoke checks. The order below is the shortest route to a public launch; each step keeps the phase exit
criteria further down.

1. **Pre-staging on one VM (now).** Deploy `anhourmail-ops` topology A on the chosen provider (`deploy.md`):
   real DNS, ACME certificates, rDNS, inbound and outbound mail with a real external mailbox, mail-tester score,
   DMARC/TLS-RPT reports arriving, first encrypted off-box backup and a restore drill. Things only a real host can
   prove: certificates, DNS/PTR, port 25, DOCKER-USER firewall rules, backup upload.
   **Exit:** smoke 100% on the real host; a customer domain verified and mailboxes sending and receiving externally;
   mail-tester ≥ 9/10; restore drill passes; `security-reviewer` pass on the deployed config.
2. **Close the product gaps a beta needs** (Phases 3–4 remainder): free `@anhourmail.com` sign-up with SMS/OTP
   verification (provider to choose) — **free addresses built 2026-10-23** (ADR-0021: claim from the console with a
   confirmed email, one per Free account, name rules, no reuse, staff create; SMS/OTP and Phase 6 sending limits for
   free mailboxes still open), console → webmail session handoff, data export and account deletion,
   act-as (staff, audited, visible to account admins), remote-image proxy, push sync in the webmail, webmail
   settings part 2 (rules, templates), and the leftover open items in the handoff (alias admin-lock, daily alias
   creation cap, provisioning-queue lock token, unknown-recipient rejection at SMTP time).
3. **Billing** (Phase 5): Stripe Checkout/Portal/Tax, webhooks, plan changes and the account lifecycle, paid-user
   invite codes; pricing decision (open item 3) and Supporter minimum confirmed.
4. **Abuse controls, monitoring, backups** (Phase 6): trust tiers stored and enforced, fail-closed outbound counters,
   Stalwart throttles pushed from the control plane, `x:WebHook` event ingestion (sign-ins, bounces), abuse queue and
   `abuse@` workflow, metrics and alerting, scheduled backups with a monthly restore drill, LUKS on the mail volume,
   DNSSEC + DANE, MTA-STS `enforce` after clean TLS-RPT. Free-tier launch posture decided.
5. **Production host and dogfood** (Phase 7): topology B (app VM + mail VM), IP and /24 screening, postmaster and
   feedback-loop registration, 4-week warm-up, staff mail on AnhourMail.
6. **Closed beta, then launch** (Phases 8–9): independent penetration test, full `standard` security audit, counsel
   review of legal pages and the AGPL image question, DMARC `quarantine` → `reject`.

**Security residuals carried forward** (accepted for pre-staging, revisit before beta): the operations key in the web
container can still do its own job through the proxy (app passwords on customers, managed Sieve) — detected by the
reconcilers, not prevented; Stalwart Community lets any account-writing key set passwords, so the proxy is the
control — keep it in front of every management caller; address-book sharing is still allowed.

## Phase 0 — Research, docs, scaffold

- Research in `research/`; internal docs, ADRs, roles, audit; agent definitions; repo scaffold with ports-and-adapters, an example vertical slice, RBAC matrix stubs, audit module, CI workflow.
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

## Phase 2 — Marketing site

- Landing page in the BookYourPTO style (`branding.md` marketing scale), pricing from `packages/shared`, FAQ, trust page (privacy policy PIPEDA/BC PIPA, AUP with CASL, transparency report, cost breakdown), "Get started" and "Sign in" CTAs to the console, changelog/blog content folder, `/credits`.
- **Exit:** legal pages reviewed by counsel; zero third-party requests (verified in Playwright); Lighthouse ≥ 95 on all marketing pages.
- **Status (2026-10-22):** built — site pages, zero third-party requests (e2e). A waitlist (double opt-in, staff invites from it, invite-only sign-up) was built in this phase, then removed from the product on 2026-10-22 by maintainer decision; any waitlist now runs outside the product, and sign-up is open (behind the production firewall IP allow-list) or closed. Open: counsel review; mobile Lighthouse is 90–94 (desktop ≥ 98); paid-user invite codes move to Phase 5.

## Phase 3 — Control plane

- better-auth (email + password, TOTP, WebAuthn security keys/passkeys, recovery codes; admins can require a passkey), accounts, memberships and roles, act-as, domains with guided DNS and live per-record verification, mailboxes, aliases, catch-all, masked aliases (ADR-0009), app passwords (issued by the control plane, scoped per protocol; ADR-0020), quotas, audit UI, Security activity page, data export and account deletion. Collaboration (Plus/Supporter): shared mailboxes/groups, static distribution lists with members-only posting, full-access delegation, forwarding (`10-collaboration.md`).
- **Status (2026-10-23):** built for local dev — domains, mailboxes (lifecycle, passwords), aliases and masked
  aliases, people/invites/roles, audit log, staff pages, sign-in security (TOTP, recovery codes, passkeys), app
  passwords, catch-all. Not built: act-as, data export/deletion, collaboration, free sign-up flow, quotas UI.
- **Exit:** RBAC harness covers every route × role; cross-account tests return 404; audit entries asserted for every mutation; a custom domain goes from add to active in ≤ 15 min in staging; a non-member can neither post to a members-only list nor send with a shared mailbox's From (integration tests); the reconciler reports ACL/membership drift.

## Phase 4 — Webmail v1 on JMAP

- `05-webmail.md` v1 scope, BFF proxy and push fan-out, sanitiser + sandbox, image proxy. Folders: nested, favourites, archive (Archive folder created at provisioning), empty Trash/Junk, BFF-enforced depth/count limits; one signature per identity (sanitised, mirrored to JMAP Identity).
- **Status (2026-10-23):** built for local dev — sign in, read (all body types, sandboxed), compose/send/undo,
  actions, search, several mailboxes, contacts, settings part 1 (incl. automatic replies, confirmed forwarding, junk,
  managed Sieve). Not built: image proxy, push sync, session handoff, settings part 2, calendar.
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

- Production VPS (port 25 tested on day one), IP and /24 screening, DNS for `anhourmail.com`, mailbox-provider postmaster and feedback-loop registration (`research/deliverability.md` §3), warm-up weeks −4 to −1 (`research/deliverability.md` "Warm-up schedule"), staff mail on AnhourMail.
- **Exit:** mail-tester 10/10; seed placement ≥ 95% inbox at the big free mailbox providers; zero blocklist listings; DMARC reports clean.

## Phase 8 — Closed beta

- Beta users admitted in waves (≤ 100, then ≤ 250, then ≤ 500), paid signups, support process, transparency page live.
- **Exit:** independent penetration test done and its summary published; spam rate < 0.1% for 4 consecutive weeks; no P1 incidents open; full `standard` security audit done; MTA-STS `enforce`; DMARC `quarantine`.

## Phase 9 — Public launch

- Paid signups open, free sign-up gated per the Phase 6 decision, community launch posts (external marketing agents use invite codes and the changelog only).
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
- **Exit:** a reviewed test sender reaches the big free mailbox providers' inboxes from the bulk pool with DMARC alignment; one-click unsubscribe suppresses within seconds; automatic pause triggers in staging at the configured thresholds; zero tracking pixels or rewritten links in sent mail (tested).

## Later

Resource mailboxes (rooms/equipment) with calendars, calendar/contacts delegation, CalDAV/CardDAV UI, Sieve editor (v1.1), per-user encryption at rest, crypto payments, second MX, separate outbound IP pool for free vs paid (earlier if free opens wider), PGP.
