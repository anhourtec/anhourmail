// SPDX-License-Identifier: AGPL-3.0-only
import type { Permission } from "@anhourmail/shared/rbac";

/**
 * Every API route and the permission that guards it. The RBAC harness (scripts/rbac-e2e.ts) derives its
 * expectations from this table plus the permission matrix, and fails if an `app/api/.../route.ts` file is
 * missing here (CLAUDE.md rule 35).
 *
 * `guard`: "public" (anyone), "session" (any signed-in person), "webmail" (a webmail session on the webmail origin —
 * a console session never grants it), "act_as" (a staff member with support access open: 404 for everyone else
 * signed in, ADR-0023), or a permission from the matrix.
 * `accountParam`: the path parameter holding the account id, for account-scoped permissions.
 */
export type RouteSpec = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  file: string;
  guard: "public" | "session" | "webmail" | "infra" | "act_as" | Permission;
  accountParam?: string;
  /** Audit action written by a mutating route (asserted by the harness). */
  audits?: string;
  /**
   * What an ALLOWED caller gets for the harness's probe request when it can't be a real success (e.g. a random
   * subject id → 404, a junk token → 400). Denied callers still get 401/403/404 from the matrix.
   */
  probeStatus?: number;
  /**
   * Refused (403, audited as denied `act_as`) for staff with support access open, though the acting role holds the
   * permission: the staff member's own profile and photo (ADR-0023).
   */
  refusedWhileActing?: true;
};

