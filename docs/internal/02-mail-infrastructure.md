# 02 — Mail infrastructure

Last updated: 2026-10-21. Research: `research/stalwart.md`, `research/deliverability.md`.

## URL and hostname map

Public facts are defined once in `packages/shared/src/platform.ts`. This table explains them; it does not redefine them.

| Host / path                                                | Purpose                                                   | Served by                |
| ---------------------------------------------------------- | --------------------------------------------------------- | ------------------------ |
| `anhourmail.com`                                           | Marketing site                                            | `apps/site`              |
| `anhourmail.com/docs`                                      | Public docs (from `docs/public` + `docs/shared`)          | `apps/site` (Fumadocs)   |
| `anhourmail.com/changelog`, `/credits`                     | Changelog, open-source credits                            | `apps/site`              |
| `app.anhourmail.com`                                       | Console                                                   | `apps/web` (host-routed) |
| `mail.anhourmail.com`                                      | Webmail and same-origin JMAP proxy                        | `apps/web` (host-routed) |
| `mx1.anhourmail.com`                                       | Inbound MX for every hosted domain; PTR target; EHLO name | Stalwart :25             |
| `smtp.anhourmail.com`                                      | Client submission 465 (implicit TLS), 587 (STARTTLS)      | Stalwart                 |
| `imap.anhourmail.com`                                      | IMAP 993, ManageSieve 4190, JMAP for third-party clients  | Stalwart                 |
| `autoconfig.anhourmail.com`, `autodiscover.anhourmail.com` | Client auto-setup; customer domains CNAME here            | Stalwart / NGINX         |
| `mta-sts.anhourmail.com`                                   | MTA-STS policy (`/.well-known/mta-sts.txt`)               | NGINX (static)           |
| `status.anhourmail.com`                                    | Status page (external provider, decided later)            | —                        |

`anhourtec.com` is staff mail only (ADR-0006). No customer or free account ever lives there.

## DNS for anhourmail.com

The full record set (A/AAAA/PTR, MX, SPF with `-all`, DKIM RSA-2048 selectors, DMARC rollout `none → quarantine → reject`, MTA-STS, TLS-RPT, optional DANE with DNSSEC, SRV, CAA, Postmaster verification) is in `research/deliverability.md` "DNS record set". It is applied at go-live (Phase 7) with real IPs.

## Customer domain records

The template is **code**: `customerDomainRecords(domain, verifyToken)` in `packages/shared/src/dns.ts`. The console renders it with live per-record verification, the docs render it per DNS provider, and the worker checks it. In summary:

- **Required:** ownership TXT (`_anhourmail`), MX → `mx1`, SPF include, two DKIM CNAMEs.
- **Recommended:** DMARC, autoconfig and autodiscover CNAMEs, client SRV records.

We compare against Stalwart's own expectation (`x:Domain/get dnsZoneFile`) so the two never drift.

### DKIM

- **RSA-2048 is primary.** The largest mailbox provider does not verify Ed25519 signatures, so Ed25519 is an optional second signature only (`research/deliverability.md` §4).
- Customer domains delegate DKIM by CNAME: `am1._domainkey.<domain> → am1.<domain>.dkim.anhourmail.com` (likewise `am2`). We publish the keys behind these and rotate them without the customer touching DNS.
- **Fixed selectors — answered in Phase 1 (ADR-0017, verified 2026-10-21 on v0.16.27):**
  - `dkimManagement: {"@type":"Automatic","selectorTemplate":"am1","algorithms":{"Dkim1RsaSha256":true}}` creates
    one RSA key with selector `am1` at domain creation. With manual DNS its `nextTransitionAt` stays null: Stalwart
    never rotates it (automatic rotation needs automatic DNS management), and a fixed template would collide on
    rotation anyway. So **the worker owns rotation** with manual `x:DkimSignature` objects.
  - A manual key is `x:DkimSignature/set create {"@type":"Dkim1RsaSha256", domainId, selector:"am2",
stage:"pending", privateKey:{"@type":"Text",secret:<PEM>}, canonicalization:"relaxed/relaxed",
headers:{From,To,Date,Subject,Message-ID: true}}`. **`headers` must be set explicitly** — with an empty set the
    key was "active" but no DKIM-Signature was added (observed).
  - Stages: `pending` (published in `dnsZoneFile`, not signing) → `active` (published, signing) → `retiring`
    (published, not signing) → `retired` (removed from the zone, kept until destroyed). Verified via Mailpit: only
    `s=am1` before the swap, only `s=am2` after; `am1` left the zone when set `retired`.
  - **Rotation procedure** (worker job, every 90 days per domain): (1) generate RSA-2048 for the idle selector
    (destroy its retired key first) and create it `pending`; (2) publish its TXT at
    `<sel>.<domain>.dkim.anhourmail.com` (the customer CNAME points there; nothing changes on their side); (3) wait
    ≥ 2 × TTL and confirm the TXT resolves; (4) in one `x:DkimSignature/set`: new key `active`, old key
    `retiring` (+ `ReloadSettings`); (5) after 7 days set the old key `retired`, after 30 days destroy it. Audit
    each step (`platform.settings_changed` with domain + selector, never key material). Private keys are generated
    by the worker and sent once; they are never stored in Postgres.
