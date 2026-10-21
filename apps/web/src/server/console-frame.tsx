// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import type { UserActor } from "@anhourmail/core";

import { ConsoleShell, type ShellNavGroup } from "@/components/console-shell";

import { getActor } from "./auth/actor";
import { visibleNav } from "./console-nav";
import { container } from "./container";

/** The signed-in person, or a redirect to sign-in. For console pages. */
export async function requireUser(): Promise<UserActor> {
  const actor = await getActor(await headers());
  if (actor.kind !== "user") redirect("/sign-in");
  return actor;
}

/** Navigation groups: staff sections, then one group per account the person belongs to (from the matrix). */
export async function navGroups(actor: UserActor): Promise<{ groups: ShellNavGroup[]; names: Record<string, string> }> {
  const names = await container().deps.uow.run((r) => r.access.accountNames(actor.memberships.map((m) => m.accountId)));
  const item = (accountId: string) => (n: ReturnType<typeof visibleNav>[number]) => ({
    label: n.label,
    permission: n.permission,
    icon: n.icon,
    ...(n.href ? { href: n.href(accountId) } : {}),
  });
  const platform = visibleNav(actor).filter((n) => n.scope === "platform");
  return {
    names,
    groups: [
      ...(platform.length > 0
        ? [{ id: "platform", title: "Anhourtec staff", kind: "platform" as const, items: platform.map(item("")) }]
        : []),
      ...actor.memberships.map((m) => ({
        id: m.accountId,
        title: names[m.accountId] ?? "Account",
        kind: "account" as const,
        items: visibleNav(actor, m.accountId)
          .filter((n) => n.scope === "account")
          .map(item(m.accountId)),
      })),
    ],
  };
}

/** Full console frame (header + navigation) around a page. */
export async function ConsoleFrame({ children }: { children: React.ReactNode }) {
  const actor = await requireUser();
  const { groups } = await navGroups(actor);
  return (
    <ConsoleShell email={actor.email} groups={groups}>
      {children}
    </ConsoleShell>
  );
}
