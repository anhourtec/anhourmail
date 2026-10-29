# ADR-0021: Free addresses on the platform domain

**Status:** Accepted 2026-10-23

## Context

Seen on pre-staging with sign-up open: a Free account could not create any mailbox. Mailboxes had to be on one of the
account's own active domains, Free has no custom domains, and the platform domain (`PLATFORM_DOMAIN`, anhourmail.com
in production) is refused as a customer domain. The core already anticipated "a platform domain nobody has claimed"
(`assertDomainHeld`), and the reconciler already treated domains of desired mailboxes as desired. What was missing:
a way to create mailboxes there, the rules for names on a domain every account shares, and the abuse gates while
Phase 6 (trust tiers, outbound counters) isn't built.

## Decision

1. **Any account may hold mailboxes on the platform domain.** Free: at most `PLANS.free.platformMailboxes` (1) per
   account; paid plans: `platformMailboxes: null`, they count toward `MAX_MAILBOXES` like any mailbox. Every status
   counts, `deleting` included (the address and the place stay reserved through the grace period). Numbers live in
   `packages/shared/src/plans.ts` and the docs render them.
2. **Name rules** (`packages/shared/src/addresses.ts`, one validator for the console form and the server):
   lowercase `a–z`, `0–9`, `.`, `-`, `_`; starts and ends with a letter or digit; no `..`; **4–32 characters**;
   a reserved list (role addresses, names that pass for us or staff, the system mailboxes, the `svc-` prefix),
   compared without `.`, `-`, `_` and trailing digits, and any name containing `anhourmail` or `anhourtec`.
   Customer domains keep their looser rules (`normaliseLocalPart`): the owner of a domain decides its names.
3. **Global and never reissued.** Addresses are lowercase, so uniqueness is case-insensitive; mailboxes and aliases
   share one address space (`lockAddress` + `addressTaken`). A platform address that was in use and is gone (a purged
   mailbox and its masked aliases, a deleted masked alias) is written to `retired_platform_address` and is never given
   to a **different** account; the account that held it may take it back. No foreign key: deleting an account doesn't
   free its addresses.
4. **No account owns the platform domain.** It is configuration (`deps.platform.domain`), never a `customer_domain`
   row: customers can't add it (`normaliseDomain`), so the domain, DNS and catch-all screens never show or edit it.
   The create form sends `domainId: "platform"` for it. On the mail server it is the deployment's system domain,
   created by the bootstrap (production) or the seed (dev). The reconciler always counts it as desired. A deployment
   whose platform domain is the company's staff domain gets no free addresses (rule 28).
5. **Gates while sign-up is open:** the console user's email must be confirmed (better-auth email verification, link
   valid `EMAIL_VERIFICATION_HOURS`, sent at sign-up and from the console's own route only); creation is rate-limited
   per account and per client address, fail closed (`platformMailboxAccount`, `platformMailboxIp`); the availability
   check is rate-limited per caller and per address, fail closed, and answers only available / not available (or the
   naming rule broken) — never whether a name is a mailbox, an alias, retired or whose; everything is audited
   (`mailbox.created` with `platformAddress: true`; refusals as `denied`).
6. **Staff path:** a Global Administrator (`platform.mailbox.create`, critical) can create a platform address in any
   customer account from Platform → account. Same name rules, allowance and no-reuse check; no email-confirmation
   requirement (staff vouch for it). **No password is set** — staff never choose a customer's mailbox password — the
   account's Owner or User Administrator sets it (`mailbox.password.reset`). Audited as `mailbox.created` by staff in
   the account's own log (rule 49); refusals before the account is known go to the platform log only, so a probe
   can't write into an account's log. **Refused during act-as**: act-as is a view of the customer's console, not a
   staff tool, and creation there would be indistinguishable from the customer's own.
7. **Reconciler:** customer mailboxes on the platform domain are ordinary desired mailboxes. `RECONCILE_IGNORE_DOMAINS`
   keeps meaning "ignore unknown accounts on this domain" for every domain except the platform domain, where only the
   system accounts (`svc-*`, `no-reply`, `postmaster`, `abuse`, `dmarc-reports`, `tls-reports`) are expected and any
   other unknown account is reported as drift (never deleted). The service-account check already lists only the `svc-*`
   names, so customer mailboxes there are not service-account drift (integration-tested).

## Why

- **4–32 characters, short names held back:** short names are scarce, valuable and the first thing squatters and
  resellers take; holding back 1–3 characters keeps them for later decisions and costs real users little.
- **One per Free account:** the free tier is the abuse surface (03-anti-spam-and-abuse.md "Free-tier risk"); one
  address per account bounds what a single sign-up yields. Paid accounts are bounded by the mailbox ceiling.
- **Reserved names:** nobody may receive mail that people expect to reach us (abuse reports, certificate checks,
  support) or pass themselves off as staff.
- **No reuse:** mail keeps arriving at old addresses for years (password resets, receipts, people). Handing an address
  to someone new would deliver the old owner's mail — and account-recovery links — to a stranger.

## Consequences

- Sending limits for free mailboxes remain Phase 6 (trust tiers stored and enforced, fail-closed outbound counters):
  the main open risk while sign-up is open. **Maintainer decision 2026-10-23 (risk accepted):** free mailboxes may
  send externally with no extra restriction until Phase 6 and sign-up stays open; the risk is the platform domain's
  and outbound IP's reputation, which transactional mail depends on. Mitigation: staff watch Platform → Customer
  accounts and the platform audit, close sign-up or suspend on abuse; Phase 6 is the fix
  (03-anti-spam-and-abuse.md "Free-tier risk").
- Security review run-27: reserved names are compared without `.`, `-`, `_` and trailing digits (`reservationForm`),
  names containing `anhourmail`/`anhourtec` are refused, the list gained list/report addresses; masked aliases on the
  platform domain skip reserved-looking draws. The availability check answers only someone with a confirmed email and
  allowance left (one generic 403 otherwise), is limited per person (user id) and per client address, and "in use"
  and "retired" take the same path. Full IPs in the platform audit need `platform.audit.full_ip` (Global
  Administrator only); Reports Readers see the network part.
- Account deletion (not built) must go through the mailbox purge (or a database trigger must retire platform addresses)
  — a cascade delete of an account would free its names without retiring them.
- Chosen aliases stay on the account's own domains only; masked aliases of a platform mailbox are random addresses on
  the platform domain (12 characters, well inside the rules) and are retired when deleted.
- Phone verification (SMS/OTP) is still the intended sign-up gate before a public launch; email confirmation is the
  interim gate.
- Ops: on a server whose `RECONCILE_IGNORE_DOMAINS` is the platform domain, unknown non-system accounts there are now
  reported. Any other hand-made account on the system domain must be removed or recorded.

## Update (2026-10-24)

"Add a user" (`packages/core/src/mailboxes/add-user.ts`, `POST /api/accounts/:accountId/users`) can put the new
person's mailbox on the platform domain under the same rules, allowance, no-reuse check and email-confirmation gate;
the route spends `platformMailboxAccount` and `platformMailboxIp` like the mailbox route, and the entry is
`account.user_added` with meta `platformAddress`. Storage is pooled per account since 2026-10-23 (`plans.ts`
`storagePoolGb`), so a free address shares the Free account's pool. The availability answer the console uses to offer
it (`people/availability.ts`, `email_unverified` when the sign-in email isn't confirmed) changes nothing above.
