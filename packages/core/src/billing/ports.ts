// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The billing provider port (ADR-0029 §1). Two adapters implement it: the payment processor over plain `fetch`
 * (`packages/adapters/src/billing-stripe`) and a fake for unit tests and dev (`packages/adapters/src/billing-fake`).
 * Both pass the shared contract suite (`packages/adapters/src/contract/billing-provider.contract.ts`). Core never
 * imports a vendor SDK (ADR-0008, rule 38).
 */
import type { Currency, PaidPlanId } from "@anhourmail/shared/plans";

import type { InvoiceStatus } from "./entity";

export type ProviderSubStatus =
  "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "paused" | "trialing";

export const PROVIDER_SUB_STATUSES: readonly ProviderSubStatus[] = [
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
  "trialing",
];

export type ProviderInvoice = {
  id: string;
  status: InvoiceStatus;
  amountMinor: number;
  paidAt: Date | null;
  /** First invoice, a renewal, or anything else (add-on proration, manual). */
  billingReason: "subscription_create" | "subscription_cycle" | "other";
  refundedMinor: number;
  /**
   * The add-on quantities the invoice billed (its storage-block and extra-mailbox lines), or null when they can't be
   * read: a paid first or renewal invoice sets the capacity paid for the period from these, never from the live
   * subscription (which may have changed since it was billed).
   */
  storageBlocks: number | null;
  extraMailboxes: number | null;
  /** The end of the period the invoice's lines bill, or null when it can't be read. */
  periodEnd: Date | null;
};

/** The provider's view of an account's subscription, read fresh on every sync (never trusted from a webhook). */
export type ProviderSubscription = {
  subscriptionId: string;
  customerId: string;
  status: ProviderSubStatus;
  /** Mapped from the plan item's price or product; an unknown item is `catalogue_drift`. */
  plan: PaidPlanId;
  currency: Currency;
  /** Plus price or the Supporter amount, per year, tax-exclusive. */
  planAmountMinor: number;
  storageBlocks: number;
  extraMailboxes: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  /** Set when cancelling at period end. */
  cancelAt: Date | null;
  latestInvoice: ProviderInvoice | null;
  /** An open dispute (or inquiry) on the latest invoice's payment. */
  disputed: boolean;
  /** A dispute on the latest invoice's payment was lost (the payer got the money back): stays restricted (§5). */
  disputeLost: boolean;
  /**
   * The disputes on the latest invoice's payment, by id, with their outcome (what `disputed` and `disputeLost` sum up).
   * The sync uses the ids to honour a staff clear: a dispute staff cleared doesn't restrict again just because the
   * provider still reports it on the latest payment. Absent (older fixtures): the two flags alone decide.
   */
  latestDisputes?: readonly { id: string; status: DisputeOutcome }[];
};

/**
 * A dispute's state as the provider reports it. `open` covers every unresolved status (and any status we don't know,
 * so an unknown one never lifts a restriction); `warning_closed` is an inquiry closed without a chargeback.
 */
export type DisputeOutcome = "open" | "won" | "lost" | "warning_closed";

/** A dispute read from the provider: its outcome and the customer its payment belongs to. */
export type ProviderDispute = {
  id: string;
  status: DisputeOutcome;
  /** Through the disputed payment (the dispute object itself carries no customer); null when the payment has none. */
  customerId: string | null;
  paymentIntentId: string | null;
};

export type CheckoutInput = {
  accountId: string;
  customerId: string;
  currency: Currency;
  plan: PaidPlanId;
  /** Supporter only; validated by the service (`supporterAmountProblem`). */
  supporterAmountMinor?: number;
  storageBlocks: number;
  extraMailboxes: number;
  successUrl: string;
  cancelUrl: string;
  /** Feeds the idempotency key: a retried request never creates a second session. */
  intentId: string;
};

export type SubscriptionChange = {
  subscriptionId: string;
  intentId: string;
  plan?: PaidPlanId;
  supporterAmountMinor?: number;
  storageBlocks?: number;
  extraMailboxes?: number;
  /** Increases are charged now, prorated; decreases and plan switches renew at the new figure. */
  proration: "charge_now" | "none";
};

/** The minimal, verified shape of a provider event: a trigger for a sync, never applied as data. */
export type ProviderEvent = {
  id: string;
  type: string;
  createdAt: Date;
  livemode: boolean;
  /** The object's customer. Null for dispute events: a dispute names only its payment (resolve with `getDispute`). */
  customerId: string | null;
  objectId: string;
  /** The payment the object refers to (disputes and charges), for resolving events that carry no customer. */
  paymentIntentId: string | null;
  chargeId: string | null;
  /** `metadata.account_id` or the checkout's reference: a cross-check only, never trusted alone. */
  accountIdHint: string | null;
};

