# ADR-0032: Webmail settings part 2 — account-wide safe senders, mail rules, templates

**Status:** Accepted 2026-11-05

- Related: ADR-0014 (folders and signatures), ADR-0019 (sender identity; the forwarding guard), ADR-0020 (who may
  write the managed Sieve script), ADR-0026 (delegated and shared mailboxes), ADR-0027 (Safe senders load images;
  section 10 left the account-wide list to this ADR); `../05-webmail.md` "Settings", "Remote images" and the managed
  script; `../10-collaboration.md` (inbox rules on all plans); `../07-security.md` "Mail rules".

## Context

Phase 4's remaining webmail settings are three features people expect from any mail service: an organisation-wide
list of trusted senders (maintainer, 2026-10-31: Owners and User Administrators, verified-only for images, audited, no
request-to-allow-list workflow), mail rules (filters), and canned replies (templates).

Constraints that shape all three:

- **Customers never write Sieve.** ManageSieve isn't published and customer mailboxes have no Sieve permissions: an
  arbitrary script could `redirect` anywhere (an open relay). Every rule is compiled by our server into the one
  managed script (`anhourmail`) from validated data, every value through `sieveString`, without the `variables` or
  `encoded-character` extensions.
- **Only the web app can write the managed script** (ADR-0020: the operations key). The worker and scheduler hold
  keys that can't (provisioning: no Sieve writes; audit: read only).
- **The managed script carries the person's contacts** for "trusted senders only" and contacts-only replies. Only the
  person's session can read contacts, so anything writing the script without a session must not rebuild it.
- Mail content (subjects, addresses of correspondents, folder names, match values) never enters logs, audit or error
  reports (rules 24, 48).

## Decision

### 1. Account-wide safe senders

1. **What it is.** A list of addresses and domains (same `senderEntry` form as a mailbox's Safe senders: lower-case,
   A-labels, exact domain with no subdomains) that counts as a Safe sender for **every mailbox of the account**: their
   images load without asking **only when the From is verified** (`senderVerified`, the same DMARC rule as ADR-0027),
   and their mail skips the "Only trust my contacts and safe senders" Junk check.