- Rotation cadence: 90 days, with the next key pre-published one TTL ahead.

## Domain lifecycle

```
pending_verification ──(ownership TXT ok)──► verifying_records ──(all required ok)──► active
        │                                           │                                   │
        └──(14 days, no TXT)──► expired             └──(record breaks later)──► degraded (warn, keep receiving)
active ──(user removes)──► removing (grace 7 days; mail kept) ──► removed (Stalwart domain destroyed by an explicit job)
```

- DNS checks run in the scheduler: every 5 min for 1 h after an edit, then hourly while pending, then daily for active domains. Each check result is stored (`dns_check`) and audited when its state changes.
- A domain can only be active in one account. Claiming an already-active domain requires the ownership TXT again, and the old owner is notified.

## Stalwart configuration principles (v0.16.27)

- **Pinned** `stalwartlabs/stalwart:v0.16.27@sha256:c429b3…` (ADR-0001). It is never forked or patched. Upgrades follow `08-operations.md`.
- Since v0.16 there is **no REST management API and no TOML**. Only `config.json` (the DataStore location) is on disk. Everything else is a JMAP object under `urn:stalwart:jmap` at `POST /jmap` (`x:Domain`, `x:Account`, `x:MtaRoute`, `x:MtaOutboundStrategy`, `x:NetworkListener`, `x:MtaOutboundThrottle`, `x:WebHook`, `x:Action`, …).
- Directory changes apply immediately. Listener, route and expression changes need `x:Action ReloadSettings`.
- All access goes through `packages/stalwart-client` (rule 21). Every write is an idempotent upsert by natural key.
- Production auth is a scoped **API key** (ADR-0017, verified 2026-10-21). API keys belong to a real account, so a
  dedicated admin service account (`svc-mgmt@<system domain>`) owns it; the key uses `permissions: {"@type":"Replace",
permissions: {authenticate, sysDomain*, sysAccount*, sysDkimSignature*, …}}` (`authenticate` is required — without
  it every request is 403) plus an `allowedIps` allow-list of the control-plane hosts. Verified: it creates and reads
  domains/accounts/DKIM keys, but `Mailbox/get` and `Email/query` on a user account and other admin objects return
  `forbidden`. Caveat: `sysAccountCreate` can create Admin-role accounts, so the key is a high-value secret (vault,
  IP allow-list, rotation). The recovery admin (`STALWART_RECOVERY_ADMIN`) is **never set in production**: it works
  in normal mode too.
