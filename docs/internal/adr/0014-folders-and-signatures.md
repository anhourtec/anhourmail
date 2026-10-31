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

## Update (2026-10-29)

What the webmail has built against this decision so far (05-webmail.md): folders are read from Stalwart with their
counts and nesting, and messages move between them (archive, delete, junk, Move to, Restore from Trash); creating,
renaming, moving and deleting folders, favourites, search folders, archive by year and rules are not built yet, so
the BFF's folder limits (decision 3) aren't exercised. The proxy still refuses `Mailbox/set`. Signatures are one
plain-text signature per identity, stored as `Identity.textSignature` with an escaped `htmlSignature` mirror
(`server/webmail/service.ts`); the rich-text composer (2026-10-24) inserts it as a marked block after the `-- ` line
and swaps it when From changes. Several signatures, defaults per message type, images, templates and disclaimers are
still ahead. Whether provisioning creates the Archive folder (decision 2) should be re-checked against the worker
before folder management ships.

## Update (2026-10-29, later) — how Archive is created

Re-checked, and decision 2 wasn't true: nothing created Archive, so the webmail's Archive button and `e` did nothing
for every mailbox except the demo ones the seed fills with sample mail. It is now met without a provisioning step of
our own, because the worker can't do it: its provisioning key has no `impersonate`, and none of the three management
keys can act inside a mailbox (`Mailbox/get`/`set` on a customer → `forbidden`, verified with the real keys in
`archive-folder.int.test.ts`); customers can't create folders over JMAP either (`CUSTOMER_PERMISSIONS`).

- **New mailboxes:** Stalwart's server-wide `x:Email.defaultFolders` gets an `archive` entry named Archive with
  `create` and `subscribe` on (`applyDefaultFolders` in `packages/stalwart-client/src/folders.ts`, then a settings
  reload). Stalwart creates its special folders the first time an account's store is opened, so every account opened after
  that gets Archive (role `archive`, IMAP `\Archive`) from the mail server itself, whichever path created it.
  Verified on v0.16.27: the built-in Archive default has `create: false`; patching only the `archive` entry keeps the
  other defaults; without a reload nothing changes; an account already opened never gains a folder from the setting.
- **Existing mailboxes:** a one-off backfill (`backfillArchiveFolders`) with the administrator credential the
  deployment's Stalwart bootstrap already uses: for each user account (service-account domains skipped), nothing if
  a folder has role `archive`; the role on a top-level folder already named Archive in any case (Stalwart refuses a
  second one that differs only in case); otherwise a new top-level Archive. Only creates a folder or sets a role,
  never moves or deletes mail; safe to re-run. The dev plan applies both on every `npm run db:seed`.
- **Webmail:** if a mailbox still has no Archive, the Archive action shows an error toast saying nothing was moved
  instead of doing nothing. The proxy's `Mailbox/set` refusal is unchanged.
- **Not done (open):** no drift check for a mailbox without Archive or for the setting itself (both need a read the
  scheduler's keys don't have). Letting the web app create a missing Archive on first use would mean adding
  `jmapMailbox{Get,Create,Update}` to the operations key: a key-scope change that needs a security review and new
  keys in production.

## Update (2026-10-29, evening) — named signatures built

Signatures decision 1 and 2 are now built, with these changes from the original wording (05-webmail.md "Signatures"):

- **Per mailbox, not per identity.** A mailbox keeps up to 20 named signatures and two defaults (new messages;
  replies and forwards), each may be none. Any of its addresses can use any signature, and changing From keeps the
  chosen one. Per-address defaults are left as a later override. Stored in `webmail_signature` (migration 0023), not
  the planned `signature` + `signature_default` pair: the defaults are two flags with partial unique indexes, so
  deleting a default simply leaves none.
