# 02 — Mail infrastructure

Last updated: 2026-10-23. Research: `research/stalwart.md`, `research/deliverability.md`.

## URL and hostname map

Public facts are defined once in `packages/shared/src/platform.ts`. This table explains them; it does not redefine them.
Every host below `anhourmail.com` is built from the deployment's `PLATFORM_DOMAIN` (default `anhourmail.com`;
`01-architecture.md` "Platform hostnames"): a staging or self-hosted install on `staging.example.org` serves
`mx1.staging.example.org`, `_spf.staging.example.org`, `<sel>.<domain>.dkim.staging.example.org` and so on, and its
console tells customers exactly those names. The marketing site and public docs always show the product's names.

| Host / path                                                | Purpose                                                   | Served by                |
| ---------------------------------------------------------- | --------------------------------------------------------- | ------------------------ |
| `anhourmail.com`                                           | Marketing site                                            | `apps/site`              |
| `anhourmail.com/docs`                                      | Public docs (from `docs/public` + `docs/shared`)          | `apps/site` (Fumadocs)   |
| `anhourmail.com/changelog`, `/credits`                     | Changelog, open-source credits                            | `apps/site`              |
| `app.anhourmail.com`                                       | Console                                                   | `apps/web` (host-routed) |
| `mail.anhourmail.com`                                      | Webmail and same-origin JMAP proxy                        | `apps/web` (host-routed) |
| `mx1.anhourmail.com`                                       | Inbound MX for every hosted domain; PTR target; EHLO name | Stalwart :25             |
| `smtp.anhourmail.com`                                      | Client submission 465 (implicit TLS), 587 (STARTTLS)      | Stalwart                 |
| `imap.anhourmail.com`                                      | IMAP 993, POP3 995, JMAP and CardDAV for third-party apps | Stalwart                 |
| `autoconfig.anhourmail.com`, `autodiscover.anhourmail.com` | Client auto-setup; customer domains CNAME here            | Stalwart / NGINX         |
| `mta-sts.anhourmail.com`                                   | MTA-STS policy (`/.well-known/mta-sts.txt`)               | NGINX (static)           |
| `status.anhourmail.com`                                    | Status page (external provider, decided later)            | —                        |

`anhourtec.com` is staff mail only (ADR-0006). No customer or free account ever lives there.

Mail apps are told only the published ports: IMAP 993 and POP3 995 (implicit TLS), SMTP 465 (implicit TLS) and 587
(STARTTLS), JMAP/CardDAV on 443 (`clientEndpoints`). The cleartext-upgrade ports 143 and 110 and ManageSieve 4190
exist inside the dev stack only and are never published in production or advertised.

## DNS for anhourmail.com

The full record set (A/AAAA/PTR, MX, SPF with `-all`, DKIM RSA-2048 selectors, DMARC rollout `none → quarantine → reject`, MTA-STS, TLS-RPT, optional DANE with DNSSEC, SRV, CAA, Postmaster verification) is in `research/deliverability.md` "DNS record set". It is applied at go-live (Phase 7) with real IPs.

## Customer domain records

