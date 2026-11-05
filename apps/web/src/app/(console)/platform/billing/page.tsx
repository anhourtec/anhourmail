// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@anhourmail/core";
import { platformBillingSummary } from "@anhourmail/core/billing";
import { PageHeader } from "@anhourmail/ui/page-header";

import { billingDate } from "@/components/billing/labels";
import { ListEmpty } from "@/components/console/data-list";
import { listClass } from "@/components/console/list-classes";
import { billingContext } from "@/server/billing";
import { DismissOrphanControl } from "@/components/platform/billing-controls";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";

export const metadata: Metadata = { title: "Platform billing" };

const LISTS = [
  {
    id: "past_due",
    title: "Payment failed, retrying",
    note: "The payment processor is retrying a renewal. Nothing has changed for the customer yet.",
  },
  {
    id: "restricted",
    title: "Sending paused",
    note: "Retries ran out, the subscription is paused, or a payment is disputed. Disputes are ours to handle.",
  },
  {
    id: "lapsed",
    title: "Paid plan ended",
    note: "On Free with items held until the Owner resolves them, subscribes again or deletes the account.",
  },
] as const;

/**
 * Staff (`platform.billing.manage`: Global and Billing Administrators; everyone else 404): accounts whose billing needs
 * attention and provider events not matched to an account (ADR-0029 §9). Metadata only. Each account opens on Platform →
 * account, whose Billing tab has the details and the staff actions.
 */
export default async function PlatformBillingPage() {
  const actor = await requireUser();
  if (!can(actor, "platform.billing.manage")) notFound();
  const s = await platformBillingSummary(container().deps, billingContext(), actor);
  // Staff acting as someone see the page and change nothing (the server refuses too).
  const canAct = actor.actingAs === undefined;
  return (
    <>
      <PageHeader
        title="Platform billing"
        description="Accounts whose billing needs attention, and payment events we couldn't match to an account. Open an account for its billing details, grants, refunds and its address ceiling."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Platform billing" }]}
      />
      {s.catalogue && s.catalogue.drift.length > 0 && (
        <div role="alert" className="flex max-w-3xl flex-col gap-1.5 rounded-lg border border-destructive px-4 py-3">
          <p className="font-medium">
            The payment processor&apos;s prices don&apos;t match the published plans: new checkouts and plan or add-on
            changes are refused until they do.
          </p>
          <ul className="am-small list-disc pl-5">
            {s.catalogue.drift.map((d) => (
              <li key={`${d.item}-${d.problem}`}>
                <span className="font-mono text-[13px]">{d.item}</span>: {d.problem}
              </li>
            ))}
          </ul>
          <p className="am-small">
            Since <span className="am-num">{billingDate.format(s.catalogue.driftSince ?? s.catalogue.checkedAt)}</span>;
            last checked <span className="am-num">{billingDate.format(s.catalogue.checkedAt)}</span>. Fix the prices at
            the processor (the plan facts are the source); the next daily check, or a worker restart, lifts it. Existing
            subscriptions keep syncing.
          </p>
        </div>
      )}
      <p className="am-small">
        {s.available ? "Billing is on" : "Billing is off on this deployment"}; paid plans are{" "}
        {s.status === "open" ? "open" : "not open to customers yet"}.{" "}
        <Link href="/platform/invite-codes" className="text-primary underline-offset-2 hover:underline">
          Invite codes
        </Link>
      </p>
      {LISTS.map((l) => {
        const rows = s.lists[l.id];
        return (
          <section key={l.id} aria-labelledby={`pb-${l.id}`} className="flex flex-col gap-2">
            <h2 id={`pb-${l.id}`} className="am-h3">
              {l.title} <span className="am-num am-small">({rows.length})</span>
            </h2>
            <p className="am-small max-w-[80ch]">{l.note}</p>
            {rows.length === 0 ? (
              <ListEmpty>None.</ListEmpty>
            ) : (
              <ul className="flex max-w-3xl flex-col border-t">
                {rows.map((r) => (
                  <li
                    key={r.accountId}
                    className="flex min-h-[46px] flex-wrap items-center justify-between gap-x-3 border-b px-1 py-2"
                  >
                    <Link
                      href={`/platform/accounts/${r.accountId}?tab=billing`}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {r.name}
                    </Link>
                    <span className="am-small">
                      {r.disputed ? "Disputed · " : ""}since{" "}
                      <span className="am-num">{billingDate.format(r.since)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <section aria-labelledby="pb-orphans" className="flex flex-col gap-2">
        <h2 id="pb-orphans" className="am-h3">
          Unmatched events <span className="am-num am-small">({s.orphans.length})</span>
        </h2>
        <p className="am-small max-w-[80ch]">
          Signed events from the payment processor whose customer isn&apos;t one of ours yet (a dispute is matched
          through its payment by the next sync). Kept until matched or dismissed.
        </p>
        {s.orphans.length === 0 ? (
          <ListEmpty>None.</ListEmpty>
        ) : (
          <div className={listClass.wrap}>
            <table className={listClass.table}>
              <thead>
                <tr>
                  <th scope="col" className={listClass.th}>
                    Event
                  </th>
                  <th scope="col" className={listClass.th}>
                    Object
                  </th>
                  <th scope="col" className={`${listClass.th} hidden sm:table-cell`}>
                    Received
                  </th>
                  {canAct && (
                    <th scope="col" className={listClass.th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {s.orphans.map((o) => (
                  <tr key={o.id} className={listClass.row}>
                    <td className={`${listClass.td} font-mono text-[13px]`}>{o.type}</td>
                    <td className={`${listClass.td} font-mono text-[13px] break-all`}>{o.objectId}</td>
                    <td className={`${listClass.td} am-num hidden sm:table-cell`}>
                      {billingDate.format(o.receivedAt)}
                    </td>
                    {canAct && (
                      <td className={listClass.td}>
                        <DismissOrphanControl eventId={o.id} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
