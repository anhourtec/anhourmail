# Audit

Last updated: 2026-10-21. Decision: ADR-0010. Code: `packages/core/src/audit` (module + `AuditRepository` port), `packages/adapters` (Postgres + in-memory).

Every meaningful action is recorded, tamper-evident, searchable and visible to the right people. Audit is a core module, not a logging side effect.

## Event catalogue

Action names are dotted `<area>.<event>` in past tense (e.g. `domain.verified`). The **source of truth is
`packages/core/src/audit/catalogue.ts`**; the table below is generated from it (`node scripts/check-audit.mjs --write`)
and `npm run check:audit` fails when it drifts (rule 46). `result` is `success` / `denied` / `failed`. Every action
inside an act-as session also carries `on_behalf_of`. Mail-protocol sign-ins ingested from Stalwart are
`auth.mail_client_sign_in` / `auth.mail_client_sign_in_failed` with the protocol (IMAP/SMTP/JMAP) in `meta`.

<!-- BEGIN generated: audit actions (scripts/check-audit.mjs --write) -->

| Area | Actions |
| --- | --- |
| `auth` | `auth.sign_in`, `auth.sign_in_failed`, `auth.sign_out`, `auth.password_changed`, `auth.password_reset`, `auth.password_reset_requested`, `auth.two_factor_enabled`, `auth.two_factor_disabled`, `auth.app_password_created`, `auth.app_password_revoked`, `auth.session_revoked`, `auth.locked_out`, `auth.mail_client_sign_in`, `auth.mail_client_sign_in_failed`, `auth.two_factor_reset`, `auth.backup_code_used`, `auth.sessions_revoked_all`, `auth.new_device`, `auth.passkey_added`, `auth.passkey_renamed`, `auth.passkey_removed`, `auth.recovery_codes_regenerated`, `auth.identity_confirmed`, `auth.email_verification_sent`, `auth.email_verified` |
| `account` | `account.created`, `account.deleted`, `account.updated`, `account.invite_sent`, `account.invite_accepted`, `account.invite_resent`, `account.invite_revoked`, `account.member_added`, `account.user_added`, `account.profile_changed`, `account.member_removed`, `account.role_changed`, `account.ownership_transferred`, `account.sign_in_policy_changed`, `account.sign_in_factor_added` |
| `domain` | `domain.added`, `domain.verified`, `domain.verify_failed`, `domain.removed`, `domain.dns_state_changed`, `domain.released`, `domain.expired` |
| `mailbox` | `mailbox.created`, `mailbox.renamed`, `mailbox.made_user`, `mailbox.suspended`, `mailbox.unsuspended`, `mailbox.deleted`, `mailbox.quota_changed`, `mailbox.deletion_scheduled`, `mailbox.restored`, `mailbox.password_reset`, `mailbox.password_changed` |
| `alias` | `alias.created`, `alias.toggled`, `alias.deleted` |
| `masked_alias` | `masked_alias.created`, `masked_alias.toggled`, `masked_alias.deleted` |
| `catch_all` | `catch_all.changed` |
| `forwarding` | `forwarding.changed`, `forwarding.verification_sent`, `forwarding.confirmed` |
| `sieve` | `sieve.changed` |
| `vacation` | `vacation.changed` |
| `junk_rules` | `junk_rules.changed` |
| `identity` | `identity.changed` |
| `webmail` | `webmail.preferences_changed` |
| `billing` | `billing.plan_changed`, `billing.payment_succeeded`, `billing.payment_failed`, `billing.refunded`, `billing.suspended`, `billing.reactivated` |
| `trust` | `trust.tier_changed`, `trust.limits_changed`, `trust.restricted`, `trust.suspended`, `trust.unsuspended` |
| `abuse` | `abuse.report_received`, `abuse.report_resolved` |
| `staff` | `staff.role_granted`, `staff.role_revoked`, `staff.act_as_started`, `staff.act_as_ended`, `staff.account_viewed`, `staff.credentials_reset` |
| `data` | `data.export_requested`, `data.export_downloaded`, `data.import_started`, `data.import_finished`, `data.deletion_requested`, `data.deleted` |
| `platform` | `platform.settings_changed`, `platform.admin_bootstrapped`, `platform.secret_changed`, `platform.stalwart_upgraded`, `platform.provisioning_failed`, `platform.reconciler_drift`, `platform.mailboxes_requeued`, `platform.mailbox_purged`, `platform.audit_chain_broken` |
| `audit` | `audit.exported` |
| `shared_mailbox` | `shared_mailbox.created`, `shared_mailbox.deleted`, `shared_mailbox.member_added`, `shared_mailbox.member_removed` |
| `distribution_list` | `distribution_list.created`, `distribution_list.deleted`, `distribution_list.member_added`, `distribution_list.member_removed`, `distribution_list.senders_changed` |
| `delegation` | `delegation.granted`, `delegation.revoked` |
| `folder_share` | `folder_share.granted`, `folder_share.revoked` |
| `send_as` | `send_as.granted`, `send_as.revoked` |
| `send_on_behalf` | `send_on_behalf.granted`, `send_on_behalf.revoked` |
| `mail_rule` | `mail_rule.created`, `mail_rule.changed`, `mail_rule.deleted` |
| `resource_mailbox` | `resource_mailbox.created`, `resource_mailbox.deleted` |
| `message_trace` | `message_trace.viewed` |
| `folder_policy` | `folder_policy.changed` |
| `signature` | `signature.changed` |
| `signature_template` | `signature_template.changed`, `signature_template.applied` |
| `disclaimer` | `disclaimer.changed` |
| `bulk` | `bulk.addon_enabled`, `bulk.addon_disabled`, `bulk.sender_domain_verified`, `bulk.list_created`, `bulk.list_imported`, `bulk.list_deleted`, `bulk.campaign_scheduled`, `bulk.campaign_held`, `bulk.campaign_approved`, `bulk.campaign_sent`, `bulk.campaign_cancelled`, `bulk.suppression_added`, `bulk.suppression_removed`, `bulk.sending_paused` |

