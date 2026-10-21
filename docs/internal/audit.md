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
| `auth` | `auth.sign_in`, `auth.sign_in_failed`, `auth.sign_out`, `auth.password_changed`, `auth.password_reset`, `auth.password_reset_requested`, `auth.two_factor_enabled`, `auth.two_factor_disabled`, `auth.app_password_created`, `auth.app_password_revoked`, `auth.session_revoked`, `auth.locked_out`, `auth.mail_client_sign_in`, `auth.mail_client_sign_in_failed`, `auth.two_factor_reset`, `auth.backup_code_used`, `auth.sessions_revoked_all`, `auth.new_device` |
| `account` | `account.created`, `account.deleted`, `account.updated`, `account.invite_sent`, `account.invite_accepted`, `account.member_added`, `account.member_removed`, `account.role_changed`, `account.ownership_transferred` |
| `domain` | `domain.added`, `domain.verified`, `domain.verify_failed`, `domain.removed`, `domain.dns_state_changed` |
| `mailbox` | `mailbox.created`, `mailbox.suspended`, `mailbox.unsuspended`, `mailbox.deleted`, `mailbox.quota_changed` |
| `alias` | `alias.created`, `alias.toggled`, `alias.deleted` |
| `masked_alias` | `masked_alias.created`, `masked_alias.toggled`, `masked_alias.deleted` |
| `catch_all` | `catch_all.changed` |
| `forwarding` | `forwarding.changed` |
| `sieve` | `sieve.changed` |
| `vacation` | `vacation.changed` |
| `billing` | `billing.plan_changed`, `billing.payment_succeeded`, `billing.payment_failed`, `billing.refunded`, `billing.suspended`, `billing.reactivated` |
| `trust` | `trust.tier_changed`, `trust.limits_changed`, `trust.restricted`, `trust.suspended`, `trust.unsuspended` |
| `abuse` | `abuse.report_received`, `abuse.report_resolved` |
| `staff` | `staff.role_granted`, `staff.role_revoked`, `staff.act_as_started`, `staff.act_as_ended`, `staff.account_viewed`, `staff.credentials_reset` |
| `data` | `data.export_requested`, `data.export_downloaded`, `data.import_started`, `data.import_finished`, `data.deletion_requested`, `data.deleted` |
| `platform` | `platform.settings_changed`, `platform.secret_changed`, `platform.stalwart_upgraded`, `platform.provisioning_failed`, `platform.reconciler_drift`, `platform.audit_chain_broken` |
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
| `waitlist` | `waitlist.joined`, `waitlist.invited`, `waitlist.confirmed` |
| `invite` | `invite.created`, `invite.redeemed`, `invite.revoked` |

<!-- END generated: audit actions -->

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

Stalwart Community has an **`x:WebHook`** object (event notifications). Plan, to be prototyped in Phase 1 (`09-roadmap.md`):

- Configure a WebHook to post auth and delivery events to the worker's internal endpoint (internal network, HMAC-signed).
- The worker maps protocol auth events to `mailauth.*` audit entries (actor = the mailbox's owning user) and delivery events to `mail_flow_event`.
- Delivery history and live telemetry are Enterprise-only, so the WebHook is the Community path. If its event coverage is incomplete, fall back to parsing Stalwart's console tracer output in the worker.

## Testing

- The RBAC harness asserts that every mutating route and server action writes the expected entry (action, actor, target, result), including **denied** attempts.
- Unit tests cover redaction, canonical JSON, hash chaining (tamper detection), snapshots and act-as attribution.
- `scripts/check-audit.mjs` (pre-commit + CI) fails when a service mutation (a function under `packages/core/src/**/service.ts` whose name starts with a mutating verb, or that is marked `@mutation`) has no `recordAudit` / `withAudit` call.
