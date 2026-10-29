// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { can } from "@anhourmail/core";
import { listAliases } from "@anhourmail/core/aliases";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AliasList } from "@/components/aliases/alias-list";
import { CreateAliasForm } from "@/components/aliases/create-alias-form";
import { UrlFlyout } from "@/components/console/flyout";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";
import { param } from "@/server/search-params";

export const metadata: Metadata = { title: "Aliases" };

const usage = (l: { used: number; max: number | null }, one: string, many: string) =>
  l.max === null
    ? `${String(l.used)} ${l.used === 1 ? one : many}`
    : `${String(l.used)} of ${String(l.max)} ${l.max === 1 ? one : many}`;

const dayFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });
/** A UTC day (`YYYY-MM-DD`) as the console shows dates. */
const showDay = (day: string) => dayFmt.format(new Date(`${day}T00:00:00Z`));

/** Aliases (console page template). `?new=1` opens the "Add an alias" panel; `?q=` pre-fills the list's search. */
export default async function AliasesPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { accountId } = await params;
  const sp = await searchParams;
  const actor = await requireUser();
  const data = await forPage(() => listAliases(container().deps, actor, accountId));
  const crumbs = [{ label: "Home", href: "/" }, { label: "Aliases" }];
  if (!data) {
    return (
      <>
        <PageHeader title="Aliases" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn't include aliases. Ask an owner if you need access.</p>
      </>
    );
  }
  const { aliases, mailboxes, domains, limits, perMailbox } = data;
  // The server enforces every limit below; the page only explains them and hides what can't work.
  const planRoom = {
    alias: limits.alias.max === null || limits.alias.used < limits.alias.max,
    masked: limits.masked.max === null || limits.masked.used < limits.masked.max,
  };
  // Free's yearly creation caps (rolling 365 days; deleting gives none back).
  const yearRoom = { alias: limits.alias.nextSlot === null, masked: limits.masked.nextSlot === null };
  // The plan's daily creation caps (UTC day; deleting gives none back).
  const todayRoom = {
    alias: limits.alias.createdToday < limits.alias.perDay,
    masked: limits.masked.createdToday < limits.masked.perDay,
  };
  // Mailboxes that can take another address (aliases and masked aliases together, `perMailbox` each).
  const openMailboxes = mailboxes.filter((m) => m.addresses < perMailbox);
  const room = {
    alias: planRoom.alias && yearRoom.alias && todayRoom.alias,
    masked: planRoom.masked && yearRoom.masked && todayRoom.masked,
  };
  const path = `/accounts/${accountId}/aliases`;
  const canAdd = openMailboxes.length > 0 && (room.alias || room.masked);
  const label = { alias: "aliases", masked: "masked aliases" } as const;
  const kinds = ["alias", "masked"] as const;
  const yearFull = kinds.flatMap((k) => {
    const next = limits[k].nextSlot;
    return planRoom[k] && next !== null
      ? [`${String(limits[k].perYear ?? 0)} new ${label[k]} this year (more on ${showDay(next)})`]
      : [];
  });
  const todayFull = kinds.flatMap((k) =>
    planRoom[k] && yearRoom[k] && !todayRoom[k] ? [`${String(limits[k].perDay)} ${label[k]}`] : [],
  );
  const mailboxesFull = mailboxes.length > 0 && openMailboxes.length === 0;
  const perYearShown = limits.alias.perYear !== null || limits.masked.perYear !== null;

  return (
    <>
      <PageHeader
        title="Aliases"
        description="More addresses for the same mailbox. Masked aliases are random ones to give a single site, so you can turn them off when they start getting spam."
        breadcrumbs={crumbs}
      />
      <p className="am-small am-num -mt-2">
        In this account: {usage(limits.alias, "alias", "aliases")} ·{" "}
        {usage(limits.masked, "masked alias", "masked aliases")}
      </p>
      {perYearShown && (
        <p className="am-small am-num" data-testid="alias-year-remaining">
          Left to create this year:{" "}
          {kinds
            .flatMap((k) => {
              const perYear = limits[k].perYear;
              if (perYear === null) return [];
              const left = Math.max(0, perYear - limits[k].createdThisYear);
              return [`${String(left)} of ${String(perYear)} ${label[k]}`];
            })
            .join(" · ")}{" "}
          (deleting one doesn&apos;t give it back)
        </p>
      )}
      {!perYearShown && mailboxes.length > 0 && (
        <p className="am-small" data-testid="alias-mailbox-counts">
          Addresses per mailbox (up to <span className="am-num">{perMailbox}</span> each):{" "}
          {mailboxes.map((m, i) => (
            <span key={m.id}>
              {i > 0 && " · "}
              <span className="font-mono">{m.address}</span> <span className="am-num">{m.addresses}</span>
            </span>
          ))}
        </p>
      )}
      {mailboxes.length === 0 ? (
        <p className="am-body rounded-lg border px-4 py-3">
          Aliases deliver to a mailbox, and you don&apos;t have one to use yet.{" "}
          {can(actor, "mailbox.manage", accountId) ? (
            <Link
              href={`/accounts/${accountId}/mailboxes?new=1`}
              className="text-primary underline-offset-2 hover:underline"
            >
              Create a mailbox
            </Link>
          ) : (
            "Ask an owner to create one for you."
          )}
        </p>
      ) : (
        !canAdd &&
        !mailboxesFull &&
        yearFull.length === 0 &&
        todayFull.length === 0 && <p className="am-small">This account has all the aliases its plan includes.</p>
      )}
      {mailboxesFull && (
        <p className="am-small" role="status">
          {mailboxes.length === 1 ? "Your mailbox has" : "Each of your mailboxes has"}{" "}
          <span className="am-num">{perMailbox}</span> addresses, the most a mailbox can have. Delete one to add
          another.
        </p>
      )}
      {mailboxes.length > 0 && yearFull.length > 0 && (
        <p className="am-small" role="status">
          This account has created {yearFull.join(" and ")}, the most its plan allows in a year.
        </p>
      )}
      {mailboxes.length > 0 && todayFull.length > 0 && (
        <p className="am-small" role="status">
          This account has created {todayFull.join(" and ")} today, the most it can in one day. You can create more
          after midnight UTC.
        </p>
      )}

      <AliasList
        accountId={accountId}
        rows={aliases.map((a) => ({
          id: a.id,
          address: a.address,
          kind: a.kind,
          enabled: a.enabled,
          note: a.description,
          mailbox: a.mailbox.address,
          locked: a.mailbox.deleting,
          adminLocked: a.adminLocked,
        }))}
        canLift={can(actor, "alias.manage.any", accountId)}
        createHref={canAdd ? `${path}?new=1` : null}
        docsHref={`${env().SITE_URL.replace(/\/$/, "")}/docs/aliases`}
        initialQuery={param(sp, "q") ?? ""}
      />

      {canAdd && param(sp, "new") === "1" && (
        <UrlFlyout label="Add an alias" closeHref={path} size="md">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="am-h2">Add an alias</h2>
              <p className="am-small">
                Another address for one of your mailboxes: one you choose, or a random masked one.
              </p>
            </div>
            <CreateAliasForm
              accountId={accountId}
              options={{ mailboxes: openMailboxes.map((m) => ({ id: m.id, address: m.address })), domains, room }}
            />
          </div>
        </UrlFlyout>
      )}
    </>
  );
}