<!-- END generated: audit actions -->

Sign-in security (`07-security.md` "Sign-in factors"): the identity layer reports `auth.sign_in` (meta `method`:
`password`, `password+totp`, `password+recovery_code`, `passkey`; `trustedDevice`/`trustDevice` when relevant),
`auth.sign_in_failed` (`denied` with the code, e.g. `invalid_code`, `code_reused`, `invalid_email_or_password`),
`auth.locked_out`, `auth.sign_out`, `auth.two_factor_enabled` / `_disabled` (refusals `denied`), `auth.backup_code_used`
(meta `codesLeft`), `auth.recovery_codes_regenerated` and `auth.passkey_added` (meta passkey id and name), all in the
**platform** scope with the person as the target, so their own Security page lists them (`getSecurityOverview`). The
person's own changes through core services — `auth.session_revoked`, `auth.sessions_revoked_all` (meta counts),
`auth.passkey_renamed` (`previousName`/`newName`), `auth.passkey_removed` — commit with their audit row. Never codes,
secrets, credential ids or public keys (redaction keys include `totpCode`, `publicKey`, `attestationObject`, …).
`account.sign_in_factor_added` (identity layer, in each requiring account's scope, meta `factor`) records someone's
first sign-in factor set up while the account requires one; they and the Owners are emailed.
`auth.identity_confirmed` is a step-up before adding a passkey (meta `method`; refusals `denied`). A sign-in refused
by an account requirement is `auth.sign_in_failed` denied `sign_in_requirement` (meta `method`); a session ended later
for the same reason is `auth.session_revoked` by the identity layer (meta `reason`, `method`); so is a session signed
out after 5 failed step-ups (reason `step_up_failures`). Removing every passkey
with "sign out everywhere else" or a reset shows as `passkeysRemoved` in that entry's meta.
`auth.password_reset` (identity layer) and `auth.password_changed` (the person) commit together with signing out the
other sessions and forgetting trusted browsers (meta `otherSessionsRevoked`, `sessions`, `trustedDevices`).
`account.sign_in_policy_changed` is written in the account's scope (meta `previousPolicy`, `newPolicy`); an attempt by
someone else is `denied`. The Security page shows each entry's network part and a browser/system summary only.

Mailbox lifecycle: `mailbox.suspended` and `mailbox.unsuspended` (resume), `mailbox.deletion_scheduled` (meta: the
status it came from, `purgeAfter`, alias count) and `mailbox.restored` are written by the person in the console;
`platform.mailbox_purged` is written by the system (`mailbox-purge`) **in the mailbox's account scope**, so the
account's admins see when a deleted mailbox was removed for good (a failed purge is recorded as `failed` and retried).
Suspending or deleting again after the worker gave up is recorded with `retry: true`. A User Administrator's attempt
on an Owner's or admin's mailbox is recorded as `denied` (`forbidden`). The reconciler's `platform.reconciler_drift`
meta includes `suspensionMismatches` and `requeued`.
`mailbox.deleted` stays reserved for an immediate deletion without a grace period (not offered today).

Storage: `job:quota-cap` writes `mailbox.quota_changed` as the system **in the mailbox's account scope** (meta
`fromGb`, `toGb`, `poolGb`, `usedBytes`, `reason: "storage_pooled"`; entries before 2026-10-23 evening carry `planGb`,
`abovePlan`, `reason: "plan_storage_reduced"`), so the account's admins see why a quota went down; an account kept
above its pool by the mail it holds is reported in the job log (`keptAbovePoolAccountIds`), not audited. The scheduler's storage measurements (`job:storage-usage`, every 10 minutes) are **not audited**: they record
an observation of the mail server, not a change anyone asked for, and would flood the log.

