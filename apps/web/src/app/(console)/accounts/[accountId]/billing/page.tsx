// SPDX-License-Identifier: AGPL-3.0-only
import { Ban, RotateCcw, Undo2 } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { can } from "@anhourmail/core";
import { type BillingOverview, billingOverview } from "@anhourmail/core/billing";
import { BILLING, formatPrice, PLANS } from "@anhourmail/shared/plans";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AddonsForm } from "@/components/billing/addons-form";
import { CheckoutForm } from "@/components/billing/checkout-form";
import { CheckoutReturn } from "@/components/billing/checkout-return";
import { ConfirmAction } from "@/components/billing/confirm-action";
import { HoldsChooser } from "@/components/billing/holds-chooser";
import { BILLING_STATE_LABELS, billingDate, gigabytes, PLAN_SOURCE_LABELS } from "@/components/billing/labels";
import { PlanForm } from "@/components/billing/plan-form";
import { PortalButton } from "@/components/billing/portal-button";
import { Field, FieldGrid } from "@/components/console/flyout";
import { StatusText } from "@/components/console/status-text";
import { billingContext, billingOffered } from "@/server/billing";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Billing" };

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="am-h3">
          {title}
        </h2>
        {description && <p className="am-small max-w-[80ch]">{description}</p>}
      </div>
      {children}
    </section>
  );
}

const STEP_UP_WHY = "Billing changes need your console password.";

/** What the account's state means, in a sentence or two (shown under the plan). */
function stateText(o: BillingOverview): string | null {
  switch (o.state) {
    case "past_due":
      return "A renewal payment failed. The payment processor is trying the card again; nothing changes for the account meanwhile. Update the card to settle it sooner.";
    case "restricted":
      return o.disputed
        ? "A payment is disputed with the card issuer, so sending is paused for every mailbox. Receiving, reading and exporting still work. Our support team handles disputes: reply to the email we sent, or contact support."
        : `Sending is paused for every mailbox because the payment couldn't be collected. Receiving, reading and exporting still work. Pay the open invoice in the payment portal to turn sending back on; after ${String(BILLING.restrictedDays)} days unpaid the plan ends and the account moves to ${PLANS.free.name}.`;
    case "lapsed":
      return `The paid plan ended. The account is on ${PLANS.free.name}, and what doesn't fit ${PLANS.free.name} is on hold: nothing is deleted. Subscribe again to bring everything back.`;
    default:
      return null;
  }
}

/**
 * The account's Billing page (ADR-0029 §9): the plan and its state, renewal, usage against the plan (the address
 * ceiling itself is never shown), choosing a paid plan, add-ons and plan changes with a preview and an explicit
 * confirmation before any charge, cancelling and the one self-service refund behind the password step-up, the payment
 * portal (card and invoices), and after a lapse what's on hold with "Choose what stays on". Owners and Billing
 * Administrators manage; Auditors and staff acting read-only see it without actions. While paid plans aren't open
 * (`BILLING.status` planned, or billing off) nothing here can be bought.
 */
