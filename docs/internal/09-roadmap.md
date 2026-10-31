# 09 — Roadmap

Last updated: 2026-10-31 (names as one source and the file-storage lockdown deployed at 6545a16; trusted image senders planned, ADR-0027). Each phase ends with its exit criteria met, the full test suite green (rule 37), docs current, and a handoff entry.

## Path to production (as of 2026-10-29)

Where we are: Phases 0–2 done; Phase 3 control plane and Phase 4 webmail built for local dev (see the phase status
lines below and the handoff's "Current state"); the private staging setup (`anhourmail-ops`) is rehearsed end to end
locally — three scoped Stalwart keys behind an internal management proxy, NGINX path/host guards, backups, key
rotation, smoke checks. Pre-staging has run on one VM since 2026-10-23; the handoff lists what it proved and the
live-server fixes still open (Stalwart's own certificate, the mail-only submission network, backups and the restore
drill). The order below is the shortest route to a public launch; each step keeps the phase exit criteria further
down.

**Current work plan (maintainer, 2026-10-29):** finish everything up to Phase 6, not Phase 6 itself — the
next-session items below, then the product gaps a beta needs (step 2), then Phase 5 billing and migration (step 3).
Abuse controls, monitoring and backups (Phase 6, step 4) come after. Billing code in this public repo holds only what
is fine to publish: the Stripe integration behind a port with a fake, webhook signature checks, plan facts already on
the pricing page. Keys, Stripe product and price ids and account settings live in `.env` or the private ops repo.

**Next session (first):** the remote-image proxy. The webmail blocks remote images and says "Loading images through
our privacy proxy is coming soon", with "Load images" disabled (`components/webmail/message-body.tsx`
`BlockedImages`). Build `/img/<signed-url>` as `05-webmail.md` describes (no cookies or referrer, size cap,
content-type checks, the sender never sees the reader's IP), with SSRF guards (public addresses only, checked again
after every redirect and DNS answer), a rate-limit tier, "Load images" enabled, remembered per sender, then the
Reading settings "always ask / allow for contacts", the notice copy, public docs and a changelog entry.

**Next session (second) — done 2026-10-29:** one composer, rich text by default. The footer's "Rich text / Plain text" switch
(`components/webmail/composer.tsx`, `role="radiogroup"` "Message format") goes; the formatting toolbar is always
there, and plain text becomes a "Plain text mode" item in a composer "More options" menu (keeping the existing
confirmation before formatting is dropped), as conventional webmail composers do. A reply to a plain-text message
can still start in plain text. The toolbar grows to undo/redo, font family and size, text colour, alignment and
indent/outdent; each new style passes the outgoing allow-list sanitiser (`server/webmail/outgoing-html.ts`, only
the properties and values it needs) with tests and a `/security-review`, then e2e, public docs and a changelog entry.
Built as described: `components/webmail/format-toolbar.tsx` + `format-options.ts`, the More options menu in
`composer.tsx`, value grammars (`STRICT_CSS`) in `outgoing-html.ts` (07-security.md "Outgoing HTML"), e2e
`tests/e2e/webmail-compose.spec.ts`.

**Maintainer decisions (2026-10-29), now in the work plan:**

- **Free sign-up:** no SMS/OTP provider. Keep console email confirmation; add a self-hosted proof-of-work check (no
  third-party requests) and tighter sign-up rate limits; sending ramps for new free mailboxes stay in Phase 6.
- **Alias limits:** free platform-domain accounts 10 aliases at a time and 10 new per rolling year (deleting doesn't
  return a yearly slot); paid accounts up to 400 addresses per mailbox; the per-day creation cap stays as a brake — **built
  2026-10-29** (`plans.ts` `ALIAS_CREATIONS_PER_YEAR`, `ALIASES_PER_MAILBOX`; `03-anti-spam-and-abuse.md`).
