# ADR-0017: DKIM with fixed selectors rotated by the worker; a scoped API key for management

- Status: Accepted, 2026-10-21. Amended 2026-10-28: customer DKIM uses direct TXT keys for now (see "Amendment").
- Related: `../02-mail-infrastructure.md` ("DKIM", "Stalwart configuration principles"), `../09-roadmap.md` Phase 1
  prototypes 1–2, ADR-0001, ADR-0011

## Context

Customer domains delegate DKIM to us by CNAME (`am1._domainkey.<domain> → am1.<domain>.dkim.anhourmail.com`, same for
`am2`), so selectors must be **fixed** and rotation must happen without the customer touching DNS. Stalwart's
automatic DKIM names selectors from a template (default date-based) and rotates only with automatic DNS management.
Separately, the control plane needs credentials for Stalwart's JMAP management API outside dev, where the recovery
admin must never be set.

Experiments on the pinned v0.16.27 (throwaway domain, all objects deleted afterwards):

- `dkimManagement: {"@type":"Automatic","selectorTemplate":"am1"}` creates one RSA key `am1`, stage `active`,
  `nextTransitionAt: null` — it never rotates with manual DNS, and a fixed template would collide on rotation.
- Manual `x:DkimSignature` (`Dkim1RsaSha256`, PEM private key, selector `am2`, stage `pending`) is published in the
  domain's `dnsZoneFile` but does not sign. After `am2 → active`, `am1 → retiring` (+ `ReloadSettings`) only `s=am2`
  signs (checked in the raw message in Mailpit); `am1 → retired` removes it from the zone. A manual key created with
  an empty `headers` set signed nothing — the signed header list must be explicit.
- API keys belong to a real account; the recovery admin cannot own one (`notFound`). A key on an Admin-role service
  account with `permissions: {"@type":"Replace", permissions: {authenticate, sysDomain*, sysAccount*,
sysDkimSignature*}}` manages domains, accounts and DKIM keys; without `authenticate` every call is HTTP 403; with
  it, `Mailbox/get` / `Email/query` on a user account and other admin objects (e.g. `x:SystemSettings`) return
  `forbidden`.

## Decision

1. Domains are created with `dkimManagement: Manual`; the **worker owns DKIM**: it generates RSA-2048 keys, creates
   `x:DkimSignature` objects with selectors `am1`/`am2` and an explicit signed-header list (From, To, Date, Subject,
   Message-ID, plus Reply-To, Cc, MIME-Version, Content-Type once tested), and rotates every 90 days:
   `pending` (publish TXT behind the CNAME, wait ≥ 2 × TTL, verify resolution) → swap `active`/`retiring` →
   `retired` after 7 days → destroy after 30 days. Private keys are sent to Stalwart once and never stored by us.
   Ed25519 is an optional second signature, never the only one (the largest mailbox provider ignores it).
2. Outside dev, the control plane and worker authenticate to Stalwart with an **API key** owned by a dedicated
   Admin-role service account, `Replace` permissions limited to `authenticate` plus the `sys*` permissions they use,
   `allowedIps` set to the control-plane hosts, stored encrypted (rule 16) and rotated quarterly. The key is
   treated as a high-value secret: `sysAccountCreate` could create admin accounts.

## Consequences

- One DKIM implementation for platform and customer domains, independent of a DNS-provider integration in Stalwart.
- The worker needs our DNS provider's API for `*.dkim.anhourmail.com` (open decision: provider with DNSSEC).
- Upgrades must re-check the `x:DkimSignature` shape and stage semantics (pinned version, rule 22).
- The `stalwart-client` gains `createDkimKey` / `setDkimStage` and a Bearer-auth constructor (Phase 1 code work).

## Alternatives

- Automatic DKIM with automatic DNS (Stalwart drives the DNS provider): gives date-named selectors and puts DNS
  credentials inside the mail server; rejected for customer CNAME delegation.
- Keep using an admin password over Basic auth: no permission scoping, no IP allow-list; rejected.

## Amendment (2026-10-28): direct TXT keys for customer domains, for now

The CNAME delegation above was shown to customers but never wired: nothing published keys under the platform's DKIM
zone, so every customer domain failed DKIM (`permerror`, no key for signature). Rather than build the DNS-provider
integration first, customer domains now keep Stalwart's automatic DKIM (default date-based selectors, one Ed25519 and
one RSA-2048 key) and the console lists those keys as TXT records at `<selector>._domainkey`, read from
`dnsZoneFile` and cached by the worker (`02-mail-infrastructure.md` "Customer domain records"). The key only exists
once the domain is on Stalwart, so a pending domain is added there once its ownership and MX records pass.

Consequences: rotation needs the customer to publish the new key first (Stalwart doesn't rotate with manual DNS, so
nothing changes under them meanwhile); Ed25519 is published alongside RSA (an extra signature, never the only one).
Part 1 of the decision (worker-owned fixed selectors, CNAME delegation, 90-day rotation) stays the target once the
platform DKIM zone can be published through a DNS provider; part 2 (scoped API key) is unchanged.

Update (2026-10-28): a customer domain now verifies only when a TXT with the same public key (`p=`) is published
behind every selector the domain signs with (`checkRecords`, `packages/core/src/domains/dns.ts`); the worker waits
briefly for the RSA key after adding the domain and the scheduler backfills keys for domains added earlier. Because a
pending domain on Stalwart makes the name local there, abandoned pending claims are released or expired
(`PENDING_DOMAIN` in `packages/shared/src/plans.ts`; `02-mail-infrastructure.md` "Customer domain records" and
"Domain lifecycle"). Part 2 has since been split into three scoped keys — provisioning, operations, audit — behind
an internal management proxy (ADR-0020 "Credential split"; `02-mail-infrastructure.md` "Stalwart configuration
principles").