- **Production management key** (verified 2026-10-22 with a key holding exactly this `Replace` set; ADR-0017,
  ADR-0020; `deploy/README.md`): `authenticate`; `sysDomain*`, `sysAccount*`, `sysDkimSignature*` (directory and
  DKIM); `impersonate` + `sysAppPassword{Create,Get,Query,Destroy}` + `sysApiKey{Get,Query}` (app passwords on
  other accounts — `x:AppPassword/set { accountId }` needs owner access — and the reconciler's credential check);
  `jmapSieveScript{Get,Query,Create,Update,Validate}` + `jmapBlobUpload` + `jmapBlobGet` (the managed Sieve script,
  05-webmail.md "Settings"). With that set and `impersonate`: `Email/query`, `Email/get`, `Mailbox/get` and
  `Blob/lookup` on a customer account → `forbidden`, so the key can't find mail. **But `jmapBlobGet` downloads any
  blob whose id it already holds, an email's raw message included** (verified): the key never lists blob ids, and
  blob ids aren't derivable without the content, but this is a real capability — a separate key for the Sieve writer
  (no `sys*`) and one for app passwords (no `jmap*`) is the planned hardening (ADR-0020). `Replace`-type app password
  permissions are not used: Stalwart only lets a caller grant permissions it holds itself, which would need mail
  permissions on this key.
  **What the key can do to a mailbox anyway** (by design, so it is watched): `impersonate` + `sysAppPasswordCreate`
  lets it mint an app password with any permissions (even `Inherit`) on any mailbox, and `impersonate` + the Sieve
  writes let it install a `redirect` on any account. The hourly reconciler reports both: app passwords without a row
  or with unexpected permissions (`reconcileAppPasswords`), and managed scripts that aren't ours, redirect anywhere
  but the confirmed forwarding target, or use extensions the webmail never writes (`reconcileManagedScripts`, which
  re-queues `mailbox.ensure` and never deletes or rewrites).
- Stalwart's HTTP listener has no host port. On the public client host (`imap.`), NGINX proxies only what mail,
  contact and calendar apps use — `/jmap` (JMAP for third-party clients, `CLIENT_ENDPOINTS`), `/dav/*` and
  `/.well-known/{jmap,carddav,caldav}` — and **must not expose `/api/*`, `/auth/*`, `/admin` or the OAuth/OIDC
  discovery documents** (`/api/auth` turns an app password into an account-wide token; `deploy/README.md`). The
  webmail never uses that host: its JMAP goes through our BFF, not a pass-through.
- Add a 587 submission listener (not created by default). Keep the default POP3S listener on 995: IMAP, POP3, SMTP submission, ManageSieve and JMAP are all offered (`packages/shared/src/platform.ts` `CLIENT_ENDPOINTS`).
- Outbound spam scanning of authenticated mail is **off by default** in Stalwart (`MtaStageData.enableSpamFilter`). We turn it on and pair it with control-plane limits (`03-anti-spam-and-abuse.md`).
- **Transport security** (ADR-0016, ADR-0018; verified 2026-10-21): listeners allow only TLS 1.2/1.3 (`TlsVersion` has
  no older values; 993 negotiated TLS 1.2 ECDHE-ECDSA-AES256-GCM and 587 STARTTLS negotiated TLS 1.3); set
  `tlsDisableCipherSuites` to leave AEAD suites only. **Clear-text auth by default:** IMAP 143 advertises
  `LOGINDISABLED` and refuses LOGIN, POP3 110 refuses USER/PASS, port 25 refuses AUTH — but **587 offered
  OAUTHBEARER/XOAUTH2 before STARTTLS** (default `x:MtaStageAuth.saslMechanisms` rule `local_port != 25 →
[oauthbearer, xoauth2]`). We remove that rule so no mechanism is offered until TLS (`infra/stalwart/dev-plan.ts`,
  same setting in production; `stack:verify` checks it). Outbound `x:MtaTlsStrategy` default `startTls/dane/mtaSts: optional` (enforced wherever the destination publishes a policy), `allowInvalidCerts: false`. Inbound `x:MtaSts` (default `mode: testing`, `maxAge` 7 days — verified) `testing` → `enforce`, `x:TlsReportSettings` on, DANE TLSA on `mx1` once the zone is DNSSEC-signed. `x:MtaExtensions.requireTls` on (RFC 8689; default `true`, verified).
- **Encryption at rest (opt-in zero-access):** `x:Email.encryptAtRest` true server-wide; per user `x:PublicKey` + `x:AccountSettings.encryptionAtRest` (`Aes256`, `encryptOnAppend: true`) set through our BFF. Community feature, verified end to end (`research/encryption.md` §3.2).
- **Catch-all** (paid plans, customer domains only): `x:Domain.catchAllAddress` set to the chosen mailbox's address by
  the worker's `domain.ensure` job, only while that mailbox is `active` (`CatchAllRepository.targetAddress`); unset,
  unknown recipients are refused at `RCPT` (`550 5.1.2 Mailbox does not exist`). Takes effect without a reload and
  may point at a mailbox on another of the account's domains (verified 2026-10-22). Suspending or deleting the
  mailbox clears it in the control plane and re-queues the domain (`turnOffCatchAllFor`); the platform domains never
  get one.
- ARC: verification only (sealing was removed in 0.16). SRS for forwarding.
- Masked email (`x:MaskedEmail`) and undelete are Enterprise. We implement masked aliases as account aliases plus our own metadata (ADR-0009).

## Dev mail flow

`docker compose --profile dev up` (ADR-0011):

- Stalwart and Mailpit sit on **`mailnet`, an `internal: true` Docker network** with no route to the internet. `mail-edge` (socat) forwards host ports (bound to `DEV_BIND_ADDRESS`, default 127.0.0.1) into that network, inbound only. Ports are in CLAUDE.md (43xxx scheme).
- The dev plan (`infra/stalwart/dev-plan.ts`, applied by the seed) sets the outbound strategy so every non-local recipient routes to the **`mailpit` Relay route**. Local domains (`dev.test`, demo domains) deliver locally.
- **Pyzor is disabled in dev only.** It is a network lookup, and Stalwart refuses to reload while it can't resolve. Production keeps it on.
- The Stalwart admin WebUI bundle is pinned (v1.0.11, sha256-checked), served via `file://` `resourceUrl` from a read-only mount, because Stalwart has no egress. Stalwart needs one restart after the bundle changes.
- `npm run stack:verify` proves it: alice → bob over JMAP; external recipient → Mailpit; `curl` from the Stalwart container to the internet fails.
- Tests that need "external" delivery use a second local domain or Mailpit. Nothing leaves the machine (rule 19).
