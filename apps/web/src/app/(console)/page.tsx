// SPDX-License-Identifier: AGPL-3.0-only
import {
  AtSign,
  Building2,
  FileClock,
  Globe,
  Inbox,
  type LucideIcon,
  Mail,
  Plus,
  ShieldAlert,
  UserPlus,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { can, type UserActor } from "@anhourmail/core";
import { listAliases } from "@anhourmail/core/aliases";
import {
  actionLabel,
  type AuditEntry,
  describeActor,
  listAccountAudit,
  listPlatformAudit,
} from "@anhourmail/core/audit";
import { domainAllowance, listDomains } from "@anhourmail/core/domains";
import { listMailboxes } from "@anhourmail/core/mailboxes";
import { listPeople } from "@anhourmail/core/people";
import { MAX_MAILBOXES } from "@anhourmail/shared/plans";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";

import { CommandBar, CommandLink } from "@/components/console/command-bar";
import { DetailTabs } from "@/components/console/flyout";
import { Greeting } from "@/components/console/greeting";
import { firstName } from "@/components/console/greeting-text";
import { StatusText, type Tone } from "@/components/console/status-text";
import { ConsoleShell } from "@/components/console-shell";
import { MailboxStatus } from "@/components/mailboxes/mailbox-status";
import { accountNames, requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { platform } from "@/server/platform";

export const metadata: Metadata = { title: "Console" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" });
const PREVIEW = 5;

/** Rule 49: staff actions on an account are always shown as such (core describeActor), with the reason if given. */
function describe(e: AuditEntry): string {
  const who = describeActor(e);
  const target = e.target.label ? ` · ${e.target.label}` : "";
  const reason = typeof e.meta.reason === "string" ? ` · reason: ${e.meta.reason}` : "";
  return `${who.label}${who.detail ? ` (${who.detail})` : ""}${target}${reason}`;
}

function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <p className="am-small">No activity yet.</p>;
  return (
    <ul className="border-t">
      {entries.map((e) => (
        <li
          key={e.id}
          className="flex min-h-[46px] flex-col gap-0.5 border-b px-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
        >
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] font-medium">{actionLabel(e.action)}</span>
            <span className="am-micro truncate">{describe(e)}</span>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <StatusText tone={e.result === "success" ? "success" : "danger"}>
              {e.result === "success" ? "Success" : e.result === "denied" ? "Denied" : "Failed"}
            </StatusText>
            <span className="am-micro am-num">{dateFmt.format(new Date(e.at))}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A small list in the "Your account" tabs: primary text, one quiet line, a status. */
function MiniList({
  items,
  empty,
}: {
  items: { key: string; href: string; label: string; mono?: boolean; detail: string; status?: React.ReactNode }[];
  empty: string;
}) {
  if (items.length === 0) return <p className="am-small border-t py-4">{empty}</p>;
  return (
    <ul className="border-t">
      {items.map((i) => (
        <li key={i.key} className="flex min-h-[46px] items-center justify-between gap-4 border-b px-1 py-2">
          <div className="flex min-w-0 flex-col">
            <Link
              href={i.href}
              className={`truncate font-medium text-[14px] underline-offset-2 hover:underline ${i.mono ? "am-code" : ""}`}
            >
              {i.label}
            </Link>
            <span className="am-micro truncate">{i.detail}</span>
          </div>
          {i.status && <div className="shrink-0">{i.status}</div>}
        </li>
      ))}
    </ul>
  );
}

function TabBar({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-1">{children}</div>;
}

type Card = { id: string; icon: LucideIcon; title: string; text: string; href: string; action: string; tone: Tone };

/** Everything the home page shows for one account, read through the services with the person's own permissions. */
async function accountOverview(actor: UserActor, accountId: string) {
  const deps = container().deps;
  const [mailboxes, people, domains, allowance, aliases, audit] = await Promise.all([
    can(actor, "mailbox.read", accountId) ? listMailboxes(deps, actor, accountId) : null,
    can(actor, "member.read", accountId) ? listPeople(deps, actor, accountId) : null,
    can(actor, "domain.read", accountId) ? listDomains(deps, actor, accountId) : null,
    can(actor, "domain.read", accountId) ? domainAllowance(deps, actor, accountId) : null,
    can(actor, "alias.manage.own", accountId) ? listAliases(deps, actor, accountId) : null,
    can(actor, "audit.read", accountId) ? listAccountAudit(deps, actor, accountId, { limit: 6 }) : null,
  ]);
  return { mailboxes, people, domains, allowance, aliases, audit };
}

type Overview = Awaited<ReturnType<typeof accountOverview>>;

/** The account has no free platform address yet, and may create one (`mailbox.manage`, room under the ceiling). */
function canClaimFree(actor: UserActor, accountId: string, o: Overview, freeDomain: string): boolean {
  return (
    o.mailboxes !== null &&
    can(actor, "mailbox.manage", accountId) &&
    o.mailboxes.length < MAX_MAILBOXES &&
    !o.mailboxes.some((m) => m.address.endsWith(`@${freeDomain}`))
  );
}

/** Recommendation cards from the account's real state (nothing invented; each links to the one action). */
function recommendations(actor: UserActor, accountId: string, o: Overview, freeDomain: string): Card[] {
  const base = `/accounts/${accountId}`;
  const cards: Card[] = [];
  if (canClaimFree(actor, accountId, o, freeDomain)) {
    cards.push({
      id: "free-address",
      icon: AtSign,
      title: `Get your free @${freeDomain} address`,
      text: "Pick a name and a password. Use it in the webmail and in any mail app.",
      href: `${base}/mailboxes?claim=1`,
      action: "Choose your address",
      tone: "info",
    });
  }
  const failing = o.mailboxes?.find((m) => m.status === "failed" || m.applyFailed);
  if (failing && can(actor, "mailbox.manage", accountId)) {
    cards.push({
      id: "mailbox-problem",
      icon: ShieldAlert,
      title: "A mailbox needs attention",
      text: `${failing.address} isn't in the state you set on the mail server yet. Open it to try again.`,
      href: `${base}/mailboxes?mailbox=${failing.id}`,
      action: "Open the mailbox",
      tone: "danger",
    });
  }
  if (o.domains && o.allowance?.allowed && o.domains.length === 0 && can(actor, "domain.manage", accountId)) {
    cards.push({
      id: "add-domain",
      icon: Globe,
      title: "Use your own domain",
      text: "Addresses at a domain you own. You add a few DNS records and we check them for you.",
      href: `${base}/domains?new=1`,
      action: "Add a domain",
      tone: "info",
    });
  }
  const pending = o.domains?.find((d) => d.status === "pending_dns");
  if (pending) {
    cards.push({
      id: "finish-domain",
      icon: Globe,
      title: `Finish setting up ${pending.name}`,
      text: "Add its DNS records at your DNS provider. Mail starts arriving once they're in place.",
      href: `${base}/domains?domain=${pending.id}`,
      action: "See the records",
      tone: "warning",
    });
  }
  const activeDomain = o.domains?.some((d) => d.status === "active") ?? false;
  if (o.mailboxes?.length === 0 && activeDomain && can(actor, "mailbox.manage", accountId)) {
    cards.push({
      id: "first-mailbox",
      icon: Inbox,
      title: "Create your first mailbox",
      text: "An address on your domain with its own storage. Add one for each person who needs mail.",
      href: `${base}/mailboxes?new=1`,
      action: "Add a mailbox",
      tone: "info",
    });
  }
  if (
    o.people?.limits.addPeople &&
    o.people.members.length === 1 &&
    o.people.invites.length === 0 &&
    can(actor, "member.manage", accountId)
  ) {
    cards.push({
      id: "invite",
      icon: UserPlus,
      title: "Invite your family or group",
      text: `Up to ${String(o.people.limits.max)} people can share this account, each with their own role.`,
      href: `${base}/people?new=1`,
      action: "Invite someone",
      tone: "info",
    });
  }
  if (o.aliases?.aliases.length === 0 && o.aliases.mailboxes.length > 0) {
    cards.push({
      id: "alias",
      icon: AtSign,
      title: "Make a masked alias",
      text: "A random address for one site. If it starts getting spam, turn it off.",
      href: `${base}/aliases?new=1`,
      action: "Add an alias",
      tone: "info",
    });
  }
  return cards.slice(0, 4);
}

const ACCENT: Record<Tone, string> = {
  info: "border-l-primary",
  success: "border-l-[rgb(var(--am-status-success))]",
  warning: "border-l-[rgb(var(--am-status-warning))]",
  danger: "border-l-[rgb(var(--am-status-danger))]",
  neutral: "border-l-border",
};

function Cards({ cards }: { cards: Card[] }) {
  return (
    <section aria-labelledby="recommended" className="flex flex-col gap-3">
      <h2 id="recommended" className="am-h3">
        Recommended for you
      </h2>
      <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <li key={c.id} className={`flex gap-3.5 rounded-lg border border-l-4 bg-card p-4 ${ACCENT[c.tone]}`}>
              <Icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
              <div className="flex min-w-0 flex-col gap-1.5">
                <h3 className="am-h4 break-words">{c.title}</h3>
                <p className="am-small">{c.text}</p>
                <Link href={c.href} className="mt-1 w-fit text-[14px] text-primary underline-offset-2 hover:underline">
                  {c.action}
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AccountTabs({ actor, accountId, o }: { actor: UserActor; accountId: string; o: Overview }) {
  const base = `/accounts/${accountId}`;
  const tabs = [
    ...(o.mailboxes
      ? [
          {
            id: "mailboxes",
            label: `Mailboxes (${String(o.mailboxes.length)})`,
            content: (
              <>
                <TabBar>
                  {can(actor, "mailbox.manage", accountId) && (
                    <CommandLink href={`${base}/mailboxes?new=1`} icon={<Plus />}>
                      Add a mailbox
                    </CommandLink>
                  )}
                  <CommandLink href={`${base}/mailboxes`} icon={<Inbox />}>
                    All mailboxes
                  </CommandLink>
                </TabBar>
                <MiniList
                  empty="No mailboxes yet."
                  items={o.mailboxes.slice(0, PREVIEW).map((m) => ({
                    key: m.id,
                    href: `${base}/mailboxes?mailbox=${m.id}`,
                    label: m.address,
                    mono: true,
                    detail: m.owner ? `Belongs to ${m.owner.email}` : "Not assigned",
                    status: <MailboxStatus status={m.status} applyFailed={m.applyFailed} />,
                  }))}
                />
              </>
            ),
          },
        ]
      : []),
    ...(o.aliases && !o.mailboxes
      ? [
          {
            id: "aliases",
            label: `Aliases (${String(o.aliases.aliases.length)})`,
            content: (
              <>
                <TabBar>
                  {o.aliases.mailboxes.length > 0 && (
                    <CommandLink href={`${base}/aliases?new=1`} icon={<Plus />}>
                      Add an alias
                    </CommandLink>
                  )}
                  <CommandLink href={`${base}/aliases`} icon={<AtSign />}>
                    All aliases
                  </CommandLink>
                </TabBar>
                <MiniList
                  empty="No aliases yet."
                  items={o.aliases.aliases.slice(0, PREVIEW).map((a) => ({
                    key: a.id,
                    href: `${base}/aliases?q=${encodeURIComponent(a.address)}`,
                    label: a.address,
                    mono: true,
                    detail: `${a.kind === "masked" ? "Masked alias" : "Alias"} to ${a.mailbox.address}`,
                    status: (
                      <StatusText tone={a.enabled ? "success" : "neutral"}>{a.enabled ? "On" : "Off"}</StatusText>
                    ),
                  }))}
                />
              </>
            ),
          },
        ]
      : []),
    ...(o.people
      ? [
          {
            id: "people",
            label: `People (${String(o.people.members.length)})`,
            content: (
              <>
                <TabBar>
                  {can(actor, "member.manage", accountId) && o.people.limits.addPeople && (
                    <CommandLink href={`${base}/people?new=1`} icon={<UserPlus />}>
                      Invite someone
                    </CommandLink>
                  )}
                  <CommandLink href={`${base}/people`} icon={<Users />}>
                    People and roles
                  </CommandLink>
                </TabBar>
                <MiniList
                  empty="Nobody yet."
                  items={o.people.members.slice(0, PREVIEW).map((p) => ({
                    key: p.userId,
                    href: `${base}/people?person=${encodeURIComponent(p.userId)}`,
                    label: p.name || p.email,
                    detail: `${p.email} · ${ROLE_LABELS[`account:${p.role}`]}`,
                    status: (
                      <StatusText tone={p.status === "active" ? "success" : "neutral"}>
                        {p.status === "active" ? "Active" : "Suspended"}
                      </StatusText>
                    ),
                  }))}
                />
              </>
            ),
          },
        ]
      : []),
    ...(o.domains
      ? [
          {
            id: "domains",
            label: `Domains (${String(o.domains.length)})`,
            content: (
              <>
                <TabBar>
                  {can(actor, "domain.manage", accountId) && o.allowance?.allowed && (
                    <CommandLink href={`${base}/domains?new=1`} icon={<Plus />}>
                      Add a domain
                    </CommandLink>
                  )}
                  <CommandLink href={`${base}/domains`} icon={<Globe />}>
                    All domains
                  </CommandLink>
                </TabBar>
                <MiniList
                  empty={
                    o.allowance?.allowed
                      ? "No domains yet."
                      : "Custom domains are part of the Plus and Supporter plans."
                  }
                  items={o.domains.slice(0, PREVIEW).map((d) => ({
                    key: d.id,
                    href: `${base}/domains?domain=${d.id}`,
                    label: d.name,
                    mono: true,
                    detail: "Custom domain",
                    status:
                      d.status === "pending_dns" ? (
                        <StatusText tone="warning">Waiting for DNS</StatusText>
                      ) : d.status === "removing" ? (
                        <StatusText tone="neutral">Removing</StatusText>
                      ) : (
                        <StatusText tone={d.provisioned ? "success" : "info"}>
                          {d.provisioned ? "Active" : "Setting up"}
                        </StatusText>
                      ),
                  }))}
                />
              </>
            ),
          },
        ]
      : []),
    ...(o.audit
      ? [
          {
            id: "activity",
            label: "Recent activity",
            content: (
              <>
                <TabBar>
                  <CommandLink href={`${base}/audit`} icon={<FileClock />}>
                    Open the audit log
                  </CommandLink>
                </TabBar>
                <AuditList entries={o.audit} />
              </>
            ),
          },
        ]
      : []),
  ];
  if (tabs.length === 0) {
    return <p className="am-small">Your role here doesn&apos;t include any console pages yet.</p>;
  }
  return <DetailTabs tabs={tabs} urlKey={null} label="Your account" />;
}

export default async function ConsoleHome() {
  const actor = await requireUser();
  const deps = container().deps;
  const names = await accountNames(actor);
  const current = actor.memberships[0]?.accountId;
  const overviews = await Promise.all(
    actor.memberships.map(async (m) => ({
      accountId: m.accountId,
      role: m.role,
      o: await accountOverview(actor, m.accountId),
    })),
  );
  const platformAudit = can(actor, "platform.audit.read") ? await listPlatformAudit(deps, actor, { limit: 8 }) : null;
  const first = overviews[0];
  const freeDomain = platform().freeAddressDomain;
  const cards = first ? recommendations(actor, first.accountId, first.o, freeDomain) : [];
  const base = current ? `/accounts/${current}` : "";
  const staff = actor.platformRoles.length > 0;
  const webmail =
    actor.memberships.length > 0
      ? `${env().WEBMAIL_URL.replace(/\/$/, "")}/sign-in?address=${encodeURIComponent(actor.email)}`
      : null;

  const quick: { href: string; icon: React.ReactNode; label: string; external?: boolean }[] = [];
  if (current && first) {
    const { o } = first;
    if (canClaimFree(actor, current, o, freeDomain))
      quick.push({ href: `${base}/mailboxes?claim=1`, icon: <AtSign />, label: "Get your free address" });
    if (can(actor, "mailbox.manage", current) && o.domains?.some((d) => d.status === "active"))
      quick.push({ href: `${base}/mailboxes?new=1`, icon: <Inbox />, label: "Add a mailbox" });
    if (can(actor, "member.manage", current) && o.people?.limits.addPeople)
      quick.push({ href: `${base}/people?new=1`, icon: <UserPlus />, label: "Invite someone" });
    if (can(actor, "domain.manage", current) && o.allowance?.allowed)
      quick.push({ href: `${base}/domains?new=1`, icon: <Globe />, label: "Add a domain" });
    if (o.aliases && o.aliases.mailboxes.length > 0)
      quick.push({ href: `${base}/aliases?new=1`, icon: <AtSign />, label: "Add an alias" });
  }
  if (can(actor, "platform.accounts.read"))
    quick.push({ href: "/platform/accounts", icon: <Building2 />, label: "Find an account" });
  if (can(actor, "platform.audit.read"))
    quick.push({ href: "/platform/audit", icon: <FileClock />, label: "Platform audit" });
  if (webmail) quick.push({ href: webmail, icon: <Mail />, label: "Open webmail", external: true });

  const lead = current
    ? `Mail, domains and people for ${names[current] ?? "your account"}, in one place.`
    : staff
      ? "Look up customer accounts and review platform activity."
      : "You're not part of an account yet.";

  return (
    <ConsoleShell actor={actor} names={names}>
      {quick.length > 0 && (
        <CommandBar label="Quick actions" boxed>
          {quick.map((q) =>
            q.external ? (
              <a
                key={q.label}
                href={q.href}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-[14px] transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&>svg]:size-4 [&>svg]:text-primary"
              >
                {q.icon}
                {q.label}
              </a>
            ) : (
              <CommandLink key={q.label} href={q.href} icon={q.icon}>
                {q.label}
              </CommandLink>
            ),
          )}
        </CommandBar>
      )}

      <header className="mt-3 flex flex-col gap-1.5">
        <Greeting name={firstName(actor.name, actor.email)} />
        <p className="am-small">{lead}</p>
        {actor.suspended && (
          <p className="mt-1">
            <StatusText tone="danger">This account is suspended.</StatusText>
          </p>
        )}
      </header>

      {cards.length > 0 && <Cards cards={cards} />}

      {overviews.length > 0 && (
        <section aria-labelledby="your-account" className="mt-2 flex flex-col gap-6">
          <h2 id="your-account" className="am-h2">
            {overviews.length > 1 ? "Your accounts" : "Your account"}
          </h2>
          {overviews.map(({ accountId, role, o }) => (
            <div key={accountId} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 id={`acct-${accountId}`} className="am-h3">
                  {names[accountId] ?? "Account"}
                </h3>
                <span className="am-small">{ROLE_LABELS[`account:${role}`]}</span>
              </div>
              <AccountTabs actor={actor} accountId={accountId} o={o} />
            </div>
          ))}
        </section>
      )}

      {staff && (
        <section aria-labelledby="platform" className="mt-2 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id="platform" className="am-h2">
              Anhourtec staff
            </h2>
            <span className="am-small">{actor.platformRoles.map((r) => ROLE_LABELS[`platform:${r}`]).join(", ")}</span>
          </div>
          {platformAudit && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="platform-activity" className="am-h4">
                  Platform activity
                </h3>
                <Link href="/platform/audit" className="text-[14px] text-primary underline-offset-2 hover:underline">
                  Open the platform audit
                </Link>
              </div>
              <AuditList entries={platformAudit} />
            </>
          )}
        </section>
      )}
    </ConsoleShell>
  );
}
