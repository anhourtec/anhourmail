// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowRight, Check, ChevronDown } from "lucide-react";
import { useId, useState } from "react";

import {
  BILLING,
  type Currency,
  formatPrice,
  MAX_EXTRA_MAILBOXES,
  MAX_STORAGE_BLOCKS,
  type PaidPlanId,
  planHighlights,
  PLANS,
} from "@anhourmail/shared/plans";

import { callApi } from "../api";
import { inputClass, primaryButtonClass } from "../ui-classes";

import { Stepper } from "./stepper";
import { supporterAmountError } from "./supporter-amount";

const timeFmt = new Intl.DateTimeFormat("en-CA", { timeStyle: "short", dateStyle: "medium", timeZone: "UTC" });

/**
 * "Choose a paid plan" (ADR-0029 §9): Plus or Supporter (an amount from the minimum up, whole units), the currency
 * (fixed once the account has paid in one), optional storage blocks and extra mailboxes, and the yearly total before
 * tax. "Continue to payment" asks our server for the payment page and goes there with a top-level navigation (the
 * console never loads the payment processor's scripts); it stays disabled from the first click, so a double click
 * can't start a second checkout.
 */
export function CheckoutForm({
  accountId,
  fixedCurrency,
  pendingUntil,
}: {
  accountId: string;
  /** The account's currency once it has one (the processor locks it). */
  fixedCurrency: Currency | null;
  /** A checkout from the last hour may still be open: when a new one can start. */
  pendingUntil: string | null;
}) {
  const id = useId();
  const [plan, setPlan] = useState<PaidPlanId>("plus");
  const [currency, setCurrency] = useState<Currency>(fixedCurrency ?? "USD");
  const minimum = PLANS.supporter.price?.[currency] ?? 0;
  const [amount, setAmount] = useState(String(minimum / 100));
  const [blocks, setBlocks] = useState(0);
  const [extras, setExtras] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plus = PLANS.plus;
  const amountMinor = Math.round(Number(amount) * 100);
  const amountProblem = plan === "supporter" ? supporterAmountError(currency, amount) : null;
  const planMinor = plan === "plus" ? (plus.price?.[currency] ?? 0) : amountProblem ? 0 : amountMinor;
  const blockMinor = plus.storageBlockPrice?.[currency] ?? 0;
  const extraMinor = plus.extraMailboxPrice?.[currency] ?? 0;
  const total = planMinor + blocks * blockMinor + extras * extraMinor;
  const pending = pendingUntil !== null;

  async function start() {
    if (amountProblem) {
      setError(amountProblem);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await callApi(`/api/accounts/${accountId}/billing/checkout`, {
      method: "POST",
      body: {
        plan,
        currency,
        ...(plan === "supporter" ? { supporterAmountMinor: amountMinor } : {}),
        storageBlocks: blocks,
        extraMailboxes: extras,
      },
    });
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    const url = (res.data as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string") {
      setBusy(false);
      setError("Something went wrong. Try again.");
      return;
    }
    // A top-level navigation to the payment page; the button stays disabled until the page is left.
    window.location.assign(url);
  }

  const card = "rounded-2xl border bg-card p-5 shadow-sm sm:p-6";
  const plusLines = planHighlights(PLANS.plus);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
      className="flex flex-col gap-5"
      noValidate
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Plan</legend>
        <div className="grid items-stretch gap-4 md:grid-cols-2">
          {(["plus", "supporter"] as const).map((p) => {
            const facts = PLANS[p];
            const price = facts.price?.[currency] ?? 0;
            const chosen = plan === p;
            return (
              <label
                key={p}
                className={`relative flex cursor-pointer flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm transition-shadow hover:shadow-md sm:p-6 ${
                  chosen ? "bg-primary/[0.04] ring-2 ring-primary" : ""
                }`}
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="flex items-center gap-2.5">
                    <input
                      type="radio"
                      name={`${id}-plan`}
                      value={p}
                      checked={chosen}
                      onChange={() => {
                        setPlan(p);
                        setError(null);
                      }}
                      className="size-4 accent-[rgb(var(--primary))]"
                    />
                    <span className="font-display font-medium text-[22px] leading-tight">{facts.name}</span>
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 font-medium text-[13px] ${
                      p === "plus" ? "bg-primary text-primary-foreground" : "border bg-background"
                    }`}
                  >
                    {p === "plus" ? "Most people" : "Pay what you want"}
                  </span>
                </span>
                <span className="am-small min-h-[2.5rem]">{facts.tagline}</span>
                <span className="flex items-baseline gap-1.5">
                  {facts.payWhatYouWant && <span className="am-small">from</span>}
                  <span className="am-num font-medium text-[32px] leading-none tracking-tight">
                    {formatPrice(price, currency)}
                  </span>
                  <span className="am-small">/ {BILLING.interval}</span>
                </span>
                <span className="am-micro -mt-2">Per account, covers everyone in it</span>
                <span className="flex flex-col gap-2.5 border-t pt-4">
                  <span className="font-medium text-[14px]">
                    {p === "plus" ? "What's included" : `Everything in ${PLANS.plus.name}, and:`}
                  </span>
                  <span role="list" className="flex flex-col gap-2.5">
                    {(p === "plus" ? plusLines : planHighlights(facts).filter((l) => !plusLines.includes(l))).map(
                      (line) => (
                        <span role="listitem" key={line} className="flex items-center gap-2.5 text-[14px]">
                          <span className="grid size-5 shrink-0 place-content-center rounded-full border border-primary/40 bg-primary/10">
                            <Check className="size-3 text-primary" aria-hidden />
                          </span>
                          <span className="text-muted-foreground">{line}</span>
                        </span>
                      ),
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className={`${card} flex flex-col gap-5`}>
          <div className="flex flex-wrap gap-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-currency`} className="am-h4">
                Currency
              </label>
              {fixedCurrency ? (
                <p id={`${id}-currency`} className="am-num flex h-10 items-center text-[15px]">
                  {fixedCurrency}
                  <span className="am-small ml-2">(this account pays in {fixedCurrency})</span>
                </p>
              ) : (
                <div className="relative w-32">
                  <select
                    id={`${id}-currency`}
                    value={currency}
                    onChange={(e) => {
                      const c = e.target.value as Currency;
                      setCurrency(c);
                      setAmount(String((PLANS.supporter.price?.[c] ?? 0) / 100));
                    }}
                    className={`${inputClass} am-num w-32 cursor-pointer appearance-none pr-10`}
                  >
                    {BILLING.currencies.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                </div>
              )}
            </div>
            {plan === "supporter" && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${id}-amount`} className="am-h4">
                  Supporter amount a {BILLING.interval}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id={`${id}-amount`}
                    inputMode="numeric"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setError(null);
                    }}
                    aria-describedby={`${id}-amount-hint`}
                    aria-invalid={amountProblem !== null}
                    className={`${inputClass} am-num w-32`}
                  />
                  <span className="am-num text-[15px]">{currency}</span>
                </div>
                <span id={`${id}-amount-hint`} className={`am-micro ${amountProblem ? "text-destructive" : ""}`}>
                  {amountProblem ??
                    `At least ${formatPrice(minimum, currency)}, whole amounts only. Everything above Plus funds the free plan.`}
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 border-t pt-5">
            <p className="am-h4">Add-ons (optional)</p>
            <Stepper
              label={`Storage blocks (+${String(plus.storageBlockGb ?? 0)} GB each, ${formatPrice(blockMinor, currency)}/${BILLING.interval})`}
              value={blocks}
              max={MAX_STORAGE_BLOCKS}
              onChange={setBlocks}
            />
            <Stepper
              label={`Extra mailboxes beyond the ${String(plus.includedMailboxes)} included (${formatPrice(extraMinor, currency)}/${BILLING.interval} each)`}
              value={extras}
              max={MAX_EXTRA_MAILBOXES}
              onChange={setExtras}
            />
          </div>
        </div>

        <div className={`${card} flex flex-col gap-4 lg:sticky lg:top-20`}>
          <p className="am-h4">Summary</p>
          <dl className="flex flex-col gap-2 text-[14px]">
            <div className="flex justify-between gap-3">
              <dt>{PLANS[plan].name}</dt>
              <dd className="am-num">{formatPrice(planMinor, currency)}</dd>
            </div>
            {blocks > 0 && (
              <div className="flex justify-between gap-3">
                <dt>
                  Storage blocks × <span className="am-num">{blocks}</span>
                </dt>
                <dd className="am-num">{formatPrice(blocks * blockMinor, currency)}</dd>
              </div>
            )}
            {extras > 0 && (
              <div className="flex justify-between gap-3">
                <dt>
                  Extra mailboxes × <span className="am-num">{extras}</span>
                </dt>
                <dd className="am-num">{formatPrice(extras * extraMinor, currency)}</dd>
              </div>
            )}
          </dl>
          <p className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-4">
            <span className="am-h4">First {BILLING.interval}</span>
            <span className="am-num font-medium text-[22px]" data-testid="checkout-total">
              {formatPrice(total, currency)}
            </span>
          </p>
          <p className="am-micro">
            Before tax, which the payment page adds for your address. Renews every {BILLING.interval}; there&apos;s no
            trial ({PLANS.free.name} is the trial). You can ask for a refund within {BILLING.refundWindowDays} days of
            paying.
          </p>
          {pending && (
            <p role="status" className="am-small">
              A checkout was started in the last hour. Finish it on the payment page, or start a new one after{" "}
              <span className="am-num">{timeFmt.format(new Date(pendingUntil))} UTC</span>. If you already paid, your
              plan shows here within a minute.
            </p>
          )}
          {error && (
            <p role="alert" className="am-small text-destructive">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || pending} className={`${primaryButtonClass} w-full`}>
            {busy ? "Opening the payment page…" : "Continue to payment"}
            {!busy && <ArrowRight className="size-4" aria-hidden />}
          </button>
          <p className="am-micro text-center">You pay on the payment processor&apos;s secure page.</p>
        </div>
      </div>
    </form>
  );
}
