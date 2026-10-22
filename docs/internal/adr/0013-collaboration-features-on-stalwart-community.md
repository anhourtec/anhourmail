# ADR-0013: Collaboration features (familiar business-mail set) on Stalwart Community

- Status: Accepted 2026-10-21
- Deciders: Nishchayjeet Singh (Nish)
- Related: ADR-0001, ADR-0002, ADR-0009, `10-collaboration.md`

## Context

The product should offer the mail collaboration features users know from mainstream business mail suites:
shared mailboxes, distribution lists (incl. dynamic), groups, delegated access (full access, send as, send on
behalf, folder sharing), resource mailboxes, mail flow rules, forwarding, auto-replies, message trace. We run
Stalwart v0.16.27 Community, unmodified, driven only through its JMAP management API.

Live probes against the pinned server (2026-10-21) showed: groups work as shared mailboxes and grant members
full rights plus an automatic send-as identity; mailing lists fan out but have **no posting restriction**;
JMAP folder sharing (RFC 9670) works with enforced per-right ACLs; header `From:` of a local group could be
spoofed by a non-member; message trace (`x:Trace`), archiving and masked email are **Enterprise-only**.

## Decision

1. Build collaboration on Community primitives: `Group` accounts for shared mailboxes and groups,
   `x:MailingList` for distribution lists, `Mailbox.shareWith` for delegation, Sieve (user + system) for rules.
2. The control plane is the source of truth for memberships, grants, posting policy and rules; provisioning
   jobs apply them; the reconciler reports drift. Same pattern as ADR-0002.
3. Policies Stalwart lacks are ours: members-only list posting (generated system Sieve + BFF check), send-as /
   send-on-behalf authorisation in the BFF, header-From enforcement for authenticated submissions, full access
   as "all folders, kept in sync", dynamic lists computed by a job, message trace from our own mail-flow log.
4. Customers never write raw Sieve: mail flow rules come from a constrained builder compiled by us.
5. Out of scope: litigation hold, eDiscovery, retention policies, journaling, public folders.
6. Plans: Free gets own-mailbox features (folder sharing, filters, forwarding, auto-reply); Plus/Supporter get
   shared mailboxes, lists, groups, delegation, mail rules, resource mailboxes, admin message trace.

## Consequences

- More control-plane code (grants, policy compilation, reconciliation of ACLs), but no Enterprise licence and
  no fork.
- The header-From gap must be closed before shared mailboxes ship (Phase 1 prototype + regression test).
- Lists are an abuse amplifier: expanded recipients count against sending limits; caps live in private config.
- New permissions in the matrix; `delegation.manage.any` and `forwarding.manage.any` are critical (Owner only).

## Alternatives considered

- **Stalwart Enterprise** (tenants, archiving, trace): solves trace/undelete, not posting policy or delegation
  UX; per-mailbox licence cost doesn't fit the price point. Revisit at scale.
- **Implementing lists in our worker (expand and resend)**: full control, but we would become a mail relay with
  bounce/DSN handling; rejected for v1.
- **Not offering delegation**: simpler, but a core expectation for families and small groups.
