# Audit

Last updated: 2026-10-31 (names as one source: `account.profile_changed` `name`, `via: webmail`; `identity.changed` retired; 2026-10-30: `platform.mail_rules_upgraded` for the managed-script upgrade; mailbox delegation, ADR-0026: `delegation.sent_as`, `delegation.sent_on_behalf`, `delegation.send_failed`, `delegation.send_cancelled` and `delegation.tagged_copy_left` for sending from a delegated mailbox, slice 13; `delegation.mailbox_opened` for opening a delegated mailbox in the webmail; `delegation.granted` / `delegation.revoked` per change, `mailbox.converted_to_shared`, `MutationOutcome.also`; `account.member_removed` `mailboxesSignedOut`; data export and account deletion, ADR-0025; staff support access / act-as events and `on_behalf_of`; profile photo and webmail signature events). Decision: ADR-0010. Code: `packages/core/src/audit` (module + `AuditRepository` port), `packages/adapters` (Postgres + in-memory).

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
| `auth` | `auth.sign_in`, `auth.sign_in_failed`, `auth.sign_out`, `auth.password_changed`, `auth.password_reset`, `auth.password_reset_requested`, `auth.two_factor_enabled`, `auth.two_factor_disabled`, `auth.app_password_created`, `auth.app_password_revoked`, `auth.session_revoked`, `auth.locked_out`, `auth.mail_client_sign_in`, `auth.mail_client_sign_in_failed`, `auth.two_factor_reset`, `auth.backup_code_used`, `auth.sessions_revoked_all`, `auth.new_device`, `auth.passkey_added`, `auth.passkey_renamed`, `auth.passkey_removed`, `auth.recovery_codes_regenerated`, `auth.identity_confirmed`, `auth.email_verification_sent`, `auth.email_verified`, `auth.login_deleted` |
| `account` | `account.created`, `account.deleted`, `account.updated`, `account.invite_sent`, `account.invite_accepted`, `account.invite_resent`, `account.invite_revoked`, `account.member_added`, `account.user_added`, `account.profile_changed`, `account.avatar_changed`, `account.avatar_removed`, `account.member_removed`, `account.role_changed`, `account.ownership_transferred`, `account.sign_in_policy_changed`, `account.sign_in_factor_added` |
| `domain` | `domain.added`, `domain.verified`, `domain.verify_failed`, `domain.removed`, `domain.dns_state_changed`, `domain.released`, `domain.expired` |
| `mailbox` | `mailbox.created`, `mailbox.renamed`, `mailbox.made_user`, `mailbox.converted_to_shared`, `mailbox.suspended`, `mailbox.unsuspended`, `mailbox.deleted`, `mailbox.quota_changed`, `mailbox.deletion_scheduled`, `mailbox.restored`, `mailbox.password_reset`, `mailbox.password_changed`, `mailbox.avatar_changed`, `mailbox.avatar_removed` |
| `alias` | `alias.created`, `alias.toggled`, `alias.deleted` |
| `masked_alias` | `masked_alias.created`, `masked_alias.toggled`, `masked_alias.deleted` |
| `catch_all` | `catch_all.changed` |
| `forwarding` | `forwarding.changed`, `forwarding.verification_sent`, `forwarding.confirmed` |
| `sieve` | `sieve.changed` |
| `vacation` | `vacation.changed` |
| `junk_rules` | `junk_rules.changed` |
| `identity` | `identity.changed` |
| `webmail` | `webmail.preferences_changed`, `webmail.signature_added`, `webmail.signature_changed`, `webmail.signature_removed`, `webmail.signature_defaults_changed`, `webmail.handoff_started`, `webmail.handoff_redeemed` |
| `billing` | `billing.plan_changed`, `billing.payment_succeeded`, `billing.payment_failed`, `billing.refunded`, `billing.suspended`, `billing.reactivated` |
| `trust` | `trust.tier_changed`, `trust.limits_changed`, `trust.restricted`, `trust.suspended`, `trust.unsuspended` |
| `abuse` | `abuse.report_received`, `abuse.report_resolved` |
| `staff` | `staff.role_granted`, `staff.role_revoked`, `staff.act_as_started`, `staff.act_as_renewed`, `staff.act_as_ended`, `staff.account_viewed`, `staff.credentials_reset` |
| `data` | `data.export_requested`, `data.export_ready`, `data.export_downloaded`, `data.export_expired`, `data.mail_exported`, `data.import_started`, `data.import_finished`, `data.deletion_requested`, `data.deletion_cancelled`, `data.deletion_started`, `data.deleted` |
| `platform` | `platform.settings_changed`, `platform.admin_bootstrapped`, `platform.secret_changed`, `platform.stalwart_upgraded`, `platform.provisioning_failed`, `platform.reconciler_drift`, `platform.mailboxes_requeued`, `platform.mail_rules_upgraded`, `platform.mailbox_purged`, `platform.audit_chain_broken` |
| `audit` | `audit.exported` |
| `shared_mailbox` | `shared_mailbox.created`, `shared_mailbox.deleted`, `shared_mailbox.member_added`, `shared_mailbox.member_removed` |
| `distribution_list` | `distribution_list.created`, `distribution_list.deleted`, `distribution_list.member_added`, `distribution_list.member_removed`, `distribution_list.senders_changed` |
| `delegation` | `delegation.granted`, `delegation.revoked`, `delegation.mailbox_opened`, `delegation.sent_as`, `delegation.sent_on_behalf`, `delegation.send_cancelled`, `delegation.send_failed`, `delegation.tagged_copy_left` |
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

