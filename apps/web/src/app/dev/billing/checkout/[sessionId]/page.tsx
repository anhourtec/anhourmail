// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { FakeBillingActions } from "@/components/dev/fake-billing-actions";

import { loadDevObject, money } from "../../dev-billing-page";

export const metadata: Metadata = { title: "Fake checkout (dev)", robots: { index: false } };

/**
 * Dev only: the fake provider's checkout (ADR-0029 §3). "Pay" completes the session (the subscription and its first
 * invoice), "Decline card" leaves it open; the events go through the real webhook, and the worker's sync does the rest.
 */
export default async function FakeCheckoutPage({ params }: { params: Promise<{ sessionId: string }> }) {
  await connection();
  const { sessionId } = await params;
  const view = await loadDevObject("checkout", sessionId);
  const cs = view.checkout;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-2">
        <p className="am-small font-mono">Development only: no payment is taken</p>
        <h1 className="am-h1">Fake checkout</h1>
      </div>
      {cs && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border p-4 text-sm">
          <dt>Plan</dt>
          <dd>{cs.plan === "plus" ? "Plus" : "Supporter"}</dd>
          <dt>Storage blocks</dt>
          <dd className="font-mono">{cs.storageBlocks}</dd>
          <dt>Extra mailboxes</dt>
          <dd className="font-mono">{cs.extraMailboxes}</dd>
          <dt>First year (before tax)</dt>
          <dd className="font-mono">{money(cs.totalMinor, cs.currency)}</dd>
          <dt>Session</dt>
          <dd className="break-all font-mono">{cs.id}</dd>
        </dl>
      )}
      {cs?.open ? (
        <FakeBillingActions
          target={{ sessionId }}
          actions={[
            { action: "pay", label: "Pay", primary: true },
            { action: "decline", label: "Decline card" },
          ]}
          after={{ pay: `/dev/billing/portal/${encodeURIComponent(view.customerId)}?checkout=done` }}
        />
      ) : (
        <p className="am-small">This checkout is no longer open.</p>
      )}
      <Link href="/" className="w-fit font-medium text-primary underline underline-offset-2">
        Back to the console
      </Link>
    </main>
  );
}
