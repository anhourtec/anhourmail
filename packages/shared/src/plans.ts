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
  /**
   * Storage for the whole account, in GB, shared by all its mailboxes (2026-10-23: Free 1, Plus and Supporter 10).
   * The mail server enforces quotas per mailbox only, so the account's owners split this pool across mailboxes: the
   * sum of mailbox quotas never exceeds the pool plus purchased blocks (`accountPoolBytes`). Lowering it doesn't
   * shrink existing mailboxes by itself: `job:quota-cap` rebalances them, never below the mail they already hold.
   */
  storagePoolGb: number;
  /** Mailboxes the price includes (Free: its one address; paid plans: `MAX_MAILBOXES`). */
  includedMailboxes: number;
  /** Per extra mailbox beyond `includedMailboxes`, per year; null = none can be added. Sold once billing opens. */
  extraMailboxPrice: Price | null;
  /** Size of one storage block that adds to the account's pool, in GB; null = the plan can't add storage. */
  storageBlockGb: number | null;
  /** Per storage block per year; null = none can be added. Sold once billing opens (blocks are 0 until then). */
  storageBlockPrice: Price | null;
  customDomains: boolean;
  /**
   * Mailboxes on the platform domain (`name@anhourmail.com`) per account. A number caps them on their own (Free: one
   * free address); `null` means they simply count toward `MAX_MAILBOXES` like any other mailbox (paid plans).
   */
  platformMailboxes: number | null;
  /** Other people can be invited into the account (family, a small group). Free accounts have one person. */
  addPeople: boolean;
  /**
   * Aliases, and separately masked aliases, one account may have at a time. `null` = no account-wide count: each
   * mailbox can have up to `ALIASES_PER_MAILBOX` addresses (both kinds together), which applies on every plan.
   */
  aliases: number | null;
  maskedAliases: number | null;
  /**
   * Aliases and, separately, masked aliases one account may create per UTC day (`ALIAS_CREATIONS_PER_DAY`). Counted
   * from creations, not from the aliases that exist, so deleting one gives none back.
   */
  aliasCreationsPerDay: AliasCreationsPerDay;
  /**
   * New aliases and, separately, masked aliases one account may create in any rolling `ALIAS_YEAR_DAYS` days
   * (`ALIAS_CREATIONS_PER_YEAR`); `null` = no yearly cap (paid plans). Counted from creations like the daily cap, so
   * deleting one gives no slot back.
   */
  aliasCreationsPerYear: AliasCreationsPerDay | null;
  catchAll: boolean;
  supporterBadge: boolean;
};

const GB = 1;

export type AliasCreationsPerDay = Readonly<{ alias: number; masked: number }>;

/**
 * Daily creation caps (placeholders until abuse data says otherwise; handoff open items). They stop an account from
 * churning through addresses (create, use once, delete, repeat) that the live-count limits alone would allow. Fails
 * closed: the count is kept in Postgres in the same transaction as the alias. The docs render them
 * (`<AliasCreationLimits />`).
 */
export const ALIAS_CREATIONS_PER_DAY: Readonly<Record<"free" | "paid", AliasCreationsPerDay>> = {
  free: { alias: 10, masked: 20 },
  paid: { alias: 50, masked: 100 },
};

/**
 * Free accounts' yearly creation caps (maintainer decision 2026-10-29): 10 new aliases in any rolling
 * `ALIAS_YEAR_DAYS` days, alongside 10 at a time. Masked aliases are the privacy feature (one per site), so they keep
 * their own at-a-time limit and their own yearly cap of the same shape (placeholder, to confirm). Paid plans have
 * none: `ALIASES_PER_MAILBOX` and the daily cap bound them. Fails closed, counted in Postgres in the create's own
 * transaction. The docs render them (`<Value of="aliasCreationsPerYearFree" />`).
 */
export const ALIAS_CREATIONS_PER_YEAR: Readonly<{ free: AliasCreationsPerDay }> = {
  free: { alias: 10, masked: 20 },
};

/** The rolling window of the yearly caps, in days (today and the 364 before it). */
export const ALIAS_YEAR_DAYS = 365;

