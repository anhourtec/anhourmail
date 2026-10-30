# Stalwart mail server: research for AnhourMail

Date: 2026-10-21

Scope: AnhourMail runs the Stalwart open-source (AGPL-3.0) edition **unmodified** and drives it only through its management API. Tenancy and plan limits live in our own control plane. Every claim is tagged with a source ID such as `[S3]`, and the URLs are listed under **Sources** at the end. Items marked **UNVERIFIED** were checked against the docs and/or source but have not been confirmed on a running server.

> **Headline finding: the plan's assumed API surface no longer exists.** Since v0.16.0 (2026-04-20), Stalwart has **removed the REST management API** (`/api/principal`, `/api/settings`, `/api/dns/records/...`, `/api/queue/...`, `/api/reports/...`, `/api/spam-filter/train`, and so on). **TOML configuration** is gone too. All configuration and management now runs over **JMAP** at `POST /jmap`, using `x:<Object>/get|set|query` methods under the `urn:stalwart:jmap` capability [S3][S2]. **Masked email is Enterprise-only** [S26][S27]. Design the control-plane integration around JMAP management objects, not REST.

---

## 1. Version, image, cadence, breaking changes, upgrades

### Current stable
- **Latest stable: `v0.16.27`, published 2026-10-18.** No pre-release is newer [S1][S2].
- The project is in a **weekly patch cadence** on the 0.16 line: 0.16.13 came out on 2026-07-12, then a release roughly every 6–8 days up to 0.16.27 on 2026-10-18 [S1].
- Minor releases: 0.13.0 (2025-07-15), 0.14.0 (2025-10-22), 0.15.0 (2025-12-16), 0.16.0 (2026-04-20) [S1]. That is roughly one minor release every 2–4 months, and the gap before 0.16 was 4 months.

### Docker image
- **Image name: `stalwartlabs/stalwart`** (Docker Hub), mirrored at `ghcr.io/stalwartlabs/stalwart` [S7][S80]. The repository was renamed from `stalwartlabs/mail-server`, which the GitHub API now redirects to the new repository id [S82]. The old Docker Hub repo `stalwartlabs/mail-server` stopped receiving tags at `v0.11` (last updated 2025-04-30) [S83]. **Do not use `mail-server`.**
- Tags published: `vX.Y.Z`, `vX.Y` (minor series), `latest`, `edge` (main branch), plus `-alpine` (musl) variants of each. Images are built for amd64 and arm64 [S5][S7].
- **Pinned tag: `stalwartlabs/stalwart:v0.16.27`**
  - Manifest-list digest `sha256:c429b311c93db5606598abc1c68225a85a6953183848ae01bee9c6a98885836c`.
  - The digest is identical on Docker Hub and GHCR. It was queried from both registries on 2026-10-21 [S5][S80].
- The docs recommend pinning `v<major>.<minor>` (for example `v0.16`) in production [S7]. Given the weekly cadence and the breaking changes noted below, AnhourMail should pin the **full patch tag plus digest** and bump deliberately.

### Breaking changes (last two minor versions plus recent patches)
**v0.16.0** (2026-04-20) [S2][S3]:
- **The REST API was replaced by the JMAP API.** The `/api/...` endpoints of earlier releases "no longer exist" [S3].
- **TOML files are gone.** The only on-disk file is a small `config.json` that holds the DataStore definition. Everything else (domains, accounts, routing, DKIM, rate limits, spam rules) is stored in the database as JMAP objects [S3][S8].
- **Account names must be email addresses** (`alice@example.com`). A bare login gets the default domain appended. DAV paths change to `/dav/cal/alice%40example.com` [S3].
- **ARC sealing was removed.** ARC verification only [S2][S34].
- The `smtp`, `imap` and `memory` directory backends were removed [S2].
- The WebUI and CLI were rewritten on the JMAP API. The old `webadmin` repo is superseded by `stalwartlabs/webui` [S2].
- Docker volumes changed. `/opt/stalwart` became `/etc/stalwart` (config) plus `/var/lib/stalwart` (data). The image now runs as **UID 2000** [S3][S6].

**v0.15.0** (2025-12-16) [S4]:
- Database schema migration that runs automatically on first start. The server is **read-only** while it runs, which can take a long time at 1,000+ mailboxes.
- Rewritten search layer, with native full-text search on PostgreSQL and MySQL.
- New FTRL-Proximal spam classifier, replacing Naive Bayes.

**Breaking patch inside 0.16 (v0.16.26, 2026-10-11)** [S2]:
- x86_64 glibc images now **require an x86-64-v2 CPU**. The server refuses to start otherwise.
- Use the `-alpine`/musl tags on old or generic virtual CPUs, such as QEMU "Common KVM processor".

### Upgrade procedure
- **Within 0.16.x:** "replace the binary (or run `docker pull`)". No manual migration is needed [S2].
- **From 0.15.x or earlier to 0.16:** an offline, multi-step migration [S3]:
  1. Upgrade to 0.15.x first.
  2. Run `migrate_v016.py dump/convert` against the live 0.15 server. It produces `config.json` and `export.json`.
  3. Stop and back up.
  4. Start 0.16 in **recovery mode** (`STALWART_RECOVERY_MODE=1`).
  5. Run `stalwart-cli apply --file export.json`.
  6. Restart normally.
  7. Recalculate quotas.
- Only accounts, groups, lists, tenants and domains (plus a few other items) are converted automatically [S3]. A zero-downtime migration proxy and the "Vandelay" importer now exist [S3][S45].
- **AnhourMail is greenfield, so none of this applies, except the rule: never skip a minor version without reading `UPGRADING/`.**

---

## 2. Configuration model and bootstrapping

### File vs database
- `config.json` holds only the **DataStore** object. A minimal RocksDB example: `{"@type":"RocksDb","path":"/var/lib/stalwart/"}`. The datastore location is "the only setting that cannot be changed through the API" [S8].
- **Everything else is stored in the datastore** as roughly 117 JMAP configuration objects, edited via WebUI, CLI or raw JMAP [S8].
- The old "local vs DB-stored keys" distinction **no longer exists** [S3][S8].
- **Change activation** [S8]:
  - **Takes effect immediately:** directory data (accounts, domains, lists, aliases, group membership).
  - **Needs `Action/ReloadSettings`:** listeners, MTA rules and expressions (routing, queue, TLS strategies, rewriting, DKIM signing), directory backends and telemetry. These are compiled into an in-memory snapshot. Cheaper narrower reloads also exist: `ReloadTlsCertificates`, `ReloadLookupStores` and `ReloadBlockedIps` [S23].
- **JSON encoding quirks** for configuration objects [S14]:
  - `List<T>` is an object keyed `"0"`, `"1"`, and so on.
  - `Set<T>` is `{"member": true}`.
  - Durations are integer milliseconds and sizes are integer bytes.
  - Wrong encodings are rejected with `invalidPatch`.

### Bootstrap and non-interactive setup
- **No `config.json` → bootstrap mode** [S9]:
  - Only the HTTP port 8080 runs (override with `STALWART_RECOVERY_MODE_PORT`).
  - Only the WebUI wizard and the `Bootstrap` object are available.
  - A random admin password is printed once to stderr.
  - `STALWART_RECOVERY_ADMIN=user:pass` pins it instead [S9][S61].
- **`config.json` present → normal start with defaults** created on first boot [S60]:
  - Default roles.
  - Default MTA routes `mx` and `local`.
  - Default listeners: `smtp` 25, `submissions` 465, `imaps` 993, `pop3s` 995, `sieve` 4190, `https` 443 (implicit TLS) and `http` 8080.
  - **There is no default 587 or 143 listener**, even though the Dockerfile `EXPOSE`s them [S60][S6].
- **Recovery mode** (`STALWART_RECOVERY_MODE=1`) [S10]:
  - Starts with all services off. The MTA, tasks and cluster are idle.
  - Exposes only HTTP 8080 with the full JMAP management API.
  - This is the documented way to pre-load configuration before mail flows [S10][S12].
- **Recovery admin** (`STALWART_RECOVERY_ADMIN=user:password`):
  - It is honoured **whenever the variable is set, including in normal mode** [S10]. The source confirms this: the variable is read at startup regardless of mode, and the auth path checks it first [S61][S56].
  - Note: the Administrators page claims it is honoured only in recovery or bootstrap mode [S55]. **That page is contradicted by the code.**
  - Treat it as a backdoor and **never set it in production** [S10].
- Other environment variables [S11]:
  - `STALWART_PUBLIC_URL`: the base URL published in OAuth, OIDC and JMAP discovery. Set it behind a reverse proxy.
  - `STALWART_HOSTNAME`, `STALWART_ROLE`, `STALWART_PUSH_SHARD`: cluster settings.
- **Documented declarative flow** [S12][S13]:
  1. Template `config.json`.
  2. Start once with `STALWART_RECOVERY_MODE=1` and `STALWART_RECOVERY_ADMIN`.
  3. Run `stalwart-cli apply` with an NDJSON plan of `upsert` / `update` / `reconcile` / `create` / `destroy` operations.
  4. Restart without the recovery variables.
  - `upsert` is idempotent and preserves server-assigned ids [S13].
  - `stalwart-cli snapshot` emits a plan from a live server [S13].
- **CLI distribution:** `stalwartlabs/cli`, latest v1.0.13 (2026-09-28). It is available as binaries and as the Docker images `stalwartlabs/cli` and `ghcr.io/stalwartlabs/cli` [S73][S74]. Auth flags: `--url`/`STALWART_URL`, `--user`/`--password`, or `--api-key`/`STALWART_TOKEN` (Bearer) [S73].

### Seeding a domain and mailboxes for dev
An official example plan [S13] shows the shape. The example uses argon2 hashes, but plaintext is also accepted: a `Password` credential secret that is not a recognised hash is strength-checked with zxcvbn and then hashed server-side [S58].

```ndjson
{"@type":"upsert","object":"Domain","matchOn":["name"],"value":{"dom-a":{"name":"anhourmail.test","dkimManagement":{"@type":"Automatic"},"dnsManagement":{"@type":"Manual"},"certificateManagement":{"@type":"Manual"},"subAddressing":{"@type":"Enabled"}}}}
{"@type":"upsert","object":"Account","matchOn":["name"],"value":{"usr-alice":{"@type":"User","name":"alice","domainId":"#dom-a","credentials":{"0":{"@type":"Password","secret":"<strong-dev-password>"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"quotas":{"maxDiskQuota":1073741824},"aliases":{"0":{"name":"hello","domainId":"#dom-a","enabled":true}}}}}
{"@type":"update","object":"SystemSettings","value":{"defaultDomainId":"#dom-a","defaultHostname":"mail.anhourmail.test"}}
```

Field shapes come from the Account and Domain references [S17][S18]. `.test` domains are explicitly accepted for test deployments [S7].

---

## 3. Management API surface (v0.16)

