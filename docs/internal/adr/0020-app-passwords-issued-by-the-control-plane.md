# ADR-0020: App passwords issued by the control plane, limited per credential

**Status:** Accepted 2026-10-22 · amended 2026-10-23 (credential split, below — supersedes the single management
key in decision 1) · amended 2026-10-23 (mailbox passwords, below — console-made mailboxes now have a known password)
· updated 2026-10-28 (mailbox handovers, below)

## Context

Mailboxes made in the console have a random password nobody knows (`packages/adapters/src/stalwart`), so mail apps
(IMAP, POP3, SMTP, CardDAV) need app passwords. Stalwart v0.16 keeps them as `x:AppPassword` credentials of an account.
Verified on the pinned v0.16.27 (throwaway domain and accounts, destroyed afterwards):

- The user can create one with their own credentials; an admin can't add one through `x:Account.credentials`
  ("Secondary credentials cannot be set directly"). `x:AppPassword/set` with `accountId` **does** work for the
  management credential when it holds `impersonate` plus `sysAppPassword*`; a scoped API key without `impersonate` gets
  "not an owner of account". With `Replace` permissions that grant no `jmap*` permission, `impersonate` gives owner
  access to other accounts' objects but no mail: `Email/query` and `Mailbox/get` there answer `forbidden`.
- The secret (`app_` + 36 lowercase letters and digits) is server-generated, returned once, stored hashed.
- Each credential carries `permissions` (`Inherit` / `Disable` / `Replace`). Stalwart enforces them per protocol
  (IMAP LOGIN refused without `imapAuthenticate`, SMTP AUTH 550 without `emailSend`, CardDAV 403 without `dav*`).
  `Inherit` hands the app every permission of the User role, including changing the account password and minting more
  app passwords over JMAP.
- The OAuth endpoint `/api/auth` accepts an app password and issues an account-wide token without the credential's
  limits.
- `Replace` permissions on a credential can only grant what the caller itself holds ("You are not authorized to grant
  permissions: …"), so a `Replace` allow-list would need a management key with every mail permission — which, with
  `impersonate`, reads every mailbox (`Email/get`, `Mailbox/get` succeed). `Disable` needs nothing.
- `Principal/query` lists every account on the server to any signed-in user (44 on the dev server) although the
  User role doesn't list the permission; disabling `jmapPrincipalQuery`/`jmapPrincipalGet` on the account closes it.
- Stalwart accepts an app password followed by `$<anything>` (its one-time-code separator).
- No "last used" is exposed. Credential ids are small and reused after a revocation. Replacing an account's credential
  list drops all its app passwords.

## Decision

1. **The control plane issues app passwords** with a management credential on the mailbox's account
   (`x:AppPassword/set { accountId }`) that holds `impersonate` and `sysAppPassword{Create,Get,Query,Destroy}`, with
   `Replace` permissions and no mail objects, so it can't read mail directly. Since the 2026-10-23 amendment that is
   the web app's **operations key**, which holds no account or domain permissions at all ("Credential split").
2. **Creation runs in the request**, an exception to "provisioning is a job" (rule 26): the secret must reach the person
   and nowhere else, and a queued job would have to hold it. The request checks permission, ownership, a fresh step-up
   and the per-mailbox limit, creates the credential, then records metadata and the audit entry in one unit of work; if
   that fails, the credential is destroyed again. **Revocation is a job** (`app_password.revoke`), matching id and
   creation time.
3. **Every app password is an allow-list:** the person picks scopes — IMAP, POP3, SMTP, mail over HTTPS (JMAP) and
   contacts and calendars (CardDAV/CalDAV and their JMAP objects; no mail, files or principal search) — and every
   other permission the server knows (`KNOWN_PERMISSIONS`, all non-administrative names from `/api/schema`) is
   turned off with `Disable`, which behaves like a `Replace` allow-list without the key needing those permissions.
   The integration test fails when the server knows a name we haven't classified. The webmail OAuth sign-in refuses
   anything starting `app_` before calling Stalwart.
4. **Every customer account has the self-service objects and principal look-ups off** (`CUSTOMER_DENIALS` in
   `CUSTOMER_PERMISSIONS`), so even an OAuth token minted from an app password straight at Stalwart can't create
   credentials or change the password, and nobody can list other customers. The management key is unaffected
   (verified).
5. **The reconciler checks credentials:** every mailbox's app passwords and API keys against our rows (unknown,
   unexpected permissions, missing, any API key), reported and audited as `platform.reconciler_drift`, never removed;
   pending revocations are queued again. Since the amendment it reads them from `x:Account.credentials` with the
   provisioning key (no owner access needed), and the revocation job removes them there too.
