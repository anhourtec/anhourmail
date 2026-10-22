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
];