- **Leavers and delegation:** removing a member offers to convert their mailbox to a shared mailbox and turn their
  sign-in off; admins grant Full access, Send as or Send on behalf on any mailbox to chosen people, and delegated
  mailboxes open in the delegate's webmail (pulls the `10-collaboration.md` delegation work forward). **Sign-in part
  built 2026-10-30:** removing someone releases their mailboxes as shared addresses with a new password nobody is
  shown and their app passwords revoked (07-security.md "Leavers"); delegation is next — **designed 2026-10-30**
  (ADR-0026, accepted: per-person grants, BFF-held mailbox tokens, shared mailbox = person-less mailbox with members).
  **Control-plane part built 2026-10-30** (ADR-0026 slices 1–7): plan flag and limits, `delegation.manage.any` for
  User Administrators (guard rail 8), `mailbox_delegation` (migration 0029), the delegation service, the removal's
  "Give full access to …", Convert to shared mailbox and the grant cascades. **Also built 2026-10-30:** console
  routes and UI (slices 8–9), the send-on-behalf exception in the sender-identity script with a per-message,
  five-minute tag (slice 10), the webmail open/gate and Shared with you on the server (11–12), sending as and on
  behalf (13). The webmail screens (slice 14, Open another mailbox, writing from a shared mailbox) and their e2e, docs and
  changelog are built too. **Left:** password-less shared mailboxes and mail-app (IMAP) access to delegated mailboxes
  (later ADRs). **Maintainer decision 2026-10-30:** no auto-mapped "Shared with you" list in the webmail
  for now; shared mailboxes open only with Open another mailbox, in a tab of their own (ADR-0026 update). **Delegation
  follow-up (later):** show each shared mailbox as a folder tree of its own under the person's mailbox in the webmail
  sidebar, in the conventional enterprise layout (the mailbox's name, expandable to Inbox, Drafts, Sent, Deleted,
  Archive and Junk).
- **Names:** the mailbox display name is the one source; a person's own mailbox follows their profile name unless an
  admin sets another; the webmail sender name shows the same value (CLAUDE.md rule 61). **Built 2026-10-31**
  (`04-data-model.md` "Names", ADR-0014 update): `mailbox.display_name` null = follow the person; Profile "Edit name";
  Mailboxes → Display name "Use the person's name" / Custom; webmail Sender name edits the person's name; the worker
  writes the description and the webmail renames identities with the session's token (migrations 0030, 0031).

**Also built 2026-10-30 (maintainer reports from pre-staging):** writing from a shared mailbox's own tab, "Shared with you" removed from the webmail (shared mailboxes open only with Open another mailbox; sidebar folder trees per shared mailbox are a future item), remote images treat mail submitted on our own server as a verified sender (keyed `X-AnhourMail-Internal` marker, stripped from port-25 mail; ADR-0019), and the forwarding guard: managed forwarding skips mail failing DMARC and own-domain mail without a pass for that domain (maintainer decision; ADR-0019 "forwarding and DMARC").

