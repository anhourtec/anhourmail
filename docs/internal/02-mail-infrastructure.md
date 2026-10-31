# 02 — Mail infrastructure

Last updated: 2026-10-31 (no file storage on customer mailboxes; the provisioning key's set narrows); 2026-10-30 (internal-mail marker and the inbound-headers script; send-on-behalf tag expiry, ADR-0026 slice 13). Research: `research/stalwart.md`, `research/deliverability.md`.

## URL and hostname map

Public facts are defined once in `packages/shared/src/platform.ts`. This table explains them; it does not redefine them.
Every host below `anhourmail.com` is built from the deployment's `PLATFORM_DOMAIN` (default `anhourmail.com`;
`01-architecture.md` "Platform hostnames"): a staging or self-hosted install on `staging.example.org` serves
`mx1.staging.example.org`, `_spf.staging.example.org`, `autoconfig.staging.example.org` and so on, and its
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

The template is **code**: `customerDomainRecords(domain, verifyToken, platform, dkimKeys)` in `packages/shared/src/dns.ts`. The console renders it with live per-record verification and the worker checks it, both with the configured platform (`deps.platform`, from `PLATFORM_DOMAIN`); the docs render it per DNS provider with the product's published names (`PUBLIC_PLATFORM`). SPF verification looks for the include in the rendered template, so it follows the platform too. In summary:

- **Required:** ownership TXT (`_anhourmail`), MX → `mx1`, SPF include, one DKIM TXT per signing key.
- **Recommended:** DMARC, autoconfig and autodiscover CNAMEs, client SRV records.

**DKIM records are the domain's real keys (2026-10-28).** Until then the console asked for CNAMEs to
`<selector>.<domain>.dkim.<platform>`, which nothing ever published (receivers: `dkim=permerror (no key for
signature)`). Now each key Stalwart signs with is a TXT at `<selector>._domainkey` with its full value:

- Stalwart creates the keys when the domain is added there (`dkimManagement: Automatic`: selectors
  `v1-ed25519-YYYYMMDD` and `v1-rsa-YYYYMMDD`; the RSA key appears 1–2 s after the domain). The worker's
  `domain.ensure` reads them from `x:Domain/get` → `dnsZoneFile` (`StalwartManagement.domainDkimRecords`,
  `parseDkimRecords` handles single and parenthesised multi-string TXT) and caches the public halves in
  `customer_domain.dkim_keys` (migration 0019). It waits up to about 5 s for the RSA key (`domainDkimKeys`, 20 × 250 ms,
  `packages/adapters/src/stalwart`), then fails and retries ("DKIM keys not ready yet") until one is listed.
  The console never calls Stalwart to render records.
- **Pending domains reach Stalwart once ownership and MX pass** (`checkDomain` queues `domain.ensure`), because the keys
  only exist there. Never earlier: a domain on Stalwart is local to it, so an unproven name would divert our other
  customers' mail for it; with MX already pointing at us that is no change. Catch-all stays off while pending. The job
  refuses a name another account has verified or another pending claim already put on Stalwart
  (`domainOnMailServerElsewhere`). A pending domain with a Stalwart id is removed through `domain.remove` (no direct
  row delete); one deleted while the job ran is taken off again unless another claim holds the name. The reconciler
  expects these pending domains too.
- **One claim on Stalwart per name.** The worker records the Stalwart id under a transaction-scoped lock on the
  lowercased name (`lockDomainName`, a Postgres advisory lock) and re-checks there that no other row holds it, so two
  pending claims racing through `domain.ensure` can't both own the Stalwart domain (the loser leaves it in place and
  retries with "domain is being set up by another account"). `domain.remove` only takes the name off Stalwart when no
  other row is recorded there for it.
