// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { UserActor } from "@anhourmail/core";

import { ConsoleShell } from "@/components/console-shell";

import { getActor } from "./auth/actor";
import { container } from "./container";

/** Where someone goes when one of their accounts requires a sign-in factor they haven't set up. */
export const ENROL_PATH = "/security?setup=required";

/**
 * The signed-in person, or a redirect to sign-in. For console pages. A person who still has to set up a factor their
 * account requires is sent to their Security page first (`enrolling`: the pages that let them do it).
 */
export async function requireUser(opts: { enrolling?: boolean } = {}): Promise<UserActor> {
  const actor = await getActor(await headers());
  if (actor.kind !== "user") redirect("/sign-in");
  if (actor.mustEnrol && !opts.enrolling) redirect(ENROL_PATH);
  return actor;
}

/** Names of the person's accounts (for the app bar, the menu and the home page). */
export async function accountNames(actor: UserActor): Promise<Record<string, string>> {
  return container().deps.uow.run((r) => r.access.accountNames(actor.memberships.map((m) => m.accountId)));
}

/** Full console frame (app bar + navigation) around a page; `accountId` picks the account the navigation shows. */
export async function ConsoleFrame({
  accountId,
  enrolling = false,
  children,
}: {
  accountId?: string;
  enrolling?: boolean;
  children: React.ReactNode;
}) {
  const actor = await requireUser({ enrolling });
  return (
    <ConsoleShell actor={actor} names={await accountNames(actor)} {...(accountId ? { accountId } : {})}>
      {children}
    </ConsoleShell>
  );
}
