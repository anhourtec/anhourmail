# ADR-0019: Sender identity enforcement for authenticated mail

**Status:** Accepted 2026-10-21 · Updated 2026-10-30 (send-on-behalf exception, one Sender address; the tag's expiry and Message-ID form; below)

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

## Update 2026-10-30: one keyed exception (send on behalf), one Sender address, self-addressed mail

Built with ADR-0026 slice 10 (§8 there is the design). The decision above stands; three changes to the script
(`senderIdentitySieve` in `packages/stalwart-client/src/sender.ts`):

1. **Exactly one `Sender:` address.** Rule 4 used Sieve's `address :is`, which is true when _any_ address matches, so
   a second `Sender:` header (or a `Sender:` listing two addresses) rode along with a matching one — verified on
   v0.16.27 (accepted with 250 before this change). When a `Sender:` is present the script now counts its addresses
   over every `Sender:` header first and refuses anything but one ("Use exactly one address in the Sender header",
   5.5.3). This only tightens the rule.
2. **Send on behalf.** When that one `Sender:` differs from the envelope sender, the message must have exactly one
   `Message-ID:` and carry `X-AnhourMail-On-Behalf` equal to hex `sha256(K | inner)` with
   `inner = hex sha256(K | lowercase envelope sender | lowercase Sender | Message-ID)` (the id as Stalwart reads it:
   without angle brackets, case kept). Binding the tag to the Message-ID means a tag copied from a stored message is
   useless with any other Message-ID; reusing the same Message-ID with a new body still passes (ADR-0026 §8). (security review 2026-10-30: the first, per-pair tag could be replayed by anyone signed in as
   the mailbox, even after the grant was revoked); the outer hash rules out length extension. The computed tag must be
   64 lowercase hex before it is compared, because a failed Stalwart expression leaves the `let` variable **empty**
   (verified on v0.16.27: `hash(x, 'nosuchalgo')` and `to_lowercase(header.nosuch.addr)` both give `""`), and an
   empty tag header would otherwise match. `From` must still equal the envelope sender (checked first, unchanged), so
   the mailbox's own sign-in is needed — in practice the web app holding the mailbox's token. `K` is
   `SENDER_DELEGATION_KEY` (64 lowercase hex, web app and this script only; the worker refuses to start with it); the
   bootstrap writes it into the script text, which is why the key format is enforced (nothing in it can end the Sieve
   or expression string), and why `applySenderIdentityPolicy` never passes Stalwart's error descriptions on (a compile
   error quotes the script text — verified). The tag header is removed from **every** authenticated submission
   (`deleteheader`), so it is never delivered. Without a key the exception isn't compiled in at all (every differing
   `Sender:` refused, as before). The tag is computed by `onBehalfTag` (`packages/core/src/webmail/on-behalf.ts`, which
   also refuses addresses or ids with `|`, `"`, `<`, `>`, whitespace or control characters); a unit test pins the two
   formulas to each other.