### Transport and auth
- **All management goes through `POST /jmap`**, with capability `urn:stalwart:jmap` and methods `x:<Object>/get`, `x:<Object>/set`, `x:<Object>/query` [S17][S3]. Standard RFC 8620 semantics apply: batching, back-references, `#creationId`.
- **Singletons** (for example `MtaOutboundStrategy` or `SystemSettings`) accept only `update` with id `singleton` [S32].
- **Doc bug:** the object reference pages show `curl -X POST https://mail.example.com/api` with JMAP bodies. In the server router, `/api` dispatches only to the helper endpoints listed below. JMAP is served at `POST /jmap` [S59]. **Use `/jmap`.**
- **Authentication** [S15][S56]:
  - HTTP `Basic` (password or app password).
  - `Bearer` with an OAuth access token, an **API key**, or an external-OIDC JWT.
  - API keys are Bearer-only, with permission modes `Inherit` / `Disable` / `Replace`, IP allow-lists and expiry [S54].
  - Administrative rights are permission sets granted through Roles. No special admin account type exists [S55].
- **OpenAPI:** `api/v1/openapi.yml` (OpenAPI 3.0.3) exists, but it covers only the helper endpoints [S16]. The JMAP object model is described by a **JSON Schema** served at `GET /api/schema` → `/api/schema/{sha256}` (gzip, immutable) [S15]. A copy also ships in the repo as `resources/schema/schema.json.gz` [S6].

### Helper (non-JMAP) HTTP endpoints [S15][S16][S59]

| Path | Purpose |
|---|---|
| `POST /api/auth` | Credential → OAuth `clientCode` (authCode or device flow). Accepts `mfaToken`. Anonymous, rate-limited. |
| `GET /api/discover/{email}` | OIDC discovery for the directory owning the domain. |
| `GET /api/account` | Effective permissions plus `edition` (`oss` / `community` / `enterprise`). |
| `GET /api/schema[/{hash}]` | JSON Schema of the configuration model. |
| `GET /api/token/{delivery\|tracing\|metrics}`, `GET /api/live/...` | SSE streams. **tracing and metrics are Enterprise-only.** |
| `/auth/token`, `/auth/device`, `/auth/introspect`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | OAuth and OIDC [S47]. |
| `/.well-known/jmap`, `/jmap/session`, `/jmap/upload/...`, `/jmap/download/...`, `/jmap/eventsource`, `/jmap/ws` | JMAP [S59][S39]. |
| `/healthz/live`, `/healthz/ready` | Health. `ready` returns 503 if no data store [S59]. |
| `/metrics/prometheus` | Prometheus scrape, with optional Basic auth [S24][S59]. |

### Mapping of the requested capabilities to v0.16 objects

| Need | v0.16 mechanism |
|---|---|
| Domains | `x:Domain/set`. Fields: `name`, `aliases`, `isEnabled`, `catchAllAddress`, `subAddressing`, `dkimManagement`, `dnsManagement`, `certificateManagement`, `reportAddressUri`. Read-only: `dnsZoneFile` [S18]. |
| Individuals and groups | `x:Account/set` with `@type: "User"` or `"Group"`. Fields: `name` (local part) plus `domainId`; `credentials`, `roles`, `permissions`, `quotas`, `aliases`, `memberGroupIds`, `locale`, `timeZone`, `encryptionAtRest` [S17]. |
| Mailing lists | `MailingList` object [S2][S85]. |
| Aliases | `Account.aliases` is a `List<EmailAlias{name, domainId, enabled, description}>`. Disable and description are available in Community [S17][S27]. Domain aliases go in `Domain.aliases` [S18]. |
| Quotas | `Account.quotas` map. `maxDiskQuota` (bytes) plus object counts: `maxEmails`, `maxMailboxes`, `maxEmailSubmissions`, `maxEmailIdentities`, `maxSieveScripts`, `maxPushSubscriptions`, `maxAppPasswords`, `maxApiKeys`, `maxMaskedAddresses`, calendars, contacts, files, and so on. `usedDiskQuota` is server-set [S17][S76]. |
| DKIM keys | `Domain.dkimManagement = {"@type":"Automatic", algorithms, selectorTemplate, rotateAfter, ...}` makes the server generate the keys. Default algorithms: Ed25519 plus RSA [S18][S20]. Manual alternative: `x:DkimSignature/set` with a PEM private key [S21][S13]. **Rotation requires automatic DNS management** [S20]. |
| DNS records | `x:Domain/get` with `properties:["dnsZoneFile"]` returns the full zone text (MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, SRV, autoconfig, CAA). CLI: `stalwart-cli get domain <id> --fields dnsZoneFile` [S7][S18]. **`/api/dns/records/{domain}` no longer exists.** Automatic publication via `DnsServer` providers (Cloudflare, Route53, RFC2136, PowerDNS, and others) [S2][S7]. |
| Settings | Individual singletons and objects (`SystemSettings`, `Jmap`, `MtaOutboundStrategy`, `SpamSettings`, and so on), then `x:Action/set` with `ReloadSettings` [S8][S23]. **`/api/settings` is gone.** |
| Queue | `x:QueuedMessage/get|query|set`: inspect, requeue, cancel [S22]. Pause or resume with `Action` `PauseMtaQueue` / `ResumeMtaQueue` [S23]. |
| Reports | Received: `DmarcExternalReport`, `TlsExternalReport`, `ArfExternalReport`. Outgoing: `DmarcInternalReport`, `TlsInternalReport` [S22]. |
| Spam training | Users train by setting the `$junk` / `$notjunk` keyword via `Email/set`, which creates a training sample (source confirms this path) [S63][S25]. Admins can upload `SpamTrainingSample` objects [S25]. Classify on demand with `Action` `ClassifySpam` [S23]. **`/api/spam-filter/train` is gone.** |
| Throttles | `MtaInboundThrottle` and `MtaOutboundThrottle` objects with `rate{count,period}`, `key` (e.g. `sender`, `senderDomain`, `rcptDomain`, `remoteIp`, `authenticatedAs`), and a `match` expression [S30]. Queue quotas use `MtaQueueQuota` [S27]. HTTP and JMAP limits live on the `Jmap` singleton [S38]. |
| Undelete | `ArchivedItem` plus `DataRetention.archiveDeletedItemsFor`. **Enterprise-only** [S29]. |
| Metrics | Prometheus at `/metrics/prometheus` via the `Metrics` singleton. OTel push is also available [S24]. **Community metrics are "Limited"** [S27]. For example, the queue-size gauge is exported only in Enterprise [S62]. Live metrics SSE and dashboards are Enterprise-only [S15][S27]. |
| Logs | Configure `Tracer` objects (console, file, journald, OTel). In Docker, use **console** [S7]. A `Log` object is browsable in the WebUI. **Trace/delivery history is Enterprise-only** [S27][S84]. |
| Reload | `x:Action/set` create `{"@type":"ReloadSettings"}`, or `stalwart-cli create Action/ReloadSettings` [S8][S23]. |

Example: create a domain via raw JMAP [S18] (endpoint corrected to `/jmap`):

```http
POST /jmap
Authorization: Bearer <api-key>
Content-Type: application/json

{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
 "methodCalls":[["x:Domain/set",{"create":{"d1":{"name":"example.com","aliases":{},
   "certificateManagement":{"@type":"Manual"},"dkimManagement":{"@type":"Automatic"},
   "dnsManagement":{"@type":"Manual"},"subAddressing":{"@type":"Enabled"}}}},"c1"],
  ["x:Domain/get",{"ids":["#d1"],"properties":["dnsZoneFile"]},"c2"]]}
```

The back-reference in `c2` follows standard RFC 8620 semantics. **UNVERIFIED** that `#d1` resolves in `x:Domain/get` on this server.

---

## 4. Catch-all, sub-addressing, aliases, masked email

- **Catch-all:** `Domain.catchAllAddress`. Leaving it unset rejects unknown recipients at SMTP time [S18][S19].
- **Sub-addressing:** `Domain.subAddressing` takes one of three variants [S18][S19]:
  - `Enabled`: `user+tag@` delivers to `user@`.
  - `Disabled`.
  - `Custom`: an expression.
- Both catch-all and sub-addressing are in Community [S27].
- **Aliases:** per-account `aliases` list (local part plus `domainId`, `enabled` flag, `description`). Domain aliases go in `Domain.aliases` [S17][S18].
- **Masked email: Enterprise-only.**
  - "Masked email is available exclusively in the Enterprise Edition ... not included in the Community Edition" [S26]. The compare table marks it Enterprise [S27].
  - It is implemented as Stalwart's own `x:MaskedEmail/get|query|set` under `urn:stalwart:jmap`. Fields: `email`, `enabled`, `description`, `forDomain`, `url`, `createdBy`, `expiresAt`, `emailPrefix`, `emailDomain` [S26].
  - It is **not** the vendor-specific MaskedEmail JMAP capability another provider publishes. No such URN appears in the v0.16.27 source. The advertised JMAP capability URNs are listed in §5 [S59].
  - Its count is capped by `quotas.maxMaskedAddresses` [S26].

### Suspending an account (verified on the pinned v0.16.27, 2026-10-22)

`x:Account` (schema `x:UserAccount`, read from `GET /api/schema`) has **no enabled/disabled flag**. Its fields are
`name`, `domainId`, `emailAddress` (server-set), `credentials`, `roles` (`User` / `Admin` / `Custom`), `permissions`
(`Inherit` / `Merge` / `Replace`, the last two with `enabledPermissions` and `disabledPermissions` sets of the
`Permission` enum), `quotas`, `aliases`, `memberGroupIds`, `memberTenantId`, `encryptionAtRest`, `locale`,
`timeZone`, `description`, `externalId`, plus server-set `createdAt` and `usedDiskQuota`. `disabledPermissions` "take
precedence over enabled permissions", including those inherited from roles.

Options considered: deleting credentials (destroys the password and every app password, not reversible), switching
the role (changes more than access), destroying the account (deletes mail). Chosen, as the least destructive:
`permissions: { "@type": "Merge", enabledPermissions: {}, disabledPermissions: { authenticate, imapAuthenticate,
pop3Authenticate, sieveAuthenticate, emailSend, emailReceive } }`; resuming sets `permissions: { "@type": "Inherit" }`
(`SUSPENDED_PERMISSIONS` in `packages/stalwart-client/src/management.ts`).

Verified against the dev stack with a throwaway domain and accounts (then destroyed):