Aliases (`packages/core/src/aliases/service.ts`), in the account scope with the alias as the target (label = its
address): `alias.toggled` / `masked_alias.toggled` meta `enabled`, plus `adminLocked: true` when an administrator
(`alias.manage.any`) turned off someone else's alias and `adminLockLifted: true` when an administrator turned a locked
one back on. Its own person trying to turn a locked alias on, or delete it, is `denied` `alias_admin_locked` on the
same `*.toggled` / `*.deleted` action. A create over the plan's daily cap (`aliasCreationsPerDay`, per UTC day, counted
from creations) is `alias.created` / `masked_alias.created` `denied` `alias_daily_limit` (meta `kind`, `perDay`);
over Free's rolling yearly cap (`aliasCreationsPerYear`) it is `denied` `alias_yearly_limit` (meta `kind`, `perYear`,
`nextSlot` — the UTC day a slot comes back); onto a mailbox that already has `ALIASES_PER_MAILBOX` aliases and masked
aliases it is `denied` `alias_mailbox_limit` (meta `kind`, `perMailbox`, `mailbox` — redacted like every address).
Nothing is created and nothing is counted. Over the account's at-a-time limit stays `failed` `plan_limit`. No new
action names: the catalogue above is unchanged.

Mailbox lifecycle: `mailbox.suspended` and `mailbox.unsuspended` (resume), `mailbox.deletion_scheduled` (meta: the
status it came from, `purgeAfter`, alias count) and `mailbox.restored` are written by the person in the console;
`platform.mailbox_purged` is written by the system (`mailbox-purge`) **in the mailbox's account scope**, so the
account's admins see when a deleted mailbox was removed for good (a failed purge is recorded as `failed` and retried). A due mailbox that Anhourtec staff hold (its account or person suspended, or a staff hold on it) is skipped
without an entry until they lift it (ADR-0025).
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
Pending custom domains (`02-mail-infrastructure.md` "Pending domains don't hold a name for good"), written by the
system **in the domain's own account scope** (target = the domain, label its name; meta `reason`, `onMailServer`):
`domain.released` when a pending claim on the mail server lost its records — `ownership_proven_elsewhere` (another
account proved the name and this claim's ownership record is gone; actor `domain-claims`; nothing about the other
account is recorded) or `records_not_found` (the daily check; actor `domain-expiry`) — and `domain.expired` (actor
`domain-expiry`, `not_verified_in_time`) when one wasn't verified in time: released from the mail server
(`onMailServer: true`) or deleted (`false`). A domain that changed meanwhile is recorded as `failed` (`conflict`) and
tried again the next day. The other account's check that triggered a release records `heldElsewhere` in its own
`domain.verify_failed` meta.
Catch-all: `catch_all.changed` (target = the domain; meta `enabled`, `mailbox` (masked address) and `changed`).
Suspending or deleting the catch-all's mailbox turns it off in the same entry: `mailbox.suspended` /
`mailbox.deletion_scheduled` meta `catchAllOff` (the domain names), and so does `platform.provisioning_failed` when
the catch-all's mailbox ends up `failed`. The reconciler's app password check writes `platform.reconciler_drift`
(target label `app passwords`; meta `appPasswordRevocationsRequeued`, `unknownAppPasswords`,
`unexpectedAppPasswordPermissions`, `missingAppPasswords`, `apiKeysOnMailboxes`, `mailboxesUnreachable`; counts only,
no addresses), and the managed-script check another (target label `managed sieve scripts`; meta `scriptsChecked`,
`scriptsNotOurs`, `unconfirmedRedirects`, `foreignScripts`, `mailboxesUnreachable`, `requeued`). The web app's start-up upgrade of managed Sieve scripts (forwarding skips DMARC failures, ADR-0019) writes one
`platform.mail_rules_upgraded` entry (system actor `webmail-rules-upgrade`, counts only: checked, upgraded, current,
skipped inactive, failed) when it wrote or failed anything.