- **Images are embedded `data:` images**, not uploaded blobs sent as `cid:`: PNG, JPEG, GIF or WebP whose bytes match
  the type, 64 KB each, 3 per signature, 300 KB in all (`WEBMAIL_SIGNATURES` in `packages/shared`). https and `cid:`
  images and CSS `url()` are removed on save (`signature-html.ts`, the outgoing sanitiser's `embeddedImagesOnly`
  mode). They are sent inside the HTML part as the composer already sends pasted images; converting them to `cid:`
  parts at send time, for mail apps that don't show `data:` images, is open.
- **Mirror to the identities is size-limited.** Stalwart v0.16.27 keeps at most 2,047 bytes per `htmlSignature` or
  `textSignature` (2,048 is refused with `invalidProperties`; measured with the integration test). The default for
  new messages is copied to every identity of the mailbox as its HTML when it fits, else without images, else as its
  text; the settings panel says when the copy is shorter or failed. The drift check (Consequences) is still open.
- **The old single signature** (the plain-text `Identity.textSignature` the webmail used to edit) is brought over once
  as "Signature", the default for both, the first time the mailbox's signatures are read
  (`webmail_preference.signatures_started_at` makes it once only). The identity route now changes the sender name
  only.
- Templates, the disclaimer and shared-mailbox signature sets (decisions 3–5) are unchanged and still ahead.

## Update (2026-10-31) — sender names: one source, mirrored to the identities

Maintainer decision (2026-10-29, `09-roadmap.md`): the mailbox display name is the one source, a person's own mailbox
follows their profile name unless an admin sets another, and the webmail sender name shows the same value (rule 61).
Until now the identity's `name` was a third, separate value edited only in the webmail.

- **Source.** `mailbox.display_name` null = follow the mailbox's person (`auth_user.name`); a value = an admin's
  custom name; no person and no value = none (`mailboxSenderName`, `packages/core/src/people/names.ts`). Migration
  0030 turned stored copies of the person's name into "follow".
- **Probed on v0.16.27** (throwaway accounts, removed): Stalwart creates an account's identities lazily, on the first
  `Identity/get`, one for the address and one per enabled alias, each named after the account `description` (none:
  the address); an alias added later gets the description current then. Changing the description never renames
  identities that exist. A management credential with `impersonate` can `Identity/get`/`set` another account's
  identities by passing its id (the dev admin), and `name: ""` is accepted (checked by `sender-name.int.test.ts`).
- **Mirroring.** The worker writes the sender name as the description (`mailbox.ensure`, queued by every change:
  a profile name edit for each mailbox that follows it, a display-name edit, "Make this a user", creation; migration
  0031 queued every existing mailbox once). Existing identities are renamed by the **webmail with the session's own
  token** whenever it reads them and a name differs (`WebmailService.identities`; every identity of the mailbox, as
  Stalwart names them), and the webmail sends with the control-plane name regardless. **Masked aliases send with no
  name** (maintainer default, 2026-10-31): a masked alias exists so a website can't tie it to the person, and a name
  in From would. Their identities are renamed to `""` and drafts, sends and delegated sends from them carry no name
  (`webmailSendingNames` gives the webmail the mailbox's masked alias addresses with its sender name, in one read);
  plain aliases keep the sender name.
  No key scope changed: neither the worker's provisioning key (no `impersonate`, by design) nor the web app's
  operations key (no identity permissions) can write identities. Consequence: an IMAP/SMTP or third-party JMAP client
  sees an old identity name until the mailbox next uses the webmail (SMTP clients set their own From name anyway).
  Closing that gap would mean adding `jmapIdentityGet` + `jmapIdentityUpdate` to the operations key (new production
  keys and a security review) — left to the maintainer.
- **Editing.** Webmail Settings → Account → Sender name now edits the person's name (`setWebmailSenderName`, audited
  as `account.profile_changed`, `via: webmail`) when the mailbox follows its person and that person is in no other
  account (the photo rule, ADR-0022); otherwise read-only with why. The per-identity route
  (`PATCH /api/webmail/settings/identities/:id`, audit `identity.changed`) is gone; `PUT
/api/webmail/settings/sender-name` replaces it. The console Profile gained "Edit name"; Mailboxes → Display name
  offers "Use the person's name" or a custom name.