6. **Only the person creates them** for their own mailbox (`app_password.manage.own`), never during act-as; admins
   who manage the mailbox can list and revoke. Metadata only in Postgres (`app_password`).

## Credential split (amendment 2026-10-23)

**Context.** The staging rehearsal showed that the single management key could not create customer mailboxes:
Stalwart lets a credential assign only permissions it holds itself (`forbidden: You are not authorized to grant
permissions: jmapPrincipalCreate, … and 175 more`). Dev never saw it because dev provisions with the recovery admin.
Widening that key to every permission a mailbox keeps, while it also held `impersonate`, would let one credential read
every mailbox. Verified on the pinned v0.16.27 (throwaway domains and accounts, destroyed afterwards;
`research/stalwart.md` "Credential split"):

- The check compares the new account's **effective** permissions (role minus `disabledPermissions`) with the
  credential's own set; disabling needs nothing. So a key holding the User role's 239 permissions minus the 53
  `CUSTOMER_DENIALS` it disables (186) creates, suspends and resumes customer mailboxes with `CUSTOMER_PERMISSIONS`.
  It still can't hand out more (`roles: Admin`, `Inherit`, `Merge +impersonate` → `forbidden`).
- Without `impersonate` such a key has no way into another account: `Email/query`, `Mailbox/get`, `Blob/get`,
  `Identity/get`, `SieveScript/get`, `Blob/lookup`, `x:AppPassword/*` → `forbidden`; downloading a message blob whose
  id it knows → 404. `x:Account/get credentials` lists app passwords (id, description, `createdAt`, `permissions`) and
  API keys, and `x:Account/set { "credentials/<position>": null }` removes one app password and nothing else.
- A key is capped by its account's role (a key with `sysDomainGet` on a User-role account → `forbidden`; a key minted
  with `impersonate` on an account whose role lacks it doesn't get it). `GET /api/account` with a key returns exactly
  what it can do.
- **Any key with `sysAccountUpdate` can set a password on any account, its own included**, and a password sign-in gets
  the account's role permissions, not the key's: with the Admin role on the service account, that was a full
  administrator (`x:SystemSettings/get`, `Email/query` on any mailbox). A custom role equal to the key's set limits it
  to what the key could do anyway.

**Decision.**

1. Three API keys, each on its own service account, never one credential that both creates accounts and acts inside
   one (`@anhourmail/stalwart-client` `keys.ts` holds the exact sets; `service-accounts.ts` creates them):

   | Key (setting)                              | Account         | Containers        | Permissions                                                                                                                                                                                                                                                            |
   | ------------------------------------------ | --------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Provisioning (`STALWART_PROVISIONING_KEY`) | `svc-provision` | worker, scheduler | `authenticate`; `sysDomain*`, `sysAccount*`, `sysDkimSignature*` (Get/Create/Update/Destroy/Query); the 186 permissions a customer mailbox keeps (`CUSTOMER_EFFECTIVE_PERMISSIONS`). No `impersonate`, no `sysAppPassword*`/`sysApiKey*`, no Sieve writes — 201 in all |
   | Operations (`STALWART_OPERATIONS_KEY`)     | `svc-ops`       | web               | `authenticate`, `impersonate`, `sysAppPassword{Create,Get,Query,Destroy}`, `sysApiKey{Get,Query}`, `jmapSieveScript{Get,Query,Create,Update,Validate}`, `jmapBlobUpload`, `jmapBlobGet` — no account, domain or DKIM access                                            |
   | Audit (`STALWART_AUDIT_KEY`)               | `svc-audit`     | scheduler         | `authenticate`, `impersonate`, `jmapSieveScriptGet`, `jmapSieveScriptQuery`, `jmapBlobGet` — reads managed scripts only                                                                                                                                                |

2. Each service account has no password and a **custom role equal to its key's set** (not Admin), credentials written
   only at creation; keys are `Replace`-typed, IP-restricted to the management network, expire, and rotate.