/**
 * Aliases and masked aliases together that can point at one mailbox, on every plan (maintainer decision 2026-10-29:
 * "up to 400 addresses per mailbox" on paid plans). With `MAX_MAILBOXES` it also bounds a paid account's total.
 * The docs render it (`<Value of="aliasesPerMailbox" />`).
 */
export const ALIASES_PER_MAILBOX = 400;

/**
 * A plan's alias allowance as the site and docs show it: the number at a time, or (no account-wide count) the
 * per-mailbox cap, which aliases and masked aliases share.
 */
export function aliasAllowance(p: Pick<Plan, "aliases" | "maskedAliases">): { aliases: string; maskedAliases: string } {
  const perMailbox = `${String(ALIASES_PER_MAILBOX)} per mailbox`;
  return {
    aliases: p.aliases === null ? perMailbox : String(p.aliases),
    maskedAliases: p.maskedAliases === null ? `Within the ${perMailbox}` : String(p.maskedAliases),
  };
}

/** Paid plans (2026-10-23): an extra mailbox beyond the ten included, per year. */
const EXTRA_MAILBOX_PRICE: Price = { USD: 100, CAD: 140 };
/** Paid plans: one storage block adds this much to the account's pool. */
const STORAGE_BLOCK_GB = 10;
/** Paid plans: per storage block per year. */
const STORAGE_BLOCK_PRICE: Price = { USD: 1000, CAD: 1400 };

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "An @anhourmail.com address with private-by-default webmail.",
    price: null,
    payWhatYouWant: false,
    storagePoolGb: 1 * GB,
    includedMailboxes: 1,
    extraMailboxPrice: null,
    storageBlockGb: null,
    storageBlockPrice: null,
    customDomains: false,
    platformMailboxes: 1,
    addPeople: false,
    aliases: 10,
    maskedAliases: 10,
    aliasCreationsPerDay: ALIAS_CREATIONS_PER_DAY.free,
    aliasCreationsPerYear: ALIAS_CREATIONS_PER_YEAR.free,
    catchAll: false,
    supporterBadge: false,
  },
  plus: {
    id: "plus",
    name: "Plus",
    tagline: `Bring your own domains, up to ${String(ALIASES_PER_MAILBOX)} aliases per mailbox and more room.`,
    price: { USD: 900, CAD: 1200 },
    payWhatYouWant: false,
    storagePoolGb: 10 * GB,
    includedMailboxes: 10,
    extraMailboxPrice: EXTRA_MAILBOX_PRICE,
    storageBlockGb: STORAGE_BLOCK_GB,
    storageBlockPrice: STORAGE_BLOCK_PRICE,
    customDomains: true,
    platformMailboxes: null,
    addPeople: true,
    aliases: null,
    maskedAliases: null,
    aliasCreationsPerDay: ALIAS_CREATIONS_PER_DAY.paid,
    aliasCreationsPerYear: null,
    catchAll: true,
    supporterBadge: false,
  },
  supporter: {
    id: "supporter",
    name: "Supporter",
    tagline: "Everything in Plus. Pay what you want and fund the free tier.",
    price: { USD: 2000, CAD: 2700 },
    payWhatYouWant: true,
    storagePoolGb: 10 * GB,
    includedMailboxes: 10,
    extraMailboxPrice: EXTRA_MAILBOX_PRICE,
    storageBlockGb: STORAGE_BLOCK_GB,
    storageBlockPrice: STORAGE_BLOCK_PRICE,
    customDomains: true,
    platformMailboxes: null,
    addPeople: true,
    aliases: null,
    maskedAliases: null,
    aliasCreationsPerDay: ALIAS_CREATIONS_PER_DAY.paid,
    aliasCreationsPerYear: null,
    catchAll: true,
    supporterBadge: true,
  },
};

/** Custom domains per account on plans that include them (an abuse ceiling, not a selling point). */
export const MAX_CUSTOM_DOMAINS = 20;