**Next session, in order** (details: the two paragraphs above and the handoff's "Next phases" 0–0f):

1. ~~The remote-image proxy~~ — done 2026-10-29 (signed links per session and mailbox, SSRF-guarded fetch; auto-load
   only for a verified From).
2. ~~One composer that starts in rich text, with plain text moved into a "More options" menu~~ — done 2026-10-29.
3. ~~Folder counts that go stale~~ — done 2026-10-29 (one coalesced reload after every change; the poll includes
   `Mailbox/changes`).
4. ~~The Archive fix~~ — done 2026-10-29: Stalwart's `x:Email.defaultFolders` creates Archive for new mailboxes,
   a one-off backfill in the Stalwart bootstrap adds it to existing ones, and the webmail says so when a mailbox
   has none (ADR-0014 update).
5. ~~Signatures~~ — done 2026-10-29 (named, rich, embedded images only, defaults for new and for replies; mirrored to
   the mail server's identity within its 2 KB limit).
6. ~~Avatars: photo upload on console Profile and in webmail Account, synced everywhere~~ — done 2026-10-29
   (ADR-0022: one re-encoded photo per person or person-less mailbox in Postgres, served same-origin). The name check
   found the console name and the webmail sender name are separate values (now labelled so; `04-data-model.md`
   "Names"); the sender name now follows them as one source (built 2026-10-31, "Names" above).

7. **Pre-staging on one VM (now, deployed 2026-10-23; live-server fixes open).** Deploy `anhourmail-ops` topology A
   on the chosen provider (`deploy.md`): real DNS, ACME certificates, rDNS, inbound and outbound mail with a real
   external mailbox, mail-tester score, DMARC/TLS-RPT reports arriving, first encrypted off-box backup and a restore
   drill. Things only a real host can prove: certificates, DNS/PTR, port 25, DOCKER-USER firewall rules, backup
   upload.
   **Exit:** smoke 100% on the real host; a customer domain verified and mailboxes sending and receiving externally;
   mail-tester ≥ 9/10; restore drill passes; `security-reviewer` pass on the deployed config.
8. **Close the product gaps a beta needs** (Phases 3–4 remainder): free `@anhourmail.com` sign-up with SMS/OTP
   verification (provider to choose) — **free addresses built 2026-10-23** (ADR-0021: claim from the console with a
   confirmed email, one per Free account, name rules, no reuse, staff create; SMS/OTP and Phase 6 sending limits for
   free mailboxes still open); **since built:** multipart text + HTML sending (the only mail-tester deduction on the
   first pre-staging run), Add a user, shared addresses and Make this a user; console → webmail session handoff
   (**built 2026-10-29**, ADR-0024: one-time browser-bound code, throwaway mail-server credential, own mailbox only,
   never while acting), data export and account deletion (**built 2026-10-29**, ADR-0025: sealed control-plane
   archives built by the worker, mail streamed from the person's own webmail session, deletion with a 14-day grace
   period, own-login deletion), act-as (**built 2026-10-29**, ADR-0023: read-only support
   access, audited, visible to account admins), remote-image proxy, push sync in
   the webmail (it polls every 30 s today), webmail settings part 2 (rules, templates; a person's own "Always load images from" list in Settings → Reading — addresses and domains they can see, add and remove, kept in the mailbox on the mail server, images loading only for a verified From; then an account-wide "Trusted image senders" list for Owners and User Admins, verified-only and audited — maintainer, 2026-10-31; no request-to-allow-list workflow), and the leftover open items
   in the handoff (alias admin-lock, daily alias creation cap, provisioning-queue lock token, unknown-recipient
   rejection at SMTP time).
9. **Billing and migration** (Phase 5): Stripe Checkout/Portal/Tax, webhooks, plan changes and the account
   lifecycle, paid-user invite codes; pricing decision (open item 3) and Supporter minimum confirmed; mail import
   over IMAP (and OAuth from the largest providers) and contacts import, so paying customers can switch with their
   history.
10. **Abuse controls, monitoring, backups** (Phase 6): trust tiers stored and enforced, fail-closed outbound counters,
    Stalwart throttles pushed from the control plane, `x:WebHook` event ingestion (sign-ins, bounces), abuse queue and
    `abuse@` workflow, metrics and alerting, scheduled backups with a monthly restore drill, LUKS on the mail volume,
    DNSSEC + DANE, MTA-STS `enforce` after clean TLS-RPT. Free-tier launch posture decided.
11. **Production host and dogfood** (Phase 7): topology B (app VM + mail VM), IP and /24 screening, postmaster and
    feedback-loop registration, 4-week warm-up, staff mail on AnhourMail.
12. **Closed beta, then launch** (Phases 8–9): independent penetration test, full `standard` security audit, counsel
    review of legal pages and the AGPL image question, DMARC `quarantine` → `reject`.

**Security residuals carried forward** (accepted for pre-staging, revisit before beta): customers can still set `shareWith` on their own address books (closing it means creating the contact books another way first; file storage sharing was closed 2026-10-31, migration 0032); the operations key in the web
container can still do its own job through the proxy (app passwords on customers, managed Sieve) — detected by the
reconcilers, not prevented; Stalwart Community lets any account-writing key set passwords, so the proxy is the
control — keep it in front of every management caller; address-book sharing is still allowed.

## Phase 0 — Research, docs, scaffold

- Research in `research/`; internal docs, ADRs, roles, audit; agent definitions; repo scaffold with ports-and-adapters, an example vertical slice, RBAC matrix stubs, audit module, CI workflow.
- Dev stack: Postgres, Redis, Stalwart v0.16.27, Mailpit; `dev.test` seeded; mail between mailboxes visible via JMAP; nothing relays outside Mailpit.
- **Exit:** owner review of docs and open questions; `stack:verify`, lint, typecheck, unit, `test:rbac` and `test:e2e` green on the scaffold.

## Phase 1 — Dev stack hardening + Stalwart prototypes

Prototypes (each ends in a short ADR or a doc update):

1. **DKIM `selectorTemplate`** with fixed `am1`/`am2` selectors behind customer CNAMEs, plus our rotation flow (`02-mail-infrastructure.md`). — **Answered 2026-10-21 (ADR-0017):** a fixed template creates `am1` but never rotates without automatic DNS; the worker rotates with manual `x:DkimSignature` keys through `pending → active → retiring → retired` (verified signing selector in Mailpit). Manual keys must list signed `headers`. **Changed 2026-10-28:** customer domains publish their own Stalwart DKIM public keys as TXT records (read from `x:Domain/get` `dnsZoneFile`), and a domain verifies only when each selector's key is published; the am1/am2 CNAMEs are gone (`02-mail-infrastructure.md`).
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
- **Status (2026-10-29):** built (pre-staging runs 73f401d until the next deploy) — domains (DKIM TXT keys, unverified
  domains expire and release their name), mailboxes (lifecycle, passwords, display names, quotas inside the account's
  storage pool with measured usage), Add a user (mailbox, person and role in one step, first-sign-in password change),
  shared addresses and Make this a user, editable profiles, aliases and masked aliases, people/invites/roles, audit
  log, staff pages and staff suspension of accounts or people, free platform addresses, sign-in security (TOTP,
  recovery codes, passkeys, breached-password check), app passwords, catch-all; refused pages answer a real 404/403.
  staff support access (act-as, read-only, ADR-0023, 2026-10-29), data export and account deletion (ADR-0025, 2026-10-29).
  Also built 2026-10-29: alias admin lock, free-tier alias limits (10 at a time, 10 new a year; paid 400 per
  mailbox), provisioning claim tokens. Not built: collaboration and delegation (next: leavers' mailboxes to shared,
  Full access / Send as / Send on behalf), free sign-up proof-of-work check (no SMS, maintainer decision).
- **Exit:** RBAC harness covers every route × role; cross-account tests return 404; audit entries asserted for every mutation; a custom domain goes from add to active in ≤ 15 min in staging; a non-member can neither post to a members-only list nor send with a shared mailbox's From (integration tests); the reconciler reports ACL/membership drift.

## Phase 4 — Webmail v1 on JMAP

- `05-webmail.md` v1 scope, BFF proxy and push fan-out, sanitiser + sandbox, image proxy. Folders: nested, favourites, archive (Archive folder created at provisioning), empty Trash/Junk, BFF-enforced depth/count limits; one signature per identity (sanitised, mirrored to JMAP Identity).
- **Status (2026-10-29):** built (pre-staging runs 73f401d until the next deploy) — sign in (blocked and suspended
  mailboxes told why, first-sign-in password change), read (all body types, sandboxed; whole conversations; original
  message with authentication results), compose/send/undo in rich text or plain text (sanitised HTML sent as
  multipart/alternative, quoted replies), actions, restore from Trash, search, several mailboxes, contacts, automatic
  refresh with a new-mail chime and desktop notifications, settings part 1 (incl. automatic replies, confirmed
  forwarding, junk, managed Sieve), remote images through the privacy proxy, the rich-text composer, named
  signatures, profile photos, Archive. Console → webmail handoff built 2026-10-29 (ADR-0024). Not built: push sync
  (polling today), settings part 2, calendar.
- **Exit:** performance budgets met in Playwright perf tests; XSS corpus (HTML email test suite) passes; Playwright MCP pass light/dark at 1440/390 as every role that can open webmail.

## Phase 5 — Billing and migration

- Stripe Checkout, Portal, Tax, Supporter flow, webhooks, account lifecycle, refunds, invoices (`06-pricing-and-billing.md`). Pricing decision made.
- Migration (import mail and contacts) ships with billing, not after launch: paying customers switching a domain
  need their old mail and contacts on day one (moved here from Phase 8.1 on 2026-10-29). Scope below.
- **Exit:** every lifecycle transition tested with Stripe test clocks; BC PST/GST position confirmed by an accountant;
  an IMAP import of a seeded source mailbox (folders, flags, dates, duplicates) and a vCard/CSV contacts import pass
  integration tests against the compose stack, resume after a worker restart, and leave no source credentials behind.

### Migration: import mail and contacts

Make switching painless for whole accounts, not just one mailbox. Runs as worker jobs (rule 26), one job per
mailbox, resumable, with progress in the console and a summary email when done.

- **Mail import over IMAP from any provider:** source host, port, username and an app password; folders mapped onto
  ours (Inbox, Sent, Drafts, Junk, Trash, custom folders kept), flags and dates preserved, duplicates skipped by
  Message-ID, attachments and size limits respected against the account's storage pool. Source credentials are
  encrypted at rest and wiped when the job ends (rule 23).
- **One-click import from the largest hosted mail providers (OAuth):** sign in with the old provider instead of an
  app password; uses their sign-in and mail APIs (or IMAP with an OAuth token) with read-only scopes. Tokens are
  held encrypted, never logged, revoked and deleted when the job ends.
- **Contacts import:** from the same providers over OAuth (their contacts APIs) and from CardDAV, plus vCard and CSV
  upload; merged into the mailbox's address book with duplicate detection by email address.
- **Calendar import (later):** CalDAV and `.ics` upload.
- **Account-wide migration for admins:** a CSV of mailboxes (old address → new mailbox, source credentials or OAuth
  per user) run as a batch with per-mailbox status, retries and a report.
- **Ongoing sync during cut-over:** repeat the import incrementally (new mail only) until the domain's MX points at
  us, then stop.
- **Forwarding helper:** step-by-step instructions to set forwarding on the old account during the switch.
- Not SMTP: SMTP only delivers new mail; existing mail moves over IMAP or the provider's API.
- Safety: per-account rate limits and concurrency caps so imports never slow the mail server; imports never count
  toward sending limits; no mail content in logs or audit (only counts, sizes and status).
- Public docs: a migration guide per source (these may name the source provider, as user-facing setup text).

## Phase 6 — Abuse controls, monitoring, backups

- Encryption at rest for the provider layer: LUKS on the mail volume (key off-disk), client-side encrypted off-server backups, DNSSEC + DANE on `mx1`, MTA-STS `enforce` after clean TLS-RPT (ADR-0016).
- Trust tiers enforced end to end, outbound counters fail-closed, Stalwart throttles pushed from the control plane, detection signals, abuse queue, `abuse@` workflow, FBL ingestion, monitoring and alerts, backups + first restore drill.
- Staff spam/abuse metrics per account on Platform → account (outbound volume, bounces, complaints, blocklist hits),
  feeding the manual staff suspension that exists today (built 2026-10-23; `03-anti-spam-and-abuse.md` "Staff
  suspension"); later the Trust & Safety Administrator gets suspension once the abuse queue exists.
- **Deliverability watch (maintainer, 2026-10-30): find out we're blocked before users tell us** (CLAUDE.md rule 62;
  checklist in `03-anti-spam-and-abuse.md` "Designed never to be blocked"). Metadata only — provider, codes, counts,
  never content or recipient lists (rule 24); thresholds in the private ops config (rule 44). In build order:
  1. **Bounce and deferral classifier** (Phase 6, needs only our servers): Stalwart delivery events
     (`dsn-perm-fail`, `dsn-temp-fail`, rate-limited) grouped by receiving provider (Gmail, Microsoft, Yahoo/AOL,
     Proton, iCloud, GMX, then others by MX); known block signatures (policy 5.7.x rejections, rate and "unsolicited"
     deferrals, block codes that name a listing) alert at once; a deferral rise above a provider's baseline warns.
  2. **Blocklist checks** (Phase 6): a scheduler job every 10–15 min looks up each outbound IP and the sending
     domains on the main DNS blocklists (Spamhaus via a DQS key, Barracuda, SpamCop, UCEPROTECT); a new listing
     alerts with the delisting link.
  3. **Queue and report health** (Phase 6): deferred count and oldest age per destination; DMARC aggregate reports
     (who fails as us) and TLS-RPT parsed into the same view.
  4. **Canary inbox placement** (Phase 7, production only — never dev or CI, rule 19): hourly test messages to seed
     inboxes we own at the major providers; a checker records inbox, spam or missing, catching silent spam-foldering.
  5. **Provider reputation data** (Phase 7, after registration): Gmail Postmaster Tools API (domain/IP reputation,
     spam rate — alert well before 0.3 %), Microsoft SNDS, and complaint loops (JMRP, Yahoo CFL) parsed from the abuse
     mailbox and mapped to the sending account.
  - **Response:** a staff **Deliverability** page (Platform) with a per-provider status (green / warning / blocked),
    listings and dated incidents; Sev-1 (a major provider blocking us, a Spamhaus listing) pages someone, Sev-2
    (a smaller server, a deferral rise) emails; first automatic response: restrict the account a block traces to
    (complaint or bounce spike) and slow sending to the affected provider; a runbook page per provider with its
    delisting or support form. Target: action the same day, resolved within a day or two. Customer domains are
    watched too, and their owners are told when only their domain is affected.
  - **Accounts the maintainer creates before Phase 7:** seed inboxes at the major providers, Gmail Postmaster Tools,
    Microsoft SNDS + JMRP, Yahoo Sender Hub (CFL), a Spamhaus DQS key.
- **Decision required:** the free-tier launch posture (`03-anti-spam-and-abuse.md` "Free-tier risk").
- **Exit:** a red-team run (scripted spam attempts from new free and paid accounts) is stopped within the published limits; restore drill passes; a simulated block (a test listing or a forced 5.7.1 from a test receiver) raises a Sev-1 alert
  within 15 minutes; `security-reviewer` pass on all abuse logic.

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

**Constraint (CLAUDE.md rule 62):** bulk and marketing mail only from the customer's own verified domain, on a separate
sending path; never from `anhourmail.com`, `anhourtec.com` or the shared IPs personal mail uses.

- Only after personal-mail deliverability is proven (≥ 8 weeks post-launch with complaints < 0.1 %). Separate bulk IP pool + warm-up, bulk subdomain onboarding, lists/consent/imports, campaign sender in the worker, RFC 8058 one-click unsubscribe, bounce/complaint processing and suppression, Trust & Safety review queue, pricing tiers (`11-bulk-sending.md`, ADR-0015).
- **Exit:** a reviewed test sender reaches the big free mailbox providers' inboxes from the bulk pool with DMARC alignment; one-click unsubscribe suppresses within seconds; automatic pause triggers in staging at the configured thresholds; zero tracking pixels or rewritten links in sent mail (tested).

## Later

Resource mailboxes (rooms/equipment) with calendars, calendar/contacts delegation, CalDAV/CardDAV UI, Sieve editor (v1.1), per-user encryption at rest, crypto payments, second MX, separate outbound IP pool for free vs paid (earlier if free opens wider), PGP.
