// SPDX-License-Identifier: AGPL-3.0-only
import type { Permission } from "@anhourmail/shared/rbac";

/**
 * Every API route and the permission that guards it. The RBAC harness (scripts/rbac-e2e.ts) derives its
 * expectations from this table plus the permission matrix, and fails if an `app/api/.../route.ts` file is
 * missing here (CLAUDE.md rule 35).
 *
 * `guard`: "public" (anyone), "session" (any signed-in person), "webmail" (a webmail session on the webmail origin —
 * a console session never grants it), or a permission from the matrix.
 * `accountParam`: the path parameter holding the account id, for account-scoped permissions.
 */
export type RouteSpec = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  file: string;
  guard: "public" | "session" | "webmail" | "infra" | Permission;
  accountParam?: string;
  /** Audit action written by a mutating route (asserted by the harness). */
  audits?: string;
  /**
   * What an ALLOWED caller gets for the harness's probe request when it can't be a real success (e.g. a random
   * subject id → 404, a junk token → 400). Denied callers still get 401/403/404 from the matrix.
   */
  probeStatus?: number;
};

export const ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: "/api/health", file: "app/api/health/route.ts", guard: "infra" },
  { method: "GET", path: "/api/health/ready", file: "app/api/health/ready/route.ts", guard: "infra" },
  { method: "GET", path: "/api/auth/*", file: "app/api/auth/[...all]/route.ts", guard: "infra" },
  { method: "GET", path: "/api/me", file: "app/api/me/route.ts", guard: "session" },
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
  { method: "GET", path: "/api/webmail/mailboxes", file: "app/api/webmail/mailboxes/route.ts", guard: "webmail" },
  { method: "POST", path: "/api/webmail/mailboxes", file: "app/api/webmail/mailboxes/route.ts", guard: "webmail" },
  {
    method: "PUT",
    path: "/api/webmail/mailboxes/active",
    file: "app/api/webmail/mailboxes/active/route.ts",
    guard: "webmail",
  },
];