"Add a user": `account.user_added` (target = the new mailbox, label its address; meta: `userId`, `role`, `quotaGb`,
`passwordGenerated`, `requirePasswordChange`, `profileFields` — the names of the optional profile fields given, never
their values — and `platformAddress` for a free address). One entry covers the mailbox, the console login, the
membership and the owner link, written in the same transaction. A User Administrator asking for a role other than
Member is recorded as `denied`. Never the password (generated or chosen). `mailbox.renamed` (meta: `cleared` — true
when the custom name was removed so the mailbox follows its person again; never the name, personal data) when an admin
edits a mailbox's display name; from the webmail of a mailbox without a person (read-only there) it is `denied`
`admin_set`. `auth.password_changed` carries `firstPasswordReplaced:
true` when it lifts the first-sign-in password change.
Mailbox handovers (`07-security.md` "Mailbox passwords"): the webmail's own change while an administrator's password
is waiting or never applied is `mailbox.password_changed` `denied` `password_change_pending` (written as the mailbox,
meta `by: "self"`). A console reset held because the login's address is a mailbox between owners is
`auth.password_reset_requested` `denied` `mailbox_password_pending` in the platform log, with the user id as target
and **no address** (meta `reason`: `held`, or `check_failed` when the check itself failed). A `mailbox.password` job
that gives up on an administrator's password writes `platform.provisioning_failed` with meta `adminPasswordKept: true`
(the hash stays so the console can ask for it again). A worker whose claim on a job went stale and was taken over by
another worker records nothing of its own outcome; if that outcome was the last failure it writes
`platform.provisioning_failed` `denied` `lock_lost` (meta `jobId`, `attempts`) and leaves the subject as it is.

"Make this a user" (a person-less mailbox): `mailbox.made_user` (target = the mailbox, label its address; meta:
`userId`, `role`, `profileFields` — names only — and `appPasswordsRevoked`, how many of the mailbox's app passwords
were moved to revoking). One entry covers the console login, the membership, the owner link, the display name, the
new generated password (never recorded) and the app password revocation. Denied entries: a role the actor may not grant
(`forbidden`), a staff act-as session (`act_as`) and a missing step-up (`step_up_required`). A right the new person
held on the mailbox as a delegate is revoked with it (`delegation.revoked`, reason `became_owner`); everyone else's
grants stay.