3. Worker-image processes never get owner access through their own key: provisioning, suspension, deletion,
   revocation and the credential inventory use the provisioning key; the managed Sieve script is written and made
   active only by the web app. The hourly managed-script check (the detective control for the operations key's Sieve
   writes) needs to read scripts, so the **scheduler** additionally holds the read-only audit key. The queue worker
   doesn't, and a one-off job without it skips that check and says so. This third key is the one deviation from "two
   keys"; leaving it out would remove the only check on the operations key's Sieve writes.
4. Start-up checks refuse the wrong settings and the wrong keys: in production each process must have its own key and
   none of the others (web: operations only; worker: provisioning only; scheduler: provisioning + audit), never the
   dev admin, and the old `STALWART_API_KEY` is refused everywhere. At start the worker and scheduler, and the web app
   before first use, ask Stalwart what each key can do (`GET /api/account`) and refuse anything but its exact set.
   ESLint stops the web app importing the provisioning or audit client and the worker the operations client.
5. Development keeps the recovery admin for all three (`STALWART_DEV_ADMIN_*`, refused in production); the
   integration tests run the code under test with real keys of each kind (`credentials.int.test.ts`,
   `app-passwords.int.test.ts`).

**Consequences of the amendment.**

- Staging can provision mailboxes. The web app (the internet-facing process) can no longer create, change or delete
  accounts or domains; the worker can no longer read a script, mint an app password or download a blob.
- **Not preventable inside Stalwart Community, so prevented at the network layer and detected (run-25):** any key
  with `sysAccountUpdate` (the provisioning key) can set a password on any account — a customer's (then read their
  mail) or `svc-ops`/`svc-audit` (then sign in with that role's `impersonate`, including Stalwart's
  `<mailbox>%<account>` master-user form **on the HTTP management path and on the mail ports** IMAP/POP3/SMTP —
  verified; app passwords can't be used that way); the operations key can likewise mint an `Inherit` app password on
  `svc-provision`. So in production the apps reach Stalwart's management listener only through an internal
  **management proxy** (ops repo `mgmtproxy/`, nginx+njs): it refuses any `x:Account/set` writing a `credentials`
  value (no password set or replaced — the HTTP and mail-port master-user routes both depend on a password existing),
  any `x:AppPassword/set`/`x:ApiKey/set` on a service account, and any Basic/`%`/non-Bearer auth; Stalwart's listener
  binds only the proxy's and the public NGINX's networks. Detection on top: the per-minute `job:service-accounts`
  (`reconcileServiceAccounts` — the three expected service accounts exist and hold API keys only; refuses to pass with
  `checked: 0` when no infrastructure domain is configured), the app-password reconciler flags a mailbox without
  exactly one Password credential (`extraPasswords`), the plan and smoke check fail on it, and NGINX refuses the
  `svc-*` names and `%` publicly. Custom roles (not Admin) bound the damage if a password lands anyway. A _replaced_
  customer password (same credential count, new `credentialId`) isn't diffed against a stored id yet (open item; the
  proxy prevents the write on the app path). Stalwart has no setting to disable master-user login (checked
  `/api/schema`).
- The worker no longer re-activates a managed script that was switched off: the webmail shows the rules as inactive
  and the next save turns them on, and the reconciler reports it (`inactive`).
- Every Stalwart upgrade re-runs `credentials.int.test.ts`: it fails if the User role changes (the provisioning key
  would no longer be able to create mailboxes) or any boundary above moves.

## Mailbox passwords (amendment 2026-10-23)

**Context.** Console-made mailboxes had a random password nobody knew, so nobody could sign in to the webmail, and the
management proxy (run-25) refuses every `x:Account/set` update that writes `credentials`.

**Decision** (maintainer, 2026-10-23; details in `07-security.md` "Mailbox passwords"):

1. The create form takes the password (typed, or generated in the browser and shown once). The core service checks it
   and hashes it to argon2id at once; only the PHC string is kept (`mailbox.pending_password_hash`) until the worker
   sets it inside `x:Account/set create` (already allowed by the proxy).
2. A person changes their own in the webmail settings. Stalwart could let an account change its own Password, but
   customer accounts have `sysAccountPassword*` denied (decision 4) and that stays: the BFF proves the current
   password with a Stalwart sign-in, then the change goes the way of 3. This session signs in again; others end.
