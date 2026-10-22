// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plans, prices and limits. The one place they are defined: the console enforces them, the marketing
 * pricing table and the docs render them, and billing maps them to Stripe Prices by `id` + currency.
 * Changing a value here is a user-facing change: update docs/public and the changelog (CLAUDE.md rule 31).
 */

export type Currency = "USD" | "CAD";
export type PlanId = "free" | "plus" | "supporter";

/** Amounts are in minor units (cents) per year. */
export type Price = Readonly<Record<Currency, number>>;

export type Plan = {
  id: PlanId;
  name: string;
  tagline: string;
  /** Fixed annual price, or the minimum for pay-what-you-want. `null` = free. */
  price: Price | null;
  payWhatYouWant: boolean;
  storageGb: number;
  customDomains: boolean;
  /** `null` = unlimited. */
  aliases: number | null;
  maskedAliases: number | null;
  catchAll: boolean;
  supporterBadge: boolean;
};

const GB = 1;

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "An @anhourmail.com address with private-by-default webmail.",
    price: null,
    payWhatYouWant: false,
    storageGb: 10 * GB,
    customDomains: false,
    aliases: 5,
    maskedAliases: 10,
    catchAll: false,
    supporterBadge: false,
  },
  plus: {
    id: "plus",
    name: "Plus",
    tagline: "Bring your own domains, unlimited aliases and more room.",
    price: { USD: 1200, CAD: 1500 },
    payWhatYouWant: false,
    storageGb: 30 * GB,
    customDomains: true,
    aliases: null,
    maskedAliases: null,
    catchAll: true,
    supporterBadge: false,
  },
  supporter: {
    id: "supporter",
    name: "Supporter",
    tagline: "Everything in Plus. Pay what you want and fund the free tier.",
    price: { USD: 2400, CAD: 3000 },
    payWhatYouWant: true,
    storageGb: 30 * GB,
    customDomains: true,
    aliases: null,
    maskedAliases: null,
    catchAll: true,
    supporterBadge: true,
  },
};

/** Custom domains per account on plans that include them (an abuse ceiling, not a selling point). */
export const MAX_CUSTOM_DOMAINS = 20;

/**
 * Mailboxes per account; each gets up to the plan's `storageGb` (placeholder until pricing is decided — see
 * docs/internal/06-pricing-and-billing.md).
 */
export const MAX_MAILBOXES = 10;

/**
 * Aliases (and, separately, masked aliases) per account on plans listed as unlimited: an abuse ceiling, not a
 * selling point. Plans with a number use that number.
 */
export const ALIAS_CEILING = 1000;

export const PLAN_ORDER: readonly PlanId[] = ["free", "plus", "supporter"];

export type AddOnId = "bulk";

export type AddOn = {
  id: AddOnId;
  name: string;
  tagline: string;
  /** `planned` add-ons are shown as coming soon and cannot be bought yet. */
  status: "planned" | "available";
  /** Base plans it can be added to. */
  requires: readonly PlanId[];
  /** Annual price per volume tier; null while planned (set when it becomes available). */
  price: Price | null;
  /** Monthly recipient volume tiers (each recipient counts once per message). */
  monthlyRecipientTiers: readonly number[];
};

/**
 * Paid add-ons. Newsletters and bulk mail are not allowed on base plans (sending.ts BULK_MAIL); this add-on is
 * the only way to send them: separate sending domain + IP pool, consent records (CASL), one-click unsubscribe.
 */
export const ADDONS: Readonly<Record<AddOnId, AddOn>> = {
  bulk: {
    id: "bulk",
    name: "Newsletters and bulk sending",
    tagline: "Send to lists that opted in, from a separate sending pool, with unsubscribe built in.",
    status: "planned",
    requires: ["plus", "supporter"],
    price: null,
    monthlyRecipientTiers: [5_000, 25_000, 100_000],
  },
};

export const BILLING = {
  interval: "year",
  currencies: ["USD", "CAD"] as const satisfies readonly Currency[],
  refundWindowDays: 14,
  /** Paid plans have no trial: the free tier is the trial. */
  trialDays: 0,
} as const;

export function formatPrice(amountMinor: number, currency: Currency): string {
  return new Intl.NumberFormat(currency === "CAD" ? "en-CA" : "en-US", {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
    minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
  }).format(amountMinor / 100);
}
