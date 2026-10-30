# 03 — Anti-spam and abuse

Last updated: 2026-10-30. Research: `research/deliverability.md` §6–8, `research/market-and-legal.md` §4.

Outbound abuse is the priority. One spammer on a shared IP hurts every user's inbox placement, and under CASL a host that knowingly helps spammers can be liable.

## What is public and what is not

| Public (in this repo, rendered in docs)                                    | Private (private ops repo / server env only)                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Trust tiers and their **sending limits**: `packages/shared/src/sending.ts` | Detection **thresholds** (bounce rate, complaint rate, velocity, content-score cut-offs, phone-risk scores) |
| Detection **logic** (which signals, what happens)                          | Tuned values, IP lists, provider API keys                                                                   |
| AUP                                                                        | Abuse queue contents                                                                                        |

Abuse logic can be open. Thresholds come from config (`ABUSE_*` env, supplied in production by the **private ops repo**, loaded by the worker and BFF at start) with conservative defaults in code that are safe but not the tuned values (CLAUDE.md rule 44). Self-hosters set their own.

## Inbound

- Stalwart's filter: SPF, DKIM, DMARC, ARC verification, DNSBLs, Pyzor, the FTRL classifier, greylisting for unknown senders.
- **Per-user training:** the webmail Junk/Not junk buttons set `$junk`/`$notjunk` via `Email/set`, which creates training samples in Stalwart (`research/stalwart.md` §3).
- Lookalike and phishing warnings in the webmail (display-name spoofing, punycode, first-time sender for a known contact name), with a banner and links disabled until confirmed.
- Remote images are blocked by default (privacy and tracking protection).
- **Unknown recipients are refused, never accepted and dropped** (verified 2026-10-29 on v0.16.27, `stack:verify`):
  on a local domain without a catch-all, Stalwart's directory lookup answers `550 5.1.2 Mailbox does not exist` at
  `RCPT`, inbound on 25 and on authenticated submission (465/587), so there is no backscatter and the sending server
  bounces it. A catch-all domain accepts them on purpose (paid plans, off by default). Disabled aliases are refused the
  same way. Nothing in our configuration is needed for this: `x:MtaStageRcpt` stays at its defaults (no `rewrite`, no
  RCPT `script`) and `upsertDomain` clears the catch-all on the plans' own domains. See `02-mail-infrastructure.md`
  "Unknown recipients" for the JMAP case.

## Aliases (abuse limits)

- **Live counts** per account and kind on Free (`PLANS.free.aliases` / `maskedAliases`, 403 `plan_limit`). Paid
  plans have no account-wide count (the old 1,000 "unlimited" ceiling is gone, 2026-10-29); the per-mailbox cap
  below bounds them (`ALIASES_PER_MAILBOX` × mailboxes).
- **Per-mailbox cap** (built 2026-10-29, maintainer decision): at most `ALIASES_PER_MAILBOX` (400) aliases and masked
  aliases together pointing at one mailbox, on every plan (it only binds paid ones). Counted from live rows under the
  account lock; over it is 409 `alias_mailbox_limit`, audited as denied. Deleting one makes room again.
- **Yearly creation cap** (built 2026-10-29, maintainer decision; Free only): new aliases and, separately, masked
  aliases per account in any rolling `ALIAS_YEAR_DAYS` (365) UTC days (`PLANS.free.aliasCreationsPerYear`, numbers
  in `ALIAS_CREATIONS_PER_YEAR`: aliases 10 as decided; masked 20, a placeholder to confirm). Masked aliases keep
  their own limits because they are the privacy feature (one address per site), and a shared count would make
  people reuse them. Counted from creations in `alias_creation_day` (kept 366 days), so deleting gives no slot back
  and a free account can't churn through more than the cap of fresh platform-domain addresses a year. Same
  transaction, same account lock, fails closed; over it is 429 `alias_yearly_limit`, audited as denied, with the
  date a slot comes back (the day the oldest counted creations leave the window).