3. Admin reset: `mailbox.password.reset` ★ (Owner, User Admin), step-up, guard rail 8, **refused during act-as** (staff
   never choose a customer's password; the same refusal applies to creating a mailbox while acting as), audited
   `mailbox.password_reset`, the owner emailed. Applied by job `mailbox.password` with the provisioning key: a patch of
   the one Password slot (`credentials/<n>`), so app passwords stay. The proxy allows exactly that shape — on a
   User-role customer account, never a service account or a system mailbox (no-reply, postmaster), with the pinned
   argon2id parameters — when the request carries `X-AnhourMail-Credential-Write: replace` (a marker) **and** a valid
   grant `X-AnhourMail-Password-Grant`: an HMAC the web app makes with `MAILBOX_PASSWORD_GRANT_KEY` (held by the web
   app and the proxy only) over the account id, the hash's SHA-256 and an expiry ≤ 1 h. So the worker's provisioning
   key alone can't set a customer password; only the web and worker together could (residual). The proxy caps marked
   replacements at 20 a minute and logs each one (account id only). Everything else stays refused (review run-26).
4. Detection: `mailbox.password_credential_id` records the Password credential after each create/reset/change; the
   reconciler reports a different or unrecorded one (`platform.reconciler_drift`) and never fixes it.

**Consequences.** People can use the webmail with console-made mailboxes. The provisioning key (worker, scheduler) can
replace a customer's Password through the proxy only with a grant the web app made for that account and hash; the
proxy still refuses service accounts, system mailboxes, extra credentials and other properties. Verified on v0.16.27: replacing the slot keeps app passwords and
revokes every OAuth token; the `credentialId` changes on the first replacement after creation but **not** on later
ones, so detection catches a replacement made before our first reset only (open item: a stronger signal). A legacy
mailbox's credential is recorded at its next `mailbox.ensure` (`job:mailbox-backfill`), adopting whatever it has then.

**Update (2026-10-28): mailbox handovers.** "Add a user" and "Make this a user" (a person-less mailbox becomes
someone's) set a password for a mailbox whose old password may still be known, so the decision above gained four
rules (details in `07-security.md` "Mailbox passwords"): the person's own change is refused (409
`password_change_pending`) while an administrator's password is waiting; console reset emails for a login whose
address is such a mailbox are held (`consoleResetHeld`); a `mailbox.password` job that gives up keeps an
administrator's hash (the console asks for it again) and drops only the person's own change; and "Make this a user"
moves the mailbox's app passwords to `revoking` in the same transaction, since they survive a password replacement.
`mailbox.pending_password_by_owner` (migration 0020) marks a waiting hash as the person's own, so applying it is what
ends the first-sign-in change (`mailbox.must_change_password`). Stalwart still has no "must change" state: IMAP, POP3
and SMTP keep accepting the administrator's password until the person changes it (accepted residual).

## Consequences

- Mail apps work for console-made mailboxes without anyone choosing or knowing a mailbox password.
- The operations key holds `impersonate`; kept on the internal network, IP-restricted and rotated (ADR-0017).
  Re-verify `impersonate` semantics on every Stalwart upgrade (rule 22). With the Sieve writer's `jmapBlobGet` it can
  download a message whose blob id it already holds (it can't list or look ids up). The directory is on a separate
  key since the 2026-10-23 amendment.
- An upgrade that adds self-service permissions to the User role is caught by the integration test
  (`packages/adapters/src/stalwart/app-passwords.int.test.ts`).
- The operations key can mint an app password with any permissions (`Inherit` included) on any mailbox, and with the
  Sieve writes install a `redirect` on any account. Neither can be prevented on Community, so both are detected: the
  reconciler reports unknown or unexpected credentials and managed scripts that aren't ours or redirect anywhere but a
  confirmed target (report only; `mailbox.ensure` re-queued; nothing deleted or rewritten).
- Sharing can't be denied by a permission of its own (`shareWith` rides on `/set`): customer accounts can't create or
  update folders and calendars over JMAP and every ACL method is off, but address books stay writable (the webmail
  needs them), so `AddressBook/set { shareWith }` remains open with a mailbox password (open item).
- Setting a mailbox password patches only the Password entry (`replacePassword`), so app passwords stay (amendment
  "Mailbox passwords").
- Production NGINX must not expose Stalwart's `/api/auth` and `/auth/*` publicly (ops item).

## Alternatives

- Ask for the mailbox password in the console and create the app password as the user: console-made mailboxes have
  none, and it would put a second password through the console.
- Queue creation and hand the secret back through Redis: holds a live credential outside Stalwart; rejected.
- `Inherit` permissions: an app password could change the account password; rejected.