3. **Self-addressed mail is not a bypass** (investigated 2026-10-30 after a probe "delivered" a forged-From message
   from a mailbox to itself while the recipient throttle was being hit). Clean probes on throwaway accounts: a
   forged From to the sender's own mailbox is refused at DATA with 5.5.3 over SMTP 465 and JMAP, exactly like any
   other recipient. When the per-recipient throttle (`senderDomain` + `rcpt`, 25 / hour) refuses every recipient at
   `RCPT` (452), a JMAP `EmailSubmission` is still _created_ (`undoStatus: final`, `deliveryStatus` "not delivered,
   452"), but DATA never runs and nothing is queued or delivered (re-checked after 90 s). What looked like delivery
   was that created submission and the unsent draft, with its forged From, left in the sender's own Drafts. No script
   change was needed; `stack:verify` now checks it with a throwaway mailbox (own From to itself delivered, forged
   From to itself refused at DATA), so the throttle can never answer first.

4. **Odd field names are not a way round** (probed 2026-10-30 over SMTP 465 as a mailbox): `Sender : x`,
   `Sender<TAB>: x`, `sEnDeR: x`, `Sender:x`, and the same tricks on `From` (alone, or next to a correct `From:` in
   either order) are all read by Stalwart's parser as the real header, so the checks see them: every variant was
   refused (forged address, or "exactly one address") and none reached Mailpit. No extra rule was needed;
   `stack:verify` keeps six of them as regression cases. Odd `Sender:` forms: group syntax and `<>` count as zero
   addresses (refused by the count); an encoded word and a source route parse to one address that needs a tag like any
   other (`header.sender.addr` keeps the route, `@relay:bob@…`), so nothing is accepted without the web app's tag.

Verification (`npm run stack:verify`, all on the pinned v0.16.27): the right tag is accepted over SMTP and JMAP and
delivered with `Sender:` and without the tag header, to Mailpit and to a local mailbox (stored copy checked); refused:
wrong, missing, empty, another pair's and another Message-ID's tag, no Message-ID, two Message-IDs, the four odd Sender
forms with no or an empty tag, a delegate putting the mailbox in `From:` even with the tag, a second `Sender:`, the
odd field names, and a forged From to another mailbox or to the sender's own. Run with a different
`SENDER_DELEGATION_KEY` than the server's, the three acceptance checks fail (negative control). The probes on throwaway
accounts also covered mixed-case addresses (accepted), a reversed pair (refused) and two tag headers with one right
(accepted: a right tag can only stand for the same message). Stalwart stores a system script without its final
newline, so the policy compares texts without trailing space (it used to rewrite the script on every run).

**Open probe item (not changed):** `Resent-From:` / `Resent-Sender:` are not checked, and a display name that itself
contains an address (`From: "ceo@bank.example" <alice@…>`) passes because only the address is compared. Both are
rendering questions for recipients' clients and our webmail; probe them and decide before launch.

The first bullet of "Consequences" is superseded by this update: send on behalf is the keyed exception above,
webmail only, audited by the web app (ADR-0026 §6).

## Update 2026-10-30 (later): the on-behalf tag expires, and the Message-ID must be readable

Built with ADR-0026 slice 13 (its dated update has the probes). The keyed exception above now also requires exactly one
`X-AnhourMail-On-Behalf-Expires:` header in the form `YYYY-MM-DDTHH:MM:SSZ`, not yet passed by Sieve's
`currentdate :zone "+0000"` (text comparison of two UTC values in the same form, verified on v0.16.27), and binds it
into the inner hash: `inner = hex sha256(K | envelope | Sender | Message-ID | expiry)`. The web app sets it five minutes
ahead. The Message-ID is read into a variable and must be `local@host` in letters, digits and `._%+=-` before it is
hashed, because the pinned server reads an unreadable one (`<>`, empty) as `""` rather than failing the expression.
Both headers are removed from every submission. `stack:verify` gained: an expired tag, a changed expiry, no or two
expiry headers, a non-UTC expiry, an empty Message-ID with the tag for an empty one and a bracketless id with its
matching tag — all refused; the accepted cases still deliver without either header. Applied to the dev server through
the management API (`applySenderIdentityPolicy` + `ReloadSettings`, no restart); the production bootstrap applies the
same text.

The expiry test fails closed: the script refuses unless `currentdate :zone "+0000" :value "le" "iso8601" "<expiry>"`
matches, so a comparison the server can't confirm refuses the message. Without the `date` extension, or with an
invalid zone, the script doesn't compile and isn't installed (probed on v0.16.27; `applySenderIdentityPolicy` then
fails and the previous script stays). `stack:verify`'s expired case uses the mail server's own clock (HTTP `Date`), ten
minutes back.

**Re-check on every Stalwart upgrade (rule 22):** that `currentdate` still answers `iso8601` as `YYYY-MM-DDTHH:MM:SSZ`
under `:zone "+0000"` and that a comparison it can't make doesn't match (fail closed), and that an unreadable
`header.message-id` still reads as `""` (or now fails the expression); `npm run stack:verify` covers the accepted,
expired and malformed cases, and its negative control (a different key) must still fail the acceptance checks.

## Alternatives

- Relying only on the BFF to pick identities: covers the webmail but not IMAP/SMTP clients. Kept as an extra check.
- An MTA expression: no expression hook can reject on header content; Sieve at DATA is the supported path.
- Rewriting `From:` to the envelope sender: silently changes users' mail; refusing is clearer.