2. **Precedence.** A person's own lists win: their Blocked senders still go to Junk (and never load images) even when
   the account lists that sender; their own Safe senders apply as today. The account list sits between the person's
   Blocked senders and the trusted-only catch-all. Anything else (Stalwart's own spam verdict) is unchanged, as for a
   mailbox's own Safe senders.
3. **Who.** New permissions `safe_sender.read` (Owner, User Administrator, Read-only) and `safe_sender.manage` (Owner,
   User Administrator). Console page **Mail → Safe senders** (`/accounts/:id/safe-senders`). People see the account's
   entries read-only in webmail Settings → Junk and blocked senders, marked "Added by your organisation".
4. **Storage.** Postgres table `account_safe_sender` (control plane; the entries are admin configuration, like
   domains, not mail content). Limits in `@anhourmail/shared/senders`: `ACCOUNT_SAFE_SENDERS` = 300 entries and 12,000
   characters in total (every entry is written into every mailbox's script, so the list has a byte budget too).
5. **Audit.** `junk_rules.account_safe_added` (meta: `added`, `addresses`, `domains`, `total`) and
   `junk_rules.account_safe_removed` (meta: `kind`, `total`), in the same transaction as the change. Never an entry, a
   hash of one or a domain (rule 48). Denied attempts are audited by `mutation()`.
6. **Images.** The image check (`safe-senders.ts`) matches the mailbox's own list first, then — when the From isn't on
   the mailbox's Blocked senders — the account's list; the match carries `source: "mailbox" | "account"`. The account
   list is read from Postgres by mailbox address (an in-process cache, 60 s, dropped by this process's own writes) — no
   Sieve read is needed. In a delegated tab, the shared mailbox's account applies (as its own list does). "Stop
   loading" is never offered for an account match; the notice says the organisation added the sender.
7. **Sieve.** When "trusted only" is on, `buildScript` writes the account list as its own branch, on one line right
   after a fixed marker comment:

   ```sieve
   # AnhourMail account safe senders (set by the account's administrators).
   elsif anyof (address :all … "from" […], address :domain … "from" […]) {
   ```

   with `false` as the test when the list is empty. Every save from the webmail writes the current list (the webmail's
   `saveMailRules` reads it). For mailboxes nobody saves, the web app **replaces only that one line** in place
   (`applyAccountSafeSenders(text, entries)`, no contacts needed): after each console change (in the background, in
   the web process that took the change) and once at web-app start-up for accounts that have entries (a Redis flag
   skips repeat runs while nothing changed). Each write is a compare-and-swap on the Sieve state read; a script that
   isn't ours, is inactive, has no marker (trusted-only off: nothing to skip) or would exceed the size budget is left
   alone and counted. The worker can't do this (no key may), so it is not a worker job: the console request returns as
   soon as Postgres is committed, and the line rewrite is idempotent and re-run at start-up. Results are logged as
   counts.

### 2. Mail rules (filters)

1. **Model** (`@anhourmail/shared/mail-rules`, zod, shared with the browser): an ordered list of rules, each `{ id,
name, enabled, match: "all" | "any", conditions, actions }`.
   - Conditions (1–5): From / To or Cc `contains` or `is`; Subject contains; List-Id contains; has an attachment; size
     over / under N KB.
   - Actions: at most one of **move to a folder** or **delete** (moves to Trash, never permanent), plus any of **mark
     as read**, **flag**, **forward**, **stop processing more rules**. Move and delete always stop: a message ends up
     in one place.
   - Limits (`MAIL_RULES`): 50 rules, 5 conditions each, names 64 characters, values 200 characters, sizes up to
     50 MB. The whole script stays under the existing 95,000-byte budget (the error says the rules are too long).
2. **Storage.** In the managed script's settings line with the other mail-flow settings (`MailRules.filters`, default
   `[]` for scripts written before). Match values and folder names are the person's correspondents and folder names:
   they live on the mail server with the mail, never in Postgres, Redis, logs or audit (as ADR-0027 decided for Safe
   senders). Deleted with the mailbox.
3. **Compilation** (`buildScript`), after the junk rules and the automatic reply / forwarding block, inside
   `if not header :contains "X-Spam-Status" "Yes"` (a rule never pulls spam out of Junk):
   - `from` / `to or cc` contains → `header :contains :comparator "i;unicode-casemap"` (display name or address);
     `is` → `address :all :is` with the value validated as an address. Subject and List-Id → `header :contains`.
     `:contains` has no wildcards; values go through `sieveString` after control characters are removed.
   - Has an attachment → `header :mime :anychild :contains "Content-Disposition" "attachment"` (`mime`).
   - Size → `size :over` / `size :under` in bytes.
   - Mark as read / flag → `addflag "\\Seen"` / `addflag "\\Flagged"` (`imap4flags`), before any filing.
   - Move → `fileinto` the folder's path (`mailbox`), resolved from its JMAP id with the person's session **at save
     time** (Stalwart v0.16.27 doesn't support `fileinto :mailboxid`, verified 2026-11-05). A folder renamed or deleted
     later makes the move fail safe (the message stays in Inbox); Settings shows "Folder renamed or deleted" and saving
     again writes the new path. Delete → `fileinto :specialuse "\\Trash" "Trash"`.
   - Forward → `redirect :copy` **to the mailbox's confirmed forwarding address only** (the control-plane
     `forwarding_target`, resolved by `saveMailRules` on every write; the rule stores no address at all), inside the
     same `SUPPRESS` block and the same `forwardingGuard` (DMARC) as Forwarding, so no rule forwards spam, list or
     automated mail, bounces or failing-DMARC mail. Refused while the mailbox's trust tier is `restricted` (the same
     check as Forwarding; a billing send-block is a different state, see Consequences) and when there is
     no confirmed target (400, "Set up and confirm a forwarding address first"); a target removed later compiles to no
     redirect. The reconciler's checks (redirects only to the confirmed target, inside the expected guard) hold
     unchanged.
4. **Writes.** `PUT /api/webmail/settings/rules { rules, version }`: the whole ordered list, against the rules version
   the browser read (`GET …/settings/rules`); a different version answers 409 "Your rules changed in another window".
   The write itself is `ifInState` on that read (ADR-0027's compare-and-set). New rules get server ids. Own mailbox
   only (403 in a delegated tab), rate tier `write`. Audit `sieve.changed` (label "Filters changed"; meta: `rules`,
   `enabled`, `forwarding`, `moving`, counts only).
5. **Preview.** The rule dialog shows which recent Inbox messages the conditions match, through the existing JMAP
   proxy (`Email/query` with the equivalent JMAP filter, 10 results). It runs in the browser on the person's own mail;
   it is an approximation of Sieve's matching (labelled "Recent messages this rule matches").

### 3. Templates (canned replies)

1. **Model.** Per mailbox, named (1–64 characters, unique ignoring case), rich text, at most 50 per mailbox and 64 KB
   of HTML each (`WEBMAIL_TEMPLATES` in `@anhourmail/shared/templates`).
2. **No images.** Templates are reply text: the outgoing sanitiser (`sanitizeOutgoingHtml` with `embeddedImagesOnly`)
   runs on every save and every image is dropped (no remote, no `data:`), which keeps them small. Signatures remain the
   place for images.
3. **Storage.** Postgres `webmail_template` (like `webmail_signature`; the person's own text, deleted with the
   mailbox). Routes `GET·POST /api/webmail/settings/templates`, `PATCH·DELETE …/:templateId`, own mailbox only, tiers
   `webmailSettings` / `write`. Audit `webmail.template_added` / `_changed` / `_removed` with ids and sizes only.
4. **Composer.** A **Templates** menu in the composer footer inserts a template at the cursor (rich mode) or as text
   (plain mode); Settings → Writing → Templates manages them.

## Consequences

- One trusted-sender idea across the account: admins add a partner domain once; people still decide for themselves
  (their Blocked list wins).
- **Account Safe senders and the trusted-only catch-all use the header From** (security review run-63, SA-63-04), as a
  mailbox's own Safe senders always have: a forged From matching an account entry skips "Only trust my contacts and
  safe senders" (Stalwart's own spam verdict still applies). Images still need a verified From (DMARC), so a forger
  can't learn the message was opened.
- **Rule forwards follow Forwarding while the account is send-blocked by billing** (security review run-63, SA-63-01):
  Stalwart still runs a send-blocked account's Sieve `redirect` and `vacation`, and the maintainer's default is to keep
  forwarding and automatic replies on then (ADR-0029 "Update (2026-11-05): slices 8–10 built", SA60-03). A rule's
  forward is the same redirect to the same confirmed target under the same guard, so it follows that default. Only the
  trust tier `restricted` refuses and drops rule forwards (`sendingTier`), as it does Forwarding.
- The account list costs every mailbox script up to 12,000 characters; mailboxes near the size budget can't save more
  junk entries or rules until they shorten something.
- Rules live with the mail and leave nothing in the control plane; an admin can't see a person's rules.
- A renamed folder breaks its move rule until the next save (fail safe: mail stays in Inbox).
- Rule forwarding adds no new destinations: it is the mailbox's one confirmed forwarding address, so the abuse surface
  is the existing Forwarding feature's.
- The start-up forwarding-guard upgrade skips scripts whose forwarding target appears in more than one redirect (a rule
  forward); those are written with today's guard already, and the reconciler still reports any that drift.

## Alternatives considered

- **A worker job for the account list:** the worker has no key that can write Sieve, and giving it one widens the
  blast radius ADR-0020 narrowed. Rejected.
- **Rebuilding every mailbox's whole script from the console:** needs each person's contacts (session-only). Rejected
  in favour of the one-line rewrite.
- **Rules in Postgres:** keeps correspondents and folder names in the control plane. Rejected (ADR-0027 reasoning).
- **Forward to any confirmed address per rule:** a second confirmation flow and a wider relay surface; the existing
  confirmed target covers the need. Rejected for now.
- **`fileinto :mailboxid`:** not supported by the pinned server (invalidScript). Paths, resolved at save time.
- **Images in templates:** possible with the signature rules, but templates are reply text and images would multiply
  storage. Rejected for now.

## Update (2026-11-05): security review run-63

- **SA-63-03 (fixed):** a forwarding request now rewrites the script whenever it has any redirect, from a read taken
  after the control-plane change and written on that read's version (once more on a conflict); removing the target
  rewrites before and again after the removal; and `saveMailRules` reads the confirmed target again right before its
  Sieve write, answering a conflict if it changed meanwhile. So a rules save racing a forwarding change can't leave a
  redirect to a target that is no longer confirmed.
- **SA-63-02 (fixed):** a rule's folder path must be one of the person's own folders level by level (every prefix is
  itself one of their folders) and never under the mail server's shared-folders namespace ("Shared Folders");
  customer mailboxes can't share folders anyway (`CUSTOMER_PERMISSIONS`). Not probed live whether Sieve `fileinto`
  could resolve into a shared namespace (research/stalwart.md).
- **SA-63-05 (checked):** the account Safe senders validation message quotes up to 60 characters of the typed entry
  to the person who typed it; the route wrapper doesn't log a `DomainError`'s message and the audit stores the error
  code only.

## Update (2026-11-05): built

All three parts are built as decided: account-wide Safe senders (migration 0039, console Mail → Safe senders,
`tests/e2e/safe-senders.spec.ts`), mail rules compiled into the managed script (`tests/e2e/webmail-rules.spec.ts`) and
templates (migration 0040, `tests/e2e/webmail-templates.spec.ts`), with the run-63 fixes above. Public guides:
`docs/public/safe-senders.mdx`, `docs/public/webmail-settings.mdx`.