Mailbox delegation (ADR-0026, `packages/core/src/delegation`): **one entry per change**, in the mailbox's account log,
target = the mailbox (label its address), meta `mailboxId`, `granteeUserId`, `grantee` (their sign-in address,
masked), `right` (`full_access`, `send_as`, `send_on_behalf`) and `reason`. `delegation.granted` reasons: `admin` (the
Delegation tab's batch), `member_removed` (the removal's "Give full access to …"), `converted_to_shared`.
`delegation.revoked` reasons: `admin`, `member_removed` (the person left: removed, or deleted their own login — then
written in each account they left), `mailbox_deleted` (the deletion was scheduled, or a purge found one left; a restore
doesn't bring them back), `became_owner` ("Make this a user"), `role_changed` (the mailbox's person became an Owner,
or a Member got an admin role — `changeMemberRole` or "Make this a user" with an admin role — and the grant wasn't
made by a current Owner; `account.role_changed` meta `grantsRevoked`). A batch is one mutation: its main entry is the first
change of its action (`delegation.granted` when it adds anyone, else `delegation.revoked`, meta `changes` = how many
changed) and every other change follows as its own entry in the same transaction (`MutationOutcome.also`); a batch where
nothing of the main action changed records `granted` / `revoked` counts on the main entry instead. Denied entries:
`forbidden` (no `delegation.manage.any`, or guard rail 8), `act_as`, `step_up_required`; `plan_limit`, `not_found` (a
person outside the account), `conflict` (own mailbox, limits, mailbox being deleted) and `bad_request` are `failed`.
**Convert to shared mailbox**: `mailbox.converted_to_shared` (target = the mailbox; meta `formerUserId`, `former`
masked, `status`, `appPasswordsRevoked`, `grants` — how many it wrote) plus one `delegation.granted` per grant; never the
generated password.
**Opening a delegated mailbox in the webmail** (ADR-0026 §6; `packages/core/src/webmail/delegation.ts`):
`delegation.mailbox_opened`, actor = the delegate (the person behind the webmail session's own mailbox, rebuilt from the
database), in **that person's own account** — every grant is within one account, so a success is also the mailbox's
account; target = the mailbox, labelled with its address only when it is in that account (an unknown address or another
account's mailbox is recorded with no target id or label, so another account's addresses never land here); meta `need`
(`full_access`, or `send` from the send path) and, on refusals, `reason` / `state`. `success`; `denied` with
`not_granted` (no right now, an unknown address, another account's, the plan without delegation, the person removed or
suspended, their own mailbox no longer theirs), `mailbox_unavailable` (a granted mailbox that is suspended, being
deleted or not on the mail server yet; meta `state`), `act_as` (the console session the webmail came from has staff
act-as open) or the matrix's `forbidden` (a suspended person); `failed` `unavailable` when the mail server refused the
credential twice (the reserved slot was held) or named another mailbox, `server_error` when it couldn't be reached.
Every refusal looks the same to the person (404). Never the tokens or the throwaway credential. The per-request gate
(`DelegationGate`) is a read and writes nothing.
**Sending from a delegated mailbox** (ADR-0026 §6, slice 13; `authorizeDelegatedSend` in the same file):
`delegation.sent_as` or `delegation.sent_on_behalf` (the right used; send as wins when both are held), written
**before any work in the shared mailbox** (no blob copied, no quota charged, nothing submitted), right after the right
was checked uncached under the account lock — if the append fails, nothing is done. Actor = the delegate (rebuilt from the database), in their account (the mailbox's); target =
the mailbox (label its address); meta `mailboxId`, `recipientCount` (envelope recipients, a number) and `need`
(`send`) — never recipient addresses, a subject, a Message-ID or content (rule 24). `denied` with `not_granted`,
`mailbox_unavailable` (meta `state`) or `act_as`, like the open; `failed` `unavailable` when the right changed between
the read and the lock ("try again"). The open a first delegated send needs is its own `delegation.mailbox_opened` with
meta `need: "send"`. What became of the send afterwards (`recordDelegatedSendOutcome`; same actor and target, meta
`mailboxId`): `delegation.send_failed` — nothing was submitted after all (meta `reason`, a short lowercase code from
the error kind: `quota`, `refused`, `unavailable`, `delegationrefused`…), written after the copies made for it were
destroyed, so a `sent_*` entry without a submission is always followed by one; `delegation.send_cancelled` — an undo in
the hold cancelled it (after the mail server cancelled it; retried once, and the undo answers an error if it still can't
be written); `delegation.tagged_copy_left` — sent, but the temporary copy holding the on-behalf tag couldn't be destroyed
(twice); its tag expires within minutes.

`identity.changed` is no longer written (since 2026-10-31): the sender name is the person's name or the mailbox's
display name, recorded as `account.profile_changed` or `mailbox.renamed`. It stays in the catalogue for older entries.

Profile details: `account.profile_changed` (target = the person, label their sign-in email; meta: `fields` — the names
of the optional profile fields that changed, and `name` when their name changed, never the values — and `self`; `via:
"webmail"` when the person changed their name as the sender name in their mailbox's webmail, whose actor is `system`
named after the mailbox). A name change also queues `mailbox.ensure` for each mailbox that follows the person (no
entry of its own: the job only mirrors it to the mail server). An admin's edit is written to that
account's log; the person's own edit from their Profile page is written to every account they belong to (the platform
log when they belong to none), so its admins see it. A User Administrator editing an admin's profile is `denied`
(`forbidden`); an admin editing someone who also belongs to another account is `denied` (`other_account`); staff
acting as someone are `denied` (`act_as`). From the webmail, a sender name an admin set is `denied` `admin_set`, a
person also in another account `other_account` and a mailbox whose person left its account `not_member`.

Webmail signatures (05-webmail.md "Signatures"), in the mailbox's account as a `system` actor named by the mailbox
address, target = the mailbox: `webmail.signature_added` (meta `signature` id, `bytes` of HTML, `images`, `signatures`
after the change, `madeDefault` for the mailbox's first one, `broughtOver` when the old single signature was brought
over), `webmail.signature_changed` (`signature`, `fields`: `name` and/or `content`, `bytes`/`images` for content),
`webmail.signature_removed` (`signature`, `wasDefaultNew`, `wasDefaultReply`), `webmail.signature_defaults_changed`
(`newMessage`, `reply`: whether each is set). Never a signature's name or content. A refusal (a taken name, too many,
another mailbox's id) is `failed` with its code. The `signature.changed` area stays reserved for admin templates.

Console → webmail handoff (ADR-0024; 05-webmail.md "Console handoff"), in the mailbox's account, target = the
mailbox (label its address once it is known to be the person's own): `webmail.handoff_started` when the console mints
the one-time code — `success`, or `denied` with `act_as`, `not_found` (someone else's, a shared, unassigned or unknown
mailbox; no label), `mailbox_unavailable` (meta `state` when the webmail access gate said so),
`password_change_required` or `step_up_required`, or the matrix's own refusal (Auditors and staff acting as someone:
`forbidden`, with `on_behalf_of`); and `webmail.handoff_redeemed` when the webmail origin redeems it — `success`,
`denied` with `wrong_browser` (no verifier or the wrong one; the code is used up), `expired`, `session_ended` (the
console session is gone or no longer meets a sign-in requirement; then the actor is `system` "webmail handoff" and meta
`userId` names the person), `act_as`, `not_found`, `mailbox_unavailable`, `password_change_required`,
`step_up_required`, or `failed` when the mail server refused or couldn't be reached. Never the code, the verifier, the
challenge or the throwaway credential. A code nobody knows (or one already used) writes no row: it names nobody
(rate-limited, logged).

Data export and account deletion (ADR-0025; `packages/core/src/data`). Exports: `data.export_requested` (the
requester; account exports in the account's log with the account as target, personal ones in the platform log with
the person as target, masked; meta `exportId`, `kind`; refusals `denied` `act_as` or the matrix's `forbidden` /
`not_found`), `data.export_ready` (system `data-export`; meta `kind`, `files`, `sizeBytes`, `attempt`; `failed`
`export_failed` after the last attempt), `data.export_downloaded` (the requester; meta `kind`, `sizeBytes`; `denied`
`step_up_required` / `act_as`; `failed` `not_found` for anyone else's id, `conflict` when not ready or expired) and
`data.export_expired` (system; platform log with `count`, plus a copy in each account whose export was deleted).
`data.mail_exported` is written as the mailbox (a `system` actor named by its address) in its account when a webmail
mail export ends (meta `scope` all/folder, `folders`, `messages`, `skipped`, `contacts`, `complete`; never folder
names or anything about the mail). Deletion: `data.deletion_requested` (Owner; meta `deleteAfter`, `graceDays`,
`mailboxesSuspended`, `invitesRevoked`, `catchAllOff`; `failed` `bad_request` without the exact name; `denied`
`step_up_required` / `act_as`), `data.deletion_cancelled` (meta `mailboxesResumed`, `mailboxesStillHeld`),
`data.deletion_started` (system `account-deletion` at the end of the grace period; meta `mailboxes`, `requestedAt`,
`deleteAfter`; `denied` `staff_hold` with meta `waitingFor`, at most once a day, while staff hold the account or one of
its mailboxes), then `platform.mailbox_purged` per mailbox (system `mailbox-purge`), `domain.removed` per domain
(system `account-deletion`, meta `reason: "account_deleted"`, `from`) and `account.deleted` (meta `people`, `plan`).
Each deletion entry is in the account's log and copied to the platform log. The account's log stays after the account
is gone (no foreign key; append-only), retained as the table below says. A person deleting their own console login:
`auth.login_deleted` in the platform log (target the person, label masked; meta `accountsDeleted`, `accountsLeft`;
`denied` `act_as`, `step_up_required`, `staff`, `mailboxes`, `sole_owner`, `deleting`; `failed` `bad_request` without
the typed address), copied to each account they left (`left: true`) or that went with them (`accountDeleted: true`).
`data.deleted` stays reserved.

Profile photos (ADR-0022): `account.avatar_changed` / `account.avatar_removed` for a person (target = the person, label
their sign-in email) and `mailbox.avatar_changed` / `mailbox.avatar_removed` for a mailbox without a person (target =
the mailbox, label its address). Meta: `bytes` (the stored size), `self`, `via: "webmail"` for a change from the
webmail, `removed` for a removal (false when there was none) — never the image, its hash or anything read from it. The
person's own change (console Profile page, their own panel, or their mailbox's webmail, whose actor is `system` named
after the mailbox) is copied to each account they belong to; an admin's is written to that account's log. Refusals
follow the profile rule (`denied`: `forbidden`, `other_account`); from the webmail, a person who is also in another
account is `denied` `other_account` and a mailbox whose person left its account `denied` `not_member`; a file that
isn't a usable image is `failed` (`bad_request`).

People: `account.invite_sent`, `account.invite_resent`, `account.invite_revoked` (target label = the invited
address, meta = role; never the token), `account.invite_accepted` (meta: role, `newLogin`, the user id; the actor is
the signed-in person, or `system`/`invite` when the link created the login), `account.role_changed` (meta:
`previousRole`, `newRole` — `from`/`to` are redacted keys) and `account.member_removed` (meta: role, how many of their
mailboxes became unassigned, `mailboxesSignedOut` — mailboxes given a new generated password so the person's sign-in
is off, never the password — `appPasswordsRevoked`, `grantsRevoked` — the delegation grants they held, each also its
own `delegation.revoked` entry — and `delegated`, how many grants the removal's "Give full access to …" wrote, each a
`delegation.granted` entry). A User Administrator's attempt on an Owner, an admin or an admin-role invite is recorded as
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

Staff support access (act-as, ADR-0023; roles.md guard rail 4): `staff.act_as_started` (meta `reason` — the staff
member's own words, shown to the account's admins —, `minutes`, `access: "read_only"`, `actAsSessionId`),
`staff.act_as_renewed` (`reason`, `until`, `actAsSessionId`) and `staff.act_as_ended` (`ended`: `staff`, `expired`,
`signed_out`, `role_removed` or `staff_account` — someone in the account became staff meanwhile; `minutes`; for the scheduler's entries also `staff` — the staff email — and
`staffRole`), each in the **account's log** with a copy in the **platform** log (target `account`, label the account
name). Start is a staff path; renew and end are by the acting staff member; expiry, sign-out and a removed role are
closed by the `act-as-expiry` job as a `system` actor. Refusals are `denied`: `not_found` and `forbidden` before the
account is known (platform log only), `step_up_required`, `staff_account` (someone in the account holds a staff role
or a company address, rule 28) and `act_as` (already acting); a suspended account or a second open session is
`failed` `conflict`. A reason that fails validation is refused before anything is recorded. Profile and photo changes
while acting, the staff member's own included, are `denied` `act_as` (`account.profile_changed`,
`account.avatar_changed`, `account.avatar_removed`), so no edit of theirs lands in the customer's log. The staff
member's email is shown to the account's admins on these entries (ADR-0023, rule 49). **Everything done while
acting** — every service call that writes, and every refusal — carries `on_behalf_of` and actor type `staff`, so the
"Anhourtec staff" filter and `describeActor` ("Anhourtec staff · Support access · <role> · <email>") show it to the
account's admins (rule 49). Reads aren't audited one by one, like every other read.

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