- **Daily creation cap** (built 2026-10-29): creations per account per UTC day, aliases and masked aliases separately
  (`PLANS[plan].aliasCreationsPerDay`, placeholders in `ALIAS_CREATIONS_PER_DAY`), an extra brake on top of the
  others (on Free it is no looser than the yearly cap, so it binds paid plans in practice). It counts creations, not
  live rows, so a create → use once → delete loop can't hand out an unlimited stream of fresh addresses. Counted in
  Postgres in the create's own transaction under the account lock, so it holds under races and fails closed; over
  the cap is 429 `alias_daily_limit`, audited as denied.
- Order of checks in `createAlias`: live count → per-mailbox → yearly → daily (the most informative refusal wins). A
  refused create records nothing. The published numbers are the limits themselves (`docs/public/aliases.mdx`);
  nothing else about detection is.
- **Per-caller rate limit** `aliasCreate` (60/hour, fail-closed Redis; `rate-limits.md`).
- **Admin lock** (built 2026-10-29): an alias an account administrator turns off can't be turned back on, or deleted
  and re-added, by its own person (403 `alias_admin_locked`); an administrator lifts it (`roles.md` guard rail 18).
  It gives an account's admins a way to stop one person's abused address without taking the mailbox away.

## Outbound

Server-side only, never only in the UI (rule 27). There are two layers:

1. **Control plane** (before submission is accepted, in the BFF and an SMTP policy hook later): per-account rolling counters (messages/hour, messages/day, recipients/message), stored in Redis and **fail-closed**.
2. **Stalwart:** `MtaInboundThrottle` keyed by `authenticatedAs` (returns `451 4.4.5` over the limit), `MtaOutboundThrottle` keyed by sender, queue quotas, and outbound spam scanning of authenticated mail (enabled; off by default upstream).

### Trust tiers

The limits are the values in `packages/shared/src/sending.ts` (`TRUST_TIERS`); refer to it, don't copy numbers here.

| Tier         | Who                                          | Movement                                                                                                                    |
| ------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `new`        | Every new account                            | → `standard` automatically after an account-age and clean-history window (private threshold), or immediately on a paid plan |
| `standard`   | Established free accounts, all paid accounts | → `trusted` after a longer clean paid history                                                                               |
| `trusted`    | Long-standing paid accounts                  | Manual or automatic, reviewed                                                                                               |
| `restricted` | Anyone, automatically or by Trust & Safety   | Sending paused (receive keeps working). Leaves only by Trust & Safety review.                                               |

### Free-tier risk (research recommendation, flagged to the owner)

Every comparable privacy-focused provider we looked at that offered open free signup later added gates — invites, verification, approval holds or paid-only signup (`research/deliverability.md` §7). Recommended launch posture:

- Free sign-up stays **gated**: `SIGNUP_MODE` is `open` only while the console sits behind the production firewall IP allow-list, otherwise `closed`; plus risk-based **phone verification**.
- Free accounts in `new` **cannot send to external domains until verified and a minimum account age passes**. Internal delivery works immediately (a model other providers use successfully).
- Free outbound moves to a **separate outbound IP** before free signups open to the public (`01-architecture.md` v2).
- Per-recipient counting, not per-message.

Status: proposed in `09-roadmap.md` Phase 6 exit criteria. The final decision is the owner's.

**Built 2026-10-23 (ADR-0021), while sign-up is open on pre-staging:** free `@<platform domain>` addresses are gated
by a confirmed console email (link sent at sign-up), one per Free account, fail-closed creation limits per account and
per client address (`platformMailboxAccount`, `platformMailboxIp`), a rate-limited availability check that answers
only available / not available, 4–32-character names with a reserved list (short names held back from squatters), and
no reuse of a retired name by another account. Everything is audited; the platform audit shows staff the full client
IP of sign-ups, reset requests and confirmations. **Still open — the main risk while sign-up is open:** sending limits
for free mailboxes (trust tiers stored and enforced, fail-closed outbound counters, `new`-tier external-sending hold)
are Phase 6; today a free mailbox sends under the same server-side limits as any other. Phone verification (SMS/OTP)
remains the intended sign-up gate before a public launch. Until then: watch Platform → Accounts and the platform audit,
and close sign-up (`SIGNUP_MODE=closed`) on abuse.