| Check while suspended                        | Result                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| JMAP session, password                       | HTTP 403                                                                              |
| JMAP session, app password                   | HTTP 403 (the app password survives and works again after resume)                     |
| SMTP AUTH (465)                              | `550 5.7.1 Your account is not authorized to use this service.`                       |
| IMAP LOGIN (993), POP3 PASS (995)            | server closes the connection; no session                                              |
| Mail to it or an alias                       | Submitted on 465: `RCPT` and `DATA` accepted, then **not delivered** but bounced to the sender (a DSN arrived in the sender's mailbox), queue empty. Inbound on 25: `RCPT` accepted (not taken to `DATA`; local delivery is the same path) |
| Stored mail, credentials                     | unchanged (`usedDiskQuota` the same; same password signs in after resume)             |

Notes: refusal is at delivery time, not at `RCPT` (a suspended address still exists in the directory). A deleting
mailbox in our control plane also has its aliases removed from the account, so mail to them is refused at `RCPT` as
unknown recipients. DAV (`PROPFIND /dav/card/…`) returns 403 while suspended. **Limitation:** an IMAP session that
was already logged in when the suspension landed keeps working (`SELECT` and `FETCH` still succeed, also after
`x:Action InvalidateCaches`); it ends only when the client disconnects or the session times out. New mail can't reach
it (delivery is refused). A credential change doesn't end them either: on v0.16.27 an IMAP session signed in with the
account password keeps working after the password is replaced, and even after the Password credential is removed and
re-added (verified on the dev stack 2026-10-28, pinned in `packages/adapters/src/stalwart/int-imap.ts`). Only revoking
an app password cuts off a session that signed in with it. `x:Account/set { destroy }` removes the account
and its mail; the purge verifies with `x:Account/get` that the id still has the expected address first.

**OAuth tokens issued before a suspension** (verified 2026-10-22 with a throwaway `dev.test` account, then destroyed;
headless code flow with the `anhourmail-webmail` client): the old access token is refused at once — `GET /jmap/session`
→ **403** immediately and still 403 after 2 s and 8 s. A new sign-in is refused (`{type:"failure"}`). But the
**refresh grant still succeeds** and mints a new access token (which is also refused with 403), and after resuming
(`Inherit`) the **old access token works again** (200) — suspension disables the account, it does not revoke tokens.
So the webmail BFF does not rely on Stalwart alone: it checks the control-plane mailbox status at sign-in and on every
use of a session (`MailboxAccessGate`, cached ≤ 30 s), ends the session (drops the tokens) for `suspended`,
`deleting` or unknown mailboxes, and also treats an upstream 403 as "this mailbox can't be used right now".

**Client address behind the BFF** (verified 2026-10-22): `x:Http` has `rateLimitAnonymous` (100 / 60 s by default),
`rateLimitAuthenticated` (1000 / 60 s) and `useXForwarded` (default `false`); `x:Security` has `authBanRate` /
`authBanPeriod` for failed logins. Without forwarding, every webmail sign-in counts against the app's own address.
With `useXForwarded: true`, 130 anonymous `/api/auth` calls carrying `X-Forwarded-For: 198.51.100.7` got 100 × 200
then 30 × **429**, while one with `198.51.100.8` still got 200: limits follow the header. The setting is a plain
boolean (no trusted-network list; `proxyTrustedNetworks` is for the PROXY protocol on listeners), so it is only safe
while Stalwart's HTTP port is reachable from the app network alone. A throttled `/api/auth` answers **HTTP 429**.

---

### App passwords (verified on the pinned v0.16.27, 2026-10-22)

Throwaway `apppw-probe.test` domain and accounts, destroyed afterwards (ADR-0020):

- Object `x:AppPassword` (permission prefix `sysAppPassword`): `description`, `secret` (server-set, returned once by
  `/set`; `****` on `/get`), `createdAt` (server-set, second precision), `expiresAt`, `allowedIps`, `permissions`
  (`Inherit` | `Disable` | `Replace`, each with a `permissions` set of `Permission` names). No last-used field.
  The same credentials appear in `x:Account.credentials` as `@type: "AppPassword"` with a `credentialId`.
- Secret format: `app_` + 36 lowercase letters and digits.
- **Who can create:** the account itself (Basic with its password). An admin adding one through
  `x:Account/set { "credentials/1": {…} }` gets `invalidProperties` "Secondary credentials cannot be set directly".
  `x:AppPassword/set { accountId: <other account> }` works for the recovery admin, and for an API key whose account has
  `impersonate` + `sysAppPassword*`; without `impersonate` it is `forbidden` "You are not an owner of account …".
  That key has no mail access (`Email/query` / `Mailbox/get` on the other account → `forbidden`) when its `Replace`
  permissions grant no `jmap*`.
- `x:AppPassword/get|set { accountId }` lists and destroys another account's app passwords the same way.
- Ids are short and **reused** after a revocation (`b`, `c`, …): match id and `createdAt` before destroying.
- Default ceiling `maxAppPasswords` 5 per account (`overQuota` "You have exceeded your quota of 5 app passwords").
- **Limits are enforced per credential:** `Disable { imapAuthenticate }` → IMAP LOGIN refused (connection closed);
  `Disable { emailSend }` → SMTP AUTH `550 5.7.1 Your account is not authorized`; `Disable` of every `dav*` → CardDAV
  PROPFIND 403; of every `jmap*` → JMAP methods `forbidden` (the session document still answers 200).
- **`Inherit` is dangerous:** the User role grants self-service (`sysAccountPasswordUpdate`, `sysAppPasswordCreate`,
  `sysApiKeyCreate`, masked email, …), so an `Inherit` app password could mint more app passwords over JMAP (it hit
  only the quota). With those disabled, `x:AppPassword/set` answers `forbidden`.
- **OAuth escalation:** `POST /api/auth` (authCode) accepts an app password, and the token it leads to carries the
  account's full permissions (`/api/account` lists all 239), not the credential's. Never let app passwords reach
  `/api/auth` (our `StalwartOAuth.signIn` refuses them) and never expose `/api/auth` publicly.
- Suspension (`SUSPENDED_PERMISSIONS`) blocks app passwords over IMAP and HTTP (403) and resuming restores them.
- **Replacing `x:Account.credentials`** (e.g. `{ "0": { "@type": "Password", … } }` to set a password) **drops every
  app password** of the account.
- Failed-login accounting (`x:Security.authBanRate` 100 per address per day, `authBanPeriod` null = permanent): a
  refusal for a missing permission (suspended account, a protocol the app password leaves out) does **not** count;
  a wrong or revoked credential does. In dev every mail-port client is the `mail-edge` forwarder's address, which other
  test runs had already brought to the limit on 2026-10-22: one more wrong IMAP login banned it (all HTTP and mail
  ports reset) until the ban was lifted from inside the container (`x:BlockedIp/set destroy` + `ReloadBlockedIps`).

Follow-up checks (review run-21, same day, throwaway accounts destroyed):

- **`Replace` grants only what the caller holds:** an API key with `impersonate` + `sysAppPassword*` creating an app
  password with `Replace { imap* }` gets `forbidden` "You are not authorized to grant permissions: imapThread, …".
  A key that holds those permissions can grant them, but it can then read every mailbox (`Email/get`, `Mailbox/get`
  succeed with `impersonate`). `Disable` of any names works with the minimal key, so we encode allow-lists as
  "disable every other known permission".
- **`Principal/query` enumerates the server:** any user (password, OAuth token, `Inherit` or `Disable` app password)
  got all 44 accounts, although `/api/account` lists no `jmapPrincipalQuery`/`Get` for the User role. Disabling
  `jmapPrincipalQuery` blocks the query and `jmapPrincipalGet` the get. DAV doesn't enumerate: `PROPFIND /dav/pal/`
  shows only the user's own principal and a `principal-property-search` returned nothing (403 without
  `davPrincipalSearch`); CardDAV discovery and the address-book home still answer 207 without any `davPrincipal*`.
- **Account-level denials don't limit the management key:** with every self-service permission (reads included) and
  the principal reads disabled on a customer account, the key still creates, lists and destroys its app passwords;
  the user (password or token) gets `forbidden` for `x:AppPassword/*`, `x:ApiKey/*`, `x:AccountPassword/set`, while
  `Email/query`, `Identity/get` and `ContactCard/query` keep working.
- **`secret$suffix`:** an app password followed by `$123456` signs in (HTTP Basic → 200): Stalwart splits a trailing
  `$…` as a one-time code and ignores it when the credential has none.
- **Production key set** (`authenticate`, `impersonate`, `sysAppPassword{Create,Get,Query,Destroy}`,
  `sysApiKey{Get,Query}`, `jmapSieveScript{Get,Query,Create,Update,Validate}`, `jmapBlobUpload`, `jmapBlobGet`):
  `Email/query`, `Email/get`, `Mailbox/get`, `Blob/lookup` → `forbidden`; managed Sieve script get/upload/set work
  even though the account denies the user `jmapSieveScriptCreate`. **`GET /jmap/download/<account>/<blobId>` of an
  email's blob returns the raw message** when the id is known.

Third round (review run-22, throwaway accounts on two domains, destroyed afterwards):

- **DAV directory search finds other customers:** `REPORT /dav/pal/` `principal-property-search` matching "bob"
  returned `bob@` on another domain (and on `dev.test`), with a password and with an OAuth token. `PROPFIND
  /dav/pal/<address>/` confirms a known address exists (no permission found that gates it; low — like an SMTP RCPT
  probe). With `davPrincipal{Search,SearchPropSet,List,Match}` disabled the search answers 403, while phone-style
  CardDAV discovery (`/.well-known/carddav`, `current-user-principal`, `addressbook-home-set`, PROPFIND of the home,
  `PUT` of a card) and `/.well-known/caldav` still answer 207/201. `x:Sharing.allowDirectoryQueries` (already `false`
  in dev) changed none of this.
- **Sharing:** `shareWith` on `Mailbox/set` (create or update), `AddressBook/set` and `Calendar/set` is accepted for a
  plain user, and the other account then appears in the sharee's session. No permission gates it on its own: the ACL
  ones (`imapAclSet`, `dav*Acl`), share notifications and principal reads don't. Only denying the object's
  `Create`/`Update` does (folders: verified forbidden; the webmail never sends `Mailbox/set` or `Calendar/set`).
  Address books are created and updated by the webmail (contacts auto-save), so `AddressBook/set { shareWith }`
  stays possible with a mailbox password. Impersonating as the user takes the user's permissions; the admin acting on
  the account by `accountId` doesn't (the dev seed makes sample folders that way).
- **Sieve:** with only `jmapSieveScript{Create,Update}` denied, a user could deactivate our script and then destroy
  it. With `jmapSieveScriptDestroy` and `jmapVacationResponse{Create,Destroy}` also denied, destroy **and** the bare
  deactivate answer `forbidden`.

### Credential split (verified on the pinned v0.16.27, 2026-10-23)

Throwaway `twokey-probe.test` and per-run `svc-*.test`/`keys-*.test` domains and accounts, destroyed afterwards
(ADR-0020 "Credential split"; repeated by `packages/adapters/src/stalwart/credentials.int.test.ts`):

