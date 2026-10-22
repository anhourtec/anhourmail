// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { UserActor } from "@anhourmail/core";

import { ConsoleShell } from "@/components/console-shell";

import { getActor } from "./auth/actor";
import { container } from "./container";

/** The signed-in person, or a redirect to sign-in. For console pages. */
export async function requireUser(): Promise<UserActor> {
  const actor = await getActor(await headers());
  if (actor.kind !== "user") redirect("/sign-in");
  return actor;
}

/** Names of the person's accounts (for the app bar, the menu and the home page). */
export async function accountNames(actor: UserActor): Promise<Record<string, string>> {
  return container().deps.uow.run((r) => r.access.accountNames(actor.memberships.map((m) => m.accountId)));
}

/** Full console frame (app bar + navigation) around a page; `accountId` picks the account the navigation shows. */
export async function ConsoleFrame({ accountId, children }: { accountId?: string; children: React.ReactNode }) {
  const actor = await requireUser();
  return (
    <ConsoleShell actor={actor} names={await accountNames(actor)} {...(accountId ? { accountId } : {})}>
      {children}
    </ConsoleShell>
  );
}
