# ADR-0014: Folders and signatures (a familiar full-depth set) on JMAP

- **Status:** Accepted, 2026-10-21
- **Related:** `05-webmail.md` "Folders" and "Signatures", `10-collaboration.md`, `04-data-model.md`, ADR-0003, ADR-0013

## Context

Users expect full-depth folders (nested folders, favourites, archive, rules, search folders, retention) and
signatures (several per person, defaults for new mail vs replies, admin-managed templates, an organisation
disclaimer). Stalwart Community v0.16.27 exposes mail folders as JMAP `Mailbox` objects (RFC 8621 §2) and
signatures as `Identity.textSignature` / `htmlSignature` (RFC 8621 §6). We probed the running dev server
(throwaway objects, all removed):

| Probe                                                                                         | Result                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Mailbox/get`                                                                                 | `role`, `sortOrder`, `isSubscribed`, `myRights`, `shareWith` present. Default folders: Inbox, Drafts, Sent Items, Junk Mail, Deleted Items. **No Archive** by default.                         |
| Create nested folders / rename / move (`parentId: null`) / `sortOrder` / `isSubscribed:false` | All work.                                                                                                                                                                                      |
| Create `role: "archive"` folder                                                               | Works.                                                                                                                                                                                         |
| Destroy a folder with children                                                                | Refused: `mailboxHasChild` (RFC 8621 §2.5).                                                                                                                                                    |
| Destroy Inbox / Junk / Trash                                                                  | Refused: "You are not allowed to delete Inbox, Junk or Trash folders."                                                                                                                         |
| Folder depth                                                                                  | `x:Email.maxMailboxDepth` = 10, `maxMailboxes` = 250, `maxMailboxNameLength` = 255 — but a 12-level chain created **in one request** was accepted. Depth must be enforced by us.               |
| `Identity/set` signatures                                                                     | Stored verbatim, **including a remote `<img src="https://…">`** — no server-side sanitising.                                                                                                   |
| Second identity for the same address                                                          | Allowed (`x:Email.maxIdentities` = 20). Identity for an address the account doesn't own: refused (`E-mail address not configured for this account`).                                           |
| Trash / Junk clean-up                                                                         | `x:DataRetention.expungeTrashAfter` = 30 days, daily schedule — **server-wide**, not per user or account.                                                                                      |
| Outbound disclaimer                                                                           | No disclaimer feature. A DATA-stage Sieve script (`x:MtaStageData.script`, `x:SieveSystemScript`) exists but appending to MIME bodies server-side is fragile and must run before DKIM signing. |

Sources: RFC 8621 §2 (Mailbox), §6 (Identity) <https://www.rfc-editor.org/rfc/rfc8621>; Stalwart docs, mailbox
and folder settings <https://stalw.art/docs/email/settings>, Sieve <https://stalw.art/docs/sieve/overview>;
retention from the pinned server's configuration schema (`x:DataRetention`, `x:Email`, `x:MtaStageData`).

## Decision

**Folders**

1. **Stalwart owns folders** (they are mail data). The webmail edits them directly over JMAP through the BFF;
   the control plane does not mirror folder trees.
2. Provisioning creates an **Archive** folder (`role: archive`) for every mailbox, so "Archive" works everywhere
   (webmail, IMAP `\Archive` special-use).
3. **Limits are enforced by the BFF** before `Mailbox/set`: depth ≤ 6 (UI), count ≤ plan limit (`x:Account.quotas.maxMailboxes`
   is set per plan as the hard backstop), name ≤ 120 characters. Stalwart's own depth check is not relied on.
4. **Per-user folder preferences** that JMAP has no property for — favourites/pinned, colour, collapsed state —
   live in the control plane (`folder_preference`), keyed by the JMAP mailbox id; they are cosmetic, never ACLs.
5. **Search folders** are saved JMAP `Email/query` filters (`saved_search`), evaluated by the client; no server
   copies.
6. **Archive by year** (a common archive-policy pattern) is a webmail action + optional account policy
   (`folder_policy`): move to `Archive/<year>`, created on demand.
7. **Trash/Junk clean-up**: the server-wide `expungeTrashAfter` stays at 30 days (published as a fact in
   `packages/shared` when the clean-up page ships). Per-account shorter clean-up is done by a worker job that
   only ever deletes from Trash and Junk, never other folders (rule 26 spirit: no surprise mail deletion).
8. **Rules** ("move to folder") are Sieve `fileinto` generated from our rule builder (per mailbox) or account mail
   rules (ADR-0013); no raw Sieve from users in v1.
9. **Sharing** is JMAP `shareWith` (ADR-0013). POP3 sees only the Inbox (protocol limit) — documented for users.

**Signatures**

1. **Several signatures per person** live in the control plane (`signature`, sanitised HTML + text); defaults are
   chosen per identity for _new_ messages and for _replies/forwards_. The default-for-new signature is mirrored
   into `Identity.htmlSignature/textSignature` so other JMAP clients see it.
2. **Sanitised on save and on render** with the same sanitiser as message HTML; **no remote images** — images are
   uploaded and embedded (`cid:`) at send time; size cap 64 KB HTML, 3 images, 200 KB total.
3. **Admin templates** (`signature_template`) with placeholders (`{{name}}`, `{{title}}`, `{{phone}}`,
   `{{email}}`, `{{account}}`) are rendered per member by the worker and pushed as a locked signature; members
   can add personal signatures unless the template is marked enforced.
4. **Disclaimers** (account-wide footer on outbound mail) are inserted **by the webmail composer** and the
   submission path we control, appended as a separate text/HTML part block before submission, so DKIM covers
   them. Mail from IMAP/SMTP clients does **not** get the disclaimer in v1 (documented); a DATA-stage Sieve
   prototype (`x:MtaStageData.script`) is tracked for later and must run before signing.
5. **Shared mailboxes / send as**: each shared mailbox identity has its own signature set (managed by members
   with access); send-on-behalf uses the sender's signature.
6. IMAP/SMTP clients (desktop and phone mail apps) keep their own signatures — server signatures apply to
   the webmail and JMAP clients only.

## Consequences

- No new Stalwart patches or Enterprise features needed; all limits and safety (depth, sanitising, disclaimers)
  sit in our BFF/worker and are unit- and integration-tested.
- Signature HTML is untrusted input in two places (save and render); the XSS corpus in Phase 4 covers both.
- Two sources of truth for signatures (control plane + Identity mirror) need a reconciler check (drift → re-push).

## Alternatives

- **Rely on Stalwart for depth and signature safety** — rejected: the probe shows neither is enforced.
- **Server-side disclaimer via Sieve now** — deferred: body rewriting risks breaking MIME and DKIM.
- **Store folder favourites in IMAP METADATA / mailbox annotations** — rejected for v1: not exposed over JMAP.