**Maintainer decision, 2026-10-23 (security review run-27, item 2 — risk accepted):** free platform-domain mailboxes may
send to external addresses **with no extra restriction until Phase 6**, and sign-up stays open. The risk: abuse from
free mailboxes damages the reputation of the platform domain and our outbound IP — the same domain and IP that
transactional mail (password resets, invites, email confirmation links) depends on, so a listing would also break
sign-in recovery for everyone. Mitigation until Phase 6: staff watch Platform → Customer accounts and the platform
audit (full client IPs for Global Administrators), and close sign-up (`SIGNUP_MODE=closed`) or suspend accounts and
mailboxes on abuse. The fix is Phase 6 (trust tiers stored and enforced, fail-closed outbound counters, the `new`-tier
external-sending hold, a separate free-tier outbound IP).

### Shared mailboxes and distribution lists

Lists multiply one message into many deliveries, so they are an abuse amplifier (`10-collaboration.md`):

- **Members-only posting by default**; "anyone can post" needs trust tier ≥ standard and is off by default. Stalwart lists accept any sender, so we enforce posting with a generated system Sieve rule plus a BFF check.
- **Expanded recipients count** against the sender's per-hour/day limits (each list member = one recipient).
- Caps on members per list, lists per account and external members per list; values live in the private ops config (rule 44), published limits in `packages/shared` when the feature ships.
- Send as from a shared mailbox counts against the **sending person's** limits and trust tier, not the shared mailbox's.
- Header `From` must be one of the sender's permitted identities (closes the spoofing gap found in the Phase 0 probe).
- Forwarding to external addresses requires confirmation by the destination and counts against limits; SRS is on.

### Bulk sending add-on (`11-bulk-sending.md`, ADR-0015)

- Separate sending subdomain, return-path, DKIM selectors, outbound IP pool and queue — bulk never shares
  reputation with personal mail. Submission only through our campaign sender (no SMTP AUTH for bulk).
- Activation and the first campaigns are reviewed by Trust & Safety; consent records are mandatory; RFC 8058
  one-click unsubscribe; automatic suppression of hard bounces and complaints.
- Automatic pause at complaints ≥ 0.3 %, bounces ≥ 5 %, a spam-trap hit or a blocklisting of the bulk pool
  (thresholds are configurable in the private ops config, rule 44).
- Disclaimers and signatures (ADR-0014) are added in our submission path before DKIM signing, so they never
  break authentication; they are not a channel for promotional content on base plans.

### Sender identity and outbound scanning (Phase 1 results)

- **Header From = envelope sender** for every authenticated submission (ADR-0019, `sender-identity` Sieve system
  script). Stops users showing another address — ours or anyone's — in mail we DKIM-sign. The same script deletes
  every `Authentication-Results` header from submitted mail (2026-10-28), so a sender can't plant passing results
  for a recipient's webmail to show (`02-mail-infrastructure.md`, `07-security.md` "Authentication results in the
  webmail"); `stack:verify` checks it. Since 2026-10-30 a `Sender:` must be exactly one address, and one that
  differs from the envelope sender passes only with the web app's keyed send-on-behalf tag (ADR-0019 update,
  ADR-0026 §8); mail-app (SMTP) users can't send on behalf.
- **Outbound spam scanning:** `MtaStageData.enableSpamFilter` defaults to `is_empty(authenticated_as)` (inbound
  only). Enabling it for authenticated mail (`true`) in dev let a GTUBE message through with no verdict and no
  headers — inconclusive, because dev Stalwart has no internet and the spam rule set
  (`SpamSettings.spamFilterRulesUrl`, GitHub) never downloads, so scanning runs without rules. Recommendation:
  pin the rules bundle locally like the admin UI (hash-checked `file://` URL), then re-test outbound with
  `scoreReject` for submissions only (reject, never silently drop, so the user sees it) and our own outbound
  checks in front (rate limits, recipient caps, trust tiers). Until then outbound scanning stays at the default.
- **Mail to a non-existent local address** submitted over JMAP: re-checked 2026-10-29 (handoff item 14). Stalwart
  creates the `EmailSubmission` and refuses the local recipient inside it: `deliveryStatus[<address>]` is
  `delivered: "no"`, `smtpReply: "550 5.1.2 Mailbox does not exist."`, and **no DSN** is sent (there is no setting for
  one; `x:DsnReportSettings` only shapes DSNs). SMTP clients see the 550 at `RCPT`. Nothing is accepted and lost on the
  server, but a JMAP client that ignores `deliveryStatus` shows the mail as sent: the webmail must read it after
  sending (or pre-check local recipients) and tell the sender. `stack:verify` pins this behaviour.

