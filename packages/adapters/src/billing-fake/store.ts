// SPDX-License-Identifier: AGPL-3.0-only
/**
 * State of the fake billing provider (ADR-0029 §3): in memory for unit tests, in Redis in dev so the web app and the
 * worker see the same fake processor. Plain JSON (times in epoch milliseconds). Holds no personal data: customers are
 * known by account id only.
 */
import type { InvoiceStatus, ProviderInvoice, ProviderSubStatus } from "@anhourmail/core/billing";
import type { Currency, PaidPlanId } from "@anhourmail/shared/plans";

export type FakeCustomer = { id: string; accountId: string; currency: Currency | null; cardFails: boolean };

export type FakeSubscription = {
  id: string;
  customerId: string;
  accountId: string;
  status: ProviderSubStatus;
  plan: PaidPlanId;
  currency: Currency;
  planAmountMinor: number;
  storageBlocks: number;
  extraMailboxes: number;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  latestInvoiceId: string | null;
};

export type FakeInvoice = {
  id: string;
  subscriptionId: string;
  customerId: string;
  status: InvoiceStatus;
  amountMinor: number;
  currency: Currency;
  paidAt: number | null;
  billingReason: ProviderInvoice["billingReason"];
  refundedMinor: number;
  /**
   * What a charge on the card paid (absent: the whole amount once paid). 0 models an invoice paid from the credit
   * balance or out of band (ADR-0034, finding F8).
   */
  chargedMinor?: number;
  /** The add-on quantities and period end the invoice billed (absent on states saved before they were recorded). */
  storageBlocks?: number;
  extraMailboxes?: number;
  periodEnd?: number;
  /** The payment behind the invoice: disputes and refunds refer to it, like the processor's objects do. */
  paymentIntentId: string;
  chargeId: string;
  dispute: { id: string; status: "open" | "won" | "lost" | "warning_closed" } | null;
};

export type FakeCheckout = {
  id: string;
  accountId: string;
  customerId: string;
  currency: Currency;
  plan: PaidPlanId;
  planAmountMinor: number;
  storageBlocks: number;
  extraMailboxes: number;
  status: "open" | "complete";
  createdAt: number;
};

/** An event the fake emitted and hasn't delivered yet (the dev simulate route signs and posts them). */
export type FakeEvent = {
  id: string;
  type: string;
  created: number;
  objectId: string;
  objectKind: string;
  /** The customer the event is about (a dispute's body still carries none, like the processor's). */
  customerId: string;
  /** The payment a dispute or charge object refers to. */
  paymentIntentId?: string;
  chargeId?: string;
  accountId: string;
};

export type FakeBillingState = {
  /** The test-clock analogue: added to the real clock. */
  offsetMs: number;
  seq: number;
  customers: Record<string, FakeCustomer>;
  subscriptions: Record<string, FakeSubscription>;
  invoices: Record<string, FakeInvoice>;
  checkouts: Record<string, FakeCheckout>;
  /** Idempotency keys already applied (action:intentId → the object id it produced). */
  applied: Record<string, string>;
  outbox: FakeEvent[];
};

export const emptyFakeBillingState = (): FakeBillingState => ({
  offsetMs: 0,
  seq: 0,
  customers: {},
  subscriptions: {},
  invoices: {},
  checkouts: {},
  applied: {},
  outbox: [],
});

/**
 * Read-modify-write over the whole state. `update` is atomic: concurrent updates (the web app and the worker) never
 * lose a write; a throw in `fn` writes nothing.
 */
export type FakeBillingStore = {
  read(): Promise<FakeBillingState>;
  update<T>(fn: (s: FakeBillingState) => T): Promise<T>;
};

/** In-process store for unit tests (single-threaded, so each update is atomic). */
export function memoryFakeBillingStore(initial: FakeBillingState = emptyFakeBillingState()): FakeBillingStore {
  let state = initial;
  return {
    read: async () => structuredClone(state),
    update: async (fn) => {
      const draft = structuredClone(state);
      const out = fn(draft);
      state = draft;
      return out;
    },
  };
}

/** The Redis commands the store uses (ioredis satisfies it). */
export type FakeStoreRedis = {
  mget(...keys: string[]): Promise<(string | null)[]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

/** Compare-and-set on a version counter, in one Lua call: a concurrent writer makes the caller retry. */
const CAS_SCRIPT =
  "local v = redis.call('GET', KEYS[2]) or '0' " +
  "if v ~= ARGV[1] then return 0 end " +
  "redis.call('SET', KEYS[1], ARGV[2]) " +
  "redis.call('SET', KEYS[2], tostring(tonumber(v) + 1)) " +
  "return 1";

const MAX_ATTEMPTS = 20;

/** Dev store in Redis under `am:billing-fake:*` (dev only; the fake is never built in production). */
export function redisFakeBillingStore(redis: FakeStoreRedis, prefix = "am:billing-fake"): FakeBillingStore {
  const stateKey = `${prefix}:state`;
  const versionKey = `${prefix}:version`;
  const load = async (): Promise<{ state: FakeBillingState; version: string }> => {
    const [raw, version] = await redis.mget(stateKey, versionKey);
    const state: FakeBillingState = raw
      ? { ...emptyFakeBillingState(), ...(JSON.parse(raw) as Partial<FakeBillingState>) }
      : emptyFakeBillingState();
    return { state, version: version ?? "0" };
  };
  return {
    read: async () => (await load()).state,
    update: async (fn) => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const { state, version } = await load();
        const out = fn(state);
        const ok = await redis.eval(CAS_SCRIPT, 2, stateKey, versionKey, version, JSON.stringify(state));
        if (Number(ok) === 1) return out;
      }
      throw new Error("fake billing store: too many concurrent updates");
    },
  };
}
