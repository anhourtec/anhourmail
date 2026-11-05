// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState } from "react";

import { BILLING, type Currency, formatPrice, type PaidPlanId, PLANS } from "@anhourmail/shared/plans";

import { inputClass } from "../ui-classes";

import { ChangeForm } from "./change-form";
import { supporterAmountError } from "./supporter-amount";

/**
 * Switch between Plus and Supporter, or change the Supporter amount (ADR-0029 §9): the features switch now, the price
 * changes at renewal, so nothing is charged now. Previewed and confirmed like every change.
 */
export function PlanForm({
  accountId,
  currency,
  plan,
  amountMinor,
}: {
  accountId: string;
  currency: Currency;
  plan: PaidPlanId;
  /** The plan's yearly amount now (the Supporter amount, or the Plus price). */
  amountMinor: number | null;
}) {
  const id = useId();
  const [next, setNext] = useState<PaidPlanId>(plan);
  const minimum = PLANS.supporter.price?.[currency] ?? 0;
  const startAmount = plan === "supporter" && amountMinor !== null ? amountMinor : minimum;
  const [amount, setAmount] = useState(String(startAmount / 100));
  const problem = next === "supporter" ? supporterAmountError(currency, amount) : null;
  const minor = Math.round(Number(amount) * 100);
  const changed = next !== plan || (next === "supporter" && minor !== (amountMinor ?? 0));
  const priceText =
    next === "plus"
      ? formatPrice(PLANS.plus.price?.[currency] ?? 0, currency)
      : problem
        ? "the amount you choose"
        : formatPrice(minor, currency);
  return (
    <ChangeForm
      accountId={accountId}
      body={{ plan: next, ...(next === "supporter" && !problem ? { supporterAmountMinor: minor } : {}) }}
      changed={changed && problem === null}
      renewalText={`${PLANS[next].name} applies now and renews at ${priceText} a ${BILLING.interval}.`}
      fields={(edited) => (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-wrap gap-4">
            <legend className="sr-only">Plan</legend>
            {(["plus", "supporter"] as const).map((p) => (
              <label key={p} className="flex items-center gap-2 text-[15px]">
                <input
                  type="radio"
                  name={`${id}-plan`}
                  checked={next === p}
                  onChange={() => {
                    setNext(p);
                    edited();
                  }}
                  className="accent-[rgb(var(--primary))]"
                />
                {PLANS[p].name}
              </label>
            ))}
          </fieldset>
          {next === "supporter" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-amount`} className="am-small text-foreground">
                Supporter amount a {BILLING.interval}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={`${id}-amount`}
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    edited();
                  }}
                  aria-invalid={problem !== null}
                  aria-describedby={`${id}-amount-hint`}
                  className={`${inputClass} am-num w-32`}
                />
                <span className="am-num">{currency}</span>
              </div>
              <span id={`${id}-amount-hint`} className={`am-micro ${problem ? "text-destructive" : ""}`}>
                {problem ?? `At least ${formatPrice(minimum, currency)}, whole amounts only.`}
              </span>
            </div>
          )}
        </div>
      )}
    />
  );
}