- **Granting is checked against the effective set.** A key creating or updating an account may assign only
  permissions it holds, compared with the account's effective permissions (role minus `disabledPermissions`, plus
  `enabledPermissions`). Disabling needs nothing. The User role grants 239 permissions (`GET /api/account` as a fresh
  User-role account with `Inherit`); `CUSTOMER_PERMISSIONS` disables 53 of them (plus 5 principal reads the role
  doesn't list), leaving 186. A key holding those 186 plus `authenticate` and `sys{Domain,Account,DkimSignature}*`
  (201 in all) creates a customer mailbox with `CUSTOMER_PERMISSIONS`, suspends (`SUSPENDED_PERMISSIONS`) and resumes
  it. The same key gets `forbidden` "not authorized to grant permissions" for `roles: Admin` on a customer (402
  missing), `permissions: Inherit` (the 58 denials), `Merge +impersonate`, creating an Admin account, `x:Role/set`.
  The single management key of earlier versions failed here (`… jmapPrincipalCreate, … and 175 more`).
- **No `impersonate`, no way in:** with that key, on another account `Email/query`/`Mailbox/get` → `forbidden` "You
  do not have access to account …", `Identity/get`, `SieveScript/get`, `Blob/get`, `Blob/lookup` → "You are not an
  owner of account …", `x:AppPassword/get|set` and `x:ApiKey/get` → `forbidden`, `Principal/query` → `forbidden`, and
  `GET /jmap/download/<account>/<message blob id>/…` → **404**. Its own account's mail objects work (empty).
- **Credentials through `x:Account`:** `x:Account/get { properties: [credentials] }` with `sysAccountGet` lists every
  credential: `Password` (`credentialId`, `****`), `AppPassword` (`credentialId`, `description`, `createdAt`,
  `permissions`, `****`), `ApiKey`. `x:Account/set { update: { <id>: { "credentials/<position>": null } } }` removes
  that one entry and keeps the rest (the map is keyed by list position, not credential id). `ifInState` isn't usable
  here (`x:Account/get` returns no state; a stale value answers HTTP 400).
- **Keys are capped by their account's role** (re-verified): a key with `{authenticate, sysDomainGet}` on a User-role
  account has only `authenticate` (`GET /api/account`) and `x:Domain/get` is `forbidden`; a key minted with
  `impersonate` on an account whose custom role lacks it doesn't get it. `GET /api/account` with an API key returns
  exactly what the key can do — the start-up scope check uses it.
- **A password on a service account:** any key with `sysAccountUpdate` sets a `Password` credential on any account,
  its own included (`credentials/<n>: {"@type":"Password", …}` → updated). Signing in with it gets the **account's role**
  permissions: with the Admin role that was a full administrator (`x:SystemSettings/get`, `x:NetworkListener/get`,
  `Email/query` on any mailbox). With a custom role equal to the key's set (`x:Role` `enabledPermissions`, account
  `roles: {"@type":"Custom", roleIds}`) the same sign-in had the key's 201 permissions and no more; the key itself
  still provisions. So service accounts get such a role, not Admin.
- **Operations key** (`authenticate`, `impersonate`, `sysAppPassword{Create,Get,Query,Destroy}`, `sysApiKey{Get,Query}`,
  `jmapSieveScript{Get,Query,Create,Update,Validate}`, `jmapBlobUpload`, `jmapBlobGet`) on a custom role: creates,
  lists and destroys app passwords on a mailbox, writes, reads and activates the managed script; `x:Account/get|set`,
  `x:Domain/get|set`, `x:DkimSignature/get`, `Email/query`, `Mailbox/get`, `Blob/lookup`, `x:ApiKey/set` on a mailbox
  → `forbidden`. It **can** create an `Inherit` app password on a customer (no grant check there) and download a
  message blob whose id it has (both known; reconciler and ADR-0020).
- **Audit key** (`authenticate`, `impersonate`, `jmapSieveScriptGet`, `jmapSieveScriptQuery`, `jmapBlobGet`): reads a
  mailbox's script and its active flag; `SieveScript/set` (write or deactivate), blob upload, `Email/query`,
  `x:AppPassword/get`, `x:Account/get` → `forbidden`.
- Probing with a wrong password through the dev forwarder banned the shared address at once (it was near the daily
  `authBanRate` already) and took the dev web app's Stalwart access with it until the ban was lifted from inside the
  container: never test wrong credentials against the shared dev address.

### Catch-all (verified on the pinned v0.16.27, 2026-10-22)

`x:Domain/set { update: { <id>: { catchAllAddress } } }` takes effect at once (no reload). Unset: `RCPT TO` an unknown
address → `550 5.1.2 Mailbox does not exist.` Set: the message is accepted and delivered to the catch-all mailbox (its
`To` keeps the original address). The target may be an account on another local domain. `null` clears it.

### Default folders and Archive (verified on the pinned v0.16.27, 2026-10-29)

Throwaway `archive-probe.test` accounts, destroyed afterwards (repeated by
`packages/adapters/src/stalwart/archive-folder.int.test.ts`):

- `x:Email.defaultFolders` (schema: map of `SpecialUse` → `x:EmailFolder` `{ name, create, subscribe, aliases }`,
  defaults `create: true, subscribe: true`) is `{}` out of the box, and a new account opens with Inbox, Drafts, Sent
  Items, Junk Mail and Deleted Items — the built-in Archive has `create: false` (its folder id is skipped).
- Setting only `defaultFolders/archive` (a patch path works on the singleton) merges over the built-ins: the next new
  account got all five plus Archive (role `archive`). It needs `ReloadSettings`: without one a new account still got
  five. Folders are made when the account's store is **first opened** (any `Mailbox/get`, sign-in, delivery), not at
  `x:Account/set`; an account already opened never gains a folder from the setting, reload or not.
- No `x:Action` or account maintenance task re-creates default folders. Adding one to an existing account takes
  `Mailbox/set` with owner access (the administrator by `accountId` works; all three scoped keys → `forbidden`).
- `Mailbox/set` `update { role: "archive" }` / `{ role: null }` works on an existing folder. Top-level names are
  unique regardless of case: creating "Archive" or "archive" next to an existing "Archive" → `alreadyExists` with
  `existingId`.
- IMAP shows the folder as `(\Archive) "Archive"` in `LIST … RETURN (SPECIAL-USE)`; the server also advertises
  `CREATE-SPECIAL-USE`.

## 5. JMAP

### Supported specs
The docs list these specs [S36][S27]:
- Core (RFC 8620), Mail and Submission (RFC 8621), WebSocket (RFC 8887), Blob Management (RFC 9404), Quotas (RFC 9425), Sieve (RFC 9661), Web Push VAPID (RFC 9749).
- Contacts (RFC 9610), Calendars (draft-ietf-jmap-calendars), File Storage (draft-ietf-jmap-filenode), Sharing (RFC 9670).

The v0.16.27 source advertises these capability URNs:
- `urn:ietf:params:jmap:` core, mail, submission, vacationresponse, websocket, blob, quota, sieve.
- contacts (+`:parse`), calendars (+`:parse`), filenode, principals (+`:availability`, `:owner`), `mail:share`, emailpush, webpush-vapid.
- `urn:stalwart:jmap`.

That URN list comes from a code search of `crates/` [S59]. JMAP for Calendars and Contacts are Community features [S27].

### Push
Three push mechanisms are available:
- **EventSource** at `/jmap/eventsource/?types=&closeafter=&ping=`, throttled by `eventSourceThrottle` (default 1s) [S39].
- **WebSocket** at `/jmap/ws` (RFC 8887). Push can be enabled over the socket. Settings: `websocketTimeout` 10m, `websocketHeartbeat` 1m, `websocketThrottle` 1s [S40][S59].
- **Web Push** `PushSubscription`, with optional RFC 8291 encryption and VAPID [S39][S36].

### Search
- Full-text search goes through the **SearchStore**. The default variant indexes inside the data store using bloom filters, with automatic language detection [S41].
- Dedicated alternatives: Elasticsearch/OpenSearch, Meilisearch, PostgreSQL, MySQL, FoundationDB [S41].
- PostgreSQL FTS truncates bodies and attachments at **650 KB each** because of `tsvector` limits [S42].
- With encryption-at-rest enabled, only headers are indexed [S41].

### Limits worth knowing for a BFF
These defaults live on the `Jmap` singleton [S38]:
- `maxConcurrentRequests` = **4 per user**.
- `maxMethodCalls` = 16, `maxRequestSize` = 10 MB.
- `maxUploadSize` = 50 MB, `uploadQuota` = 50 MB per window.
- `getMaxResults` = 500, `queryMaxResults` = 5000.

### Failed-login bans (verified on the pinned v0.16.27, 2026-10-22)
- After about nine wrong passwords from one address on `/api/auth`, Stalwart answers "throttled", then adds the
  address to `x:BlockedIp` (`reason: "authFailure"`, `expiresAt: null` — permanent until removed). With
  `x:Http.useXForwarded` the banned address is the forwarded one; a banned connection address has its TCP
  connections reset.
- In dev the app reaches Stalwart through the `mail-edge` forwarder, so when no client address was forwarded the
  forwarder itself was banned (twice on 2026-10-22) and every sign-in failed with "unavailable". Fixed by forwarding
  visitors' addresses in dev (05-webmail.md "Dev forwards visitors' addresses too"). Verified: 18 wrong passwords
  from `203.0.113.x` banned only that address; the forwarder stayed reachable and other clients signed in.
- Removing a ban: `x:BlockedIp/set { destroy }`, then `x:Action/set { "@type": "ReloadBlockedIps" }`.
- **Default inbound throttles** (`x:MtaInboundThrottle`, unchanged): "Sender IP throttle" (`remoteIp`, 5 / s) and
  "Sender address to recipient throttle" (`senderDomain` + `rcpt`, **25 / hour**). Over the limit, a submission's
  recipient gets `452 4.4.5 Rate limit exceeded` (`deliveryStatus.delivered: "no"`) and a submission with no
  accepted recipient is never held, so it is `final` at once and can't be undone. It isn't keyed on the client
  address (so forwarding addresses doesn't affect it), and sub-addressing doesn't get round it
  (`member+tag@` shares `member@`'s allowance). Tests that send therefore use a fresh recipient per run (integration:
  a throwaway `dev.test` account; e2e: a run-scoped mailbox from `scripts/e2e-fixtures.ts`) instead of the demo
  mailboxes, which repeated runs exhaust.
- **A throttled submission never reaches DATA** (verified 2026-10-30): with every recipient refused at `RCPT` (452),
  the DATA-stage system script (our `sender-identity`) doesn't run, and nothing is queued or delivered. So a probe
  that sees a JMAP submission *created* while the throttle is hit has not shown a bypass: check `deliveryStatus` and
  the recipient's mailbox (the unsent draft stays in the sender's own Drafts when the submission fails outright).
- **Sieve at DATA, for the keyed send-on-behalf check** (verified 2026-10-30 on v0.16.27, ADR-0026 P8 and the
  security-review follow-up): `require "vnd.stalwart.expressions"`, `let "v" "hash('…' + to_lowercase(envelope.from) +
  …, 'sha256')"` gives lowercase hex SHA-256 and nests (`hash('k|' + hash(…, 'sha256'), 'sha256')`), comparable with
  `header :is "<name>" "${v}"`; `deleteheader` removes the header before delivery and signing. `header.message-id`
  reads the id without angle brackets, case kept (the **last** one when there are several; JMAP fills one in when the
  client sets none); `header :count` counts `Message-ID:` headers. **A failed expression leaves the variable empty**
  (`hash(x, 'nosuchalgo')`, `to_lowercase(header.nosuch.addr)`), so check the shape (`string :regex "${v}"
  "^[0-9a-f]{64}$"`, extension `regex`) before comparing. `address :count` over `"sender"` counts addresses across
  every `Sender:` header (group syntax and `<>` count 0), while `address :is` is true when any one matches;
  `header.sender.addr` keeps a source route (`@relay:bob@…`). Field names with a space or tab before the colon, or in
  mixed case, are parsed as the real header. A compile error's `SetError.description` quotes the script text.
  `x:MemoryLookupKey` + `key_exists` was not readable from Sieve (P9). `x:SieveSystemScript.contents` is stored without
  its final newline.

