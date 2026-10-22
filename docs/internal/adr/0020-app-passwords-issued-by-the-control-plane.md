# ADR-0020: App passwords issued by the control plane, limited per credential

**Status:** Accepted 2026-10-22

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

1. **The control plane issues app passwords** with the management credential on the mailbox's account
   (`x:AppPassword/set { accountId }`). The production service account (ADR-0017) gains `impersonate` and
   `sysAppPassword{Create,Get,Query,Destroy}`, still with `Replace` permissions and no `jmap*`/`dav*`, so the key can't
   read mail directly. Its blast radius is unchanged: it could already reset any password (`sysAccountUpdate`).
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
5. **The reconciler checks credentials:** every mailbox's `x:AppPassword` and `x:ApiKey` against our rows (unknown,
   unexpected permissions, missing, any API key), reported and audited as `platform.reconciler_drift`, never removed;
   pending revocations are queued again.
6. **Only the person creates them** for their own mailbox (`app_password.manage.own`), never during act-as; admins
   who manage the mailbox can list and revoke. Metadata only in Postgres (`app_password`).

## Consequences

- Mail apps work for console-made mailboxes without anyone choosing or knowing a mailbox password.
- The management key is more powerful on paper (`impersonate`); kept on the internal network, IP-restricted and rotated
  (ADR-0017). Re-verify `impersonate` semantics on every Stalwart upgrade (rule 22). With the Sieve writer's
  `jmapBlobGet` it can download a message whose blob id it already holds (it can't list or look ids up). **Later
  hardening:** separate keys — one for app passwords (`impersonate` + `sysAppPassword*`, no `jmap*`), one for the
  managed Sieve script (`impersonate` + Sieve/blob, no `sys*`), one for the directory.
- An upgrade that adds self-service permissions to the User role is caught by the integration test
  (`packages/adapters/src/stalwart/app-passwords.int.test.ts`).
- The key can mint an app password with any permissions (`Inherit` included) on any mailbox, and with the Sieve
  writes install a `redirect` on any account. Neither can be prevented on Community, so both are detected: the
  reconciler reports unknown or unexpected credentials and managed scripts that aren't ours or redirect anywhere but a
  confirmed target (report only; `mailbox.ensure` re-queued; nothing deleted or rewritten).
- Sharing can't be denied by a permission of its own (`shareWith` rides on `/set`): customer accounts can't create or
  update folders and calendars over JMAP and every ACL method is off, but address books stay writable (the webmail
  needs them), so `AddressBook/set { shareWith }` remains open with a mailbox password (open item).
- A future "set mailbox password" must patch only the password entry, or it drops the app passwords.
- Production NGINX must not expose Stalwart's `/api/auth` and `/auth/*` publicly (ops item).

## Alternatives

- Ask for the mailbox password in the console and create the app password as the user: console-made mailboxes have
  none, and it would put a second password through the console.
- Queue creation and hand the secret back through Redis: holds a live credential outside Stalwart; rejected.
- `Inherit` permissions: an app password could change the account password; rejected.