Columns as in `packages/adapters/src/db-postgres/schema.ts` (`audit_log`):

| Field                                                         | Notes                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`, `seq`, `scope`                                          | `scope` = `account:<id>` or `platform`; `seq` increases per scope (unique `scope, seq`)                 |
| `at`                                                          | UTC                                                                                                     |
| `actor_type`                                                  | `user` / `staff` / `system` / `anonymous` (`api_token` reserved for API tokens, not built)              |
| `actor_user_id`, `actor_email`, `actor_role`, `actor_account_id` | Snapshots keep entries readable after deletion; a system actor's name is in `actor_email`            |
| `on_behalf_of`                                                | JSON `{ userId, email, accountId, sessionId }` during staff act-as: the staff member, the account they act in and the act-as session id; the actor is then `staff` with the platform role (`auditActor`, `packages/core/src/audit/record.ts`; ADR-0023) |
| `action`                                                      | From the catalogue                                                                                      |
| `target_type`, `target_id`, `target_label`                    | e.g. `domain`, id, `example.com`                                                                        |
| `result`, `error_code`                                        | `success` / `denied` / `failed`                                                                         |
| `request_id`, `ip`, `user_agent`                              | From the request context; IP is stored as-is for 1 year, then truncated (/24, /48)                      |
| `meta`                                                        | JSON, redacted; before/after values for changes                                                         |
| `prev_hash`, `hash`                                           | Chain (below)                                                                                           |

## Never in audit

Mail content, subjects, bodies, previews, attachments, recipient lists, passwords, tokens, secrets, keys, OTP codes and full payment details. `mutation()` (`packages/core/src/mutation.ts`) passes `meta` through `redactMeta()`, which uses the **same redaction list as the logger** (`packages/server/src/log.ts` `REDACT_KEYS`), and unit tests assert it (rule 48).

## Integrity

- **Same unit of work:** the audit row is written in the same transaction as the change. If the audit write fails, the change fails. Denied attempts are written on their own (no change to roll back).
- **Append-only:** migration 0001 adds triggers on `audit_log` that refuse `UPDATE`, `DELETE` and `TRUNCATE` for every role, owner included. No repository method updates or deletes audit rows (rule 47; `check:audit` fails on one).
- **Hash chain per scope:** `hash = sha256(prev_hash ‖ canonical_json(entry without hash))`. `prev_hash` of the first entry is a fixed genesis value. Writes take a per-scope advisory lock to read the previous hash.
- **Verification:** the scheduler job `audit-verify` (`apps/worker/src/jobs/audit-verify.ts`, every 6 hours) walks every scope's chain (`verifyAuditScope`). A break is logged at `fatal` and the job exits non-zero; `platform.audit_chain_broken` is catalogued for it and the alert channel arrives with monitoring (`09-roadmap.md` "Path to production").
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
- `scripts/check-audit.mjs` (pre-commit + CI) fails when a `packages/core/src/**/service.ts` file writes through a repository without `mutation(`, when anything but `mutation.ts` calls `audit.append`, when a `mutation(` action is missing from `audit/catalogue.ts` or this file, when an adapter adds an update/delete path for audit rows, and when the generated event table above is stale.