- **Pending domains don't hold a name for good** (`packages/core/src/domains/expiry.ts`; numbers in
  `PENDING_DOMAIN`, `packages/shared/src/plans.ts`, published in the custom-domain guide). A pending claim on Stalwart
  makes the name local there: abandoned, it would block the real owner and keep our other customers' mail for that
  name inside Stalwart. So:
  - when another account's ownership and MX records are found (`checkDomain`, by the person or the 5-minute re-check)
    and a pending claim of another account holds the name on Stalwart, that claim's ownership TXT is looked up live;
    if its token is gone it is **released** (`removing` + `domain.remove`, system actor `domain-claims`, audited
    `domain.released` reason `ownership_proven_elsewhere` in the released account). While another claim holds the
    name no `domain.ensure` is queued for the newcomer; its check result says `heldElsewhere: "held"` or `"releasing"`;
  - the daily scheduler job `domain-expiry` releases a pending claim on Stalwart that wasn't verified within
    `onMailServerDays` (14) of being added (`domain.expired`, `not_verified_in_time`), or whose ownership or MX record
    is gone (`domain.released`, `records_not_found`), and deletes pending rows never put on Stalwart after
    `unverifiedDays` (30) (`domain.expired`). A failed DNS lookup never releases anything; a row that changed meanwhile
    is audited as `failed` and retried the next day. Every change is the system's, in the domain's own account log.
- Until keys are cached the template shows one `placeholder` DKIM row (can't pass, no copy button; the check message
  says the keys are being created). Verification (`checkRecords` in `packages/core/src/domains/dns.ts`) passes a key
  only when a TXT at its name has the same `p=` (whitespace and quotes ignored); otherwise "DKIM not found in DNS —
  mail will fail DKIM" or "The DKIM key in DNS is not this one". The domain stays pending until every key matches.
- **Backfill:** the `domain-recheck` scheduler job runs `backfillDkimKeys`, queueing `domain.ensure` for domains on
  Stalwart with no cached keys and no last error; a customer's Check now also re-queues it. Domains connected before
  this change get their keys without manual work, and their console shows the TXT records to publish (the old CNAMEs
  must be replaced).
- With manual DNS management Stalwart never rotates these keys (`nextTransitionAt` stays null), so the cache stays
  valid; every `domain.ensure` refreshes it anyway.

### DKIM

- **RSA-2048 is primary.** The largest mailbox provider does not verify Ed25519 signatures, so Ed25519 is an optional second signature only (`research/deliverability.md` §4).
- **Customers publish their keys as TXT records** (above). CNAME delegation with fixed `am1`/`am2` selectors and
  worker-owned rotation (ADR-0017, below) is **not built**: it needs our DNS provider's API to publish the keys under
  the platform zone. Until then rotating a customer's key means the customer publishes the new TXT first.
