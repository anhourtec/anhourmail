# 03 — Anti-spam and abuse

Last updated: 2026-10-21. Research: `research/deliverability.md` §6–8, `research/market-and-legal.md` §4.

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
  script). Stops users showing another address — ours or anyone's — in mail we DKIM-sign.
- **Outbound spam scanning:** `MtaStageData.enableSpamFilter` defaults to `is_empty(authenticated_as)` (inbound
  only). Enabling it for authenticated mail (`true`) in dev let a GTUBE message through with no verdict and no
  headers — inconclusive, because dev Stalwart has no internet and the spam rule set
  (`SpamSettings.spamFilterRulesUrl`, GitHub) never downloads, so scanning runs without rules. Recommendation:
  pin the rules bundle locally like the admin UI (hash-checked `file://` URL), then re-test outbound with
  `scoreReject` for submissions only (reject, never silently drop, so the user sees it) and our own outbound
  checks in front (rate limits, recipient caps, trust tiers). Until then outbound scanning stays at the default.
- **Mail to a non-existent local address** submitted over JMAP was accepted and silently dropped (no DSN, no
  error) in dev. Phase 3 must surface this to the sender (BFF pre-check of local recipients or DSN on).

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
| OVH anti-spam block on our IP                                                                                         | OVH API poll                                             | Page operator                                            |

Each produces an `AbuseEvent` (`04-data-model.md`) and an audit entry.

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
   sending or receiving; mail kept; its people see only a notice). **Suspend person** (People tab) when one person's
   login is compromised or abusive in an otherwise fine account (their sessions end, their sign-in is refused, the
   mailboxes assigned to them stop). Staff and yourself can't be suspended here.
3. Pick the reason category (spam, abuse, phishing or impersonation, payment, legal, other — what the customer sees)
   and write the internal note: ticket or report reference, what you saw. The note never leaves staff views.
4. Confirm with a fresh step-up. The customer is emailed the category and the appeal address (`SUPPORT_EMAIL`).
5. Appeals arrive at `support@anhourtec.com`. To restore, open the account and **Lift suspension**: only the mailboxes
   the suspension stopped come back (within a minute or two); ones the customer had suspended stay suspended.

Mail sent to a suspended mailbox is bounced (Stalwart `emailReceive` denied; `SUSPENDED_PERMISSIONS`). Nothing is
deleted; closing an account after a suspension is a separate, later decision.

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