export const ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: "/api/health", file: "app/api/health/route.ts", guard: "infra" },
  { method: "GET", path: "/api/health/ready", file: "app/api/health/ready/route.ts", guard: "infra" },
  { method: "GET", path: "/api/auth/*", file: "app/api/auth/[...all]/route.ts", guard: "infra" },
  { method: "GET", path: "/api/me", file: "app/api/me/route.ts", guard: "session" },
  // The person's own sign-in security (packages/core/src/security). Someone else's ids are a 404.
  { method: "GET", path: "/api/me/security", file: "app/api/me/security/route.ts", guard: "self.security.manage" },
  // The person's own optional profile details (packages/core/src/people/profile-service.ts).
  {
    method: "PUT",
    path: "/api/me/profile",
    file: "app/api/me/profile/route.ts",
    guard: "self.profile.manage",
    audits: "account.profile_changed",
    refusedWhileActing: true,
  },
  // The person's own profile photo (packages/core/src/avatars, ADR-0022). The harness's empty body isn't an image (400).
  { method: "GET", path: "/api/me/avatar", file: "app/api/me/avatar/route.ts", guard: "self.profile.read" },
  {
    method: "POST",
    path: "/api/me/avatar",
    file: "app/api/me/avatar/route.ts",
    guard: "self.profile.manage",
    audits: "account.avatar_changed",
    probeStatus: 400,
    refusedWhileActing: true,
  },
  {
    method: "DELETE",
    path: "/api/me/avatar",
    file: "app/api/me/avatar/route.ts",
    guard: "self.profile.manage",
    audits: "account.avatar_removed",
    refusedWhileActing: true,
  },
  // A profile photo on the console origin: any signed-in person may ask; the service then answers 404 unless they may
  // see that person or mailbox (the harness's random ids are 404 for everyone signed in).
  {
    method: "GET",
    path: "/api/avatars/:kind/:id",
    file: "app/api/avatars/[kind]/[id]/route.ts",
    guard: "self.profile.read",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/me/sessions",
    file: "app/api/me/sessions/route.ts",
    guard: "self.security.manage",
    audits: "auth.sessions_revoked_all",
  },
  {
    method: "DELETE",
    path: "/api/me/sessions/:sessionId",
    file: "app/api/me/sessions/[sessionId]/route.ts",
    guard: "self.security.manage",
    probeStatus: 404,
  },
  {
    method: "PATCH",
    path: "/api/me/passkeys/:passkeyId",
    file: "app/api/me/passkeys/[passkeyId]/route.ts",
    guard: "self.security.manage",
    // The harness sends no name: allowed callers get a validation error.
    probeStatus: 400,
  },
  {
    method: "DELETE",
    path: "/api/me/passkeys/:passkeyId",
    file: "app/api/me/passkeys/[passkeyId]/route.ts",
    guard: "self.security.manage",
    probeStatus: 404,
  },
  // "Send the confirmation link again" to the signed-in person's own address (already confirmed → 200, nothing sent).
  {
    method: "POST",
    path: "/api/me/email-verification",
    file: "app/api/me/email-verification/route.ts",
    guard: "session",
  },
  { method: "GET", path: "/api/search", file: "app/api/search/route.ts", guard: "session" },
  { method: "GET", path: "/api/platform/audit", file: "app/api/platform/audit/route.ts", guard: "platform.audit.read" },
  {
    method: "GET",
    path: "/api/accounts/:accountId/audit",
    file: "app/api/accounts/[accountId]/audit/route.ts",
    guard: "audit.read",
    accountParam: "accountId",
  },
  {
    method: "GET",
    path: "/api/accounts/:accountId/domains",
    file: "app/api/accounts/[accountId]/domains/route.ts",
    guard: "domain.read",
    accountParam: "accountId",
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/domains",
    file: "app/api/accounts/[accountId]/domains/route.ts",
    guard: "domain.manage",
    accountParam: "accountId",
    // The harness sends no domain name: allowed callers get a validation error.
    probeStatus: 400,
  },
  {
    method: "GET",
    path: "/api/accounts/:accountId/domains/:domainId",
    file: "app/api/accounts/[accountId]/domains/[domainId]/route.ts",
    guard: "domain.read",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/domains/:domainId",
    file: "app/api/accounts/[accountId]/domains/[domainId]/route.ts",
    guard: "domain.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/domains/:domainId/check",
    file: "app/api/accounts/[accountId]/domains/[domainId]/check/route.ts",
    guard: "domain.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "PUT",
    path: "/api/accounts/:accountId/domains/:domainId/catch-all",
    file: "app/api/accounts/[accountId]/domains/[domainId]/catch-all/route.ts",
    guard: "domain.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "GET",
    path: "/api/accounts/:accountId/mailboxes",
    file: "app/api/accounts/[accountId]/mailboxes/route.ts",
    guard: "mailbox.read",
    accountParam: "accountId",
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes",
    file: "app/api/accounts/[accountId]/mailboxes/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    // The harness sends no address: allowed callers get a validation error.
    probeStatus: 400,
  },
  // "Add a user": a mailbox plus a console login with a role, in one step (packages/core/src/mailboxes/add-user.ts).
  {
    method: "POST",
    path: "/api/accounts/:accountId/users",
    file: "app/api/accounts/[accountId]/users/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    audits: "account.user_added",
    // The harness sends no names: allowed callers get a validation error.
    probeStatus: 400,
  },
  // "Edit name": the mailbox's display name (sender name). Random ids → 404 for allowed callers.
  {
    method: "PUT",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/name",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/name/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  // The photo of a mailbox without a person (core avatars/service.ts). Random ids → 404 for allowed callers.
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/avatar",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/avatar/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/avatar",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/avatar/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  // "Make this a user": a person-less mailbox becomes a person who signs in with it (core mailboxes/make-user.ts).
  // Random ids → 404 for allowed callers.
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/user",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/user/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  // Mailbox delegation (ADR-0026; core delegation/service.ts). Random ids → 404 for allowed readers; the harness's
  // empty batch is a validation error (400) for allowed callers, reached only after the permission and act-as checks.
  // Its audit action depends on the batch (`delegation.granted` or `delegation.revoked`), so none is asserted here.
  {
    method: "GET",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/delegation",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/delegation/route.ts",
    guard: "delegation.read",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "PATCH",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/delegation",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/delegation/route.ts",
    guard: "delegation.manage.any",
    accountParam: "accountId",
    probeStatus: 400,
  },
  // "Convert to shared mailbox" (core mailboxes/convert-to-shared.ts): giving people access in the same request also
  // needs delegation.manage.any (checked in the service). Random ids → 404 for allowed callers.
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/convert-to-shared",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/convert-to-shared/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    audits: "mailbox.converted_to_shared",
    probeStatus: 404,
  },
  // Free platform-domain addresses (ADR-0021): is a name available (no name → the rule it breaks, 200).
  {
    method: "GET",
    path: "/api/accounts/:accountId/mailboxes/platform-address",
    file: "app/api/accounts/[accountId]/mailboxes/platform-address/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
  },
  {
    method: "GET",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/route.ts",
    guard: "mailbox.read",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "PATCH",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/suspend",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/suspend/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/resume",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/resume/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/restore",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/restore/route.ts",
    guard: "mailbox.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  // Mailbox passwords (07-security.md "Mailbox passwords"): an admin's reset needs its own critical permission.
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/password",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/password/route.ts",
    guard: "mailbox.password.reset",
    accountParam: "accountId",
    probeStatus: 404,
  },
  // App passwords (docs/internal/07-security.md "App passwords"): own mailboxes; others' are read with mailbox.read
  // and revoked with mailbox.manage, which every holder pairs with app_password.manage.own.
  {
    method: "GET",
    path: "/api/accounts/:accountId/app-passwords",
    file: "app/api/accounts/[accountId]/app-passwords/route.ts",
    guard: "app_password.manage.own",
    accountParam: "accountId",
  },
  // Console → webmail handoff, step 2 (ADR-0024): one's own mailbox only; the harness's random id is a 404 for anyone
  // allowed. Staff acting as someone hold Auditor there, which doesn't have the permission (403).
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/webmail-handoff",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/webmail-handoff/route.ts",
    guard: "webmail.open.own",
    accountParam: "accountId",
    audits: "webmail.handoff_started",
    probeStatus: 404,
  },
  {
    method: "GET",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/app-passwords",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/app-passwords/route.ts",
    guard: "mailbox.read",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/app-passwords",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/app-passwords/route.ts",
    guard: "app_password.manage.own",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/app-passwords",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/app-passwords/route.ts",
    guard: "app_password.manage.own",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/mailboxes/:mailboxId/app-passwords/:appPasswordId",
    file: "app/api/accounts/[accountId]/mailboxes/[mailboxId]/app-passwords/[appPasswordId]/route.ts",
    guard: "app_password.manage.own",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "GET",
    path: "/api/accounts/:accountId/aliases",
    file: "app/api/accounts/[accountId]/aliases/route.ts",
    guard: "alias.manage.own",
    accountParam: "accountId",
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/aliases",
    file: "app/api/accounts/[accountId]/aliases/route.ts",
    guard: "alias.manage.own",
    accountParam: "accountId",
    // The harness sends no mailbox: allowed callers get a validation error.
    probeStatus: 400,
  },
  {
    method: "PATCH",
    path: "/api/accounts/:accountId/aliases/:aliasId",
    file: "app/api/accounts/[accountId]/aliases/[aliasId]/route.ts",
    guard: "alias.manage.own",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/aliases/:aliasId",
    file: "app/api/accounts/[accountId]/aliases/[aliasId]/route.ts",
    guard: "alias.manage.own",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "PUT",
    path: "/api/accounts/:accountId/sign-in-policy",
    file: "app/api/accounts/[accountId]/sign-in-policy/route.ts",
    guard: "account.security.manage",
    accountParam: "accountId",
    // The harness sends no policy: allowed callers get a validation error.
    probeStatus: 400,
  },
  // People and roles (roles.md guard rails; packages/core/src/people).
  {
    method: "GET",
    path: "/api/accounts/:accountId/people",
    file: "app/api/accounts/[accountId]/people/route.ts",
    guard: "member.read",
    accountParam: "accountId",
  },
  {
    method: "PATCH",
    path: "/api/accounts/:accountId/people/:userId",
    file: "app/api/accounts/[accountId]/people/[userId]/route.ts",
    guard: "account.admins.manage",
    accountParam: "accountId",
    audits: "account.role_changed",
    probeStatus: 404,
  },
  // "Mailboxes they can open" on a person's panel (ADR-0026 §5). Random ids → 404 for allowed readers.
  {
    method: "GET",
    path: "/api/accounts/:accountId/people/:userId/delegation",
    file: "app/api/accounts/[accountId]/people/[userId]/delegation/route.ts",
    guard: "delegation.read",
    accountParam: "accountId",
    probeStatus: 404,
  },
  // "Edit profile" on a person's panel: a Member's with member.manage, anyone's for an Owner (and your own always,
  // which the harness's random id can't be). Random ids → 404 for allowed callers.
  {
    method: "PUT",
    path: "/api/accounts/:accountId/people/:userId/profile",
    file: "app/api/accounts/[accountId]/people/[userId]/profile/route.ts",
    guard: "member.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  // A person's photo on their panel: the "Edit profile" rule (core avatars/service.ts). Random ids → 404 when allowed.
  {
    method: "POST",
    path: "/api/accounts/:accountId/people/:userId/avatar",
    file: "app/api/accounts/[accountId]/people/[userId]/avatar/route.ts",
    guard: "member.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/people/:userId/avatar",
    file: "app/api/accounts/[accountId]/people/[userId]/avatar/route.ts",
    guard: "member.manage",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/people/:userId",
    file: "app/api/accounts/[accountId]/people/[userId]/route.ts",
    guard: "member.manage",
    accountParam: "accountId",
    audits: "account.member_removed",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/invites",
    file: "app/api/accounts/[accountId]/invites/route.ts",
    guard: "member.manage",
    accountParam: "accountId",
    audits: "account.invite_sent",
    // The harness sends no email address: allowed callers get a validation error.
    probeStatus: 400,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/invites/:inviteId",
    file: "app/api/accounts/[accountId]/invites/[inviteId]/route.ts",
    guard: "member.manage",
    accountParam: "accountId",
    audits: "account.invite_revoked",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/invites/:inviteId/resend",
    file: "app/api/accounts/[accountId]/invites/[inviteId]/resend/route.ts",
    guard: "member.manage",
    accountParam: "accountId",
    audits: "account.invite_resent",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/invites/accept",
    file: "app/api/invites/accept/route.ts",
    guard: "public",
    audits: "account.invite_accepted",
    // The harness sends no token: everyone gets a validation error.
    probeStatus: 400,
  },
  // Staff: customer accounts (metadata only; opening one is audited in that account's log).
  {
    method: "GET",
    path: "/api/platform/accounts",
    file: "app/api/platform/accounts/route.ts",
    guard: "platform.accounts.read",
  },
  {
    method: "GET",
    path: "/api/platform/accounts/:accountId",
    file: "app/api/platform/accounts/[accountId]/route.ts",
    guard: "platform.accounts.read",
    audits: "staff.account_viewed",
    probeStatus: 404,
  },
  // Staff create a free platform-domain address in a customer account (no password; audited in that account's log).
  {
    method: "POST",
    path: "/api/platform/accounts/:accountId/mailboxes",
    file: "app/api/platform/accounts/[accountId]/mailboxes/route.ts",
    guard: "platform.mailbox.create",
    accountParam: "accountId",
    // The harness sends no address: allowed callers get a validation error.
    probeStatus: 400,
  },
  // Staff support access (ADR-0023): start from Platform → account (fresh step-up; the harness's random id → 404),
  // then renew or end it while it is open (everyone else signed in: 404). The harness's empty body has no reason: 400.
  {
    method: "POST",
    path: "/api/platform/accounts/:accountId/act-as",
    file: "app/api/platform/accounts/[accountId]/act-as/route.ts",
    guard: "platform.accounts.actAs",
    audits: "staff.act_as_started",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/me/act-as/renew",
    file: "app/api/me/act-as/renew/route.ts",
    guard: "act_as",
    probeStatus: 400,
  },
  {
    method: "DELETE",
    path: "/api/me/act-as",
    file: "app/api/me/act-as/route.ts",
    guard: "act_as",
    audits: "staff.act_as_ended",
  },
  // Data export and account deletion (ADR-0025). Export requests create a queued export (202); downloads probe a random
  // id (404). Deletion with the harness's empty body has no typed name (400); cancelling with none pending is a 409.
  {
    method: "GET",
    path: "/api/accounts/:accountId/exports",
    file: "app/api/accounts/[accountId]/exports/route.ts",
    guard: "account.export",
    accountParam: "accountId",
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/exports",
    file: "app/api/accounts/[accountId]/exports/route.ts",
    guard: "account.export",
    accountParam: "accountId",
    audits: "data.export_requested",
  },
  {
    method: "GET",
    path: "/api/accounts/:accountId/exports/:exportId",
    file: "app/api/accounts/[accountId]/exports/[exportId]/route.ts",
    guard: "account.export",
    accountParam: "accountId",
    probeStatus: 404,
  },
  {
    method: "GET",
    path: "/api/me/exports",
    file: "app/api/me/exports/route.ts",
    guard: "self.data.export",
    refusedWhileActing: true,
  },
  {
    method: "POST",
    path: "/api/me/exports",
    file: "app/api/me/exports/route.ts",
    guard: "self.data.export",
    audits: "data.export_requested",
    refusedWhileActing: true,
  },
  {
    method: "GET",
    path: "/api/me/exports/:exportId",
    file: "app/api/me/exports/[exportId]/route.ts",
    guard: "self.data.export",
    probeStatus: 404,
  },
  {
    method: "GET",
    path: "/api/accounts/:accountId/deletion",
    file: "app/api/accounts/[accountId]/deletion/route.ts",
    guard: "account.read",
    accountParam: "accountId",
  },
  {
    method: "POST",
    path: "/api/accounts/:accountId/deletion",
    file: "app/api/accounts/[accountId]/deletion/route.ts",
    guard: "account.delete",
    accountParam: "accountId",
    probeStatus: 400,
  },
  {
    method: "DELETE",
    path: "/api/accounts/:accountId/deletion",
    file: "app/api/accounts/[accountId]/deletion/route.ts",
    guard: "account.delete",
    accountParam: "accountId",
    probeStatus: 409,
  },
  {
    method: "GET",
    path: "/api/me/login",
    file: "app/api/me/login/route.ts",
    guard: "self.login.delete",
    refusedWhileActing: true,
  },
  {
    method: "DELETE",
    path: "/api/me/login",
    file: "app/api/me/login/route.ts",
    guard: "self.login.delete",
    audits: "auth.login_deleted",
    probeStatus: 400,
    refusedWhileActing: true,
  },
  {
    method: "GET",
    path: "/api/platform/deletions",
    file: "app/api/platform/deletions/route.ts",
    guard: "platform.deletions.read",
  },
  // Staff suspension (Global Administrator; fresh step-up). The harness probes random ids: allowed callers get 404.
  {
    method: "POST",
    path: "/api/platform/accounts/:accountId/suspension",
    file: "app/api/platform/accounts/[accountId]/suspension/route.ts",
    guard: "platform.account.suspend",
    audits: "trust.suspended",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/platform/accounts/:accountId/suspension",
    file: "app/api/platform/accounts/[accountId]/suspension/route.ts",
    guard: "platform.account.suspend",
    audits: "trust.unsuspended",
    probeStatus: 404,
  },
  {
    method: "POST",
    path: "/api/platform/people/:userId/suspension",
    file: "app/api/platform/people/[userId]/suspension/route.ts",
    guard: "platform.account.suspend",
    audits: "trust.suspended",
    probeStatus: 404,
  },
  {
    method: "DELETE",
    path: "/api/platform/people/:userId/suspension",
    file: "app/api/platform/people/[userId]/suspension/route.ts",
    guard: "platform.account.suspend",
    audits: "trust.unsuspended",
    probeStatus: 404,
  },
  // Webmail BFF (ADR-0003, ADR-0018): served on the webmail origin only (host-routing.ts).
  {
    method: "POST",
    path: "/api/webmail/auth",
    file: "app/api/webmail/auth/route.ts",
    guard: "public",
    // The harness sends no address: everyone gets a validation error.
    probeStatus: 400,
  },
  { method: "DELETE", path: "/api/webmail/auth", file: "app/api/webmail/auth/route.ts", guard: "public" },
  // Console → webmail handoff (ADR-0024), webmail origin: the start sets the verifier cookie and redirects to the
  // console page (the harness follows it to a 200 page); the redemption without a code is a validation error.
  { method: "GET", path: "/api/webmail/handoff", file: "app/api/webmail/handoff/route.ts", guard: "public" },
  {
    method: "POST",
    path: "/api/webmail/handoff",
    file: "app/api/webmail/handoff/route.ts",
    guard: "public",
    probeStatus: 400,
  },
  { method: "GET", path: "/api/webmail/session", file: "app/api/webmail/session/route.ts", guard: "webmail" },
  { method: "POST", path: "/api/webmail/jmap", file: "app/api/webmail/jmap/route.ts", guard: "webmail" },
  {
    method: "GET",
    path: "/api/webmail/messages/:emailId",
    file: "app/api/webmail/messages/[emailId]/route.ts",
    guard: "webmail",
  },
  {
    method: "GET",
    path: "/api/webmail/download/:blobId",
    file: "app/api/webmail/download/[blobId]/route.ts",
    guard: "webmail",
  },
  { method: "PUT", path: "/api/webmail/drafts", file: "app/api/webmail/drafts/route.ts", guard: "webmail" },
  { method: "GET", path: "/api/webmail/contacts", file: "app/api/webmail/contacts/route.ts", guard: "webmail" },
  { method: "POST", path: "/api/webmail/contacts", file: "app/api/webmail/contacts/route.ts", guard: "webmail" },
  { method: "DELETE", path: "/api/webmail/contacts", file: "app/api/webmail/contacts/route.ts", guard: "webmail" },
  {
    method: "PATCH",
    path: "/api/webmail/contacts/:contactId",
    file: "app/api/webmail/contacts/[contactId]/route.ts",
    guard: "webmail",
  },
  {
    method: "POST",
    path: "/api/webmail/contacts/move",
    file: "app/api/webmail/contacts/move/route.ts",
    guard: "webmail",
  },
  {
    method: "PUT",
    path: "/api/webmail/contacts/settings",
    file: "app/api/webmail/contacts/settings/route.ts",
    guard: "webmail",
  },
  {
    method: "POST",
    path: "/api/webmail/contacts/import",
    file: "app/api/webmail/contacts/import/route.ts",
    guard: "webmail",
  },
  {
    method: "GET",
    path: "/api/webmail/contacts/export",
    file: "app/api/webmail/contacts/export/route.ts",
    guard: "webmail",
  },
  // Mail export (ADR-0025): the signed-in mailbox's folders as mbox files and its contacts, streamed, never stored.
  { method: "GET", path: "/api/webmail/export", file: "app/api/webmail/export/route.ts", guard: "webmail" },
  {
    method: "GET",
    path: "/api/webmail/messages/:emailId/attached/:blobId",
    file: "app/api/webmail/messages/[emailId]/attached/[blobId]/route.ts",
    guard: "webmail",
  },
  {
    method: "GET",
    path: "/api/webmail/messages/:emailId/raw",
    file: "app/api/webmail/messages/[emailId]/raw/route.ts",
    guard: "webmail",
  },
  {
    method: "GET",
    path: "/api/webmail/messages/:emailId/print",
    file: "app/api/webmail/messages/[emailId]/print/route.ts",
    guard: "webmail",
  },
  { method: "POST", path: "/api/webmail/img", file: "app/api/webmail/img/route.ts", guard: "webmail" },
  {
    method: "GET",
    path: "/api/webmail/preview/:blobId",
    file: "app/api/webmail/preview/[blobId]/route.ts",
    guard: "webmail",
  },
  { method: "POST", path: "/api/webmail/send", file: "app/api/webmail/send/route.ts", guard: "webmail" },
  { method: "POST", path: "/api/webmail/send/undo", file: "app/api/webmail/send/undo/route.ts", guard: "webmail" },
  { method: "POST", path: "/api/webmail/upload", file: "app/api/webmail/upload/route.ts", guard: "webmail" },
  { method: "GET", path: "/api/webmail/identities", file: "app/api/webmail/identities/route.ts", guard: "webmail" },
  { method: "GET", path: "/api/webmail/senders", file: "app/api/webmail/senders/route.ts", guard: "webmail" },
  { method: "GET", path: "/api/webmail/mailboxes", file: "app/api/webmail/mailboxes/route.ts", guard: "webmail" },
  { method: "POST", path: "/api/webmail/mailboxes", file: "app/api/webmail/mailboxes/route.ts", guard: "webmail" },
  {
    method: "PUT",
    path: "/api/webmail/mailboxes/active",
    file: "app/api/webmail/mailboxes/active/route.ts",
    guard: "webmail",
  },
  // Open a mailbox shared with the person (ADR-0026 §6): the grant is the authorisation, checked by core; every
  // refusal is the same 404, audited in the person's own account.
  {
    method: "POST",
    path: "/api/webmail/mailboxes/delegated",
    file: "app/api/webmail/mailboxes/delegated/route.ts",
    guard: "webmail",
  },
  // Profile photos in the webmail (ADR-0022): the session's mailboxes' photos, lookups and images (same account only).
  { method: "GET", path: "/api/webmail/avatars", file: "app/api/webmail/avatars/route.ts", guard: "webmail" },
  {
    method: "POST",
    path: "/api/webmail/avatars/lookup",
    file: "app/api/webmail/avatars/lookup/route.ts",
    guard: "webmail",
  },
  {
    method: "GET",
    path: "/api/webmail/avatars/:kind/:id",
    file: "app/api/webmail/avatars/[kind]/[id]/route.ts",
    guard: "webmail",
  },
  // Webmail settings (docs/internal/05-webmail.md "Settings"): the session's own mailbox only.
  { method: "GET", path: "/api/webmail/settings", file: "app/api/webmail/settings/route.ts", guard: "webmail" },
  {
    method: "POST",
    path: "/api/webmail/settings/password",
    file: "app/api/webmail/settings/password/route.ts",
    guard: "webmail",
  },
  {
    method: "PATCH",
    path: "/api/webmail/settings/preferences",
    file: "app/api/webmail/settings/preferences/route.ts",
    guard: "webmail",
  },
  {
    method: "POST",
    path: "/api/webmail/settings/avatar",
    file: "app/api/webmail/settings/avatar/route.ts",
    guard: "webmail",
  },
  {
    method: "DELETE",
    path: "/api/webmail/settings/avatar",
    file: "app/api/webmail/settings/avatar/route.ts",
    guard: "webmail",
  },
  {
    method: "PUT",
    path: "/api/webmail/settings/sender-name",
    file: "app/api/webmail/settings/sender-name/route.ts",
    guard: "webmail",
  },
  // Named signatures and their defaults (docs/internal/05-webmail.md "Signatures"): the session's own mailbox only.
  {
    method: "GET",
    path: "/api/webmail/settings/signatures",
    file: "app/api/webmail/settings/signatures/route.ts",
    guard: "webmail",
  },
  {
    method: "POST",
    path: "/api/webmail/settings/signatures",
    file: "app/api/webmail/settings/signatures/route.ts",
    guard: "webmail",
  },
  {
    method: "PATCH",
    path: "/api/webmail/settings/signatures/:signatureId",
    file: "app/api/webmail/settings/signatures/[signatureId]/route.ts",
    guard: "webmail",
  },
  {
    method: "DELETE",
    path: "/api/webmail/settings/signatures/:signatureId",
    file: "app/api/webmail/settings/signatures/[signatureId]/route.ts",
    guard: "webmail",
  },
  {
    method: "PUT",
    path: "/api/webmail/settings/signatures/defaults",
    file: "app/api/webmail/settings/signatures/defaults/route.ts",
    guard: "webmail",
  },
  {
    method: "PUT",
    path: "/api/webmail/settings/vacation",
    file: "app/api/webmail/settings/vacation/route.ts",
    guard: "webmail",
  },
  {
    method: "PUT",
    path: "/api/webmail/settings/junk",
    file: "app/api/webmail/settings/junk/route.ts",
    guard: "webmail",
  },
  {
    method: "POST",
    path: "/api/webmail/settings/forwarding",
    file: "app/api/webmail/settings/forwarding/route.ts",
    guard: "webmail",
  },
  {
    method: "PUT",
    path: "/api/webmail/settings/forwarding",
    file: "app/api/webmail/settings/forwarding/route.ts",
    guard: "webmail",
  },
  {
    method: "DELETE",
    path: "/api/webmail/settings/forwarding",
    file: "app/api/webmail/settings/forwarding/route.ts",
    guard: "webmail",
  },
  {
    method: "POST",
    path: "/api/webmail/forwarding/confirm",
    file: "app/api/webmail/forwarding/confirm/route.ts",
    guard: "public",
    // The harness sends no token: everyone gets "expired or already used".
    probeStatus: 404,
  },
];