The template is **code**: `customerDomainRecords(domain, verifyToken, platform)` in `packages/shared/src/dns.ts`. The console renders it with live per-record verification and the worker checks it, both with the configured platform (`deps.platform`, from `PLATFORM_DOMAIN`); the docs render it per DNS provider with the product's published names (`PUBLIC_PLATFORM`). SPF verification looks for the include in the rendered template, so it follows the platform too. In summary:

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
- **Production auth is three scoped API keys** (ADR-0017; ADR-0020 "Credential split", verified 2026-10-23 on
  v0.16.27), never one credential that both creates accounts and acts inside one. Exact sets in
  `packages/stalwart-client/src/keys.ts`; each key is `Replace`-typed (`authenticate` is required — without it every
  request is 403), IP-restricted to the management network, expiring and rotated:

  | Key (setting)                              | Owner account   | Used by           | Can                                                                                                                                                                                                                                                     |
  | ------------------------------------------ | --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Provisioning (`STALWART_PROVISIONING_KEY`) | `svc-provision` | worker, scheduler | Domains, accounts, DKIM keys; the 186 permissions a customer mailbox keeps (so it can grant them); app passwords listed and revoked through `x:Account.credentials`. No `impersonate`                                                                   |
  | Operations (`STALWART_OPERATIONS_KEY`)     | `svc-ops`       | web               | `impersonate` + app passwords (`sysAppPassword{Create,Get,Query,Destroy}`, `sysApiKey{Get,Query}`) + the managed Sieve script (`jmapSieveScript{Get,Query,Create,Update,Validate}`, `jmapBlobUpload`, `jmapBlobGet`). No account, domain or DKIM access |
  | Audit (`STALWART_AUDIT_KEY`)               | `svc-audit`     | scheduler         | `impersonate` + `jmapSieveScript{Get,Query}` + `jmapBlobGet`: reads managed scripts for the hourly check                                                                                                                                                |
  - **Why the provisioning key holds mail permissions:** Stalwart lets a credential assign only permissions it holds,
    measured against the new account's effective set (role minus `disabledPermissions`; disabling needs nothing). The
    single key of earlier versions failed on staging with `not authorized to grant permissions: jmapPrincipalCreate, …
and 175 more`. Without `impersonate` these permissions apply to its own account only: on another account
    `Email/query`, `Mailbox/get`, `Blob/get`, `SieveScript/get` and `x:AppPassword/*` are `forbidden` and a known
    message blob id downloads as 404. It still can't grant more than a customer keeps (`roles: Admin`, `Inherit`,
    `Merge +impersonate` → `forbidden`).
  - **The operations key** with `impersonate`: `Email/query`, `Email/get`, `Mailbox/get` and `Blob/lookup` on a
    customer account → `forbidden`, so it can't find mail. **But `jmapBlobGet` downloads any blob whose id it already
    holds, an email's raw message included** (verified; the integration test asserts it so an upgrade that changes it
    is noticed); blob ids aren't listable or derivable without the content. It can mint an app password with any
    permissions (even `Inherit`) on any mailbox and install a `redirect` on any account: the hourly reconciler reports
    both — app passwords without a row or with unexpected permissions (`reconcileAppPasswords`, provisioning key), and
    managed scripts that aren't ours, redirect anywhere but the confirmed forwarding target, use extensions the webmail
    never writes or are switched off (`reconcileManagedScripts`, audit key). Report only, never deletes or rewrites.
  - **Service accounts** have no password and a **custom role equal to their key's set** (a key is capped by its
    account's role — re-verified). Not the Admin role: any key with `sysAccountUpdate` can set a password on any
    account, and that password signs in with the role's permissions (with Admin: a full administrator — verified);
    on `svc-ops`/`svc-audit` the master-user form `<mailbox>%<account>` then signs in as any mailbox over the HTTP
    management path **and the mail ports** (IMAP/POP3/SMTP — verified run-25; app passwords can't). Because Stalwart
    Community can't forbid this, production routes the apps to the management listener only through an internal
    **management proxy** (ops repo `mgmtproxy/`) that refuses credential writes, app-password/API-key writes on a
    service account, and Basic/`%` logins; Stalwart's listener binds only the proxy's and the public NGINX's networks.
    The deployment plan creates the accounts (`service-accounts.ts`) and fails on a password, app password or a key
    whose set differs; the per-minute `job:service-accounts` (`reconcileServiceAccounts`) reports any credential but
    API keys on them or a missing expected account; the app-password reconciler flags a mailbox without exactly one
    Password (`extraPasswords`); NGINX refuses the `svc-*` names and `%` publicly. A _replaced_ customer password
    (new `credentialId`, same count) isn't diffed against a stored id yet (open item; the proxy blocks the write).
  - **Start-up checks** (`credentialEnvProblems`, `verifyStalwartCredential`): in production each process has its own
    key and no other (web: operations; worker: provisioning; scheduler: provisioning + audit), never the dev admin,
    and the legacy `STALWART_API_KEY` is refused everywhere; worker and scheduler at start, and the web app before
    first use, compare `GET /api/account` with the key's exact set and refuse anything else. ESLint keeps the web app
    off the provisioning/audit clients and the worker off the operations client.
  - **Development** uses the recovery admin (`STALWART_DEV_ADMIN_*`) for all three, refused in production. The
    integration tests run with real keys of each kind (`packages/adapters/src/stalwart/credentials.int.test.ts`,
    `app-passwords.int.test.ts`). The recovery admin is **never set in production**: it works in normal mode too.
  - `Replace`-type app password permissions are not used: they could only grant what the operations key holds.

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
