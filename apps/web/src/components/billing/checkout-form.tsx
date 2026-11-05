// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowRight } from "lucide-react";
import { useId, useState } from "react";

import {
  BILLING,
  type Currency,
  formatPrice,
  MAX_EXTRA_MAILBOXES,
  MAX_STORAGE_BLOCKS,
  type PaidPlanId,
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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
      className="flex max-w-3xl flex-col gap-5"
      noValidate
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="am-h4 mb-2">Plan</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["plus", "supporter"] as const).map((p) => {
            const facts = PLANS[p];
            const price = facts.price?.[currency] ?? 0;
            return (
              <label
                key={p}
                className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-4 transition-colors ${
                  plan === p ? "border-primary bg-primary/5" : "hover:bg-accent"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-plan`}
                    value={p}
                    checked={plan === p}
                    onChange={() => {
                      setPlan(p);
                      setError(null);
                    }}
                    className="accent-[rgb(var(--primary))]"
                  />
                  <span className="font-medium text-[15px]">{facts.name}</span>
                </span>
                <span className="am-num text-[14px]">
                  {facts.payWhatYouWant ? "From " : ""}
                  {formatPrice(price, currency)}/{BILLING.interval}
                </span>
                <span className="am-small">{facts.tagline}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

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
            <select
              id={`${id}-currency`}
              value={currency}
              onChange={(e) => {
                const c = e.target.value as Currency;
                setCurrency(c);
                setAmount(String((PLANS.supporter.price?.[c] ?? 0) / 100));
              }}
              className={`${inputClass} w-32`}
            >
              {BILLING.currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
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

      <div className="flex flex-col gap-3">
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

      <div className="flex flex-col gap-1 rounded-xl border px-4 py-3">
        <p className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="am-h4">First {BILLING.interval}</span>
          <span className="am-num font-medium text-[17px]" data-testid="checkout-total">
            {formatPrice(total, currency)}
          </span>
        </p>
        <p className="am-micro">
          Before tax, which the payment page adds for your address. Renews every {BILLING.interval}; there&apos;s no
          trial ({PLANS.free.name} is the trial). You can ask for a refund within {BILLING.refundWindowDays} days of
          paying.
        </p>
      </div>

      {pending && (
        <p role="status" className="am-small">
          A checkout was started in the last hour. Finish it on the payment page, or start a new one after{" "}
          <span className="am-num">{timeFmt.format(new Date(pendingUntil))} UTC</span>. If you already paid, your plan
          shows here within a minute.
        </p>
      )}
      {error && (
        <p role="alert" className="am-small text-destructive">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || pending} className={`${primaryButtonClass} w-fit`}>
        {busy ? "Opening the payment page…" : "Continue to payment"}
        {!busy && <ArrowRight className="size-4" aria-hidden />}
      </button>
    </form>
  );
}