### JMAP Contacts (verified on the pinned v0.16.27, 2026-10-22)
Probed with a demo mailbox; the webmail's contacts (05-webmail.md "Contacts") are built on these results.
- **Capability** `urn:ietf:params:jmap:contacts`. The session capability is `{}`; the account capability is
  `{"maxAddressBooksPerCard": null, "mayCreateAddressBook": true}`.
- **AddressBook:** every account has one default book (`isDefault: true`, id `b` on the demo account), named
  "Stalwart Address Book (<address>)" — that name is what phones show over CardDAV (the webmail labels it
  "My contacts"; renaming it is an open item). `AddressBook/set` create, update (`name`, `description`) and destroy
  work. Books carry `myRights`.
- **ContactCard (JSContact, RFC 9553):** create needs `"@type": "Card"`, `version: "1.0"` and `addressBookIds`.
  Verified properties: `kind` (`individual`, `group` with `members {urn: true}`), `name` (`components`
  given/surname, `isOrdered`; the server fills `full` when it's missing), `emails {id: {address, contexts|label}}`,
  `phones {id: {number, features}}`, `organizations {id: {name}}`, `notes {id: {note}}`,
  `anniversaries {id: {kind: "birth", date: {"@type": "PartialDate", year?, month, day}}}`, `keywords`. Updates
  replace whole top-level properties (`"name/full"` patch paths also work); moving between books is an
  `addressBookIds` update. `uid`, `created` and `updated` aren't returned as properties.
- **Query:** filters `text`, `email` (case-insensitive) and `inAddressBook` work; `name` and `uid` match nothing.
  Sorting is only by `created`/`updated` (`name/given`, `name/surname` → `unsupportedSort`), so the BFF sorts by
  name itself. **The `email` filter goes through the search index and lags fresh writes:** a card created a moment
  earlier wasn't found (a re-run of the seed duplicated two cards), so dedupe reads the cards' `emails` instead.
- **Quota:** `x:Account.quotas` accepts `maxContactCards` and `maxAddressBooks` (`maxContacts` is an invalid key),
  but with `maxContactCards: 2` a single `ContactCard/set` created four cards — not enforced in that case on
  v0.16.27. The BFF enforces its own 5,000 cards per mailbox instead; provisioning sets no contacts quota.
- **`calculateTotal`** works on `ContactCard/query` (used to count cards against the cap).
- **Submissions after the hold:** once the `HOLDFOR` hold is over, `undoStatus` is no longer `pending` (and
  `canceled` after an undo), which is what auto-save checks before saving recipients.
- **Limits:** `getMaxResults` 500 applies to `ContactCard/get`, so the BFF reads ids with `ContactCard/query`
  (`queryMaxResults` 5000) and fetches cards in 500-id batches. `ContactCard/parse` returned only `{accountId}` for
  a vCard blob (not useful), so vCard import is parsed by the BFF.
- **CardDAV:** `/.well-known/carddav` → 307 to `/dav/card`; `PROPFIND /dav/card/<url-encoded address>/` (Depth 1)
  → 207 listing the books, with the mailbox password **or an app password** (Basic). Production: Stalwart HTTP is
  internal (rule 18), so CardDAV is published through NGINX on the client host (`CARDDAV` in
  `packages/shared/src/platform.ts`, same host as JMAP); the NGINX route for `/dav/` and `/.well-known/carddav`
  lives in the private ops repo and must exist before the public guide's URL works.

### Sieve and automatic replies (verified on the pinned v0.16.27, 2026-10-22)
Probed with throwaway `dev.test` accounts; the webmail settings (05-webmail.md "Settings") are built on these.
- **Capability** `urn:ietf:params:jmap:sieve` (RFC 9661): `maxSizeScript` 102,400, `maxNumberScripts` 100,
  `maxNumberRedirects` **1**, `notificationMethods ["mailto"]`, `externalLists` null (no extlists, so contact
  addresses must be written into a script). Extensions include `fileinto`, `mailbox`, `special-use`, `copy`, `date`,
  `relational`, `vacation`, `vacation-seconds`, `include`, `variables`, `encoded-character`, `regex`, `editheader`.
- **Scripts:** upload the text as a blob (`POST /jmap/upload/<account>/`, `application/sieve`), then
  `SieveScript/set` `create {name, blobId}` / `update {blobId}` with `onSuccessActivateScript` (`#creationId` works).
  **Only one script is active**; activating one deactivates the rest. `SieveScript/validate` returned
  `error: null` even for an obviously broken script, so it isn't relied on; `set` refuses scripts that don't compile.
- **`urn:ietf:params:jmap:vacationresponse`** is advertised, but `VacationResponse/set {isEnabled: true}` creates a
  script named `vacation` and makes it the active one (the previously active script is deactivated); activating
  another script makes `VacationResponse/get` report `isEnabled: false`. It can't coexist with other rules, so the
  webmail writes automatic replies into its own script instead.
- **Delivery checks** (inbound SMTP from the host, and JMAP submissions between accounts): `fileinto :specialuse
  "\\Junk" "Junk"` files into the Junk folder; `vacation` replies once per sender (local senders get it in their
  inbox, outside senders' replies go to Mailpit in dev); `redirect :copy` delivers to the target and keeps a copy;
  `include :personal :optional` runs another of the account's scripts. Covered by
  `apps/web/src/server/adapters/webmail-settings.int.test.ts`.
- **`X-Spam-Status`** is added by Stalwart's filter, but a sender-supplied header of the same name is kept as well
  (a forged `Yes` survived), so rules must not trust that header.
- **Quota/get** (`urn:ietf:params:jmap:quota`) returns one `octets` quota with `scope: "account"`, `used` and
  `hardLimit` (the account's `maxDiskQuota`).
- **Identity/set** updates `name`, `textSignature` and `htmlSignature` on the account's own identities (aliases
  have their own identity each; the default `name` is the address).
- **Identity signatures are capped at 2,047 bytes** each (`htmlSignature`, `textSignature`; measured 2026-10-29 on
  v0.16.27 with the integration test: 2,047 ASCII characters or 1,023 two-byte characters are stored, 2,048 is
  refused in `notUpdated` with `invalidProperties`, "Field could not be set."). Signatures with embedded images don't
  fit; the webmail copies a shortened version (05-webmail.md "Signatures").

#### User Sieve is an open-relay vector; we block it (security review run-20, 2026-10-22)
- **Reproduced:** a mailbox token can upload `require ["variables"]; if header :matches "X-T" "*" { redirect
  "${1}"; }` and `SieveScript/set`-activate it; a message with an `X-T` header then relays to the attacker's
  per-message target — an open relay from our IPs, bypassing our forwarding confirmation, quotas and audit.
  `enotify`/`redirect` to any address work the same way. ManageSieve on 4190 with the mailbox password does too.
- **Mitigation (management.ts `CUSTOMER_PERMISSIONS`, applied at provisioning):** `disabledPermissions`
  `{ sieveAuthenticate, jmapSieveScriptCreate, jmapSieveScriptUpdate }`. Probed the `Permission` enum by setting
  candidate names (invalid ones give `invalidPatch`): valid are `jmapSieveScriptCreate`, `jmapSieveScriptUpdate`,
  `jmapSieveScriptGet`, `jmapSieveScriptValidate`, `jmapBlobUpload`; **`jmapSieveScriptSet`/`…Delete`/`…Activate`/
  `…Rename` are not valid names** (destroy and activate ride on create/update). After lockdown: a user
  `SieveScript/set create` is `forbidden`, a user blob upload still works (attachments need it), ManageSieve
  `AUTHENTICATE` is `NO`, JMAP sign-in/sending/delivery are unaffected, and `authenticate` stays enabled so the
  reconciler's suspended check is unchanged.
- **Management credentials can manage another account's Sieve:** the admin principal's `SieveScript/get|set` and
  blob upload/download accept a target `accountId` (equal to the mailbox's x:Account id), so the BFF writes the one
  managed script with management credentials (`StalwartManagement.getSieveScript`/`putSieveScript`) instead of the
  user token.
- **Suppressing auto-reply/forward on automated mail:** `vacation`'s own RFC 5230 handling already skips
  list/auto-submitted mail, but we also gate replies **and** redirect behind
  `if not anyof(header :contains "X-Spam-Status" "Yes", header :matches ["List-Id","List-Unsubscribe","List-Help","List-Post"] "?*", header :contains "Precedence" ["bulk","list","junk"], allof(exists "Auto-Submitted", not header :is "Auto-Submitted" "no"), envelope :all :is "from" "")`.
  Verified: clean mail is replied-to and forwarded; blocked, bulk (`List-Id` alone), spam (`X-Spam-Status: Yes`)
  and spoofed-spam mail get neither. Note `exists ["a","b"]` is **all-of** in RFC 5228, so a list test must use a
  `header :matches` with multiple header-names (any-of), not `exists` with a list.
- **VacationResponse is a bypass too (run-21):** a locked (Sieve-denied) token's `VacationResponse/set {isEnabled:
  true}` still succeeded and activated Stalwart's `vacation` script, deactivating ours. Its permission is
  **`jmapVacationResponseUpdate`** (also valid: `jmapVacationResponseGet`; `jmapVacationResponseSet` is invalid).
  Denied → `forbidden` "You are not authorized to update objects of this type". Now part of `CUSTOMER_PERMISSIONS`.
- **Activate/deactivate without create/update (run-21):** with create/update denied, a user's bare
  `SieveScript/set {onSuccessActivateScript: <other id>}` is silently ignored (state unchanged), but
  `{onSuccessDeactivateScript: true}` **deactivates our script** — there is no permission for it. `destroy` of the
  active script is refused (`scriptIsActive`). Management credentials re-activate it with a bare
  `onSuccessActivateScript` (verified); `mailbox.ensure` and every settings save do that, and the webmail shows
  `inactive` meanwhile.
- **What a User-role token can call over public JMAP (run-21, NV-C):** its own mail/contacts/submission/Sieve-read
  objects and its own `x:AppPassword/get`; `x:Account/get` and `x:Account/set` (incl. its own permissions),
  `x:Domain/get` and `x:SieveSystemScript/set` all answer `forbidden`. No `x:*` call writes Sieve or account
  permissions.
- **Untrusted-Sieve interpreter limits (open):** with user Sieve blocked this is defense-in-depth only; the exact
  v0.16 setting-object names for the untrusted interpreter's allowed capabilities and max outgoing messages per run
  weren't found from `/api/schema` (302 redirect) — discover them from the running server before changing config.

### Recommended push approach behind a reverse proxy or BFF
- The browser never talks to Stalwart. The BFF opens **one upstream push channel per active user**, preferably the JMAP WebSocket with `WebSocketPushEnable`, or EventSource. It fans `StateChange` events out to the browser over its own SSE or WebSocket.
- **Set `STALWART_PUBLIC_URL`** so the session's `apiUrl`, `downloadUrl`, `uploadUrl` and `eventSourceUrl` match the URL the BFF uses [S11][S70]. The BFF should also rewrite these URLs (or never expose the session object) before anything reaches the browser.
- **UNVERIFIED:** whether a long-lived EventSource or WebSocket counts against `maxConcurrentRequests` (4). Test this before sizing.

---

## 6. Authentication, and how the BFF gets a user JMAP session

### Capabilities
- **OAuth 2.0 / OIDC provider is built in** [S46][S47][S48][S50]:
  - Authorization Code (+PKCE) and Device flows.
  - Dynamic registration, introspection, refresh tokens.
  - Defaults: access token 1h, refresh 30d, renewal at 4d.
  - The token key is derived from the account's password hash, so **a password change revokes every token**.
  - ID tokens are signed with HS256 by default. RS256/ES256 are configurable.
- **External OIDC directory** (Stalwart as relying party) [S51]:
  - Validates the external access token offline via JWKS, or via userinfo.
  - Checks `aud` (default `"stalwart"`) and scopes.
  - Creates accounts just-in-time, with no deprovisioning.
  - Passwords **cannot** be set on accounts in an external directory [S58].
  - In Community there is **one** active directory server-wide. Per-domain directories are Enterprise [S27][S18].
- **2FA/TOTP** [S52]:
  - Users enrol in the self-service portal. Admins can set `otpAuth` on the Password credential.
  - It only works with OAuth-capable clients. Legacy clients need app passwords.
- **App passwords** [S53][S56]:
  - Created by the **user** (`x:AppPassword/set`, self-service).
  - "Administrators ... cannot create new ones on a user's behalf."
  - The secret is returned only once.
  - App passwords **cannot be used for impersonation**.
- **API keys** [S54]:
  - Long-lived Bearer credentials for automation, with scoped permissions, IP allow-list and expiry.
  - Docs say they "cannot be used to log in over IMAP, POP3, JMAP mail".
  - **UNVERIFIED:** the HTTP auth path accepts API keys as Bearer for `/jmap` without an obvious protocol check [S56]. Do not rely on either behaviour without a test.
- **Impersonation ("master user")** [S55][S56][S57]:
  - Grant the `impersonate` permission to a service account.
  - Log in as `target@domain%service@domain` with the **service account's password**, using HTTP Basic or SASL.
  - The resulting token is the target user's token.
  - Holders of `impersonate` are also treated as members of every account in access checks (`is_member`) [S57].
  - The recovery admin can impersonate the same way [S56].

### Options for the BFF (no Stalwart token in the browser)

| # | Option | How it works | Pros | Cons |
|---|---|---|---|---|
| A | **Stalwart OAuth, headless code flow, tokens held by the BFF** (recommended) | 1. At AnhourMail login, the BFF calls `POST /api/auth {type:"authCode", accountName, accountSecret, mfaToken?, clientId, redirectUri, codeChallenge}` and gets a `clientCode`. 2. It calls `POST /auth/token` (authorization_code + PKCE verifier). 3. It encrypts and stores `access_token` and `refresh_token` server-side, keyed to the AnhourMail session. 4. It proxies `/jmap` with `Authorization: Bearer`. | Documented, per-user least privilege. The password is used once and never stored. MFA is supported. Server audit logs show the real user. Refresh handled by BFF. A password change revokes all tokens (consistent). [S15][S47][S48] | `/api/auth` is described as for the WebUI and device-flow clients, so it is semi-internal. Its shape changed in 0.16 and may change again. The BFF must be the only place the password transits. Anonymous rate limits key on the client IP, so the proxy must send `X-Forwarded-For` and be trusted [S15][S70]. Register an `OAuthClient` with exact `redirectUris` [S49]. |
| A′ | Standard browser redirect to Stalwart's `/authorize` UI, with the BFF as a confidential client | Classic OAuth code flow. Stalwart's login page is shown to the user. | Fully standard. The BFF never sees the password. | Users see a Stalwart-branded login (branding is Enterprise [S27]). Two login surfaces. |
| B | **External OIDC directory pointing at AnhourMail's IdP** | Stalwart trusts our IdP. The BFF forwards our own access token (aud=`stalwart`) as Bearer [S51][S56]. | Single identity system. No Stalwart tokens at all. Our IdP owns MFA and lockout. | All accounts become external: **no Stalwart passwords** [S58], so IMAP/SMTP clients need app passwords or OAUTHBEARER. Accounts must be pre-created via API (JIT only on login, no deprovisioning) [S51]. One directory server-wide in Community. Larger blast radius if the IdP signing key leaks. |
| C | **Impersonation service account** | A service principal with `impersonate`. The BFF sends `Basic base64("user@dom%svc@dom:svcpass")` per request (the server caches the auth) [S55][S56]. | Simplest. No per-user token storage. Works for users who never logged in to AnhourMail (support or migration jobs). | A single god credential that can read every mailbox. It must be password-based Basic, because app passwords are rejected and API keys are Bearer [S56]. It bypasses the user's MFA. Audit attribution is weaker. Store it in a secrets manager and restrict by IP. |
| D | Store user app passwords | — | — | Admins cannot create app passwords for users [S53]. It would need impersonation to mint them (**UNVERIFIED**). Long-lived secrets. Not recommended. |

**Recommendation:**
- Use **A** for interactive webmail sessions.
- Use **C**, restricted to internal network IPs and kept in a vault, only for back-office jobs (support tools, imports). Keep its use auditable.
- Revisit **B** if AnhourMail wants a single IdP and accepts that IMAP users need app passwords.

There is no OAuth token-exchange (RFC 8693) grant and no admin-mints-user-token API. Only the code and device flows are documented [S46][S47].

---

### Console handoff without the password (verified on the pinned v0.16.27, 2026-10-29)

For ADR-0024, with a throwaway domain and account and the real service keys (`issueTestKeys`), destroyed afterwards;
pinned in `packages/adapters/src/stalwart/handoff.int.test.ts`:

- **No grant to mint a user token without a credential.** Discovery lists `authorization_code`, `refresh_token` and
  `urn:ietf:params:oauth:grant-type:device_code` only (no RFC 8693 token exchange). `POST /api/auth` with the
  operations API key as `accountSecret`, or as `Authorization: Bearer`, for a customer account → `{"type":"failure"}`.
- **A throwaway app password works:** `x:AppPassword/set { accountId }` with the operations key, `expiresAt` 60 s and
  `Disable` of every known and self-service permission except `authenticate` → `/api/auth` accepts it; the token has
  the account's 186 customer permissions; `Mailbox/get` works. HTTP Basic with it on `/jmap/session` answers 200 (the
  session document), methods are `forbidden`.
- **Destroying it keeps the token and the refresh grant working** (the token key comes from the account's Password,
  not the credential used). A later password change revokes them (401, refresh `invalid_grant`).
- A destroyed credential, or one past `expiresAt`, is refused at `/api/auth` (`failure`); an expired one stays listed
  (`x:AppPassword/get`, `x:Account.credentials` with `description`, `createdAt`, `expiresAt`, `permissions`) until it
  is destroyed. `expiresAt` takes whole seconds (`2026-10-29T12:01:01Z`).
- `maxAppPasswords` (default 5) counts it; `quotas.maxAppPasswords: 6` on the account (set by `mailbox.ensure` with the
  provisioning key) leaves room for it next to five app passwords.

## 7. Outbound controls

- **Strategy model** [S32]: the `MtaOutboundStrategy` singleton has four expressions (`route`, `schedule`, `connection`, `tls`). Each returns the name of an `MtaRoute`, `MtaDeliverySchedule`, `MtaConnectionStrategy` or `MtaTlsStrategy` object. A missing name falls back silently to built-ins and logs `smtp.id-not-found`.
  - Default route expression: `is_local_domain(rcpt_domain)` → `'local'`, else `'mx'` [S60].
- **Relay / smarthost:** `MtaRoute` `@type: "Relay"` with `address`, `port`, `protocol` (smtp/lmtp), `implicitTls`, `allowInvalidCerts`, `authUsername`, `authSecret` [S31].
- **Per-sender throttling:** `MtaOutboundThrottle` with `key {"sender":true}` or `{"senderDomain":true}` [S30].
  - Messages over the limit **stay queued** rather than being rejected.
  - Inbound throttles return `451 4.4.5` and can key on `authenticatedAs`. Use this to cap submissions per user [S30].
- **Queues:** virtual queues, delivery schedules, priority, delayed delivery and queue quotas [S27][S32].
- **DKIM signing:** `SenderAuth.dkimSignDomain` expression. The documented default signs with every `DkimSignature` of `sender_domain` when the sender is authenticated and the domain is local [S21].
- **MTA-STS and DANE (outbound):** `MtaTlsStrategy` fields `startTls`, `dane`, `mtaSts`, each `optional|require|disable` (default `optional`), plus `allowInvalidCerts` [S33]. MTA-STS policy publishing and TLS-RPT are supported [S27].
- **ARC:** inbound verification only. Sealing was removed in 0.16 [S34][S2].
- **Outbound spam filtering:** `MtaStageData.enableSpamFilter` defaults to `is_empty(authenticated_as)`, so **authenticated or submitted mail is not spam-scanned by default** [S35].
  - Change the expression to scan outbound. **UNVERIFIED** how the scoring and actions behave for submissions.
  - For abuse control, rely primarily on control-plane quotas plus `MtaInboundThrottle` keyed by `authenticatedAs`, and outbound throttles.
- **Dev → Mailpit:** see Recommendations.

---

## 8. Storage

- **Four stores**, each a singleton with a backend variant [S43][S41][S7]:
  - **DataStore:** RocksDB, FoundationDB, PostgreSQL, MySQL, SQLite.
  - **BlobStore:** Default (data store), S3, Azure, filesystem.
  - **SearchStore:** Default, Elasticsearch, Meilisearch, PostgreSQL, MySQL, FoundationDB.
  - **InMemoryStore:** Default or Redis.
  - Read replicas and sharded blob/in-memory stores are Enterprise [S42][S27].
- **Recommended single node:** RocksDB for all four stores. "Recommended configuration for single-node installations" [S7][S43].
- **PostgreSQL as the store is supported in Community** [S27][S42].
  - Fields: `host`, `port`, `database` (default `stalwart`), `authUsername`, `authSecret`, `useTls`, `poolMaxConnections` (default 10) [S42].
  - Stalwart creates its own tables on start [S61].
- **Separate Postgres database or cluster from the control plane?** Yes, use at minimum a separate database and role.
  - Stalwart owns its schema.
  - Its connection pool, FTS and blob load profile differ from OLTP control-plane traffic.
  - Upgrades may run schema migrations, as 0.15 did [S4].
  - A separate cluster is preferable at scale. This is a design judgement, not a vendor statement.
- **Backup and restore:**
  - **No built-in online backup.** The `--export` / `--import` binary dump is for **backend migration** and is explicitly "not a substitute for proper backup procedures". It requires the server **stopped** [S44].
  - Use the backend's native tooling instead: Postgres PITR or `pg_dump`, filesystem or volume snapshots of a stopped RocksDB, S3 versioning for blobs [S44].
  - The DB console (`--console`) can run concurrently only on FoundationDB, PostgreSQL or MySQL [S79].
  - **Configuration backup:** `stalwart-cli snapshot` emits a plan [S13].
  - **Per-account backup and restore:** Vandelay (JMAP/IMAP → SQLite archive → export back) [S45].

---

## 9. Community (AGPL-3.0) vs Enterprise

The source is the compare page as published 2026-10-21 [S27], with confirmation from individual docs pages.

**Enterprise-only:**
- **Masked email** [S26].
- **Multi-tenancy** (the `Tenant` object, per-tenant quotas and isolation, `Domain.memberTenantId`) [S27][S18][S78].
- **Per-domain directory backends** (`Domain.directoryId`).
- **SCIM 2.0** provisioning.
- **Account archiving and un-deletion / restore deleted emails** [S29].
- **AI/LLM spam classifier** and **AI/LLM Sieve scripting**.
- **Branding** (including multi-tenant branding and branded scheduling emails).
- **Read replicas, sharded blob and in-memory stores**.
- **Live telemetry (SSE), message delivery history, dashboards, metric alerts**.
- **Full metric set.** Community is "Limited" [S27][S62].
- Premium support (minimum 150 mailboxes).

**In Community:**
- All of JMAP, IMAP and POP3.
- SMTP with DKIM, SPF, DMARC, DANE, MTA-STS and TLS-RPT.
- Automatic DKIM rotation and DNS management, ACME.
- Spam filter with the FTRL classifier, DNSBL, Pyzor, greylisting.
- CalDAV, CardDAV and WebDAV, plus JMAP Calendars, Contacts and Files.
- Every storage backend, including PostgreSQL.
- Internal, LDAP, SQL and OIDC directories.
- OAuth and OIDC provider.
- TOTP, app passwords, API keys.
- Roles and permissions.
- Per-account disk and object quotas.
- Aliases with disable flag, domain aliases, catch-all, sub-addressing.
- Clustering and HA.
- WebUI and declarative IaC [S27].

**Licensing notes:**
- Enterprise licences are per mailbox, bound to the **server** hostname domain, and allow unlimited client domains [S28][S27].
- Cancelling reverts to Community without data loss [S27].
- Stalwart pledges not to move existing Community features behind the paywall [S27].

---

## 10. AGPL implications

- **Licence structure:** Stalwart is dual-licensed AGPL-3.0-only and Stalwart Enterprise License (SELv2) [S64][S65].
  - Each file carries an SPDX notice. Enterprise code is marked `LicenseRef-SEL`.
  - **The official Docker image is built with the `enterprise` feature** (`--features "... enterprise"`), so it contains SEL-licensed code that stays dormant without a licence key. `/api/account` reports `community` in that case and `oss` for builds without the feature [S6][S72].
  - Stalwart's own site describes Community as "free under AGPL-3.0" and directs operators to this image [S66][S7].
  - Building an AGPL-only binary means compiling the tagged source without `enterprise` [S71]. The `ossify.py` script strips SEL code [S6].
  - **Flag for counsel:** whether running the official mixed image without a subscription is fully covered by AGPL is not stated in a licence text. The vendor's public position, quoted next, implies it is fine.
- **Running unmodified:** Stalwart's own statement says "running unmodified Stalwart, or using it internally, does not trigger any source-disclosure requirement" [S66].
  - AGPL §13's network clause attaches to **modified** versions: "if you modify the Program, your modified version must prominently offer all users interacting with it remotely ... an opportunity to receive the Corresponding Source" [S68].
  - The FSF confirms that §13 applies when a *modified* AGPL program is run as a network service [S67].
  - Prudent practice anyway: link to the upstream source and the exact version or tag in the product's legal or about page. It costs nothing.
- **Our MIT code talking to it over HTTP/JMAP/SMTP:**
  - The FSF view is that "pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs". Such modules "normally are separate programs" unless the exchanged data is intimate internal structure [S67].
  - Calling a documented, public JMAP API over the network is arm's-length. Our control plane and BFF are not derivative works and can remain MIT.
  - Avoid linking Stalwart crates into our code. Several, such as `mail-parser` and `mail-auth`, are separately licensed; check each one.
- **If we ever modify Stalwart:**
  - We must offer the complete corresponding source of the modified server to all users interacting with it over the network (§13) [S68].
  - Our separate programs are still unaffected.
  - Config objects, plans, Sieve scripts and DNS automation are data or configuration, not modifications.

---

## 11. Docker gotchas

- **Volumes:** `/etc/stalwart` (holds `config.json`) and `/var/lib/stalwart` (RocksDB, local blobs). External stores leave the data volume empty [S7].
  - Bind mounts must be owned by **UID/GID 2000** [S7][S6].
- **Non-root:** the image runs as `stalwart` (UID 2000). It binds ports below 1024 via the file capability `cap_net_bind_service`. `--cap-drop NET_BIND_SERVICE` breaks exec [S7][S6].
- **Ports:** the Dockerfile `EXPOSE`s 443, 25, 110, 587, 465, 143, 993, 995, 4190 and 8080 [S6]. But the **default listeners are only 25, 465, 993, 995, 4190, 443 (TLS) and 8080 (HTTP)** [S60].
  - Add 587 and 143 listeners via `NetworkListener` if needed.
  - **UNVERIFIED** how the 8080 HTTP listener behaves after bootstrap. The docs say admin sign-in over 8080 stops working once the OAuth issuer is bound to HTTPS, unless in recovery mode or `STALWART_RECOVERY_ADMIN` is set [S7][S9].
- **Healthcheck:** the image has a built-in `HEALTHCHECK` that curls `https://127.0.0.1:443/healthz/live`, falling back to `http://127.0.0.1:8080/healthz/live` (overridable via `STALWART_HEALTHCHECK_URL`) [S6].
  - Use `/healthz/ready` for readiness [S59].
  - Health endpoints count against **anonymous rate limits** [S59].
- **Entrypoint:** `stalwart --config /etc/stalwart/config.json`. A missing file triggers bootstrap mode. Its random admin password is printed **once** in the logs [S6][S9].
- **Outbound HTTPS at runtime:** the WebUI bundle downloads from GitHub releases. If that fails, `/admin` and `/account` return 404. Spam rules download from GitHub, and ACME needs Let's Encrypt [S69].
- **Memory and CPU:** about 100 MB idle, 1 GB is fine for 5–10 users, and the default cap is 8,192 concurrent connections [S69]. **x86-64-v2 is required** for non-alpine images since 0.16.26 [S2].
- **Logging:** pick the Console tracer in containers [S7].
- **Reverse proxy:**
  - Set `STALWART_PUBLIC_URL`.
  - Use either `X-Forwarded-For` (HTTP mode) or PROXY protocol, not both, and add the proxy to the trusted networks [S11][S70].
  - Otherwise every BFF request appears to come from one IP. That breaks rate limiting and auth fail2ban, which is keyed on IP plus username [S56].
- **FoundationDB:** no prebuilt image. Use `Dockerfile.fdb` [S7].

---

## Recommendations for AnhourMail

1. **Pinned image:** `stalwartlabs/stalwart:v0.16.27@sha256:c429b311c93db5606598abc1c68225a85a6953183848ae01bee9c6a98885836c` [S5].
   - Track releases weekly.
   - Read `UPGRADING/` before any minor bump.
   - Use `-alpine` only if deploying to pre-x86-64-v2 virtual CPUs.
   - Pin `stalwartlabs/cli:1.0.13` for seeding [S74].
2. **Rewrite the integration plan around JMAP management.** The control plane talks to `POST /jmap` with `urn:stalwart:jmap` and uses:
   - `x:Domain`, `x:Account`, `x:MailingList`, `x:DkimSignature`, `x:QueuedMessage`, `x:MtaOutboundThrottle`, `x:Action`.
   - `x:Domain/get dnsZoneFile` for DNS.
   - Generate typed clients from `/api/schema` [S15].
   - Authenticate with a dedicated **API key** (Bearer, `Replace` permissions limited to `sys*` management permissions, IP allow-list) [S54].
   - Our control plane remains the source of truth for tenancy and plans. Push the derived quotas (`maxDiskQuota`, `maxEmailSubmissions`, `maxEmailIdentities`, and so on) and throttles to Stalwart [S17][S30].
   - Do **not** use Stalwart Tenants. They are Enterprise.
3. **Store choice:**
   - **Dev:** RocksDB for all stores, single container, named volumes [S7][S43].
   - **Prod (single node):** RocksDB on a dedicated persistent volume with snapshot-based backups (stop or quiesce first), or PostgreSQL if managed backups and PITR matter more than raw performance [S42][S44].
   - With PostgreSQL, use a **separate database and role**, and ideally a separate instance, from the control-plane Postgres.
   - Consider S3 for blobs, and an external search engine if large messages must be fully searchable, because of the 650 KB PostgreSQL FTS truncation [S42].
4. **BFF session strategy:**
   - Use **Option A** (`/api/auth` → `/auth/token`, with PKCE). Store tokens server-side and encrypted, and refresh in the BFF. Proxy `/jmap`, `/jmap/upload`, `/jmap/download` and one upstream WebSocket or EventSource per user.
   - Keep **Option C** (impersonation service account) only for back-office jobs, behind IP restriction and vault storage.
   - Register an `OAuthClient` for the BFF and set `OidcProvider.requireClientRegistration=true` [S49].
   - Configure `X-Forwarded-For` trust for the BFF's network [S70].
   - Raise `Jmap.maxConcurrentRequests` if the BFF multiplexes [S38].
5. **Masked email contradicts the plan:**
   - It is Enterprise-only. Either buy Enterprise, or implement "masked addresses" in our control plane.
   - Control-plane implementation: random local parts as **`Account.aliases` entries** (Community supports `enabled` and `description` on aliases [S17][S27]), with metadata such as `forDomain` and `createdBy` kept in our DB.
   - If we do this, expose our own JMAP-like API to clients. Stalwart's `x:MaskedEmail` will not be available.
   - Likewise, **undelete** is Enterprise. Implement soft-delete in the webmail via a Trash retention policy instead.
6. **Dev seeding approach:**
   - Ship `config.json` = `{"@type":"RocksDb","path":"/var/lib/stalwart/"}` so the container skips the wizard.
   - Start with `STALWART_RECOVERY_MODE=1` and `STALWART_RECOVERY_ADMIN=admin:<dev-secret>`.
   - Run `stalwart-cli apply --file dev-plan.ndjson`: domain, users, route, strategy, and an API key for the control plane if desired. See §2 and the snippet below.
   - Restart without `STALWART_RECOVERY_MODE`.
   - For dev only, keeping `STALWART_RECOVERY_ADMIN` set is acceptable. Never in prod [S10][S12][S13].
   - Because `upsert` is idempotent, the same plan can run on every `docker compose up` [S13].
7. **Outbound → Mailpit (dev).** Mailpit's SMTP listens on `0.0.0.0:1025` by default [S75]. The plan below uses the Relay route fields from [S31] and the strategy expression shape from [S32].
   - The default TLS strategy uses `startTls: optional`, so plaintext to Mailpit works without a custom TLS strategy [S33].
   - Keep `local` for local domains so intra-domain mail still lands in Stalwart.

```ndjson
{"@type":"upsert","object":"MtaRoute","matchOn":["name"],"value":{"r-mailpit":{"@type":"Relay","name":"mailpit","description":"Dev: all remote mail to Mailpit","address":"mailpit","port":1025,"protocol":"smtp","implicitTls":false,"allowInvalidCerts":true,"authSecret":{"@type":"None"}}}}
{"@type":"update","object":"MtaOutboundStrategy","value":{"route":{"match":{"0":{"if":"is_local_domain(rcpt_domain)","then":"'local'"}},"else":"'mailpit'"}}}
```

Then reload the compiled settings [S8]:

```sh
stalwart-cli create Action/ReloadSettings
```

   In recovery mode a restart happens anyway. **UNVERIFIED end-to-end on a running instance:** the exact NDJSON field acceptance for `MtaRoute` and `MtaOutboundStrategy`. Validate with `stalwart-cli apply --dry-run`, or compare against `stalwart-cli snapshot MtaRoute` output [S13][S14].

8. **Other operational must-dos:**
   - Add a 587 submission listener for SMTP clients [S60].
   - Enable the Prometheus exporter with Basic auth [S24].
   - Back up RocksDB/Postgres with native tooling [S44].
   - Treat `dnsZoneFile` as the input to our DNS-instructions UI [S18].
   - Decide whether to scan authenticated outbound mail. It is off by default [S35].

### Not verified / open questions
- API keys used as Bearer on `/jmap` for mail data: docs say no, code suggests possibly yes. Test this.
- ~~Whether an impersonated session can create an `AppPassword` for the target user.~~ Yes (see "App passwords").
- The exact behaviour and listener availability of the 8080 HTTP listener after normal startup.
- Whether a long-lived EventSource or WebSocket counts against `maxConcurrentRequests`.
- ~~That `Domain.dkimManagement: Automatic` with `dnsManagement: Manual` generates the initial key on creation.~~ Yes (verified 2026-10-28 on v0.16.27): one Ed25519 and one RSA key, selectors `v1-ed25519-YYYYMMDD` and `v1-rsa-YYYYMMDD`, listed in `dnsZoneFile`; the RSA key appears a second or two after the domain, and right after the create the zone may list no key at all. `nextTransitionAt` stays null (no rotation under manual DNS).
- The legal status of running the official enterprise-feature image unlicensed. The vendor says Community is AGPL and free [S66]. Get counsel's review of the SEL text [S65].
- The open-source page mentions "SELv1" while the repo licence is "SELv2" [S66][S65]. The inconsistency is minor.

---

## Sources

- **S1** GitHub releases: https://github.com/stalwartlabs/stalwart/releases (API: https://api.github.com/repos/stalwartlabs/stalwart/releases)
- **S2** CHANGELOG (v0.16.27): https://github.com/stalwartlabs/stalwart/blob/v0.16.27/CHANGELOG.md
- **S3** Upgrading v0.15 → v0.16: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/UPGRADING/v0_16.md
- **S4** Upgrading v0.14 → v0.15: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/UPGRADING/v0_15.md
- **S5** Docker Hub tags: https://hub.docker.com/r/stalwartlabs/stalwart/tags (API: https://hub.docker.com/v2/repositories/stalwartlabs/stalwart/tags/v0.16.27)
- **S6** Dockerfile: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/Dockerfile (repo tree incl. `resources/schema`, `resources/scripts/ossify.py`: https://github.com/stalwartlabs/stalwart/tree/v0.16.27)
- **S7** Docker install: https://stalw.art/docs/install/platform/docker/
- **S8** Configuration overview: https://stalw.art/docs/configuration/
- **S9** Bootstrap mode: https://stalw.art/docs/configuration/bootstrap-mode/
- **S10** Recovery mode: https://stalw.art/docs/configuration/recovery-mode/
- **S11** Environment variables: https://stalw.art/docs/configuration/environment-variables/
- **S12** Declarative deployments: https://stalw.art/docs/configuration/declarative-deployments/
- **S13** CLI apply (incl. example plan): https://stalw.art/docs/management/cli/apply/
- **S14** Object encoding: https://stalw.art/docs/configuration/object-encoding/
- **S15** API endpoints: https://stalw.art/docs/development/api/
- **S16** OpenAPI spec: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/api/v1/openapi.yml
- **S17** Account object: https://stalw.art/docs/ref/object/account/
- **S18** Domain object: https://stalw.art/docs/ref/object/domain/
- **S19** Domains overview: https://stalw.art/docs/domains/
- **S20** DKIM rotation: https://stalw.art/docs/domains/dkim-rotation/
- **S21** DKIM signing: https://stalw.art/docs/mta/authentication/dkim/sign/
- **S22** MTA management (queue, reports): https://stalw.art/docs/mta/management/
- **S23** Actions: https://stalw.art/docs/management/tasks-actions/actions/
- **S24** Prometheus: https://stalw.art/docs/telemetry/metrics/prometheus/
- **S25** Spam classifier training: https://stalw.art/docs/spamfilter/classifier/training/
- **S26** Masked email: https://stalw.art/docs/email/management/masked-email/
- **S27** Compare editions: https://stalw.art/compare/ (source: https://github.com/stalwartlabs/website/blob/main/src/content/pages/compare.yml)
- **S28** Enterprise licence doc: https://stalw.art/docs/server/enterprise/
- **S29** Storage overview (un-deleting): https://stalw.art/docs/storage/
- **S30** Rate limits: https://stalw.art/docs/mta/outbound/rate-limit/
- **S31** Outbound routing: https://stalw.art/docs/mta/outbound/routing/
- **S32** Outbound strategies: https://stalw.art/docs/mta/outbound/strategy/ (MtaOutboundStrategy ref: https://stalw.art/docs/ref/object/mta-outbound-strategy/)
- **S33** MtaTlsStrategy object: https://stalw.art/docs/ref/object/mta-tls-strategy/
- **S34** ARC: https://stalw.art/docs/mta/authentication/arc/
- **S35** MtaStageData object: https://stalw.art/docs/ref/object/mta-stage-data/
- **S36** Supported RFCs: https://stalw.art/docs/development/rfcs/
- **S37** JMAP overview: https://stalw.art/docs/http/jmap/
- **S38** JMAP protocol limits: https://stalw.art/docs/http/jmap/protocol/
- **S39** JMAP push: https://stalw.art/docs/http/jmap/push/
- **S40** JMAP WebSockets: https://stalw.art/docs/http/jmap/websockets/
- **S41** Search store: https://stalw.art/docs/storage/fts/
- **S42** PostgreSQL backend: https://stalw.art/docs/storage/backends/postgresql/
- **S43** Data store: https://stalw.art/docs/storage/data/
- **S44** Database import/export: https://stalw.art/docs/management/maintenance/migration/
- **S45** Vandelay backup: https://stalw.art/docs/migration/import-export/backup/
- **S46** OAuth flows: https://stalw.art/docs/auth/oauth/flows/
- **S47** OAuth endpoints: https://stalw.art/docs/auth/oauth/endpoints/
- **S48** OAuth tokens: https://stalw.art/docs/auth/oauth/tokens/
- **S49** OAuth clients: https://stalw.art/docs/auth/oauth/oauth-client/
- **S50** OIDC provider: https://stalw.art/docs/auth/openid/provider/
- **S51** External OIDC directory: https://stalw.art/docs/auth/backend/oidc/
- **S52** Two-factor auth: https://stalw.art/docs/auth/authentication/2fa/
- **S53** App passwords: https://stalw.art/docs/auth/authentication/app-password/
- **S54** API keys: https://stalw.art/docs/auth/authentication/api-key/
- **S55** Administrators / impersonation: https://stalw.art/docs/auth/authorization/administrator/
- **S56** Auth source: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/common/src/auth/authentication.rs (HTTP auth: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/http/src/auth/authenticate.rs)
- **S57** Access token source: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/common/src/auth/access_token.rs
- **S58** Account credential validation source: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/jmap/src/registry/mapping/principal.rs
- **S59** HTTP router source: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/http/src/request.rs (capability URNs: https://github.com/stalwartlabs/stalwart/tree/v0.16.27/crates/jmap-proto)
- **S60** First-boot defaults source: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/common/src/manager/defaults.rs (default route expression: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/registry/src/schema/structs_impl.rs)
- **S61** Registry env handling: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/store/src/registry/local.rs and https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/store/src/build/registry.rs
- **S62** Metric gauges (community vs enterprise): https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/trc/src/ipc/metrics.rs
- **S63** Email/set junk training: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/jmap/src/email/set.rs
- **S64** README licence section: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/README.md#license
- **S65** SELv2 text: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/LICENSES/LicenseRef-SEL.txt
- **S66** Community edition page: https://stalw.art/open-source/
- **S67** GNU GPL FAQ: https://www.gnu.org/licenses/gpl-faq.html#MereAggregation, https://www.gnu.org/licenses/gpl-faq.html#UnreleasedModsAGPL, https://www.gnu.org/licenses/gpl-faq.html#AGPLv3InteractingRemotely
- **S68** AGPL-3.0 §13: https://www.gnu.org/licenses/agpl-3.0.html#section13
- **S69** System requirements: https://stalw.art/docs/install/requirements/
- **S70** Reverse proxy: https://stalw.art/docs/server/reverse-proxy/
- **S71** Compiling (features): https://stalw.art/docs/development/compile/
- **S72** Edition reporting source: https://github.com/stalwartlabs/stalwart/blob/v0.16.27/crates/http/src/auth/permissions.rs
- **S73** CLI overview: https://stalw.art/docs/management/cli/
- **S74** CLI releases: https://github.com/stalwartlabs/cli/releases
- **S75** Mailpit runtime options: https://mailpit.axllent.org/docs/configuration/runtime-options/
- **S76** Quotas: https://stalw.art/docs/auth/authorization/quotas/
- **S77** Spam autolearn: https://stalw.art/docs/spamfilter/classifier/autolearn/
- **S78** Tenant object (Enterprise): https://stalw.art/docs/ref/object/tenant/
- **S79** Database console: https://stalw.art/docs/management/maintenance/database/
- **S80** GHCR package: https://github.com/stalwartlabs/stalwart/pkgs/container/stalwart
- **S81** v0.16 design discussion: https://github.com/stalwartlabs/stalwart/discussions/2892
- **S82** Old repo name (redirects): https://github.com/stalwartlabs/mail-server
- **S83** Old Docker Hub repo: https://hub.docker.com/r/stalwartlabs/mail-server/tags
- **S84** Trace object (Enterprise): https://stalw.art/docs/ref/object/trace/
- **S85** Mailing lists: https://stalw.art/docs/email/management/mailing-lists/
