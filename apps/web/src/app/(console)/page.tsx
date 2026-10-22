// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";

import { can, type UserActor } from "@anhourmail/core";
import {
  actionLabel,
  type AuditEntry,
  describeActor,
  listAccountAudit,
  listPlatformAudit,
} from "@anhourmail/core/audit";
import { ROLE_LABELS } from "@anhourmail/shared/rbac";

import { PageHeader } from "@anhourmail/ui/page-header";

import { ConsoleShell } from "@/components/console-shell";
import { navGroups, requireUser } from "@/server/console-frame";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Console" };

const dateFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" });

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
    <ul className="divide-y rounded-xl border">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col">
            <span className="am-body truncate">{actionLabel(e.action)}</span>
            <span className="am-micro truncate">{describe(e)}</span>
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
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id={`activity-${accountId}`} className="am-h3 scroll-mt-20">
              Recent activity
            </h3>
            <Link href={`/accounts/${accountId}/audit`} className="am-small underline-offset-2 hover:underline">
              Open the audit log
            </Link>
          </div>
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
  const platformAudit = can(actor, "platform.audit.read") ? await listPlatformAudit(deps, actor, { limit: 8 }) : null;

  return (
    <ConsoleShell actor={actor} groups={groups}>
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
          {platformAudit && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 id="platform-activity" className="am-h3 scroll-mt-20">
                  Platform activity
                </h3>
                <Link href="/platform/audit" className="am-small underline-offset-2 hover:underline">
                  Open the platform audit
                </Link>
              </div>
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
