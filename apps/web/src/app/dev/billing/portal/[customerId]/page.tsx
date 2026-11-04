// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { FakeBillingActions } from "@/components/dev/fake-billing-actions";

import { loadDevObject, money } from "../../dev-billing-page";

export const metadata: Metadata = { title: "Fake billing portal (dev)", robots: { index: false } };

/**
 * Dev only: the fake provider's customer portal plus the controls a test clock gives (ADR-0029 §3): a failing card,
 * advancing the fake clock, retries running out, cancelling at period end, refunds and disputes. Each action's events
 * go through the real webhook; the worker's sync then changes the account.
 */
export default async function FakePortalPage({ params }: { params: Promise<{ customerId: string }> }) {
  await connection();
  const { customerId } = await params;
  const view = await loadDevObject("customer", customerId);
  const sub = view.subscription;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-2">
        <p className="am-small font-mono">Development only: no payment is taken</p>
        <h1 className="am-h1">Fake billing portal</h1>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border p-4 text-sm">
        <dt>Fake clock</dt>
        <dd className="font-mono">{view.now.toISOString().slice(0, 10)}</dd>
        <dt>Card</dt>
        <dd data-testid="fake-card">{view.cardFails ? "Fails" : "Works"}</dd>
        <dt>Subscription</dt>
        <dd className="font-mono" data-testid="fake-subscription-status">
          {sub ? sub.status : "none"}
        </dd>
        {sub && (
          <>
            <dt>Plan</dt>
            <dd>
              {sub.plan === "plus" ? "Plus" : "Supporter"} ·{" "}
              <span className="font-mono">{money(sub.yearMinor, sub.currency)}</span> a year
            </dd>
            <dt>Renews</dt>
            <dd className="font-mono" data-testid="fake-renewal">
              {sub.cancelAtPeriodEnd ? "Cancels" : "Renews"} {sub.periodEnd.toISOString().slice(0, 10)}
            </dd>
            <dt>Latest invoice</dt>
            <dd className="font-mono">
              {sub.latestInvoice
                ? `${sub.latestInvoice.status} ${money(sub.latestInvoice.amountMinor, sub.currency)}${sub.latestInvoice.refundedMinor > 0 ? " (refunded)" : ""}`
                : "none"}
            </dd>
            <dt>Dispute</dt>
            <dd className="font-mono">{sub.dispute ?? "none"}</dd>
          </>
        )}
      </dl>
      <FakeBillingActions
        target={{ customerId }}
        actions={[
          {
            action: sub?.cancelAtPeriodEnd ? "undo_cancel" : "cancel_at_period_end",
            label: sub?.cancelAtPeriodEnd ? "Don't cancel" : "Cancel at period end",
          },
          {
            action: view.cardFails ? "card_works" : "card_fails",
            label: view.cardFails ? "Card works again" : "Card fails from now",
          },
          { action: "advance_clock", label: "Advance clock", days: true },
          { action: "exhaust_retries", label: "Exhaust retries" },
          { action: "pay_open_invoice", label: "Pay open invoice" },
          { action: "pause", label: "Pause" },
          { action: "refund", label: "Refund (outside the console)" },
          { action: "open_dispute", label: "Open dispute" },
          { action: "close_dispute_won", label: "Dispute won" },
          { action: "close_dispute_lost", label: "Dispute lost" },
        ]}
      />
      <Link href="/" className="w-fit font-medium text-primary underline underline-offset-2">
        Back to the console
      </Link>
    </main>
  );
}
