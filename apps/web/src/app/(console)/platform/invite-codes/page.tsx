// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { can } from "@anhourmail/core";
import { listInviteCodes } from "@anhourmail/core/billing";
import { PLANS } from "@anhourmail/shared/plans";
import { PageHeader } from "@anhourmail/ui/page-header";

import { billingDate } from "@/components/billing/labels";
import { ListEmpty } from "@/components/console/data-list";
import { listClass } from "@/components/console/list-classes";
import { StatusText, type Tone } from "@/components/console/status-text";
import { InviteCodeForm } from "@/components/platform/invite-code-form";
import { RevokeInviteCode } from "@/components/platform/revoke-invite-code";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Invite codes" };

const STATUS: Record<string, { text: string; tone: Tone }> = {
  active: { text: "Unused", tone: "success" },
  redeemed: { text: "Used", tone: "neutral" },
  revoked: { text: "Revoked", tone: "neutral" },
  expired: { text: "Expired", tone: "neutral" },
};

/**
 * Staff: invite codes (ADR-0029 §8). Global and Support Administrators make sign-up codes; Global and Billing
 * Administrators make codes that give a paid plan for some days. Everyone else on staff gets a 404. Codes are listed
 * without the code itself (only its hash is stored).
 */
export default async function InviteCodesPage() {
  const actor = await requireUser();
  const canSignup = can(actor, "platform.invites.manage");
  const canComp = can(actor, "platform.billing.manage");
  if ((!canSignup && !canComp) || actor.actingAs) notFound();
  const codes = await listInviteCodes(container().deps, actor);
  return (
    <>
      <PageHeader
        title="Invite codes"
        description="Single-use codes for sign-up while it's closed, for a complimentary paid plan, or both. A code is shown once when it's made; it always expires."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Invite codes" }]}
      />
      <InviteCodeForm
        canSignup={canSignup}
        canComp={canComp}
        signUpUrl={`${env().APP_URL.replace(/\/$/, "")}/sign-up`}
      />
      <section aria-labelledby="codes" className="flex flex-col gap-3">
        <h2 id="codes" className="am-h3">
          Codes
        </h2>
        {codes.length === 0 ? (
          <ListEmpty>No codes yet.</ListEmpty>
        ) : (
          <div className={listClass.wrap}>
            <table className={listClass.table} data-testid="invite-codes">
              <thead>
                <tr>
                  <th scope="col" className={listClass.th}>
                    Note
                  </th>
                  <th scope="col" className={listClass.th}>
                    Grants
                  </th>
                  <th scope="col" className={`${listClass.th} hidden md:table-cell`}>
                    Expires
                  </th>
                  <th scope="col" className={listClass.th}>
                    Status
                  </th>
                  <th scope="col" className={listClass.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => {
                  const st = STATUS[c.status] ?? { text: c.status, tone: "neutral" as const };
                  const grants = [
                    c.grantsSignup ? "Sign-up" : null,
                    c.compPlan ? `${PLANS[c.compPlan].name} for ${String(c.compDays ?? 0)} days` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  const label = c.label || "Untitled code";
                  // Revoking a comp code takes `platform.billing.manage` (the server checks it too).
                  const mayRevoke = c.status === "active" && (c.compPlan ? canComp : canSignup);
                  return (
                    <tr key={c.id} className={listClass.row}>
                      <td className={listClass.td}>
                        <span className="flex flex-col">
                          <span className="font-medium">{label}</span>
                          {c.email && <span className="font-mono text-[12.5px] break-all">{c.email}</span>}
                        </span>
                      </td>
                      <td className={listClass.td}>{grants}</td>
                      <td className={`${listClass.td} am-num hidden md:table-cell`}>
                        {billingDate.format(c.expiresAt)}
                      </td>
                      <td className={listClass.td}>
                        <StatusText tone={st.tone}>{st.text}</StatusText>
                      </td>
                      <td className={`${listClass.td} text-right`}>
                        {mayRevoke && <RevokeInviteCode id={c.id} label={label} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
