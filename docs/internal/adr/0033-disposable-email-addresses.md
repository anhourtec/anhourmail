# ADR-0033: Refuse disposable email addresses

**Status:** Accepted 2026-11-06

## Context

The maintainer asked (2026-11-06) that the platform not accept temporary-inbox addresses (services that hand out an
inbox for minutes or days, such as temp-mail.org and temp-mail.io). An outside address enters the control plane in
three places: console **sign-up** (the sign-in address, confirmed by email), **people invites** (the invited address,
which becomes a console sign-in) and **webmail forwarding** (an outside target, confirmed from that inbox). A
throwaway address in any of them lets someone make accounts nobody can reach later (support, billing notices,
recovery), farm free accounts for abuse (rule 27, rule 62), or forward mail to an inbox that anyone can read.
Changing the sign-in address is switched off, and "Add a user" uses one of the account's own addresses, so neither is
an entry point. Staff invite codes may carry an address; staff are trusted, so they are not checked.

Research (2026-11-06, public DNS only):

- The CC0 list `disposable-email-domains/disposable-email-domains` (`disposable_email_blocklist.conf`, 10,143 domains,
  updated 2026-11-04) covers temp-mail.org and the six domains temp-mail.io hands out today, but not temp-mail.io
  itself, and services register new domains faster than any list.
- Those services receive mail on a few machines. Resolving the mail servers (MX, then their IPv4 addresses) of every
  listed domain: one address receives for 1,160 listed domains, several for 300–650; all six current temp-mail.io
  domains name their own `mail.<domain>` but resolve to one address that serves seven listed domains. A new domain
  pointed at the same machine is caught without a list update.
- Shared infrastructure also hosts throwaway domains (Cloudflare Email Routing — temp-mail.org itself — Google
  Workspace, Mailgun, Amazon SES inbound, registrars' forwarding, parking). Their addresses must never count, or real
  people on those providers would be refused.

## Decision

1. **Two checks, one verdict** (`packages/adapters/src/disposable-email/`, port `DisposableEmailCheck` in
   `packages/core/src/security/disposable-email.ts`):
   - **Domain list:** the address's domain or any parent domain (not the bare TLD) is on the vendored list or the
     deployment's extra list (`DISPOSABLE_EXTRA_DOMAINS`), and not on its allow list (`DISPOSABLE_ALLOW_DOMAINS`, for
     a false positive until the next list update). Local, no network.
   - **Mail server:** the domain's MX hosts (or the domain itself when it has no MX, RFC 5321 §5.1) resolve to an IPv4
     address on the vendored disposable mail-server list. MX hosts on a shared-provider suffix are skipped, not trusted (a dummy `mx.google.com` can't hide a disposable
     server), and reserved or internal names (`.internal`, `.local`, `.test`, single labels, …) are never looked up,
     so attacker-chosen names can't make us query internal DNS. DNS has a 1.5 s budget; answers are cached in Redis for a day.
2. **Failure mode: open.** A DNS timeout or error (or no Redis) means "not shown to be disposable": the domain list
   still applies and email confirmation still follows. Logged with the domain only.
3. **Where:** the sign-up gate (after the proof-of-work and attempts tier, before the account tiers, so a refused
   address never takes an account slot), `inviteMember` before its transaction, and the forwarding target before the
   confirmation email. Refusal: `422 disposable_email`, "Use a permanent email address. Temporary and disposable inboxes
   can't be used here." Sign-up refusals are logged and audited like the other sign-up refusals
   (`auth.sign_up_refused`, reason `disposable_email`, once per network an hour); never the address, only its domain
   in the log line.
4. **Data:** `scripts/disposable-email-update.mjs` downloads the list at the upstream's latest commit, resolves every
   domain's mail servers through public resolvers, keeps addresses that receive for at least five listed domains and
   aren't on a shared-provider suffix or in a shared or reserved range, and writes
   `packages/adapters/src/disposable-email/data.generated.ts` with the source commit, date and counts. Run monthly (and
   on a report of a missed service); review the diff (the address list is small) before committing. The upstream is
   credited in `THIRD_PARTY_NOTICES.md`.
5. **Not done:** checking existing accounts' addresses (a later report for staff), staff-entered addresses, and blocking
   by network ranges (too broad).

## Consequences

- temp-mail.org's own and listed domains are refused; its unlisted new domains ride on Cloudflare and are caught only
  once listed. temp-mail.io's new domains are caught by the mail-server check on day one.
- A real person on a small host that also serves disposable domains could be refused; the message says what to do,
  and support adds the domain to `DISPOSABLE_ALLOW_DOMAINS`.
- Public docs say disposable addresses aren't accepted; the mail-server list and the five-domain rule are detection
  details and stay out of public docs (rule 33), though the generated data is in this public repository.
