# ADR-0019: Sender identity enforcement for authenticated mail

**Status:** Accepted 2026-10-21 · Updated 2026-10-30 (send-on-behalf exception, one Sender address; the tag's expiry and Message-ID form; the internal-mail marker and its review follow-up; forwarding skips DMARC failures; below)

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

## Update 2026-10-30 (internal mail): a keyed marker for mail submitted here, removed from mail arriving from outside

**Problem.** The webmail offers "Just this once / Always for <sender>" for remote images only when the From is verified
(`senderVerified`, `apps/web/src/server/webmail/image-proxy.ts`). Since security-audit run-32, a message with no
Authentication-Results of ours counts as not verified, because a copy redirected by a mailbox's own rule arrives with
our LMTP `Received` on top and no results, whatever its From says. Mail submitted to our own server and delivered here
(between our users, and our system mail) never passes the inbound checks either, so it also read "We can't confirm
this message came from anhourmail.com". That bypass had to stay closed.

**Probed on the dev stack (v0.16.27), headers on the stored copy, top down** (throwaway accounts, removed afterwards):

| Path                                                                        | Headers above the sender's own                                                                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) SMTP 465 submission to a local mailbox                                  | `Delivered-To`, `X-Spam-Status`, two `DKIM-Signature` (ours). **No `Received`, no results**; headers the client wrote (a fake `Received … with ESMTPSA`, `X-*`) are kept |
| (b) JMAP `EmailSubmission` (the webmail)                                    | as (a)                                                                                                                                                                   |
| (c) system mail (`MAIL_TRANSPORT_URL`: `smtps://no-reply@…@stalwart:465`)   | as (a) (nodemailer over 465). In dev `MAIL_TRANSPORT_URL` is Mailpit, so dev system mail never reaches Stalwart                                                          |
| (d) port 25, no or failed authentication (From forged as a local address)   | `Delivered-To`, `X-Spam-Status`, `Received … with ESMTP`, our `Authentication-Results`, `Received-SPF`, `X-Spam-*`, `Return-Path`                                        |
| (e) copy redirected by the recipient's own Sieve `redirect :copy` (from 25) | `Delivered-To`, `X-Spam-Status`, two `DKIM-Signature` (**ours, over the original From**), `Received … with LMTP`, then (d)'s block                                       |
| (e') the same for internal mail                                             | `Delivered-To`, `X-Spam-Status`, our `DKIM-Signature`s, `Received … with LMTP`, then (a)'s block                                                                         |
| (f) mail from outside that passed DMARC                                     | as (d), with `dmarc=pass`. Not producible in dev (no DNS egress: every check is `temperror`); the parser path is unit-tested                                             |

Port 587 without AUTH refuses `MAIL` (503 5.5.1), so port 25 is the only unauthenticated way in. A submission without
a `Message-ID` is stored without one (Stalwart adds none for local delivery).

**Options considered.** (1) Our `Received … with ESMTPSA` as the only hop: Stalwart writes no `Received` on submission
at all (`addReceivedHeader` is `local_port == 25`), so the top of a submitted message is whatever the client wrote — a
planted one survives (probe (a)). (2) "Our DKIM signature with no `Received` above it": a redirected copy of a forged
outside message gets our DKIM signature on top too (probe (e)), so it can't tell them apart. (3) Stalwart-side
results for local delivery: `addAuthResultsHeader` for submissions would report checks of our own outbound path, not
a verdict on the From; not a supported meaning. (4) **A header only our submission script adds, removed on arrival from
outside, and keyed** — chosen.

**Decision.**

1. The `sender-identity` script (authenticated sessions only, after From = envelope sender is enforced and every
   `Authentication-Results` removed) also removes every `X-AnhourMail-Internal` header the client sent, then — when the
   message has exactly one `Message-ID` in the `local@host` form the on-behalf check uses — adds
   `X-AnhourMail-Internal: hex sha256(K | hex sha256(K | "internal-mail-v1" | lowercase envelope sender | Message-ID))`.
   `K` is `SENDER_DELEGATION_KEY` (already in the script and the web app; the worker never holds it). The label keeps it
   apart from the on-behalf tag, whose inner hash has an address in that position. A failed expression leaves the
   variable empty, so only a 64-hex digest is added. Without a key, any marker is removed and none added.
2. A second system script, `inbound-headers`, runs at DATA for every **unauthenticated** session
   (`MtaStageData.script` `else` branch, previously `false`) and does one thing: `deleteheader "X-AnhourMail-Internal"`.
   Inbound checks, our `Received` and results are unaffected (probed: the results header still sits directly below our
   `Received`).
3. The webmail (`isInternalMail` in `apps/web/src/server/webmail/original.ts`, `internalMailTag` in
   `@anhourmail/core/webmail`) treats the From as verified when there is exactly one `From`, one `Message-ID` and one
   marker, and the marker equals the tag for that From and Message-ID. Everything else is as before: our own trusted
   results (DMARC pass for the From domain, or aligned DKIM pass), and `null` results without a marker is not verified.

**Why it can't be forged.** Every way into a mailbox is one of: an authenticated submission (the script deletes any
marker and adds its own, bound to the address mustMatchSender and the From check have already proved is the account's,
so only an address on a domain we host whose ownership was checked before it reached the mail server); an
unauthenticated session on port 25 (the marker is deleted at DATA, including oddly spelled names, which Stalwart's
parser reads as the same header); a Sieve redirect of a message already stored (it keeps that message's headers, so a
redirected copy of outside mail has no marker and a redirected copy of internal mail keeps one whose From is ours); or
the mailbox writing into itself (IMAP `APPEND`, JMAP `Email/set`/`import`). Two walls: the inbound strip stops a
genuine marker copied, with its From and Message-ID, into mail sent from outside (the negative control below shows the
key alone wouldn't); the key stops a made-up one anywhere, including the self-write path, where only a marker copied
from a genuine message with that message's own From and Message-ID could pass — the same residual as a planted results
pair in one's own mailbox (`07-security.md` "Authentication results in the webmail"). A future mail import must remove
the header, like the on-behalf headers.

**Verification** (`npm run stack:verify`, "Internal mail: marker on every path…", on throwaway mailboxes): JMAP and
SMTP 465 submissions arrive with exactly one marker that the webmail's own `isInternalMail` accepts for the From and
refuses for another From or another key (negative control); three planted spellings are replaced by one valid marker;
no `Message-ID` means no marker; the genuine marker copied into a port 25 message with the same From and Message-ID
(two spellings) is removed and our results are still read; that outside message sent to a mailbox that redirects has a
redirected copy with no marker and no trusted results (not verified, the run-32 property); a redirected copy of
internal mail keeps a valid marker. With the old DATA expression (`else: false`, no inbound strip) put back, the port 25
and redirect checks fail; re-applying the policy makes them pass. Applied to the dev server through the management API
only (`applySenderIdentityPolicy` + `ReloadSettings`, no restart); the production bootstrap applies the same call.

**Notes.** Probe (e) also showed that a redirected copy of a message from outside is DKIM-signed by us over its
original From (see the next update). **Re-check on every Stalwart upgrade (rule 22):** that submissions still get no
`Received`, that the `else` branch of `MtaStageData.script` still runs for port 25 and `deleteheader` still removes the
header there, and that redirects still keep the stored headers; `stack:verify` covers all three.

## Update 2026-10-30 (internal mail, review follow-up): local recipients only, a reader barrier, exact names, redirect signing

Two security reviews of the marker (0 confirmed findings) asked for hardening; all probed on v0.16.27 with throwaway
accounts.

1. **Marker only for mail that stays here.** The script adds it only when every envelope recipient is on a domain we
   host, so outside recipients never get one (nothing to replay, no hosting fingerprint for custom domains). In a
   DATA-stage `let`, `envelope.to` is the recipient array (`count(envelope.to)` = 2 for two), `envelope.to[i]` past its
   end reads as empty, `||` short-circuits and `is_local_domain` works; a Sieve `envelope :domain :is "to"` test was
   **not** true for a second, outside recipient, so it isn't used. The expression (`allRecipientsLocalExpression`)
   checks recipients 0–99 by index and needs 1–100 recipients (Stalwart's default `maxRecipients`); more means no
   marker. A local recipient whose own rule forwards outside still sends the marker on in that copy.
2. **Reader barrier** (`isInternalMail`): false when any `Authentication-Results` or `Received-SPF` header appears
   anywhere (look-alike spellings included), or any `Received` stamped by our host with anything but LMTP. Internal mail
   never has these: the submission script deletes every results header, submissions get no `Received`, a redirect adds
   only an LMTP one. Needed because **Stalwart skips a missing or inactive system script and delivers** (probed:
   `inbound-headers` set inactive, then destroyed — both times port 25 mail was accepted with the marker kept). With the
   strip off, a replayed genuine marker on port 25 and its redirected copy are both refused by the reader (probed).
3. **Exact header names.** Stalwart keeps names ending in NBSP, a BOM or `\v` as written and its `deleteheader`
   doesn't remove them; a name ending in `\f` is removed. JS `trim()` strips all of those, so the reader now counts
   look-alikes loosely (ASCII-lowercased, everything but `[a-z0-9]` removed), needs exactly one, and needs that one to
   be named exactly (ASCII-only lowercasing). The same rule now applies to every name match in `original.ts`, and the
   raw-source parser (`parseHeaderBlock`, "Show original") trims only ASCII space and tab before the colon: before this,
   a submitter could plant `Received\u00a0` + `Authentication-Results\u00a0`, which the submission strip misses, and
   the parser trimmed them into a pair it trusted (unit-tested now).
4. **BDAT.** Port 25 advertises `CHUNKING`; a message sent with `BDAT … LAST` has the marker removed like `DATA`.
5. **No re-serialisation.** With the strip active, the stored sender's header block is byte-identical to what was sent
   apart from the removed line (folded, padded and odd-case headers kept), so the strip can't break an original DKIM
   signature. Our own `DKIM-Signature` covers `Subject:To:From:Date:Message-ID` (in some order); the marker
   is never in `h=`.
6. **Exempt sessions.** None found: `mustMatchSender` is `true` for every session, and the dev recovery admin was
   refused (`501 5.5.4`) as another mailbox and a foreign address (and `501 5.1.8` for its bare name); the schema has
   no "send as anyone" permission. Members of a group or mailing list can send as the group address, so they get valid
   markers for it — the same trust the group's own From already has here. Re-check if a relay or service credential
   that may send as other addresses is ever added.
7. **Drift.** The reconciler doesn't check system scripts: its keys have fixed, verified scopes without
   `sysSieveSystemScriptGet`, so adding it changes the key split (both repos). Not done; `stack:verify` checks both
   scripts end to end, and the reader barrier covers an inactive strip.
8. **Import and delegate IMAP.** A future mail import, and IMAP access for delegates if it is ever offered, must
   remove `X-AnhourMail-Internal` (and the on-behalf headers) from what they store.

### Redirected copies are signed by us (pre-existing, rated high; not changed — maintainer decision)

An outside sender can send `From: support@anhourmail.com` on port 25 to a mailbox with confirmed forwarding; the copy
leaves signed by us. Probed:

- Redirects are signed by **`x:SieveUserInterpreter.dkimSignDomain`** (`is_local_domain(sender_domain)` →
  `sender_domain`), not by `x:SenderAuth.dkimSignDomain`: variants of the latter (`local_port != 25`,
  `local_port != 0`, `!is_empty(listener)`, `remote_ip != '127.0.0.1'`) all left redirects signed, and the last two
  unsigned JMAP submissions (they run with `local_port` 0 and `remote_ip` 127.0.0.1).
- A redirect's envelope sender is the forwarding mailbox (`fwd@dev.test`; no SRS), so `sender_domain` is ours and every
  redirect is signed `d=` our domain: unaligned (harmless for DMARC) for a foreign From, **aligned** for a forged From
  on a domain we host, so the target sees DMARC pass. No ARC seal is added.
- A DATA-stage script on port 25 can read the From header (`is_local_domain(email_part(header.from.addr, 'domain'))`
  = 1 for ours) but **not** our results: Stalwart adds `Received` and `Authentication-Results` after the script runs,
  so an inbound script can't refuse on the DMARC verdict.

Options for the maintainer: (a) `x:SieveUserInterpreter.dkimSignDomain` = `false` — simplest, but it also unsigns our
users' automatic replies (vacation goes through the same interpreter), which under our `p=reject` would be refused;
not acceptable as is. (b) Make the managed forwarding rule skip a message whose stored results say `dmarc=fail`
(`header :contains "Authentication-Results" "dmarc=fail"`; a forged results header can only stop forwarding of the
sender's own mail; the copy stays in the inbox): closes the forged-own-domain case where our domains publish
`p=reject`/`quarantine` DMARC (a fail is a fail whatever the policy), costs forwarding of other DMARC-failing mail
(much of it would be refused by the target anyway). Not provable in dev (no DNS: every result is `temperror`).
(c) `x:SenderAuth.dmarcVerify` `strict` for port 25, which enforces published policies at the door — standard
practice, but it applies to every sender domain and can refuse mailing-list traffic that keeps the original From.
(d) A spam-filter rule rejecting port 25 mail whose From is a hosted domain and whose DMARC isn't `pass` — tightest,
but it also refuses lists that keep our users' From and customers' misconfigured third-party senders. Recommendation:
(b) now, (c) or (d) after pre-staging shows real traffic; SRS for redirects is a separate deliverability question.

## Update 2026-10-30 (forwarding and DMARC): the maintainer chose option (b), then widened it

**Decisions (maintainer, 2026-10-30):** the managed forwarding rule doesn't forward (1) a message whose Authentication-
Results from our own server say `dmarc=fail`, nor (2) a message whose From is on the forwarding mailbox's own domain or
a subdomain of it unless our results show `dmarc=pass` — so `none`, `temperror` and `permerror` on a customer domain
with no or a broken DMARC record are covered too. Part 2 is exactly the case where the copy's DKIM signature (made with
the forwarding mailbox's domain, `x:SieveUserInterpreter.dkimSignDomain`) would be aligned with the From. The message
stays in the mailbox as usual (`:copy` / implicit keep unchanged). Redirect signing is unchanged (it also signs
automatic replies).

**Built:** `forwardingGuard(authservIds, mailboxDomain)` in `@anhourmail/core/webmail` (one source for the web app's
generator, its upgrade and the reconciler) wraps the redirect, inside the unchanged spam / bulk / auto-submitted guard,
in

```sieve
if not anyof (
  header :matches "Authentication-Results" ["<id>;*dmarc=fail*", …],
  allof (anyof (address :domain :is "from" "<domain>", address :domain :matches "from" "*.<domain>"),
         header :index 1 :matches "Authentication-Results" ["<id>;*", …],
         anyof (anyof (address :count "gt" :comparator "i;ascii-numeric" :all "from" "1",
                       header :count "gt" :comparator "i;ascii-numeric" "from" "1"),
                not header :index 1 :regex "Authentication-Results" "<dmarcPassRegex(domain)>"))) { redirect … }
```

(on one line in the script; `index`, `regex`, `relational` and `comparator-i;ascii-numeric` are added to `require`
only with part 2). The ids are
`trustedAuthservIds` (now in core; the reader re-exports it); the domain is the mailbox address's. Both are written only
as plain hostnames (`isPlainHostname`: no wildcard, quote or backslash).

**Which results count (probed on v0.16.27).**

- **Part 1:** any results header with one of our ids saying `fail`. A sender who plants one can only stop forwarding of
  their own message.
- **Part 2:** only the **top-most** results header counts for "pass", so a planted `pass` below ours can't unlock
  forwarding. Ours is always top-most on port 25 mail, and `:index 1` works in user scripts.
- **The pass test is an end-anchored regex built for the mailbox's domain** (`dmarcPassRegex(domain)`:
  `;[[:space:]]*dmarc=pass( \([^()"]*\))? header\.from=([a-z0-9-]+\.)*<domain, dots escaped>( policy\.dmarc=[a-z]+)?$`),
  not a substring: a pass for any other `header.from` never counts (review N1: with `From: a@evil.example,
ceo@<domain>`, a pass for `evil.example` must not unlock forwarding). A message with more than one From address or
  header never passes part 2 (`address :count` / `header :count`, which compile and work in user scripts on v0.16.27);
  for such messages Stalwart writes `dmarc=none header.from=` with an empty domain (probed: two addresses, two
  headers and group syntax). A
  quoted MAIL FROM local part lands **verbatim** inside our own header (`smtp.mailfrom="x; dmarc=pass
header.from=dev.test y@…"`, probed), so `*dmarc=pass*` could be fooled. Stalwart writes the `dmarc` item last.
- **Other sender-controlled fields are safe:** an EHLO argument like that is refused (`550 5.5.0`), and From and
  comment text are reduced to letters in our header.
- **Internal mail has no results header** (the submission script removes them all), so part 2 doesn't apply and it
  is forwarded.

**Existing mailboxes.** The web app (the only holder of the key that writes managed scripts) runs `upgradeManagedScripts`
30 s after each start (`apps/web/src/server/webmail/rules-upgrade.ts`). For each active mailbox:

- **What it rewrites:** a script that is exactly a generator's (`upgradeManagedScript`). That is either the bare
  redirect from before this change, or a guard that is exactly `forwardingGuard` for some other ids or domain (an
  authserv-id change is replaced too). The result is exactly what `buildScript` writes today, unit-tested.
- **Skips:** a script that isn't active; a target that isn't the mailbox's **confirmed** forwarding target
  (case-insensitive; `skippedUnconfirmed`); a result over `MAX_SCRIPT_BYTES` (`skippedTooLarge`).
- **Compare-and-swap:** the write is a `SieveScript/set` with `ifInState` from the read. The pinned server refuses a
  stale state with `stateMismatch`, so a save in between (forwarding turned off, say) is never undone
  (`skippedChanged`).
- **Audit:** one `platform.mail_rules_upgraded` entry, counts only.
- **Done flag:** a run with nothing left sets a Redis flag for this format and these ids, so later starts don't re-read
  every script. It expires after one day (the reconciler runs in the scheduler, which has no Redis, so it can't clear the
  flag when it finds an unguarded script; at most a day until the next start re-runs the upgrade), and changing the ids
  or `RULES_FORMAT` (now `forwarding-guard-v3`) runs it again. A require line the transform can't read leaves that
  script alone instead of stopping the run. The reconciler counts only redirect commands, not the word in a reply text.

The reconciler (scheduler, `MAIL_AUTHSERV_ID` or the MX host, like the web app) compares each redirect's guard with the
exact text expected for that mailbox and counts `unguardedForwarding`.

**Configuration.** In production the web app refuses to start when no usable authserv-id results
(`MAIL_AUTHSERV_ID` entries must be hostnames; unset, the MX host `mx1.<PLATFORM_DOMAIN>` is used, which is what the
production plan sets as Stalwart's `defaultHostname`). If `MAIL_AUTHSERV_ID` is ever set, set the same value for the
web app and the scheduler (ops README).

**Verification:** unit tests for the guard text and the regex, including the injected form, the upgrade transform, the
job (confirmed target, compare-and-swap, size, inactive) and the reconciler's exact compare. `npm run stack:verify`
("Forwarding guard: …") runs the real generator's script on the dev server:

- the pre-change script still forwards our `fail` (control); the upgrade equals today's script;
- on the real server, a compare-and-swap write loses to a save in between and succeeds with the current state;
- kept, not forwarded: our id's `fail`; own-domain and own-subdomain From without a pass (dev's `temperror` stands in
  for `none`); two From headers, or a From listing a foreign and an own address; a planted `pass` below ours; the pass
  words injected through a quoted MAIL FROM;
- forwarded: foreign From, another id's `fail`, internal mail from the own domain;
- the spam skip still applies;
- Stalwart's regex engine matches the pass pattern at a header's end, not a `temperror` nor a pass for a foreign
  `header.from`, and the anchored form matches our real top-most header.

**What dev can't prove:** a real DMARC `pass`, `fail` or `none` verdict (no DNS: every verdict is `temperror`). See the
pre-staging list below.

**Pre-staging checks:**

1. Which authserv-id Stalwart stamps (the first token of our results header): it must be `mx1.<domain>`, or set
   `MAIL_AUTHSERV_ID` (web and scheduler) to what it is.
2. The header format on real verdicts: that our `dmarc` item is still the last one, and the exact text for `pass` (with
   or without a comment and `policy.dmarc`). Capture one `pass`, `fail`, `none` and `permerror` and check them against
   `dmarcPassRegex(domain)` and the `fail` pattern. A `pass` the regex misses would stop own-domain forwarding (fails safe).
3. Real mail:
   - own-domain mail passing DMARC from an outside service is forwarded;
   - a forged own-domain From isn't;
   - a customer domain with no DMARC record isn't forwarded from outside (own domain), but is from inside;
   - a foreign DMARC-passing sender is forwarded.
4. Unusual From forms, which the `address :domain` test may read differently from receivers: two From addresses, group
   syntax, an encoded-word display name containing an address, a source route, uppercase, IDN domains. Make sure none
   gives an own-domain From that our test reads as foreign.
5. After the first deploy: `platform.mail_rules_upgraded` with `upgraded` > 0 and no failures, and the reconciler
   reporting `unguardedForwarding: 0`.

**Trade-off accepted:** other mail that fails DMARC (for example lists that keep the original From and break its
signature), and own-domain mail from outside services without DMARC, isn't forwarded; it stays in the inbox.

## Alternatives

- Relying only on the BFF to pick identities: covers the webmail but not IMAP/SMTP clients. Kept as an extra check.
- An MTA expression: no expression hook can reject on header content; Sieve at DATA is the supported path.
- Rewriting `From:` to the envelope sender: silently changes users' mail; refusing is clearer.