export type CatalogueItem = "plus" | "storage_block" | "extra_mailbox" | "supporter_product";

export const CATALOGUE_ITEMS: readonly CatalogueItem[] = [
  "plus",
  "storage_block",
  "extra_mailbox",
  "supporter_product",
];

/** One way the provider's catalogue disagrees with `plans.ts` (the facts are the source; the provider must match). */
export type CatalogueDrift = { item: CatalogueItem; problem: string };

export type BillingProviderErrorCode =
  | "unavailable"
  | "rate_limited"
  | "card_declined"
  | "invalid_request"
  | "not_found"
  | "catalogue_drift"
  /** More than one live subscription for one customer: the sync refuses to guess (ADR-0029 §4). */
  | "multiple_subscriptions";

/**
 * A provider call failed. `unavailable` and `rate_limited` are our outage or theirs: callers retry and change nothing
 * (an outage never restricts a customer). The message never carries request bodies or personal data.
 */
export class BillingProviderError extends Error {
  constructor(
    readonly code: BillingProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BillingProviderError";
  }

  get retryable(): boolean {
    return this.code === "unavailable" || this.code === "rate_limited";
  }
}

export type WebhookRejectReason =
  | "missing_header"
  | "malformed_header"
  | "timestamp_out_of_tolerance"
  | "no_matching_signature"
  | "malformed_event"
  | "livemode_mismatch";

/** A webhook failed verification. Answered `400 bad_signature`; logged with the reason only, never the body. */
export class WebhookRejected extends Error {
  constructor(readonly reason: WebhookRejectReason) {
    super(`webhook rejected: ${reason}`);
    this.name = "WebhookRejected";
  }
}

export type BillingProvider = {
  readonly kind: "stripe" | "fake";
  /** Creates the provider customer for an account (once; the service stores the id). */
  ensureCustomer(i: { accountId: string; email: string; name: string }): Promise<{ customerId: string }>;
  createCheckout(i: CheckoutInput): Promise<{ url: string }>;
  createPortalSession(i: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** The one live, non-terminal subscription, or null (none, or only cancelled/expired ones). */
  getSubscription(customerId: string): Promise<ProviderSubscription | null>;
  previewChange(c: SubscriptionChange): Promise<{ amountDueNowMinor: number; currency: Currency }>;
  changeSubscription(c: SubscriptionChange): Promise<ProviderSubscription>;
  /**
   * Ends the subscription at the period's end, or now. With `voidOpenInvoices` (only with `now`: an account being
   * deleted), its open invoices are voided first, so a failed renewal can never be collected after it ended.
   */
  cancel(i: {
    subscriptionId: string;
    when: "period_end" | "now";
    intentId: string;
    voidOpenInvoices?: boolean;
  }): Promise<void>;
  undoCancel(i: { subscriptionId: string; intentId: string }): Promise<void>;
  refundInvoice(i: { invoiceId: string; intentId: string }): Promise<{ amountMinor: number; currency: Currency }>;
  /** Verifies the raw body against the signature header at `now`; throws `WebhookRejected`. */
  verifyWebhook(rawBody: string, signatureHeader: string | null, now: Date): ProviderEvent;
  /** The provider's prices against `plans.ts`; empty = in sync. */
  checkCatalogue(): Promise<readonly CatalogueDrift[]>;
  /**
   * A dispute's outcome and customer, read fresh: the sync passes the outcome of each dispute-closed event to
   * `deriveBilling`, and ingestion resolves dispute events (which carry no customer) to an account. Unknown: not_found.
   */
  getDispute(disputeId: string): Promise<ProviderDispute>;
};

/** Dispute event types: their object is a dispute, which names a payment, not a customer. */
export const DISPUTE_EVENT_TYPES: readonly string[] = ["charge.dispute.created", "charge.dispute.closed"];

/** Live (non-terminal) subscription statuses: the ones `getSubscription` may return. */
export const isLiveSubStatus = (s: ProviderSubStatus): boolean => s !== "canceled" && s !== "incomplete_expired";

/**
 * Event types the webhook route records (ADR-0029 §4); anything else is answered 200 and dropped.
 */
export const HANDLED_EVENT_TYPES: readonly string[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "customer.deleted",
];
