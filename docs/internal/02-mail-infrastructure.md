# 02 — Mail infrastructure

Last updated: 2026-10-21. Research: `research/stalwart.md`, `research/deliverability.md`.

## URL and hostname map

Public facts are defined once in `packages/shared/src/platform.ts`. This table explains them; it does not redefine them.

| Host / path                                                | Purpose                                                   | Served by                |
| ---------------------------------------------------------- | --------------------------------------------------------- | ------------------------ |
| `anhourmail.com`                                           | Marketing site and waitlist                               | `apps/site`              |
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

- **RSA-2048 is primary.** Gmail does not verify Ed25519 signatures, so Ed25519 is an optional second signature only (`research/deliverability.md` §4).
- Customer domains delegate DKIM by CNAME: `am1._domainkey.<domain> → am1.<domain>.dkim.anhourmail.com` (likewise `am2`). We publish the keys behind these and rotate them without the customer touching DNS.
- **Open problem:** Stalwart's automatic DKIM names selectors by date (observed in dev: `v1-rsa-20261021._domainkey`, `v1-ed25519-20261021._domainkey`). Fixed customer CNAMEs need fixed selectors, so Phase 1 prototypes `dkimManagement.selectorTemplate` with fixed `am1`/`am2` plus our own rotation (publish next key under the idle selector → switch signing → retire), or manual `x:DkimSignature` objects driven by the worker. Stalwart's automatic rotation requires automatic DNS management, which needs our zone (`*.dkim.anhourmail.com`) at an API-driven DNS provider (open decision).
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
- Production auth is a scoped **API key** (Bearer, `sys*` permissions only, IP allow-list). The recovery admin (`STALWART_RECOVERY_ADMIN`) is **never set in production**: it works in normal mode too.
- The management and JMAP HTTP listener is reachable from the internal network only. NGINX exposes nothing under `/jmap`, `/api` or `/admin` publicly. The webmail JMAP proxy is our BFF, not a pass-through.
- Add a 587 submission listener (not created by default). Keep the default POP3S listener on 995: IMAP, POP3, SMTP submission, ManageSieve and JMAP are all offered (`packages/shared/src/platform.ts` `CLIENT_ENDPOINTS`).
- Outbound spam scanning of authenticated mail is **off by default** in Stalwart (`MtaStageData.enableSpamFilter`). We turn it on and pair it with control-plane limits (`03-anti-spam-and-abuse.md`).
- **Transport security** (ADR-0016, verified schema 2026-10-21): listeners allow only TLS 1.2/1.3 (`TlsVersion` has no older values); set `tlsDisableCipherSuites` to leave AEAD suites only; plain 143/110/587 must refuse AUTH before STARTTLS (Phase 1 check). Outbound `x:MtaTlsStrategy` default `startTls/dane/mtaSts: optional` (enforced wherever the destination publishes a policy), `allowInvalidCerts: false`. Inbound `x:MtaSts` `testing` → `enforce`, `x:TlsReportSettings` on, DANE TLSA on `mx1` once the zone is DNSSEC-signed. `x:MtaExtensions.requireTls` on (RFC 8689).
- **Encryption at rest (opt-in zero-access):** `x:Email.encryptAtRest` true server-wide; per user `x:PublicKey` + `x:AccountSettings.encryptionAtRest` (`Aes256`, `encryptOnAppend: true`) set through our BFF. Community feature, verified end to end (`research/encryption.md` §3.2).
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
