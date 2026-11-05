// SPDX-License-Identifier: AGPL-3.0-only
import {
  ArrowRight,
  ArrowUpRight,
  Ban,
  Check,
  CreditCard,
  FlaskConical,
  Info,
  RotateCcw,
  Ticket,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { can } from "@anhourmail/core";
import { type BillingOverview, billingOverview } from "@anhourmail/core/billing";
import { BILLING, formatPrice, planHighlights, PLANS } from "@anhourmail/shared/plans";
import { PageHeader } from "@anhourmail/ui/page-header";

import { AddonsForm } from "@/components/billing/addons-form";
import { BillingTabs } from "@/components/billing/billing-tabs";
import { CheckoutForm } from "@/components/billing/checkout-form";
import { CheckoutReturn } from "@/components/billing/checkout-return";
import { ConfirmAction } from "@/components/billing/confirm-action";
import { HoldsChooser } from "@/components/billing/holds-chooser";
import { BILLING_STATE_LABELS, billingDate, gigabytes, PLAN_SOURCE_LABELS } from "@/components/billing/labels";
import { PlanForm } from "@/components/billing/plan-form";
import { PortalButton } from "@/components/billing/portal-button";
import { RedeemCode } from "@/components/billing/redeem-code";
import { UsageMeter } from "@/components/billing/usage-meter";
import { StatusText } from "@/components/console/status-text";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";
import { billingContext, billingOffered } from "@/server/billing";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { forPage } from "@/server/page-guard";

export const metadata: Metadata = { title: "Billing" };

/** The page's cards: one surface, rounded like the console's dialogs. */
const card = "rounded-2xl border bg-card p-5 shadow-sm sm:p-6";

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
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="am-h3">
          {title}
        </h2>
        {description && <p className="am-small max-w-[80ch]">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** A note across the page: an icon and a sentence or two (test mode, read-only, what the state means). */
function Notice({
  icon,
  tone = "neutral",
  children,
  testId,
}: {
  icon: ReactNode;
  tone?: "neutral" | "warning";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={`flex max-w-[90ch] items-start gap-3 rounded-xl border px-4 py-3 ${
        tone === "warning"
          ? "border-[rgb(var(--am-status-warning)/0.4)] bg-[rgb(var(--am-status-warning)/0.06)]"
          : "bg-muted/40"
      }`}
    >
      <span
        className={`mt-0.5 shrink-0 ${tone === "warning" ? "text-[rgb(var(--am-status-warning))]" : "text-muted-foreground"}`}
      >
        {icon}
      </span>
      <p className="am-small text-foreground" data-testid={testId}>
        {children}
      </p>
    </div>
  );
}

/** A label and its value inside a card (renewal date, where the plan comes from, currency). */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="am-small">{label}</dt>
      <dd className="text-[15px] break-words">{children}</dd>
    </div>
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
 * The account's Billing page (ADR-0029 §9): an overview with the plan card (plan, state, price, renewal and the
 * cancel / refund actions) next to the usage card (meters against the plan; the address ceiling itself is never
 * shown), then what's on hold after a lapse with "Choose what stays on", the plan cards to subscribe, add-ons and plan
 * changes with a preview and an explicit confirmation before any charge, the payment portal (card and invoices), and
 * redeeming a code. Owners and Billing Administrators manage; Auditors and staff acting read-only see it without
 * actions. While paid plans aren't open (`BILLING.status` planned, or billing off) nothing here can be bought.
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
  const owed = o.state === "past_due" || restrictedForPayment;
  const choosing = manage && canCheckout;
  const changing = manage && live && o.paidPlan !== null;

  // The plan card's big figure: what the subscription costs a year, $0 on Free, or no charge for a granted plan.
  const price =
    o.plan === "free"
      ? formatPrice(0, currency)
      : live && o.planAmountMinor !== null
        ? formatPrice(o.planAmountMinor, currency)
        : null;
  const priceNote =
    o.plan === "free"
      ? plan.tagline
      : price !== null
        ? `For the plan, before tax and add-ons. Billed every ${BILLING.interval}.`
        : "Given to this account, with nothing to pay.";

  return (
    <>
      <PageHeader
        title="Billing"
        description="Your plan and payments. Invoices and receipts are in the payment portal."
        breadcrumbs={crumbs}
      />
      <BillingTabs accountId={accountId} current="plan" />

      {returned && offered && <CheckoutReturn outcome={returned} settled={live} />}

      {!offered ? (
        <Notice icon={<Info className="size-4" aria-hidden />} testId="billing-not-open">
          Paid plans open soon. Until then every account is on the plan it has now, and nothing here can be bought:
          storage blocks, extra mailboxes and the {PLANS.plus.name} and {PLANS.supporter.name} plans come with billing.
        </Notice>
      ) : (
        o.status === "planned" &&
        test && (
          <Notice icon={<FlaskConical className="size-4" aria-hidden />}>
            Paid plans aren&apos;t open to customers yet. This server uses a test payment setup: no real card is
            charged.
          </Notice>
        )
      )}
      {offered && !manage && (
        <Notice icon={<Info className="size-4" aria-hidden />}>
          {actor.actingAs
            ? "Anhourtec support access is read-only: billing can be seen here, not changed."
            : "Your role can see billing but not change it. Owners and Billing Administrators can."}
        </Notice>
      )}

      <section aria-labelledby="overview-title" className="flex flex-col gap-4">
        <h2 id="overview-title" className="am-h3">
          Overview
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {/* The plan */}
          <div className={`${card} relative flex flex-col gap-5 overflow-hidden`}>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.07] via-transparent to-transparent"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -top-20 -right-20 size-56 rounded-full bg-primary/10 blur-3xl"
            />
            <div className="relative flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-2">
                <span className="am-small">Current plan</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="rounded-full border bg-background px-2.5 py-0.5 font-medium text-[14px]">
                    {plan.name}
                  </span>
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
                {price !== null ? (
                  <p className="flex items-baseline gap-1.5">
                    <span className="am-num font-medium text-[34px] leading-tight tracking-tight">{price}</span>
                    <span className="am-small">/ {BILLING.interval}</span>
                  </p>
                ) : (
                  <p className="font-display font-medium text-[28px] leading-tight tracking-tight">No charge</p>
                )}
                <p className="am-small max-w-[46ch]">{priceNote}</p>
              </div>
              {choosing && (o.state === "free" || o.state === "lapsed" || o.planSource === "comp") && (
                <a href="#choose" className={primaryButtonClass}>
                  {o.state === "lapsed" ? "See plans" : "Upgrade"}
                  <ArrowUpRight className="size-4" aria-hidden />
                </a>
              )}
              {changing && (
                <a href="#change-plan" className={secondaryButtonClass}>
                  Change plan
                </a>
              )}
            </div>

            <dl className="relative grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4">
              {live && o.currentPeriodEnd && (
                <Fact label={o.cancelAt ? "Ends on" : "Renews on"}>
                  <span className="am-num">{billingDate.format(o.currentPeriodEnd)}</span>
                </Fact>
              )}
              {o.planSource === "comp" && o.compUntil && (
                <Fact label="Complimentary until">
                  <span className="am-num">{billingDate.format(o.compUntil)}</span>
                </Fact>
              )}
              <Fact label="Where it comes from">{PLAN_SOURCE_LABELS[o.planSource]}</Fact>
              {o.currency && <Fact label="Currency">{o.currency}</Fact>}
              {o.state !== "free" && (
                <Fact label="Since">
                  <span className="am-num">{billingDate.format(o.stateSince)}</span>
                </Fact>
              )}
            </dl>

            {manage && (live || o.refund.mayBeEligible) && (
              <div className="relative flex flex-wrap items-start gap-3 border-t pt-4">
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
                      . Then the account moves to {PLANS.free.name}: one mailbox on the platform domain stays fully on,
                      and the rest is held (sign-in, reading and export keep working; nothing is deleted). You can undo
                      this until then.
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
                      The last plan payment is refunded in full (tax included) and the plan ends now. The account moves
                      to {PLANS.free.name}; what doesn&apos;t fit is held, never deleted.
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
          </div>

          {/* What the plan includes, and usage at a glance (the full picture is on Usage) */}
          <div className={`${card} flex flex-col gap-5`}>
            <div className="flex flex-col gap-2.5">
              <h3 className="am-h4">Included in {plan.name}</h3>
              <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {planHighlights(plan).map((line) => (
                  <li key={line} className="flex items-center gap-2.5 text-[14px]">
                    <span className="grid size-5 shrink-0 place-content-center rounded-full border border-primary/40 bg-primary/10">
                      <Check className="size-3 text-primary" aria-hidden />
                    </span>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-auto flex flex-col gap-4 border-t pt-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="am-small">Usage at a glance</h3>
                <Link
                  href={`/accounts/${accountId}/billing/usage`}
                  className="inline-flex items-center gap-1.5 text-[14px] text-primary underline-offset-2 hover:underline"
                >
                  See usage
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </div>
              <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <UsageMeter label="Mailboxes" used={o.usage.mailboxes} limit={o.usage.mailboxCeiling} />
                <UsageMeter
                  label="Storage given to mailboxes"
                  used={o.usage.assignedBytes}
                  limit={o.usage.poolBytes}
                  usedText={gigabytes(o.usage.assignedBytes)}
                  limitText={gigabytes(o.usage.poolBytes)}
                />
              </div>
            </div>
          </div>
        </div>

        {why && (
          <Notice icon={<TriangleAlert className="size-4" aria-hidden />} tone="warning" testId="billing-why">
            {why}
          </Notice>
        )}
        {o.cancelAt && (
          <p className="am-small max-w-[80ch]">
            Cancelled: the plan stays until <span className="am-num">{billingDate.format(o.cancelAt)}</span>, then the
            account moves to {PLANS.free.name}. Anything that doesn&apos;t fit {PLANS.free.name} is held, never deleted.
          </p>
        )}
      </section>

      {o.state === "lapsed" && (
        <Section
          id="holds"
          title="On hold"
          description={`What doesn't fit ${PLANS.free.name}. Held mailboxes can't send; they keep receiving for ${String(BILLING.heldReceiveDays)} days after the plan ended, and sign-in, reading and export never stop. Nothing is deleted.`}
        >
          <div className={`${card} flex flex-col gap-5`}>
            {o.holds.length === 0 ? (
              <p className="am-small">Nothing is on hold.</p>
            ) : (
              <ul className="flex flex-col" data-testid="billing-holds">
                {o.holds.map((h) => (
                  <li
                    key={`${h.subjectType}:${h.subjectId}`}
                    className="flex min-h-[46px] flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b py-2 last:border-b-0"
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
              <div className="flex flex-col gap-2 border-t pt-5">
                <h3 className="am-h4">Choose what stays on</h3>
                <HoldsChooser accountId={accountId} choices={o.holdChoices} />
              </div>
            )}
          </div>
        </Section>
      )}

      {choosing && (
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

      {changing && o.paidPlan && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <section id="addons" aria-labelledby="addons-title" className={`${card} flex scroll-mt-20 flex-col gap-4`}>
            <div className="flex flex-col gap-1">
              <h2 id="addons-title" className="am-h3">
                Storage and extra mailboxes
              </h2>
              <p className="am-small">
                Adding is charged now for the rest of this period; you see the amount and confirm it first.
              </p>
            </div>
            <AddonsForm
              accountId={accountId}
              currency={currency}
              renewal={o.renewal}
              restricted={restrictedForPayment}
            />
          </section>
          <section
            id="change-plan"
            aria-labelledby="change-plan-title"
            className={`${card} flex scroll-mt-20 flex-col gap-4`}
          >
            <div className="flex flex-col gap-1">
              <h2 id="change-plan-title" className="am-h3">
                Change plan
              </h2>
              <p className="am-small">
                Switch between {PLANS.plus.name} and {PLANS.supporter.name}, or change what you pay as a Supporter. It
                applies now and the price changes at renewal.
              </p>
            </div>
            <PlanForm accountId={accountId} currency={currency} plan={o.paidPlan} amountMinor={o.planAmountMinor} />
          </section>
        </div>
      )}

      {manage && o.portal && (
        <section
          aria-labelledby="payment-title"
          className={`${card} flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between`}
        >
          <div className="flex items-start gap-4">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <CreditCard className="size-5" aria-hidden />
            </span>
            <div className="flex flex-col gap-1">
              <h2 id="payment-title" className="am-h4">
                Payment and invoices
              </h2>
              <p className="am-small max-w-[62ch]">
                Your card, billing address and tax ids, and every invoice and receipt, are kept by the payment
                processor. Open the portal to change the card or download an invoice; we never see the card number.
              </p>
            </div>
          </div>
          <PortalButton
            accountId={accountId}
            primary={owed}
            label={restrictedForPayment ? "Pay the open invoice" : "Manage payment and invoices"}
          />
        </section>
      )}

      {canManage && (o.state === "free" || o.state === "lapsed") && (
        <section aria-labelledby="redeem-title" className={`${card} flex flex-col gap-4`}>
          <div className="flex items-start gap-4">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Ticket className="size-5" aria-hidden />
            </span>
            <div className="flex flex-col gap-1">
              <h2 id="redeem-title" className="am-h4">
                Redeem a code
              </h2>
              <p className="am-small max-w-[62ch]">
                A code from Anhourtec can give this account a paid plan for a while, with no card. It works once.
              </p>
            </div>
          </div>
          <RedeemCode accountId={accountId} />
        </section>
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