## Platform reputation (CLAUDE.md rule 62)

- **Nothing promotional from our domains.** The platform domains (`anhourmail.com`, `anhourtec.com`), the MX/HELO
  hostname and the shared outbound IPs carry person-to-person mail and our own transactional mail only. Marketing,
  newsletters and bulk sending (Phase 10 add-on) are allowed only from a customer's own verified domain, DKIM-signed
  with that domain's keys, on a separate sending path (dedicated IPs or a separate subdomain and throttles), so a bulk
  sender can never damage the reputation personal mail depends on. Free platform-domain addresses never get bulk
  sending.
- **Watch it:** blocklist checks for the platform domains and IPs, postmaster and feedback-loop dashboards, DMARC
  aggregate and TLS-RPT reports, bounce codes that name a block (Phase 6 monitoring and alerts).
- **When a receiving server blocks us:** occasionally a smaller or stricter mail server refuses our mail. Treat it as
  an incident: read the bounce for the listing or the server's policy, request delisting or contact its postmaster the
  same day, find and stop the cause (usually one abusive or compromised sender), and record it in the deliverability
  runbook. Target: resolved within a day or two. Never rotate domains or IPs to get around a block.

### Designed never to be blocked: the big receivers' sender requirements

The large mailbox providers (Gmail, Yahoo/AOL, Microsoft Outlook.com/Hotmail, Proton and others) publish what they
require of senders and enforce it with temporary and permanent rejections (`research/deliverability.md` §3). Our
`anhourmail.com` mail can cross their 5,000-a-day "bulk" line once there are a few thousand users, and our IPs are
shared by everyone, so we meet the **bulk** rules for all mail from day one. The binding limit is the spam-complaint
rate: aim below **0.1 %**, never reach **0.3 %** (Gmail Postmaster) — one abusive account can push a shared IP over it,
so prevention comes before the queue.

