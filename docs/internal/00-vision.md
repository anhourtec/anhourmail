# 00 — Vision

Last updated: 2026-10-23

## What AnhourMail is

A hosted email service from Anhourtec for **privacy-minded, tech-savvy individuals**. It offers free `@anhourmail.com` addresses, paid custom domains, aliases, catch-all and masked aliases, standard protocols (IMAP, SMTP, JMAP), and an **open-source, fast webmail**, the successor to HourMail.

For families and small groups on Plus/Supporter it also offers the mail collaboration people know from mainstream business mail suites: shared mailboxes, distribution lists (static and dynamic), groups, delegated access (full access, send as, send on behalf, folder sharing), mail flow rules, forwarding, auto-replies and message trace — built on Stalwart Community, with policy in our control plane (`10-collaboration.md`, ADR-0013).

The pitch, in one line (from `research/market-and-legal.md` §5.3): _Budget-provider price, standard protocols, built-in aliases and masked addresses, a polished webmail, open source, from a company that isn't one person._

## Audience

- People in privacy and self-hosting communities on Reddit, Hacker News, Lemmy and Mastodon.
- They read the docs, check DNS records themselves, use desktop and Android IMAP clients, and care about exports and lock-in.
- **Not** businesses. There is no B2B sales motion, no sales team and no cold email. Plus and Supporter accounts can add a few people (family, a small group), and that is all.

## Positioning

| Gap in the market (from research)                                                 | Our answer                                                                         |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Low-cost providers run by one person: bus factor, spartan UI, no masked-alias UX  | Company-backed, published continuity plan, modern webmail, masked aliases built in |
| Privacy-focused providers that gate IMAP behind a paid local bridge, at ~4× price | IMAP/SMTP/JMAP on every plan, no bridge, ~¼ the price                              |
| Privacy-focused providers with no IMAP/SMTP at all                                | Standard protocols first                                                           |
| Established JMAP providers priced at US$60/yr and rising                          | Comparable protocol support (JMAP) at a fraction of the price                      |
| Hard daily send caps on cheap plans                                               | Reputation-based trust tiers instead of a flat tiny cap                            |
| Alias services that need a second subscription and dependency                     | Aliases and masked aliases included in the mailbox                                 |

We are honest about limits. Mail is **not end-to-end encrypted** in v1 (it is encrypted in transit and at rest per server). We make **no hosting-region claims** in public copy (product decision 2026-10-21): no "hosted in <country>" and no "immune to foreign legal process". The transparency report covers lawful access requests.

## Principles

1. **Privacy promises are product requirements:** no trackers, no ads, no third-party requests on our pages, remote images blocked by default.
2. **Standard protocols and full export at any time.** Leaving should be easy.
3. **Transparency:** a public cost breakdown, a transparency report, open-source code (AGPL apps, MIT libraries), and Stalwart run unmodified.
4. **Deliverability is the product.** Abuse controls protect every user's inbox placement, so outbound limits are strict and server-side.
5. **Speed is a feature:** the webmail must feel instant (budgets below).
6. **More secure than the low-cost providers we're priced against, and honest about it:** TLS 1.2+ everywhere with MTA-STS/DANE, encrypted disks and off-server encrypted backups, an opt-in zero-access mode where only the user's key can read stored mail, passkeys/security keys, user-visible audit — and no claim ships before the feature does (`12-encryption-and-security-posture.md`).

## Scope highlights (a familiar business-mail feature set)

- Collaboration: shared mailboxes, distribution lists, groups, delegation (`10-collaboration.md`).
- **Folders**: nested folders, favourites, archive (incl. by year), rules, search folders, folder sharing, Trash/Junk
  clean-up (`05-webmail.md`, ADR-0014).
- **Signatures**: several per person with new/reply defaults, per shared mailbox, admin templates with
  placeholders, account disclaimer (ADR-0014).
- **Newsletters and bulk sending**: a separate paid add-on with its own domain and IP pool, consent records and
  one-click unsubscribe — never on base plans (`11-bulk-sending.md`, ADR-0015).

## Non-goals (v1)

- End-to-end encryption, PGP key management UI (later), calendar/contacts UI (later, CalDAV/CardDAV come from Stalwart), mobile apps (standard clients work), bulk or marketing mail on the base plans (only via the planned paid add-on, `11-bulk-sending.md`), enterprise compliance (litigation hold, eDiscovery, retention policies, journaling, public folders), business features (SSO, SCIM, multi-org admin), lifetime deals, monthly billing.

## Success metrics

| Area            | Metric                                                                    | Target                                                            |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Inbox placement | Seed tests at the big free mailbox providers land in Inbox                | ≥ 95% before beta, mail-tester 10/10                              |
| Reputation      | Mailbox-provider postmaster spam rate                                     | < 0.1% (never ≥ 0.3%)                                             |
| Reputation      | Blocklist listings on our IPs                                             | 0 (daily sweep)                                                   |
| Webmail speed   | Cold load to usable inbox (cached shell, p75, 4G)                         | ≤ 1.5 s                                                           |
| Webmail speed   | Warm open (IndexedDB cache)                                               | ≤ 300 ms to list                                                  |
| Webmail speed   | Open a message (p75)                                                      | ≤ 150 ms cached, ≤ 400 ms uncached                                |
| Webmail speed   | Folder switch (p75)                                                       | ≤ 100 ms cached                                                   |
| Onboarding      | Sign-up → first mail received (free)                                      | ≤ 3 minutes                                                       |
| Onboarding      | Custom domain: add → all required records verified (user with DNS access) | ≤ 15 minutes                                                      |
| Trust           | Abuse reports actioned                                                    | first response ≤ 24 h                                             |
| Economics       | Paying users covering fixed infra                                         | ≥ 300 by end of beta + 6 months (see `06-pricing-and-billing.md`) |

Full webmail budgets are in `05-webmail.md`.
