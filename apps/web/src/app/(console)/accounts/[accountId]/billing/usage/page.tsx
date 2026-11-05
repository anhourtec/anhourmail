// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowRight, ArrowUpRight, AtSign, HardDrive, Inbox, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { can } from "@anhourmail/core";
import { billingOverview } from "@anhourmail/core/billing";
import { PLANS } from "@anhourmail/shared/plans";
import { PageHeader } from "@anhourmail/ui/page-header";

import { BillingTabs } from "@/components/billing/billing-tabs";
import { gigabytes } from "@/components/billing/labels";
import { UsageMeter } from "@/components/billing/usage-meter";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";
import { billingContext, billingOffered } from "@/server/billing";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Usage" };

const card = "rounded-2xl border bg-card p-5 shadow-sm sm:p-6";

/** One usage figure as a card: icon, title, the meter (or a plain count), what counts, and where to manage it. */
function UsageCard({
  icon,
  title,
  children,
  note,
  link,
  wide = false,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  note: string;
  link?: { href: string; label: string } | null;
  /** Spans both columns (the last card when the count is odd). */
  wide?: boolean;
}) {
  return (
    <section aria-label={title} className={`${card} flex flex-col gap-4 ${wide ? "md:col-span-2" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {icon}
        </span>
        <h2 className="am-h4">{title}</h2>
      </div>
      {children}
      <p className="am-small">{note}</p>
      {link && (
        <Link
          href={link.href}
          className="mt-auto inline-flex w-fit items-center gap-1.5 text-[14px] text-primary underline-offset-2 hover:underline"
        >
          {link.label}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      )}
    </section>
  );
}

/**
 * Billing → Usage: what the account uses against what its plan allows (mailboxes, people, the shared storage pool),
 * the address count (the address ceiling itself is never shown, ADR-0029 §7), add-ons in force, and where to get more
 * room. Same `billing.read` guard as Billing (the billing layout); links to other console pages show only to roles
 * that can open them.
 */
export default async function UsagePage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  const actor = await requireUser();
  const o = await forPage(() => billingOverview(container().deps, billingContext(), actor, accountId));
  const crumbs = [
    { label: "Home", href: "/" },
    { label: "Billing", href: `/accounts/${accountId}/billing` },
    { label: "Usage" },
  ];
  if (!o) {
    return (
      <>
        <PageHeader title="Usage" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn&apos;t include billing.</p>
      </>
    );
  }
  const plan = PLANS[o.plan];
  const { offered } = billingOffered(o.status, o.available);
  const canManage = actor.actingAs === undefined && can(actor, "billing.manage", accountId);
  const manage = offered && canManage;
  const base = `/accounts/${accountId}`;
  const paidLive = o.planSource === "stripe" && o.paidPlan !== null && o.state !== "lapsed";
  const mailboxLink = can(actor, "mailbox.read", accountId)
    ? { href: `${base}/mailboxes`, label: "Go to Mailboxes" }
    : null;

  return (
    <>
      <PageHeader
        title="Usage"
        description={`What the account uses right now, against what ${plan.name} allows.`}
        breadcrumbs={crumbs}
      />
      <BillingTabs accountId={accountId} current="usage" />

      <div className="grid gap-4 md:grid-cols-2" data-testid="billing-usage">
        <UsageCard
          icon={<Inbox className="size-5" aria-hidden />}
          title="Mailboxes"
          note={
            plan.extraMailboxPrice
              ? `${plan.name} includes ${String(plan.includedMailboxes)}; extra mailboxes are an add-on.`
              : `${plan.name} includes ${String(plan.includedMailboxes)} ${plan.includedMailboxes === 1 ? "mailbox" : "mailboxes"}.`
          }
          link={mailboxLink}
        >
          <UsageMeter label="Mailboxes in use" used={o.usage.mailboxes} limit={o.usage.mailboxCeiling} />
        </UsageCard>

        <UsageCard
          icon={<HardDrive className="size-5" aria-hidden />}
          title="Storage"
          note="One pool for the whole account, split between its mailboxes. This is how much of it is given to mailboxes, not how much mail they hold."
          link={mailboxLink}
        >
          <UsageMeter
            label="Storage given to mailboxes"
            used={o.usage.assignedBytes}
            limit={o.usage.poolBytes}
            usedText={gigabytes(o.usage.assignedBytes)}
            limitText={gigabytes(o.usage.poolBytes)}
          />
        </UsageCard>

        {plan.addPeople && (
          <UsageCard
            icon={<Users className="size-5" aria-hidden />}
            title="People"
            note="Everyone with a role in the account, you included."
            link={
              can(actor, "member.read", accountId) ? { href: `${base}/people`, label: "Go to People and roles" } : null
            }
          >
            <UsageMeter label="People in the account" used={o.usage.people} limit={o.usage.peopleCeiling} />
          </UsageCard>
        )}

        <UsageCard
          icon={<AtSign className="size-5" aria-hidden />}
          title="Addresses"
          wide={!plan.addPeople}
          note="Every address that receives mail: mailboxes and their aliases together."
          link={can(actor, "alias.manage.own", accountId) ? { href: `${base}/aliases`, label: "Go to Aliases" } : null}
        >
          <p className="flex items-baseline gap-2">
            <span className="am-num font-medium text-[28px] leading-none">{o.usage.addresses}</span>
            <span className="am-small">{o.usage.addresses === 1 ? "address" : "addresses"}</span>
          </p>
          {o.usage.addressesNearCeiling && (
            <p className="am-small text-foreground" data-testid="billing-address-ceiling">
              This account is close to the number of addresses one account can have. Contact support if you need more:
              we can raise it.
            </p>
          )}
        </UsageCard>
      </div>

      {(o.entitled.storageBlocks > 0 || o.entitled.extraMailboxes > 0) && (
        <p className="am-small">
          Add-ons in force: <span className="am-num">{o.entitled.storageBlocks}</span> storage{" "}
          {o.entitled.storageBlocks === 1 ? "block" : "blocks"} and{" "}
          <span className="am-num">{o.entitled.extraMailboxes}</span> extra{" "}
          {o.entitled.extraMailboxes === 1 ? "mailbox" : "mailboxes"}.
        </p>
      )}

      {manage && (
        <section
          aria-labelledby="more-room-title"
          className={`${card} relative flex flex-col gap-4 overflow-hidden sm:flex-row sm:items-center sm:justify-between`}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.07] via-transparent to-transparent"
          />
          <div className="relative flex flex-col gap-1">
            <h2 id="more-room-title" className="am-h4">
              Need more room?
            </h2>
            <p className="am-small max-w-[62ch]">
              {paidLive
                ? "Add storage blocks or extra mailboxes to this subscription. You see the amount and confirm it before anything is charged."
                : `${PLANS.plus.name} gives the account its own domains, ${String(PLANS.plus.includedMailboxes)} mailboxes and ${String(PLANS.plus.storagePoolGb)} GB to share.`}
            </p>
          </div>
          <Link
            href={paidLive ? `${base}/billing#addons` : `${base}/billing#choose`}
            className={`relative ${paidLive ? secondaryButtonClass : primaryButtonClass}`}
          >
            {paidLive ? "Add storage or mailboxes" : "See plans"}
            <ArrowUpRight className="size-4" aria-hidden />
          </Link>
        </section>
      )}
    </>
  );
}