First platform administrator: `platform.admin_bootstrapped` is written by the system actor `bootstrap-admin` (worker
job `job:bootstrap-admin`, deploy/README.md "First platform administrator") in the **platform** scope, with the new
login as the target (label = the email). Success meta: `role` (`global_admin`) and `linkExpiresAt`; never the
set-password token or link. A refused run is `denied` with code `admin_exists` (someone already holds a platform role)
or `login_exists` (the email already has a console login); an invalid email or name throws before anything is written.

App passwords (ADR-0020), in the mailbox's **account** scope with the mailbox as the target:
`auth.app_password_created` (meta `name`, `protocols`; never the secret or Stalwart's credential id) and
`auth.app_password_revoked` (meta `name` — plus `retry: true` when it was already being revoked and the job is
queued again — or `all: true` and `count` for "revoke all"). Refusals are `denied` with the
code: `step_up_required` (no recent confirmation on that session), `act_as` (staff acting as the person),
`forbidden` (someone else's mailbox, or a User Administrator on an Owner's or admin's mailbox). The removal from the
mail server is the worker's job and isn't audited again (a job that gives up writes `platform.provisioning_failed`).
Catch-all: `catch_all.changed` (target = the domain; meta `enabled`, `mailbox` (masked address) and `changed`).
Suspending or deleting the catch-all's mailbox turns it off in the same entry: `mailbox.suspended` /
`mailbox.deletion_scheduled` meta `catchAllOff` (the domain names), and so does `platform.provisioning_failed` when
the catch-all's mailbox ends up `failed`. The reconciler's app password check writes `platform.reconciler_drift`
(target label `app passwords`; meta `appPasswordRevocationsRequeued`, `unknownAppPasswords`,
`unexpectedAppPasswordPermissions`, `missingAppPasswords`, `apiKeysOnMailboxes`, `mailboxesUnreachable`; counts only,
no addresses), and the managed-script check another (target label `managed sieve scripts`; meta `scriptsChecked`,
`scriptsNotOurs`, `unconfirmedRedirects`, `foreignScripts`, `mailboxesUnreachable`, `requeued`).

"Add a user": `account.user_added` (target = the new mailbox, label its address; meta: `userId`, `role`, `quotaGb`,
`passwordGenerated`, `requirePasswordChange`, `profileFields` — the names of the optional profile fields given, never
their values — and `platformAddress` for a free address). One entry covers the mailbox, the console login, the
membership and the owner link, written in the same transaction. A User Administrator asking for a role other than
Member is recorded as `denied`. Never the password (generated or chosen). `mailbox.renamed` (meta: none; the name is
personal data) when an admin edits a mailbox's display name. `auth.password_changed` carries `firstPasswordReplaced:
true` when it lifts the first-sign-in password change.

"Make this a user" (a person-less mailbox): `mailbox.made_user` (target = the mailbox, label its address; meta:
`userId`, `role`, `profileFields` — names only). One entry covers the console login, the membership, the owner link,
the display name and the new generated password (never recorded). Denied entries: a role the actor may not grant
(`forbidden`), a staff act-as session (`act_as`) and a missing step-up (`step_up_required`).

Profile details: `account.profile_changed` (target = the person, label their sign-in email; meta: `fields` — the names
of the optional profile fields that changed, never their values — and `self`). An admin's edit is written to that
account's log; the person's own edit from their Profile page is written to every account they belong to (the platform
log when they belong to none), so its admins see it. A User Administrator editing an admin's profile is `denied`.

People: `account.invite_sent`, `account.invite_resent`, `account.invite_revoked` (target label = the invited
address, meta = role; never the token), `account.invite_accepted` (meta: role, `newLogin`, the user id; the actor is
the signed-in person, or `system`/`invite` when the link created the login), `account.role_changed` (meta:
`previousRole`, `newRole` — `from`/`to` are redacted keys) and `account.member_removed` (meta: role, how many of their
mailboxes became unassigned, `appPasswordsRevoked`). A User Administrator's attempt on an Owner, an admin or an admin-role invite is recorded as
`denied` in the account. An invite opened by a different signed-in address is recorded as `denied` in the
**platform** scope with the invited address masked, so a non-member's address and id never land in the inviting
account's log. `staff.account_viewed` is written in the viewed account's scope each time staff open its summary;
staff paths (`MutationSpec.staffPath`) always record the actor as staff with the platform role, even when that staff
member also belongs to the account (rule 49).

Views: account audit logs (console and API) and the person's own Security activity show the network part of the IP
only (`203.0.113.x`, IPv6 `/48`); the **platform** audit shows the full stored address, IPv4 or IPv6, only to
holders of `platform.audit.full_ip` (Global Administrator), so they can watch open sign-ups and reset requests for
abuse; other platform readers (Reports Reader) see the network part. Decided in the audit service by scope and permission (`platformAuditPage`), never by the page. No view shows the
user agent. Filters are area, actor (person, staff — including act-as —, system, signed out), result and UTC dates,
newest first with a `before` cursor.

Signed-out and identity events carry the request's client address (TRUST_PROXY rules, the same one the rate limiter
uses): `account.created` (sign-up), `auth.password_reset_requested`, `auth.email_verification_sent` and
`auth.email_verified`, like every sign-in event. The IP is the only request detail they keep (no user agent).

Staff suspension (`platform.account.suspend`, roles.md guard rail 17): `trust.suspended` and `trust.unsuspended`, always
by staff (`staffPath`), written through `mutation()` with `copies` so one unit of work records every scope. An
account: target `account` (label = the account name), the entry in the **account's own log** (meta `reason` — the
category in plain words —, `reasonCategory`, `mailboxesSuspended` / `mailboxesResumed`, `mailboxesStillHeld`,
`catchAllOff`) and a copy in the **platform** log that alone adds `internalNote`. A person: target `user` (label = the
masked email), the entry in the **platform** log (with `internalNote`, `sessionsRevoked`) and a copy in **each of their
accounts' logs** without the note. Refusals are `denied`: `step_up_required`, `act_as`, `staff` (target holds a
platform role), `self`, `not_found` and `forbidden` (the last two in the platform log only); a member's request to a
suspended account is `denied` `account_suspended` in that account's log. The mailbox jobs it queues aren't audited
again. A suspended person's refused sign-in is `auth.sign_in_failed` denied `sign_in_requirement` (identity layer).

Free platform addresses (ADR-0021): `mailbox.created` with meta `platformAddress: true` in the account's scope;
refusals are `denied` with `email_unverified` (sign-in email not confirmed) or `act_as`, failures `failed` with
`plan_limit` (the plan's free addresses used up) or `conflict` (name in use or retired from another account). Staff
creating one (`platform.mailbox.create`) is the same action by staff in the account's own log, with meta
`passwordSetBy: "account"`; a refusal before the account is known (missing permission, unknown account) goes to the
platform log only. `platform.mailbox_purged` meta `retiredPlatformAddresses` counts the platform addresses retired
for good. `auth.email_verification_sent` (target masked, no link or token) and `auth.email_verified` are platform-scope
identity events.

Not audited here by design: personal folder create/rename/move/delete and message moves — they are mail data
handled by Stalwart over JMAP/IMAP and never pass through the control plane (ADR-0014). Audited: folder sharing
(`folder_share.*`), account folder policies (`folder_policy.changed`), signatures and templates
(`signature.changed`, `signature_template.changed`, `signature_template.applied` — with a hash of the HTML, never
the HTML itself), the account disclaimer (`disclaimer.changed`, before/after text, which is account-authored
policy, not mail content) and every bulk add-on action (`bulk.*`; never subscriber lists or campaign bodies).

Collaboration events (`shared_mailbox.*`, `distribution_list.*`, `delegation.*`, `folder_share.*`, `send_as.*`, `send_on_behalf.*`, `mail_rule.*`, `resource_mailbox.*`, `message_trace.viewed`) are in the table above. Grants on someone else's mailbox also notify that mailbox's owner (see Alerts), and every send as / send on behalf through the webmail BFF is recorded with the identity used (never the message).

## Entry fields

| Field                                                 | Notes                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `id`, `seq`, `scope`                                  | `scope` = `account:<id>` or `platform`; `seq` increases per scope                  |
| `occurred_at`                                         | UTC                                                                                |
| `actor_type`                                          | `user` / `staff` / `system` / `api_token` / `anonymous`                            |
| `actor_user_id`, `actor_email_snapshot`, `actor_role` | Snapshots keep entries readable after deletion                                     |
| `on_behalf_of_user_id`, `act_as_session_id`           | Set during act-as                                                                  |
| `account_id`                                          | Account scope (null for platform-only events)                                      |
| `action`                                              | From the catalogue                                                                 |
| `target_type`, `target_id`, `target_label_snapshot`   | e.g. `domain`, id, `example.com`                                                   |
| `result`, `error_code`                                | `success` / `denied` / `failed`                                                    |
| `request_id`, `ip`, `user_agent`                      | From the request context; IP is stored as-is for 1 year, then truncated (/24, /48) |
| `meta`                                                | JSON, redacted; before/after values for changes                                    |
| `prev_hash`, `hash`                                   | Chain (below)                                                                      |

## Never in audit

Mail content, subjects, bodies, previews, attachments, recipient lists, passwords, tokens, secrets, keys, OTP codes and full payment details. `recordAudit()` passes `meta` through the **same redaction list as the logger** (`packages/server/src/log.ts` `REDACT_KEYS`), and unit tests assert it (rule 48).

## Integrity

- **Same unit of work:** the audit row is written in the same transaction as the change. If the audit write fails, the change fails. Denied attempts are written on their own (no change to roll back).
- **Append-only:** the app's DB role has `INSERT, SELECT` on `audit_log`, with no `UPDATE`/`DELETE`, granted by migration. No repository method updates or deletes audit rows (rule 47).
- **Hash chain per scope:** `hash = sha256(prev_hash ‖ canonical_json(entry without hash))`. `prev_hash` of the first entry is a fixed genesis value. Writes take a per-scope advisory lock to read the previous hash.
- **Verification:** the scheduler job `audit-chain-verify` walks each scope from its last checkpoint nightly. A break raises `platform.audit_chain.break` and pages the operator.
- **Retention purge** runs under a separate maintenance role. Before deleting a prefix it records a checkpoint (`scope`, `seq`, `hash`), and the purge itself is audited.

## Visibility

| Who                                                           | Sees                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account admins (Owner, User Administrator, Read-only Auditor) | Their account's audit log: filter by actor, action, target, date; full-text search over labels; export CSV/JSON (rate-limited `export` tier, itself audited)                                                                               |
| Members                                                       | Their own **Security activity** page: sign-ins (including IMAP/SMTP/JMAP), devices, sessions with "sign out everywhere", app passwords, 2FA changes                                                                                        |
| The affected account                                          | **Staff actions on their account**, labelled "Anhourtec staff" with role, reason and time (rule 49). The only exception is a legally required confidentiality order; that is documented internally and counted in the transparency report. |
| Global Administrator, Reports Reader                          | Platform audit: all accounts, staff actions, platform settings                                                                                                                                                                             |

## Alerts

These events notify the affected people (email to the account's recovery address + in-console) and feed the abuse and compromised-account detectors: new-device sign-in, 2FA disabled, role change, domain removed, export requested, staff act-as started, app password created, password reset by staff.

Collaboration: full access, send as or forwarding granted on a mailbox notifies that mailbox's owner; a new member of a shared mailbox notifies the shared mailbox's admins.

## Retention (configurable; stated in the privacy policy)

| Data                                                    | Retention                    |
| ------------------------------------------------------- | ---------------------------- |
| Account audit                                           | Life of the account + 1 year |
| Security sign-in history (incl. mail protocol sign-ins) | 1 year                       |
| Platform audit                                          | 7 years                      |
| Mail-flow logs                                          | 30 days                      |

## Mail-flow logs (separate from audit)

Delivery metadata from Stalwart (message-id, from/to **domains**, status, timestamps, size; no content, no full addresses beyond the account's own) goes in `mail_flow_event` with 30-day retention. Users see it as **Message trace** for troubleshooting. Support Administrators see it via `platform.mailflow.read`.

## Ingesting Stalwart events

Stalwart Community has an **`x:WebHook`** object. **Prototyped in Phase 1 (2026-10-21)** with a dev-only
`event-sink` service on the mail network (`docker compose logs event-sink`): payloads are batched
`{"events":[{id, createdAt, type, data}]}` and signed `X-Signature: base64(HMAC-SHA256(key, raw body))`.

Receiver design (apps/worker, Phase 3):

- Internal endpoint only (mail network), `x:WebHook.signatureKey` from the secrets store; verify the HMAC over the
  raw body with a constant-time compare before parsing; reject unsigned or stale batches (`createdAt` window) and
  de-duplicate by event `id` (Stalwart retries until `discardAfter`).
- `auth.success` → `auth.mail_client_sign_in`; `auth.failed` / `auth.too-many-attempts` →
  `auth.mail_client_sign_in_failed` (`meta`: protocol from `listenerId` — `imaps`/`imap` IMAP, `pop3s`/`pop3`
  POP3, `submissions`/`submission` SMTP, `http` JMAP — plus remote IP and reason). Actor = the user who owns the
  mailbox (`accountName` → mailbox → user), scope = that account. New-device detection and alerts read these.
- `delivery.dsn-perm-fail`, `delivery.failed`, `incoming-report.abuse-report` → mail-flow log (30 days) and
  abuse signals (`03-anti-spam-and-abuse.md`); never message content.
- Event selection is an include-list (`eventsPolicy: include`); `lossy: false`; throttle 1 s.

## Testing

- The RBAC harness asserts that every mutating route and server action writes the expected entry (action, actor, target, result), including **denied** attempts.
- Unit tests cover redaction, canonical JSON, hash chaining (tamper detection), snapshots and act-as attribution.
- `scripts/check-audit.mjs` (pre-commit + CI) fails when a service mutation (a function under `packages/core/src/**/service.ts` whose name starts with a mutating verb, or that is marked `@mutation`) has no `recordAudit` / `withAudit` call.
