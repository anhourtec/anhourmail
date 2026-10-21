// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";

import { can, type UserActor } from "@anhourmail/core";
import { type AuditEntry, listAccountAudit, listPlatformAudit } from "@anhourmail/core/audit";
import { listWaitlist } from "@anhourmail/core/waitlist";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";

import { PageHeader } from "@anhourmail/ui/page-header";

import { ConsoleShell } from "@/components/console-shell";
import { InviteButton } from "@/components/invite-button";
import { navGroups, requireUser } from "@/server/console-frame";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Console" };

const WAITLIST_STATUS = { pending: "Unconfirmed", confirmed: "Confirmed", invited: "Invited" } as const;

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" });

const roleLabel = (role: string | null): string =>
  role
    ? ((ROLE_LABELS as Record<string, string>)[`platform:${role}`] ??
      (ROLE_LABELS as Record<string, string>)[`account:${role}`] ??
      role)
    : "";

/** Rule 49: staff actions on an account are always shown as such, with role and reason. */
function describeActor(e: AuditEntry): string {
  const target = e.target.label ? ` · ${e.target.label}` : "";
  const reason = typeof e.meta.reason === "string" ? ` · reason: ${e.meta.reason}` : "";
  if (e.onBehalfOf)
    return `Anhourtec staff (${e.onBehalfOf.email}) acting as ${e.actor.email ?? "a member"}${target}${reason}`;
  if (e.actor.type === "staff")
    return `Anhourtec staff · ${roleLabel(e.actor.role)} · ${e.actor.email ?? ""}${target}${reason}`;
  return `${e.actor.email ?? e.actor.type}${target}`;
}

function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <p className="am-small">No activity yet.</p>;
  return (
    <ul className="divide-y rounded-xl border">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col">
            <span className="am-code truncate">{e.action}</span>
            <span className="am-micro truncate">{describeActor(e)}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className={`am-status am-status--${e.result === "success" ? "success" : "danger"}`}>{e.result}</span>
            <span className="am-micro am-num">{dateFmt.format(new Date(e.at))}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

async function AccountSection({ actor, accountId, name }: { actor: UserActor; accountId: string; name: string }) {
  const membership = actor.memberships.find((m) => m.accountId === accountId);
  const audit = can(actor, "audit.read", accountId)
    ? await listAccountAudit(container().deps, actor, accountId, { limit: 8 })
    : null;
  return (
    <section className="flex flex-col gap-4 border-t pt-8" aria-labelledby={`acct-${accountId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`acct-${accountId}`} className="am-h2">
          {name}
        </h2>
        {membership && <span className="am-status am-status--info">{ROLE_LABELS[`account:${membership.role}`]}</span>}
      </div>
      {audit && (
        <div className="flex flex-col gap-3">
          <h3 className="am-h3">Recent activity</h3>
          <AuditList entries={audit} />
        </div>
      )}
    </section>
  );
}

export default async function ConsoleHome() {
  const actor = await requireUser();
  const deps = container().deps;
  const { groups, names } = await navGroups(actor);
  const canInvite = can(actor, "waitlist.manage");
  const [waitlist, platformAudit] = await Promise.all([
    can(actor, "waitlist.read") ? listWaitlist(deps, actor, { limit: 5 }) : null,
    can(actor, "platform.audit.read") ? listPlatformAudit(deps, actor, { limit: 8 }) : null,
  ]);

  return (
    <ConsoleShell email={actor.email} groups={groups}>
      <PageHeader title="Overview" description="What you can do here comes from your roles." />
      {actor.suspended && <p className="am-status am-status--danger w-fit">This account is suspended.</p>}

      {actor.platformRoles.length > 0 && (
        <section className="flex flex-col gap-4 border-t pt-8" aria-labelledby="platform">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="platform" className="am-h2">
              Anhourtec staff
            </h2>
            <div className="flex flex-wrap gap-2">
              {actor.platformRoles.map((r) => (
                <span key={r} className="am-status am-status--info">
                  {ROLE_LABELS[`platform:${r}`]}
                </span>
              ))}
            </div>
          </div>
          {waitlist && (
            <div className="flex flex-col gap-3">
              <h3 className="am-h3">
                Waitlist <span className="am-num am-small">({waitlist.total})</span>
              </h3>
              {waitlist.entries.length === 0 ? (
                <p className="am-small">Nobody on the waitlist yet.</p>
              ) : (
                <ul className="divide-y rounded-xl border">
                  {waitlist.entries.map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                      <span className="flex min-w-0 flex-col">
                        <span className="am-code truncate">{w.email}</span>
                        <span className="am-micro">{w.community ?? "—"}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span
                          className={`am-status am-status--${
                            w.status === "confirmed" ? "success" : w.status === "invited" ? "info" : "neutral"
                          }`}
                        >
                          {WAITLIST_STATUS[w.status]}
                        </span>
                        {canInvite && w.status === "confirmed" && <InviteButton entryId={w.id} email={w.email} />}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {platformAudit && (
            <div className="flex flex-col gap-3">
              <h3 className="am-h3">Platform activity</h3>
              <AuditList entries={platformAudit} />
            </div>
          )}
        </section>
      )}

      {actor.memberships.map((m) => (
        <AccountSection
          key={m.accountId}
          actor={actor}
          accountId={m.accountId}
          name={names[m.accountId] ?? "Account"}
        />
      ))}

      {actor.platformRoles.length === 0 && actor.memberships.length === 0 && (
        <p className="am-small border-t pt-8">You're not part of an account yet.</p>
      )}
    </ConsoleShell>
  );
}