- **Fixed selectors — researched in Phase 1, not in use yet (ADR-0017, verified 2026-10-21 on v0.16.27):**
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
pending_dns ──(ownership TXT + MX found)──► on Stalwart, DKIM keys cached (still pending_dns)
pending_dns ──(every required record passes, each DKIM key included)──► active
pending_dns ──(never on Stalwart, 30 days)──► row deleted
pending_dns ──(on Stalwart: 14 days unverified, records gone, or proven elsewhere)──► removing ──► row deleted
active ──(user removes; no mailbox or alias left on it)──► removing ──(domain.remove)──► row deleted
```

- Statuses are `pending_dns`, `active` and `removing` (`packages/core/src/domains/entity.ts`). There is no degraded
  state: an active domain is not re-checked on a schedule, and a record that breaks later isn't reported yet.
- The `domain-recheck` scheduler job (every 5 minutes) re-checks pending domains added in the last 7 days
  (`AUTO_RECHECK_MS`; at most 50 per run, 5 per account, 3-minute budget — `RECHECK_LIMITS`) and activates the ones
  that pass; older ones wait for the customer's Check. Scheduler re-checks that fail aren't audited; a person's are
  (`domain.verify_failed`). Results aren't stored: the console checks live.
- Removal never deletes mail: a domain with mailboxes or aliases on it can't be removed. A pending domain never put on
  Stalwart is deleted at once; any other goes `removing`, and `domain.remove` takes it off Stalwart (unless another
  row is recorded there for the name), then deletes the row.
- A domain can only be active in one account. Adding a name that is active (or being removed) in another account is
  refused ("already connected to another account. Contact support"); pending claims don't block each other until one
  is on Stalwart (above).

## The platform domain (free addresses)

`PLATFORM_DOMAIN` (anhourmail.com in production) is the deployment's system domain on Stalwart — `svc-*` service
accounts, `no-reply`, `postmaster`, the reporting addresses — and, since ADR-0021, also holds customers' free addresses
(`name@<platform domain>`). It has no lifecycle above: no account owns it, it has no `customer_domain` row, customers
can't add it, and it never gets a catch-all. The deployment's bootstrap creates it (the seed does on the dev Stalwart).
Free addresses are ordinary Stalwart user accounts created by the worker's `mailbox.ensure` with the provisioning key
(the password the person chose, as an argon2id hash; a random unusable one when staff create it). The reconciler
expects only the system accounts there besides the control plane's mailboxes; any other account on it is reported as
drift. Names follow `packages/shared/src/addresses.ts` (4–32 characters, reserved names, no reuse across accounts).
Sending limits for free mailboxes are still Phase 6 (03-anti-spam-and-abuse.md "Free-tier risk").

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
  | Provisioning (`STALWART_PROVISIONING_KEY`) | `svc-provision` | worker, scheduler | Domains, accounts, DKIM keys; the 162 permissions a customer mailbox keeps (so it can grant them); app passwords listed and revoked through `x:Account.credentials`. No `impersonate`                                                                   |
  | Operations (`STALWART_OPERATIONS_KEY`)     | `svc-ops`       | web               | `impersonate` + app passwords (`sysAppPassword{Create,Get,Query,Destroy}`, `sysApiKey{Get,Query}`) + the managed Sieve script (`jmapSieveScript{Get,Query,Create,Update,Validate}`, `jmapBlobUpload`, `jmapBlobGet`). No account, domain or DKIM access |
  | Audit (`STALWART_AUDIT_KEY`)               | `svc-audit`     | scheduler         | `impersonate` + `jmapSieveScript{Get,Query}` + `jmapBlobGet`: reads managed scripts for the hourly check                                                                                                                                                |
  - **Why the provisioning key holds mail permissions:** Stalwart lets a credential assign only permissions it holds,
    measured against the new account's effective set (role minus `disabledPermissions`; disabling needs nothing). The
    single key of earlier versions failed on staging with `not authorized to grant permissions: jmapPrincipalCreate, …