export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ checkout?: string | string[] }>;
}) {
  const { accountId } = await params;
  const { checkout } = await searchParams;
  const actor = await requireUser();
  const o = await forPage(() => billingOverview(container().deps, billingContext(), actor, accountId));
  const crumbs = [{ label: "Home", href: "/" }, { label: "Billing" }];
  if (!o) {
    return (
      <>
        <PageHeader title="Billing" breadcrumbs={crumbs} />
        <p className="am-body">Your role in this account doesn&apos;t include billing.</p>
      </>
    );
  }
  const { offered, test } = billingOffered(o.status, o.available);
  // Owners and Billing Administrators; never staff acting read-only. Buying needs paid plans offered here.
  const canManage = actor.actingAs === undefined && can(actor, "billing.manage", accountId);
  const manage = offered && canManage;
  const plan = PLANS[o.plan];
  const label = BILLING_STATE_LABELS[o.state];
  const live =
    o.planSource === "stripe" && (o.state === "active" || o.state === "past_due" || o.state === "restricted");
  const canCheckout = o.checkoutBlocked !== "already_subscribed";
  const currency = o.currency ?? "USD";
  const docs = `${env().SITE_URL.replace(/\/$/, "")}/docs/billing`;
  const returned = checkout === "done" || checkout === "cancelled" ? checkout : null;
  const why = stateText(o);
  const restrictedForPayment = o.state === "restricted" && !o.disputed;

  return (
    <>
      <PageHeader
        title="Billing"
        description="Your plan, what the account uses, and payments. Invoices and receipts are in the payment portal."
        breadcrumbs={crumbs}
      />

      {returned && offered && <CheckoutReturn outcome={returned} settled={live} />}

      {!offered ? (
        <p className="am-small max-w-[80ch] rounded-lg border px-4 py-3" data-testid="billing-not-open">
          Paid plans open soon. Until then every account is on the plan it has now, and nothing here can be bought:
          storage blocks, extra mailboxes and the {PLANS.plus.name} and {PLANS.supporter.name} plans come with billing.
        </p>
      ) : (
        o.status === "planned" &&
        test && (
          <p className="am-small max-w-[80ch] rounded-lg border px-4 py-3">
            Paid plans aren&apos;t open to customers yet. This server uses a test payment setup: no real card is
            charged.
          </p>
        )
      )}
      {offered && !manage && (
        <p className="am-small">
          {actor.actingAs
            ? "Anhourtec support access is read-only: billing can be seen here, not changed."
            : "Your role can see billing but not change it. Owners and Billing Administrators can."}
        </p>
      )}

      <Section id="plan" title="Your plan">
        <FieldGrid>
          <Field label="Plan">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{plan.name}</span>
              {o.state === "free" ? (
                <span className="sr-only" data-testid="billing-state">
                  {label.text}
                </span>
              ) : (
                <StatusText tone={label.tone}>
                  <span data-testid="billing-state">{label.text}</span>
                </StatusText>
              )}
            </span>
          </Field>
          <Field label="Where it comes from">{PLAN_SOURCE_LABELS[o.planSource]}</Field>
          {live && o.currentPeriodEnd && (
            <Field label={o.cancelAt ? "Ends on" : "Renews on"}>
              <span className="am-num">{billingDate.format(o.currentPeriodEnd)}</span>
              {!o.cancelAt && o.planAmountMinor !== null && (
                <span className="am-small block">
                  {formatPrice(o.planAmountMinor, currency)}/{BILLING.interval} for the plan, before tax and add-ons
                </span>
              )}
            </Field>
          )}
          {o.planSource === "comp" && o.compUntil && (
            <Field label="Complimentary until">
              <span className="am-num">{billingDate.format(o.compUntil)}</span>
            </Field>
          )}
          {o.currency && <Field label="Currency">{o.currency}</Field>}
          {o.state !== "free" && (
            <Field label="Since">
              <span className="am-num">{billingDate.format(o.stateSince)}</span>
            </Field>
          )}
        </FieldGrid>
        {why && (
          <p className="am-small max-w-[80ch] rounded-lg border px-4 py-3 text-foreground" data-testid="billing-why">
            {why}
          </p>
        )}
        {o.cancelAt && (
          <p className="am-small max-w-[80ch]">
            Cancelled: the plan stays until <span className="am-num">{billingDate.format(o.cancelAt)}</span>, then the
            account moves to {PLANS.free.name}. Anything that doesn&apos;t fit {PLANS.free.name} is held, never deleted.
          </p>
        )}
        {manage && (
          <div className="flex flex-wrap items-start gap-3">
            {o.portal && (
              <PortalButton
                accountId={accountId}
                primary={o.state === "past_due" || restrictedForPayment}
                label={restrictedForPayment ? "Pay the open invoice" : "Manage payment and invoices"}
              />
            )}
            {live && o.cancelAt && (
              <ConfirmAction
                label="Undo the cancellation"
                icon={<Undo2 className="size-4" aria-hidden />}
                title="Keep the plan"
                confirmLabel="Keep my plan"
                url={`/api/accounts/${accountId}/billing/undo-cancel`}
                why={STEP_UP_WHY}
                done="The plan renews as before. It shows here within a minute."
              >
                <p>The subscription renews on its date as before.</p>
              </ConfirmAction>
            )}
            {live && !o.cancelAt && (
              <ConfirmAction
                label="Cancel the plan"
                icon={<Ban className="size-4" aria-hidden />}
                tone="danger"
                title="Cancel at the end of the period"
                confirmLabel="Cancel at period end"
                url={`/api/accounts/${accountId}/billing/cancel`}
                why={STEP_UP_WHY}
                done="Cancelled at period end. It shows here within a minute."
              >
                <p>
                  Nothing changes until{" "}
                  <span className="am-num">
                    {o.currentPeriodEnd ? billingDate.format(o.currentPeriodEnd) : "the end of this period"}
                  </span>
                  . Then the account moves to {PLANS.free.name}: one mailbox on the platform domain stays fully on, and
                  the rest is held (sign-in, reading and export keep working; nothing is deleted). You can undo this
                  until then.
                </p>
              </ConfirmAction>
            )}
            {o.refund.mayBeEligible && (
              <ConfirmAction
                label="Ask for a refund"
                icon={<RotateCcw className="size-4" aria-hidden />}
                tone="danger"
                title="Refund and end the plan now"
                confirmLabel="Refund and end the plan"
                url={`/api/accounts/${accountId}/billing/refund`}
                why={STEP_UP_WHY}
                done="Refunded. The plan ended; the account shows on Free within a minute."
              >
                <p>
                  The last plan payment is refunded in full (tax included) and the plan ends now. The account moves to{" "}
                  {PLANS.free.name}; what doesn&apos;t fit is held, never deleted.
                </p>
                <p>
                  Each account can do this once, within {BILLING.refundWindowDays} days of paying
                  {o.refund.windowEndsAt ? (
                    <>
                      {" "}
                      (until <span className="am-num">{billingDate.format(o.refund.windowEndsAt)}</span>)
                    </>
                  ) : null}
                  . Add-on charges and later refunds go through support.
                </p>
              </ConfirmAction>
            )}
          </div>
        )}
      </Section>

      <Section id="usage" title="What the account uses">
        <ul className="flex max-w-xl flex-col border-t" data-testid="billing-usage">
          <li className="flex min-h-[46px] items-center justify-between gap-3 border-b px-1 py-2">
            <span>Mailboxes</span>
            <span className="am-num">
              {o.usage.mailboxes} of {o.usage.mailboxCeiling}
            </span>
          </li>
          {plan.addPeople && (
            <li className="flex min-h-[46px] items-center justify-between gap-3 border-b px-1 py-2">
              <span>People</span>
              <span className="am-num">
                {o.usage.people} of {o.usage.peopleCeiling}
              </span>
            </li>
          )}
          <li className="flex min-h-[46px] items-center justify-between gap-3 border-b px-1 py-2">
            <span>Storage given to mailboxes</span>
            <span className="am-num">
              {gigabytes(o.usage.assignedBytes)} of {gigabytes(o.usage.poolBytes)}
            </span>
          </li>
          <li className="flex min-h-[46px] items-center justify-between gap-3 border-b px-1 py-2">
            <span>Addresses (mailboxes and aliases)</span>
            <span className="am-num">{o.usage.addresses}</span>
          </li>
        </ul>
        {(o.entitled.storageBlocks > 0 || o.entitled.extraMailboxes > 0) && (
          <p className="am-small">
            Add-ons in force: <span className="am-num">{o.entitled.storageBlocks}</span> storage{" "}
            {o.entitled.storageBlocks === 1 ? "block" : "blocks"} and{" "}
            <span className="am-num">{o.entitled.extraMailboxes}</span> extra{" "}
            {o.entitled.extraMailboxes === 1 ? "mailbox" : "mailboxes"}.
          </p>
        )}
        {o.usage.addressesNearCeiling && (
          <p className="am-small max-w-[80ch]" data-testid="billing-address-ceiling">
            This account is close to the number of addresses one account can have. Contact support if you need more: we
            can raise it.
          </p>
        )}
      </Section>

      {o.state === "lapsed" && (
        <Section
          id="holds"
          title="On hold"
          description={`What doesn't fit ${PLANS.free.name}. Held mailboxes can't send; they keep receiving for ${String(BILLING.heldReceiveDays)} days after the plan ended, and sign-in, reading and export never stop. Nothing is deleted.`}
        >
          {o.holds.length === 0 ? (
            <p className="am-small">Nothing is on hold.</p>
          ) : (
            <ul className="flex max-w-2xl flex-col border-t" data-testid="billing-holds">
              {o.holds.map((h) => (
                <li
                  key={`${h.subjectType}:${h.subjectId}`}
                  className="flex min-h-[46px] flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-1 py-2"
                >
                  <span className="font-mono text-[14px] break-all">{h.label ?? "Removed"}</span>
                  <span className="am-small">
                    {h.subjectType === "mailbox"
                      ? h.receiveUntil
                        ? `Receiving until ${billingDate.format(h.receiveUntil)}; reading and export stay on`
                        : "Read and export only"
                      : h.subjectType === "domain"
                        ? "Domain kept; no catch-all, no new addresses"
                        : "Alias off (mail to it is refused)"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {manage && o.holdChoices && (
            <div className="flex flex-col gap-2">
              <h3 className="am-h4">Choose what stays on</h3>
              <HoldsChooser accountId={accountId} choices={o.holdChoices} />
            </div>
          )}
        </Section>
      )}

      {manage && canCheckout && (
        <Section
          id="choose"
          title={o.state === "lapsed" ? "Subscribe again" : "Choose a paid plan"}
          description={
            o.planSource === "comp"
              ? "A subscription replaces the complimentary period at once; days left on it aren't credited."
              : o.state === "lapsed"
                ? "Everything on hold comes back as soon as the payment goes through."
                : "Custom domains, more mailboxes and people, and shared storage for the whole account."
          }
        >
          <CheckoutForm
            accountId={accountId}
            fixedCurrency={o.currency}
            pendingUntil={o.checkoutPendingUntil?.toISOString() ?? null}
          />
        </Section>
      )}

      {manage && live && o.paidPlan && (
        <>
          <Section
            id="addons"
            title="Storage and extra mailboxes"
            description="Adding is charged now for the rest of this period; you see the amount and confirm it first."
          >
            <AddonsForm
              accountId={accountId}
              currency={currency}
              renewal={o.renewal}
              restricted={restrictedForPayment}
            />
          </Section>
          <Section
            id="change-plan"
            title="Change plan"
            description={`Switch between ${PLANS.plus.name} and ${PLANS.supporter.name}, or change what you pay as a Supporter. It applies now and the price changes at renewal.`}
          >
            <PlanForm accountId={accountId} currency={currency} plan={o.paidPlan} amountMinor={o.planAmountMinor} />
          </Section>
        </>
      )}

      <p className="am-small">
        Plans, payments, refunds and what happens when a payment fails are explained in the{" "}
        <a href={docs} className="text-primary underline-offset-2 hover:underline">
          billing guide
        </a>
        .
      </p>
    </>
  );
}