/**
 * How long an unverified custom domain is kept. One already on the mail server (its ownership and MX records were
 * found, so its DKIM keys exist) must be verified within `onMailServerDays` of being added, and keep its ownership and
 * MX records published meanwhile (checked daily), or it is taken off the mail server and removed: an abandoned claim
 * must not hold the name, or its mail, for good. Any other unverified domain is removed after `unverifiedDays`. The
 * docs render both (`<Value of="pendingDomainSetupDays" />`, `<Value of="pendingDomainDays" />`).
 */
export const PENDING_DOMAIN = { onMailServerDays: 14, unverifiedDays: 30 } as const;

/**
 * Mailboxes an account can create today: the ten paid plans include (`includedMailboxes`); they share the account's
 * storage pool (`storagePoolGb`). Extra mailboxes (`extraMailboxPrice`) can't be added until billing exists (Phase 5), so this stays the
 * ceiling until then (docs/internal/06-pricing-and-billing.md).
 */
export const MAX_MAILBOXES = 10;

/**
 * Days a deleted mailbox is kept (suspended, mail intact, address reserved) before it's permanently removed. It can
 * be restored until then. The docs render this number (`<Value of="mailboxDeleteGraceDays" />`).
 */
export const MAILBOX_DELETE_GRACE_DAYS = 30;

/**
 * People per account on plans that can add them, counting pending invites (placeholder ceiling until pricing is
 * decided, like MAX_MAILBOXES). The docs render it (`<Value of="maxPeople" />`).
 */
export const MAX_PEOPLE = 10;

/** Days an invite link works. Resending it issues a new link with a fresh period (`<Value of="inviteDays" />`). */
export const INVITE_TTL_DAYS = 7;

/**
 * Invite emails (first sends and resends) one account may send in 24 hours. Counted from a send log, not from live
 * invites, so revoking and re-inviting doesn't reset it (anti-abuse ceiling; fails closed).
 */
export const INVITE_EMAILS_PER_DAY = 50;

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

/**
 * Storage an account can assign to its mailboxes, in bytes: the plan's pool plus purchased storage blocks (always 0
 * until billing opens, Phase 5).
 */
export function accountPoolBytes(plan: PlanId, storageBlocks = 0): number {
  const p = PLANS[plan];
  const blocks = p.storageBlockGb === null ? 0 : Math.max(0, Math.floor(storageBlocks)) * p.storageBlockGb;
  return (p.storagePoolGb + blocks) * 1024 ** 3;
}

/**
 * The paid plans' storage and extras lines for the pricing page and docs: "10 GB shared by the whole account",
 * "More storage: +10 GB for $10/year (coming with billing)", "Extra mailboxes: $1/year each (coming with billing)".
 */
export function storageText(plan: Plan, currency: Currency = "USD") {
  return {
    pool: `${String(plan.storagePoolGb)} GB shared by the whole account`,
    block:
      plan.storageBlockGb === null || plan.storageBlockPrice === null
        ? null
        : `More storage: +${String(plan.storageBlockGb)} GB for ${formatPrice(plan.storageBlockPrice[currency], currency)}/${BILLING.interval} (coming with billing)`,
    extraMailbox:
      plan.extraMailboxPrice === null
        ? null
        : `Extra mailboxes: ${formatPrice(plan.extraMailboxPrice[currency], currency)}/${BILLING.interval} each (coming with billing)`,
  };
}

/**
 * Account and sending policy published in the docs and enforced later (Phase 6): daily external recipients per
 * mailbox (lower during the first days), message size, and what happens to a free account nobody signs in to.
 */
export const ACCOUNT_POLICY = {
  /** External recipients per mailbox per day. */
  externalRecipientsPerDay: { free: 50, paid: 500 },
  /** Days after sign-up during which the daily cap is lower. */
  newAccountDays: 14,
  /** Largest message a mailbox can send / receive, in MB. */
  sendMessageMb: 25,
  receiveMessageMb: 50,
  /** Free accounts: months without a sign-in before suspension (after email warnings). */
  freeInactivityMonths: 12,
  /** Days a suspended inactive account's mail is kept before it is removed (its name is never reissued). */
  inactiveMailKeptDays: 90,
} as const;
