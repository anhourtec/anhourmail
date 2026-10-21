// SPDX-License-Identifier: AGPL-3.0-only
import type { Permission } from "@anhourmail/shared/rbac";

/**
 * Every API route and the permission that guards it. The RBAC harness (scripts/rbac-e2e.ts) derives its
 * expectations from this table plus the permission matrix, and fails if an `app/api/.../route.ts` file is
 * missing here (CLAUDE.md rule 35).
 *
 * `guard`: "public" (anyone), "session" (any signed-in person), or a permission from the matrix.
 * `accountParam`: the path parameter holding the account id, for account-scoped permissions.
 */
export type RouteSpec = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  file: string;
  guard: "public" | "session" | "infra" | Permission;
  accountParam?: string;
  /** Audit action written by a mutating route (asserted by the harness). */
  audits?: string;
};

export const ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: "/api/health", file: "app/api/health/route.ts", guard: "infra" },
  { method: "GET", path: "/api/health/ready", file: "app/api/health/ready/route.ts", guard: "infra" },
  { method: "GET", path: "/api/auth/*", file: "app/api/auth/[...all]/route.ts", guard: "infra" },
  {
    method: "POST",
    path: "/api/public/waitlist",
    file: "app/api/public/waitlist/route.ts",
    guard: "waitlist.join",
    audits: "waitlist.joined",
  },
  { method: "GET", path: "/api/me", file: "app/api/me/route.ts", guard: "session" },
  { method: "GET", path: "/api/platform/waitlist", file: "app/api/platform/waitlist/route.ts", guard: "waitlist.read" },
  { method: "GET", path: "/api/platform/audit", file: "app/api/platform/audit/route.ts", guard: "platform.audit.read" },
  {
    method: "GET",
    path: "/api/accounts/:accountId/audit",
    file: "app/api/accounts/[accountId]/audit/route.ts",
    guard: "audit.read",
    accountParam: "accountId",
  },
];
