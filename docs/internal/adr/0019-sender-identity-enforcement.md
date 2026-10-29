# ADR-0019: Sender identity enforcement for authenticated mail

**Status:** Accepted 2026-10-21

## Context

Stalwart's `MtaStageAuth.mustMatchSender` checks only the SMTP envelope sender. In the Phase 0 collaboration probe
an authenticated user sent mail whose visible `From:` was a group address they did not belong to. A Phase 1 probe
(Stalwart v0.16.27, SMTP 465/587) showed the same for any address: another local user's, or an external one. Mail we
accept from our users is DKIM-signed with our domains, so a forged local `From:` would pass DMARC at the receiver —
a phishing primitive and a deliverability risk.

## Decision

Install a Sieve **system script** `sender-identity` and run it at the DATA stage for authenticated sessions only:
`MtaStageData.script = if !is_empty(authenticated_as) then 'sender-identity' else false`, with
`MtaStageAuth.mustMatchSender = true` kept. The script requires:

1. a `From:` header;
2. exactly one address in it;
3. that address equals the envelope sender (`${envelope.from}`, already checked against the account's own address,
   aliases and groups by `mustMatchSender`), case-insensitively;
4. if a `Sender:` header is present, it equals the envelope sender too.

JMAP `EmailSubmission` goes through the same DATA stage, so one rule covers SMTP clients and the webmail.
Implemented in `packages/stalwart-client/src/sender.ts` (`applySenderIdentityPolicy`), applied by the dev plan;
production applies the same objects (`x:SieveSystemScript` named `sender-identity` with the script text, the
`x:MtaStageData.script` expression above, `x:MtaStageAuth.mustMatchSender = true`, then `ReloadSettings`) from the
provisioning/bootstrap code in the private ops repository.

Group members may send as the group only with the group as envelope sender — the identity Stalwart creates for
members does exactly that. Non-members cannot (already refused at `MAIL FROM`).

## Verification

`npm run stack:verify` checks that alice's own header From is accepted and a forged one (`bob@dev.test`) is refused.
The probe matrix (own address, own alias, display name, member as group: accepted; forged local/external From,
non-member as group, two From addresses, forged Sender, missing From: refused with 5.5.3 on SMTP and
`forbiddenToSend` on JMAP) is recorded in `10-collaboration.md`.

## Consequences

- "Send on behalf" (`Sender: delegate`, `From: owner`) is refused by rule 4. If we offer it (Phase 4.1) it needs an
  explicit, audited exception (e.g. a per-delegation allow-list the script reads) — never a blanket relaxation.
- Mailing-list software and forwarders that rewrite `From:` must submit as their own address.
- Addendum 2026-10-28: the same script also deletes every `Authentication-Results` header from submitted mail
  (`editheader`), because Stalwart stamps none on authenticated submission and a sender could otherwise plant results
  the recipient's webmail would show (`07-security.md` "Authentication results in the webmail"). `stack:verify`
  submits a message with a forged results header and checks it arrives without one; the webmail in turn trusts only
  the results header directly below our own topmost `Received` (`02-mail-infrastructure.md`).
- Stalwart-specific detail: Sieve match variables (`${1}`) are empty in this context, so the script compares with
  `${envelope.from}` directly. Re-verify on every Stalwart upgrade (rule 22) — `stack:verify` does.

## Alternatives

- Relying only on the BFF to pick identities: covers the webmail but not IMAP/SMTP clients. Kept as an extra check.
- An MTA expression: no expression hook can reject on header content; Sieve at DATA is the supported path.
- Rewriting `From:` to the envelope sender: silently changes users' mail; refusing is clearer.