| Requirement (who enforces it)                                                 | Our design                                                                                                                                                                                                                                                                     | Status                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| SPF and DKIM on every message, aligned with From (all)                        | SPF in the DNS templates (`~all` on customer domains, which may also send through other services; the platform domains' records are set in the ops DNS); Stalwart signs Ed25519 + RSA-2048 per domain; From must equal the signed-in account (ADR-0019 sender-identity script) | Built (DNS published per domain at go-live)                  |
| DMARC published, aligned (all bulk senders)                                   | DMARC in the platform and customer templates; rollout `none → quarantine → reject` after clean reports                                                                                                                                                                         | Built in templates; `reject` at Phase 8–9                    |
| Forward-confirmed reverse DNS (PTR) matching the HELO name (Gmail, Microsoft) | `mx1.<domain>` is the PTR target and EHLO name                                                                                                                                                                                                                                 | Pre-staging live-server item (rDNS); required before Phase 7 |
| TLS for transmission (Gmail)                                                  | Stalwart offers and uses STARTTLS/implicit TLS; MTA-STS `testing → enforce`; TLS-RPT                                                                                                                                                                                           | Built; `enforce` after clean TLS-RPT (Phase 6)               |
| RFC 5322-valid messages, no impersonation (Gmail)                             | One From, one Sender, valid Message-ID enforced at submission (ADR-0019); webmail builds messages server-side                                                                                                                                                                  | Built                                                        |
| Spam rate < 0.1 %, never 0.3 % (Gmail, Yahoo)                                 | Trust tiers with sending limits (`packages/shared/src/sending.ts`), new-account ramps, per-account daily caps, fail-closed outbound counters, outbound content scanning, automatic `restricted` on complaint or bounce spikes, `abuse@` workflow                               | Limits in shared; enforcement and automation Phase 6         |
| Complaint feedback loops (Gmail Postmaster, Microsoft SNDS/JMRP, Yahoo CFL)   | Register every outbound IP and `anhourmail.com`; opaque per-account token in Message-ID so redacted complaints map to an account                                                                                                                                               | Phase 7 (registration at go-live)                            |
| No forwarding of mail that fails checks (protects our DKIM and IPs)           | Forwarding guard: no redirect of DMARC failures or unpassed own-domain mail (ADR-0019 "forwarding and DMARC"); SRS for redirects still open                                                                                                                                    | Guard built 2026-10-30; SRS open                             |
| One-click unsubscribe (RFC 8058) for marketing mail (Gmail, Yahoo, Microsoft) | Only bulk/marketing sending needs it; that is Phase 10, from customers' own domains on a separate path (rule 62)                                                                                                                                                               | Phase 10                                                     |
| Warm, consistent volume from new IPs (Microsoft, Gmail)                       | 4-week warm-up plan (`research/deliverability.md` §6) on the production IPs; clean IP and /24 screening before use                                                                                                                                                             | Phase 7                                                      |
| Not on blocklists                                                             | Screen IPs and /24 before use; monitor the major DNS blocklists and postmaster dashboards; alert on bounce codes that name a block                                                                                                                                             | Phase 6 (monitoring) / Phase 7 (screening)                   |
| Separate reputation for risky traffic                                         | New and free accounts ramp slowly; bulk (Phase 10) never shares the personal-mail IPs or the platform domains                                                                                                                                                                  | Ramps Phase 6; bulk Phase 10                                 |

**Finding blocks before users do:** the deliverability watch (bounce classifier, blocklist checks, canary inboxes, provider
reputation data, a staff Deliverability page and Sev-1/Sev-2 alerts) is planned in `09-roadmap.md` Phase 6.

**When a block happens anyway** (an obscure or strict server, or a provider's temporary deferral): the playbook in the
section above — read the bounce, fix the cause (usually one sender), request delisting or contact that postmaster the
same day, record it; resolved within a day or two. A block at a large provider is a Sev-1 incident.

## Events from Stalwart (Phase 1 prototype)

`x:WebHook` (Community) posts batched events `{"events":[{id, createdAt, type, data}]}`, signed with
`X-Signature: base64(HMAC-SHA256(key, raw body))` (verified). Useful types: `auth.success`, `auth.failed`,
`auth.too-many-attempts`, `delivery.completed`, `delivery.failed`, `delivery.dsn-perm-fail`,
`delivery.dsn-temp-fail`, `delivery.rate-limit-exceeded`, `incoming-report.abuse-report` (ARF complaints).
Auth events carry `accountName`, `accountId`, `listenerId` (`imaps`, `pop3s`, `submissions`, `http` = JMAP), `remoteIp`
and, for failures, `reason`. Signals for detection: bursts of `auth.failed` per account (credential stuffing),
sign-ins from new networks, `dsn-perm-fail` ratio and abuse reports per sender (bounce/complaint spikes →
auto-restrict). Note: in dev `remoteIp` is the mail forwarder's container address; production must expose
Stalwart directly (or use PROXY protocol) so client IPs survive.

## Detection

| Signal                                                                                                                | Source                                                   | Action                                                   |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Hard-bounce spike                                                                                                     | Stalwart DSNs / delivery WebHook events                  | Auto-`restricted` + abuse event                          |
| Complaints (FBL/JMRP/Yahoo CFL, `abuse@` reports)                                                                     | FBL ingestion (opaque per-account token in `Message-ID`) | Abuse event; threshold → `restricted`                    |
| Velocity (sudden volume, many new recipients)                                                                         | Control-plane counters                                   | Throttle, then `restricted`                              |
| Outbound content score                                                                                                | Stalwart spam filter on submissions                      | Reject or hold + abuse event                             |
| Compromised account (new country/device then a burst of sends, many failed logins, app password created then a burst) | Audit + Stalwart auth WebHook events                     | Force sign-out everywhere, `restricted`, notify the user |
| Signup farming (same device/IP/phone patterns, disposable phone numbers)                                              | Signup flow                                              | Block or require extra verification                      |
| Blocklist listing of our IPs                                                                                          | Daily sweep (scheduler)                                  | Page operator                                            |
| Hosting provider anti-spam block on our IP                                                                            | Provider API poll                                        | Page operator                                            |

Each produces an `AbuseEvent` (`04-data-model.md`) and an audit entry.

Prevention, built 2026-10-23: a password found in public breach data is refused at sign-up, reset, invite acceptance
and for every mailbox password (k-anonymity range check, only a hash prefix leaves the server; `07-security.md`
"Breached-password check"), so credential stuffing with leaked passwords has less to work with.

## Escalation

1. Automatic: throttle → `restricted` (sending paused) with a notice in the console and an email to the account's recovery address.
2. Trust & Safety review (abuse queue): restore, keep restricted, or suspend (sign-in blocked, mail kept, export allowed for 30 days unless legally barred).
3. Close: data deleted after the retention window. Severe cases (CSAM, credible threats) are preserved and reported per legal obligations; this path is documented in a runbook.
4. `abuse@anhourmail.com` and `postmaster@` are monitored (RFC 2142), with first response ≤ 24 h.

### Staff suspension (built 2026-10-23)

Until the Phase 6 abuse queue exists, a Global Administrator suspends by hand (`platform.account.suspend`; roles.md
guard rail 17; code `packages/core/src/platform/suspension.ts`). Procedure:

1. Confirm the signal in the platform audit and the account's page (Platform → Customer accounts → the account):
   sign-ups and sign-ins from one network, abuse reports to `abuse@`, a receiving provider's complaint, a legal order.
2. Choose the scope. **Suspend account** when the account itself is the problem (every mailbox stops: no sign-in,
   sending or receiving; mail kept; its people can still sign in to the console, where every account action is
   refused with a notice). **Suspend person** (People tab) when one person's login is compromised or abusive in an
   otherwise fine account (their sessions end, their console sign-in is refused, the mailboxes assigned to them stop,
   in any account). Staff and yourself can't be suspended, and nobody can suspend while acting as someone.
3. Pick the reason category (spam, abuse, phishing or impersonation, payment, legal, other — what the customer sees)
   and write the internal note: ticket or report reference, what you saw. The note never leaves staff views.
4. Confirm with a fresh step-up. The customer is emailed the category and the appeal address (`SUPPORT_EMAIL`).
5. Appeals arrive at `support@anhourtec.com`. To restore, open the account and **Lift suspension**: only the mailboxes
   the suspension stopped come back (within a minute or two); ones the customer had suspended stay suspended.

Mail sent to a suspended mailbox is bounced (Stalwart `emailReceive` denied; `SUSPENDED_PERMISSIONS`). Nothing is
deleted; closing an account after a suspension is a separate, later decision. The webmail refuses a suspended mailbox,
or any mailbox of a suspended person, within 30 s, open sessions included (`packages/core/src/webmail/access.ts`).
Stalwart refuses a suspended mailbox's right password like a wrong one, so the webmail sign-in says the mailbox is
blocked only to a browser that signed in to it before; anyone else sees an ordinary failed sign-in, so the message
can't be used to learn which addresses exist.

**Planned (Phase 6, not built):** per-account staff metrics on the account page — outbound volume, bounces,
complaints and blocklist hits — so the decision in step 1 doesn't depend on outside reports.

## AUP summary (full text in the public legal pages, Phase 2)

- No bulk, marketing or unsolicited commercial email on the base plans (CASL; `BULK_MAIL.allowedOnBasePlans = false` in `packages/shared`). Newsletters to opted-in lists are allowed **only** through the paid bulk add-on, which runs on a separate domain and IP pool with its own controls (below).
- No phishing, malware, fraud, harassment, illegal content, or impersonation.
- No address harvesting, list-washing, or using us to relay for another service.
- No reselling accounts. No automated account creation.
- We may throttle, restrict or suspend to protect deliverability. We tell you why unless the law forbids it.
- Staff never read mail content to investigate abuse. Decisions use metadata (volumes, bounces, complaints, headers of reported messages supplied by the reporter).

## CASL posture (`research/market-and-legal.md` §4)

- The carrier exemption covers mere transmission only. The CRTC position is that a host can be liable for **aiding** contraventions, so we keep a strict AUP, an abuse desk, documented enforcement, and records of actions.
- Account invites are transactional mail sent at an account admin's request: generic subject, inviter text only in the
  body, per-caller `invite` rate tier and a per-account daily cap (`INVITE_EMAILS_PER_DAY`, counting resends;
  `07-security.md` "Invites"), so the invite form can't be used to spam arbitrary addresses at volume.
- Our own mail (invites, product news) needs consent records (express consent with timestamp, source and IP) and a working unsubscribe that is honoured within 10 business days (we aim for immediately).
