# ADR-0025: Data export and account deletion

**Status:** Accepted 2026-10-29 (updated the same day after security review: staff holds block every removal, login
lock, handoff gate, truncated session IPs, current memberships only, access gate during mail exports)

- Related: ADR-0003 (webmail behind the BFF), ADR-0010 (audit), ADR-0016 (encryption at rest), ADR-0018 (webmail
  OAuth sessions), ADR-0020 (credential split, app passwords), ADR-0021 (platform addresses never reissued), ADR-0023
  (act-as never reaches mail), ADR-0024 (handoff credential); `../04-data-model.md`, `../07-security.md` "Data export
  and deletion", `../audit.md`, `../roles.md`, `../rate-limits.md`, `docs/public/export-and-deletion.mdx`, the
  site's privacy policy ("Your rights") and `../research/market-and-legal.md` §3 (PIPEDA / BC PIPA access requests
  answered within 30 days; retention schedule).

## Context

The roadmap's product gaps for a beta ("Path to production" step 8) include data export and account deletion. The
privacy policy already promises that people can export all their mail and contacts at any time and that closing an
account deletes its mail, contacts and settings. Nothing did either.

The hard part is mail. The control plane never holds mail-reading credentials: the worker's provisioning key and the
web app's operations key are refused `Mailbox/get` / `Email/query` (ADR-0017, ADR-0020), and a webmail session's OAuth
token is the person's own, held sealed server-side only while they use the webmail (ADR-0018). Options for the mail
part of an export:

