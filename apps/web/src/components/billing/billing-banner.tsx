// SPDX-License-Identifier: AGPL-3.0-only
import { CreditCard, TriangleAlert } from "lucide-react";
import Link from "next/link";

import type { BillingNotice } from "@anhourmail/core/billing";
import { PLANS } from "@anhourmail/shared/plans";

import { billingDate } from "./labels";

/**
 * Above every console page of an account whose billing needs attention (ADR-0029 §9; who sees it: `accountBillingNotice`).
 * People who can fix it get the link to Billing; everyone else is told who can.
 */
export function BillingBanner({ notice, billingHref }: { notice: BillingNotice; billingHref: string }) {
  const danger = notice.state === "restricted";
  const fixer = "An Owner or Billing Administrator of this account can fix it.";
  let title: string;
  let body: string;
  let action: string | null = null;
  switch (notice.state) {
    case "past_due":
      title = "A payment failed";
      body =
        "The renewal payment didn't go through. The payment processor is trying the card again; nothing has changed yet.";
      action = notice.canManage ? "Update the card on the Billing page" : notice.canRead ? "See Billing" : null;
      break;
    case "restricted":
      title = "Sending is paused";
      body =
        notice.reason === "dispute"
          ? "A payment is disputed with the card issuer, so no mailbox in this account can send. Receiving, reading and exporting still work."
          : `The payment couldn't be collected, so no mailbox in this account can send. Receiving, reading and exporting still work.${
              notice.endsAt
                ? ` Unless it's paid by ${billingDate.format(notice.endsAt)}, the account moves to ${PLANS.free.name}.`
                : ""
            }`;
      if (!notice.canManage) body += ` ${fixer}`;
      action = notice.canManage
        ? notice.reason === "dispute"
          ? "See Billing"
          : "Pay the open invoice on the Billing page"
        : notice.canRead
          ? "See Billing"
          : null;
      break;
    case "lapsed":
      title = "The paid plan ended";
      body = `This account is on ${PLANS.free.name}. What doesn't fit is on hold, not deleted: held mailboxes can't send, but sign-in, reading and export keep working.`;
      if (!notice.canManage) body += ` ${fixer}`;
      action = notice.canManage ? "Choose what stays on, or subscribe again" : notice.canRead ? "See Billing" : null;
      break;
  }
  const Icon = danger ? TriangleAlert : CreditCard;
  return (
    <section
      role="status"
      aria-labelledby="billing-banner-title"
      data-testid="billing-banner"
      className={`flex flex-col gap-2 rounded-xl border p-4 ${
        danger ? "border-destructive/40 bg-destructive/5" : "border-[rgb(var(--am-status-warning))]/40"
      }`}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={`mt-0.5 size-5 shrink-0 ${danger ? "text-destructive" : "text-[rgb(var(--am-status-warning))]"}`}
          aria-hidden
        />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="billing-banner-title" className="am-h4 break-words">
            {title}
          </h2>
          <p className="am-small text-foreground">{body}</p>
          {action && (
            <Link href={billingHref} className="am-small w-fit text-primary underline-offset-2 hover:underline">
              {action}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
