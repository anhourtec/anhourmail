// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { forbidden, notFound } from "next/navigation";

import { can, type UserActor } from "@anhourmail/core";
import type { Permission } from "@anhourmail/shared/rbac";

import { requireUser } from "./console-frame";

/**
 * Access checks for console layouts, so a refused page answers with a real HTTP status. Pages stream (each has a
 * `loading.tsx`), and once streaming starts the status is fixed at 200; a layout renders before its segment's loading
 * boundary, so a check here still sets 404 / 403 (node_modules/next/dist/docs, "loading" → "Status codes"). The
 * services check everything again; these only pick the status and the page shown.
 */

/** Someone outside the account (customers of other accounts, staff not acting as it) gets the 404 page. */
export async function requireAccountMember(accountId: string): Promise<UserActor> {
  const actor = await requireUser();
  if (!actor.memberships.some((m) => m.accountId === accountId)) notFound();
  return actor;
}

/**
 * A section of an account (Mailboxes, Domains, …): a member whose role lacks the section's permission gets the 403
 * page. A suspended account renders as usual: the console frame shows its suspension notice instead of the page.
 */
export async function requireAccountSection(accountId: string, permission: Permission): Promise<UserActor> {
  const actor = await requireAccountMember(accountId);
  if (actor.suspendedAccountIds?.includes(accountId)) return actor;
  if (!can(actor, permission, accountId)) forbidden();
  return actor;
}

/** Staff pages are a 404 for everyone without the permission (customers never learn they exist). */
export async function requirePlatformPermission(permission?: Permission): Promise<UserActor> {
  const actor = await requireUser();
  if (permission ? !can(actor, permission) : actor.platformRoles.length === 0) notFound();
  return actor;
}