| Option                                                                                                                                     | Credential at rest                                                                                                                                                                                | Mail at rest outside the mail server                                     | Worker job                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| **A. The person's own webmail session streams it** (the BFF reads with the session token and writes a ZIP straight into the HTTP response) | None new                                                                                                                                                                                          | None                                                                     | No (a long download; resumable per folder) |
| B. A throwaway read-only app password (like ADR-0024's) minted at request time, sealed for the worker, used for hours                      | Yes: a mailbox credential sealed in Postgres for hours. With `authenticate` it can also be exchanged at `/api/auth` for an account-wide token whose refresh grant outlives it (ADR-0024 findings) | Yes: the worker writes the archive; it must be stored (encrypted) 7 days | Yes                                        |
| C. Give the worker (or a new key) mail-read scope                                                                                          | A standing key that reads every mailbox                                                                                                                                                           | Yes                                                                      | Yes                                        |

## Decision

1. **Two kinds of export, built in two places.**
   - **Control-plane data** (account settings, people and roles, invites, domains with their DNS records, mailbox and
     alias settings, app password names, the audit log; or, for a person, their profile, memberships, own mailboxes'
     settings, sign-in factors and sessions, and their own activity) is a **worker job** (rule 26): `job:data-export`
     (scheduler, every minute) builds a ZIP of JSON + CSV files (CSV cells that start like a formula get a leading `'`),
     **seals it with the key ring** (AES-256-GCM, its own HKDF purpose `data-export`, AAD `data_export:<id>`, key id in
     the output) and stores the sealed bytes in `data_export.archive`. No mail content is in it, so Postgres is the
     right place (no new volume, covered by the same backups and encryption). It is downloadable for
     `DATA_EXPORT.keepDays` (7) days, then the archive is deleted (`data.export_expired`). The person who asked is
     emailed when it is ready (a branded system email linking to the console, never to the file).
   - **Mail and contacts** use **option A**: in the webmail, Settings → Export streams the signed-in mailbox's folders
     as mboxrd files (one per folder, split at `MAIL_EXPORT_PART_BYTES` = 1 GiB) plus `contacts.vcf`, in a ZIP written
     straight into the response with the session's own token (`GET /api/webmail/export`, optionally `?folder=<id>`).
     **No new credential, no new key scope, and no copy of anyone's mail at rest outside the mail server.** It is
     pinned to the mailbox active when it started: a switch to another mailbox mid-way stops it. Resumable per folder.
     The webmail access gate applies (suspended or deleting mailboxes can't export), and is asked again before each
     folder, before the contacts and every 50 messages, so a mailbox suspended mid-way (or its account scheduled for
     deletion) ends the download with an error rather than a finished archive. Audited `data.mail_exported`
     (counts only) in the mailbox's account. Option B was rejected for the escalation path and the stored credential
     (rule 23's spirit); option C for a standing mail-reading key.

2. **Who may export.** `account.export` (new, critical, Owners only) for an account's export; `self.data.export`
   (new, self) for one's own. Only the person who asked can list or download their exports (anyone else's id: 404).
   Downloading needs a **fresh step-up** on the console session (`stepUpFresh`), like app passwords. One export at a
   time per person and kind (409). Never while staff act as someone (403 `act_as`; the Auditor role staff hold while
   acting lacks `account.export` anyway, and the `self` permissions are refused explicitly). Mail is exported by each
   mailbox's own person (their webmail session); an Owner can't export other people's mail.

3. **Account deletion with a grace period** (`account.delete`, critical, Owners; fresh step-up; the account's name
   typed exactly; never while acting as someone).
   - **At once:** an `account_deletion` row with `delete_after = now + ACCOUNT_DELETION_GRACE_DAYS` (14, a shared
     fact); every usable mailbox suspended through the normal lifecycle (provisioning job), each with a mailbox hold of
     kind **`deletion`** (the staff-suspension hold table), so cancelling resumes exactly those and a staff hold keeps
     its own; catch-alls pointing at them turned off; pending invites revoked; everyone in the account emailed. The
     actor gets `deletingAccountIds`: in that account only reads, `account.export` and `account.delete` (cancel) pass;
     everything else answers 403 `account_deleting` (`allowedWhileDeleting` in the matrix), so nothing new lands in an
     account on its way out (no mailbox restored, no domain or person added). Staff's platform-address create checks
     it too. Every member sees a notice with the date.
   - **Cancel** until the grace period ends: the row goes, the `deletion` holds are released, mailboxes with no other
     hold resume; everyone is emailed. Catch-alls stay off (said in the email).
   - **After the grace period** the scheduler's `job:account-deletion` (every 10 minutes) advances each due account
     one idempotent, audited step per run, never before `delete_after`: (1) `data.deletion_started` — every mailbox →
     `deleting` with its purge date now (the hourly `mailbox-purge` destroys the mail-server account and its mail, and
     retires platform addresses, ADR-0021); (2) once no mailbox is left, each domain is released (`domain.removed` by
     the system: pending rows deleted, the rest `removing` + `domain.remove`); (3) once no domain is left,
     `account.deleted` — the account row is deleted, and with it memberships, invites, exports and the deletion record
     (foreign keys cascade); everyone who was in it is emailed. A failed step is audited `failed` and retried next run.
     **Staff holds always win** (an investigation must not lose its evidence): while staff hold the account (an
     account suspension) or **any** of its mailboxes (an account or person suspension, or a staff hold on it), no step
     runs — checked before each run and again under the account lock when removal starts — and the wait is audited
     (`data.deletion_started` denied `staff_hold`, at most once a day). Independently, the mailbox purge itself skips
     any due mailbox staff hold (`staffHeld`: account or person suspended, or an `account`/`person` hold; re-checked
     under the account lock), which also covers an ordinary mailbox deletion's purge. An Owner can't ask or cancel
     while the account is suspended (403 `account_suspended`).
   - **People keep their console logins** (they may belong to other accounts; nobody can delete someone else's
     identity). Each can delete their own afterwards.
   - **Audit is retained** (append-only, rule 47): the account's log stays under its `account:<id>` scope after the
     row is gone, readable by staff in the platform audit, retained per `audit.md` "Retention" (life of the account +
     1 year; the retention purge is a later, separately audited maintenance job). Every step is copied to the platform
     log so staff see deletions.
   - **Billing:** no hook yet. Phase 5 adds cancelling the subscription at request time and refund rules
     (`06-pricing-and-billing.md`); until then plans are free.

4. **Deleting one's own login** (`self.login.delete`, self; step-up; the sign-in address typed; never while acting
   as): only when no account depends on it — no mailbox anywhere is theirs (that account's admins remove them first,
   keeping the mailbox), no account where they are the only Owner still has mailboxes, domains or other people (an
   empty one is deleted with the login, immediately: nothing to wait for), no platform role (staff), and no empty
   account of theirs is staff-suspended. Memberships elsewhere are removed (each account's log records it). Sessions,
   factors, profile, photo and exports cascade with `auth_user`. The browser's session cookie is cleared and the
   address gets a confirmation email. The login row is locked first (`FOR UPDATE`, which a new membership's foreign
   key waits on), then each account; the memberships are read again after the locks and a change answers 409 "try
   again", so a membership created meanwhile can't leave an account without its person.

5. **Defence in depth.** The console → webmail handoff's redemption rebuilds the person with `deletingAccountIds` too
   (ADR-0024 `personFor`), so it is refused (`account_deleting`) in an account waiting to be deleted even before its
   mailboxes' suspension reaches the mail server. A personal export lists only mailboxes in the accounts the person
   belongs to **now** (a mailbox still linked to them in an account they left is that account's data; reassigning or
   converting such mailboxes when someone leaves is the next slice, the leaver flow). Session addresses in a personal
   export are the network part only (`partialIp`, as the Security page shows); the person's own user agent is kept.
   Binary sealed values refuse a key id longer than the header's one-byte length (ids are at most 32 characters).

6. **Staff:** `platform.deletions.read` (Global Administrators) lists pending deletions (Platform → Pending
   deletions); staff can't cancel or force one. Act-as never exports or deletes.

7. **Rate limits:** export requests and downloads (console and webmail) use the `export` tier (5 / hour per caller,
   fail closed); deletion request/cancel and login deletion use `sensitive` (30 / hour, fail closed).

8. **Accepted after review.** (a) A request without `Sec-Fetch-Site` is allowed on the download routes (older
   browsers send none); `cross-site` and `same-site` are refused, and a console download still needs the step-up.
   (b) Cancelling a deletion needs no step-up: it only moves in the safe direction (nothing is removed; mailboxes
   resume), and everyone in the account is emailed.

## Consequences

- People can leave with everything: mail and contacts in standard formats from the webmail, account and personal
  data from the console; the privacy policy's export and deletion promises are now true and name the grace period.
- An Owner must export before asking for deletion: once mailboxes are suspended their mail can't be exported (the
  console, the email and the public docs say so; cancelling, exporting and asking again works).
- Mail export is a long HTTP download through the web container rather than a background job: a very large mailbox
  needs the tab open (per-folder downloads resume it). It uses the person's own token and per-user JMAP queue, so it
  can't exceed what their webmail session could read anyway.
- Sealed control-plane archives live in Postgres for 7 days: the worker and the web app must share `SECRETS_KEYRING`
  (the scheduler now needs it, plus `MAIL_TRANSPORT_URL`, `MAIL_FROM`, `APP_URL`, in the private ops compose).
- Removal after the grace period takes up to about an hour per step (the hourly purge), so an account is fully gone
  within a few hours of its date.
- Re-verify on every Stalwart upgrade (rule 22): `packages/adapters/src/stalwart/account-deletion.int.test.ts` and
  `apps/web/src/server/adapters/mail-export.int.test.ts`.

## Alternatives

- **Browser-side archive building** (the page fetches each raw message through the BFF and zips in the browser): no
  server memory, but thousands of requests, a heavy page and the same token; the streamed ZIP is simpler.
- **Store mail exports encrypted for 7 days** (option B/C): a high-value copy of everyone's mail outside the mail
  server's own encryption at rest (ADR-0016); rejected.
- **Delete people's logins with the account:** someone else's identity (and their other accounts) isn't the Owner's to
  delete; rejected. Self-service login deletion covers it.
- **Immediate deletion:** no recovery from a mistake or a hijacked Owner session; the grace period plus step-up plus a
  typed name is the guard.