and 175 more`. Without `impersonate` these permissions apply to its own account only: on another account
    `Email/query`, `Mailbox/get`, `Blob/get`, `SieveScript/get` and `x:AppPassword/*` are `forbidden` and a known
    message blob id downloads as 404. It still can't grant more than a customer keeps (`roles: Admin`, `Inherit`,
    `Merge +impersonate` → `forbidden`).
  - **Customer mailboxes keep no file storage** (2026-10-31): `CUSTOMER_DENIALS` turns off every JMAP FileNode and
    WebDAV file permission (`FILE_STORAGE_PERMISSIONS`) and the share notifications (`07-security.md` "App
    passwords"), so the provisioning key no longer holds them either. Its key set changed, so the deploy re-runs the Stalwart bootstrap to narrow its role and
    issue a new provisioning key (`08-operations.md` "Deploy step for the file storage lockdown").
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
    **management proxy** (ops repo `mgmtproxy/`) that refuses credential writes (except the mailbox password job's
    exact one-slot argon2id Password replacement on a non-service account, marked `X-AnhourMail-Credential-Write`;
    ADR-0020 "Mailbox passwords"), app-password/API-key writes on a service account, and Basic/`%` logins; Stalwart's listener binds only the proxy's and the public NGINX's networks.
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
- **Authentication-Results on submitted mail** (verified 2026-10-28 on v0.16.27): Stalwart adds `Received` and
  `Authentication-Results` only on port 25 (`MtaStageData.addReceivedHeader` / `addAuthResultsHeader` default
  `local_port == 25`), directly after one another, and never strips sender-supplied results headers. The sender
  identity Sieve script (ADR-0019, `packages/stalwart-client/src/sender.ts`) therefore also runs
  `deleteheader "Authentication-Results"` (`editheader`) on every authenticated submission, so locally sent mail
  can't carry results our server never produced; the webmail trusts only the results header directly below our own
  topmost `Received` (`07-security.md` "Authentication results in the webmail"). `stack:verify` checks the strip.
- **Sender identity script and send on behalf** (ADR-0019, update 2026-10-30; ADR-0026 §8): authenticated mail needs
  exactly one `From:` equal to the envelope sender and, if a `Sender:` is present, exactly one `Sender:` address equal
  to it — except the keyed send-on-behalf case: a `Sender:` that differs passes only with exactly one `Message-ID:` (in
  the web app's `local@host` form), exactly one `X-AnhourMail-On-Behalf-Expires: <UTC time>` not yet passed by the
  server's clock, and
  `X-AnhourMail-On-Behalf: hex sha256(K | hex sha256(K | mailbox | delegate | Message-ID | expiry))`, which only the web
  app can make and which is good for that one message for five minutes (ADR-0026 slice 13). `K` is
  `SENDER_DELEGATION_KEY` (64 lowercase hex), compiled into the `sender-identity` system script by the dev plan
  (derived from `BETTER_AUTH_SECRET` when unset) and by the production bootstrap (private ops repository); the web app
  holds the same value, the worker never. The tag and expiry headers are removed from every submission. Changing the key = re-run
  the plan (or `applySenderIdentityPolicy` + `ReloadSettings`, no restart) and redeploy the web app together.
  `stack:verify` checks the accepted, refused and stripped cases (Mailpit and a local mailbox's stored copy) and that a forged From to the sender's own mailbox is
  refused (it is: a JMAP submission whose every recipient is throttled at `RCPT` is created as "not delivered" and
  never reaches DATA, so it is no bypass).
- **Internal-mail marker** (ADR-0019 update 2026-10-30, verified on v0.16.27): with the key set, the `sender-identity`
  script removes any `X-AnhourMail-Internal` the client sent and adds its own keyed tag (bound to the envelope sender
  and the one `Message-ID`) to every authenticated submission whose recipients are all local; a second system script, `inbound-headers`, runs at DATA
  for unauthenticated sessions (`MtaStageData.script` `else` branch) and only removes that header. The webmail uses it
  to treat mail submitted here as from a verified sender (`05-webmail.md` "Remote images"). Both scripts and the DATA
  expression are written by `applySenderIdentityPolicy` (dev plan and production bootstrap), then `ReloadSettings`;
  no restart. `stack:verify` checks submission, port 25 (a copied genuine marker is removed) and redirected copies.
- **Redirect signing** (verified 2026-10-30): Sieve redirects and automatic replies are DKIM-signed by
  `x:SieveUserInterpreter.dkimSignDomain` with the forwarding mailbox's domain (the redirect's envelope sender; no
  SRS), so a redirected copy of an outside message forging one of our addresses leaves with an aligned signature.
  Mitigated (maintainer decision 2026-10-30, ADR-0019 update "forwarding and DMARC"): the managed forwarding rule
  doesn't redirect mail whose results from our server say `dmarc=fail`; the signing setting is unchanged (it also signs
  automatic replies). This relies on our own domains publishing an enforcing DMARC policy record; check on pre-staging.
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
- **Archive folder** (ADR-0014 update 2026-10-29; verified on v0.16.27): Stalwart creates an account's special folders
  the first time its store is opened, from `x:Email.defaultFolders` merged over built-in defaults whose Archive has
  `create: false` (new accounts got Inbox, Drafts, Sent Items, Junk Mail and Deleted Items only). We patch
  `defaultFolders/archive` to `{ name: "Archive", create: true, subscribe: true }` (`applyDefaultFolders`,
  `packages/stalwart-client/src/folders.ts`; needs `ReloadSettings`), so every mailbox opened afterwards gets Archive
  (role `archive`) from Stalwart, whatever created it; no worker step is involved. An account already opened never
  gains a folder from the setting, so older mailboxes are backfilled once by `backfillArchiveFolders` with the
  bootstrap's administrator credential: none of the three keys can act inside a mailbox (`Mailbox/get`/`set` →
  `forbidden`, asserted in `archive-folder.int.test.ts`). It only creates a folder or sets the role on a top-level
  folder already named Archive (names are unique at a level regardless of case); never moves, reads or deletes
  mail, and is safe to re-run. Both are applied by the dev plan and, in production, by the Stalwart bootstrap
  (`08-operations.md` "One-off steps"). Neither is checked by the reconciler yet (open: the scheduler's keys can't
  read folders or `x:Email`).
- ARC: verification only (sealing was removed in 0.16). SRS for forwarding.
- Masked email (`x:MaskedEmail`) and undelete are Enterprise. We implement masked aliases as account aliases plus our own metadata (ADR-0009).

### Unknown recipients

Verified 2026-10-29 on v0.16.27 (handoff item 14; `stack:verify` checks every case below):

- **SMTP, any listener:** mail for an address that isn't a mailbox or an enabled alias at a local domain without a
  catch-all is refused at `RCPT` with `550 5.1.2 Mailbox does not exist.`, inbound on 25 and on authenticated
  submission (465/587). The message is never accepted, so it can't be dropped and no backscatter is generated; the
  sending server bounces it. This is Stalwart's directory lookup for local domains, not a setting of ours:
  `x:MtaStageRcpt` stays at its defaults (`rewrite` and `script` false; `allowRelaying` only for signed-in senders),
  and `upsertDomain` writes `catchAllAddress: null` for the plans' own domains (dev `dev.test`; production the system
  domain), so nothing configures them to accept unknown names.
- **Catch-all domains** accept any local part at `RCPT` (`x:Domain.catchAllAddress`, paid plans only, off by default;
  "Stalwart configuration principles" above).
- **JMAP `EmailSubmission`:** the submission is created, and Stalwart refuses the local recipient inside it:
  `deliveryStatus[<address>]` becomes `{ delivered: "no", smtpReply: "550 5.1.2 Mailbox does not exist." }` with
  **no DSN** to the sender (`x:DsnReportSettings` has no switch for it). This is what looked like a silent drop. The
  webmail has to read `deliveryStatus` after sending, or pre-check local recipients, and show the sender that the
  address doesn't exist (open item for the webmail).
- **Production** needs no change: the ops staging plan sets nothing on the RCPT stage and creates the system domain
  through the same `upsertDomain`. After a deploy, an `RCPT TO:<random>@<system domain>` from outside must get 550
  (a probe that stops at `RCPT`, never sending content).

## Dev mail flow

`docker compose --profile dev up` (ADR-0011):

- Stalwart and Mailpit sit on **`mailnet`, an `internal: true` Docker network** with no route to the internet. `mail-edge` (socat) forwards host ports (bound to `DEV_BIND_ADDRESS`, default 127.0.0.1) into that network, inbound only. Ports are in CLAUDE.md (43xxx scheme).
- The dev plan (`infra/stalwart/dev-plan.ts`, applied by the seed) sets the outbound strategy so every non-local recipient routes to the **`mailpit` Relay route**. Local domains (`dev.test`, demo domains) deliver locally.
- **Pyzor is disabled in dev only.** It is a network lookup, and Stalwart refuses to reload while it can't resolve. Production keeps it on.
- The Stalwart admin WebUI bundle is pinned (v1.0.11, sha256-checked), served via `file://` `resourceUrl` from a read-only mount, because Stalwart has no egress. Stalwart needs one restart after the bundle changes.
- `npm run stack:verify` proves it: alice → bob over JMAP; external recipient → Mailpit; `curl` from the Stalwart container to the internet fails; unknown local recipients get 550 at `RCPT` (25 and 465) while a throwaway catch-all domain accepts them, and a JMAP submission to one reports the 550 in `deliveryStatus`.
- Tests that need "external" delivery use a second local domain or Mailpit. Nothing leaves the machine (rule 19).
