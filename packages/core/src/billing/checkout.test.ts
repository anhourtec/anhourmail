// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing overview, checkout and the portal (ADR-0029 §9, slice 8) against the in-memory repositories and the fake
 * provider: permission (403) and scope (404) for every service, act-as refused, billing off (503), a provider outage
 * audited and changing nothing, the provider customer created once, the one-hour pending checkout, the currency fixed,
 * the email confirmation, URLs only from the expected origins, and the audit entries in the same unit of work.
 */
import { describe, expect, it } from "vitest";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "../../../adapters/src/billing-fake";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  actAs,
  actingStaff,
  deps as makeDeps,
  fixedClock,
  req,
  user,
} from "../__tests__/helpers";

import {
  billingOverview,
  CHECKOUT_PENDING_MS,
  checkoutIntentId,
  openBillingPortal,
  parseCheckout,
  startCheckout,
} from "./checkout";
import { BillingError } from "./entitlements";
import { assertRedirect, type BillingContext, providerError } from "./guards";
import { defaultBilling } from "./lifecycle";
import { type BillingProvider, BillingProviderError } from "./ports";

const APP = "http://localhost:43200";
const owner = user({ id: "owner-1", account: [[ACCOUNT_A, "owner"]] });
const billingAdmin = user({ id: "billing-1", account: [[ACCOUNT_A, "billing_admin"]] });
const auditor = user({ id: "auditor-1", account: [[ACCOUNT_A, "auditor"]] });
const member = user({ id: "member-1", account: [[ACCOUNT_A, "member"]] });
const outsider = user({ id: "outsider-1", account: [[ACCOUNT_B, "owner"]] });

function world(opts: { plan?: "free" | "plus" } = {}) {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  d.uow.state.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: opts.plan ?? "free" });
  d.uow.state.accounts.push({ id: ACCOUNT_B, name: "Other", plan: "free" });
  const fake = createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: APP,
    webhookSecret: fakeWebhookSecret("checkout-test"),
    clock: () => clock.now(),
    nodeEnv: "test",
  });
  const ctx: BillingContext = { provider: fake, appUrl: APP, redirectOrigins: [APP], paidPlansOpen: true };
  const audit = (action: string) => d.uow.state.audit.filter((e) => e.action === action);
  return { clock, d, fake, ctx, audit };
}

const plus = { plan: "plus", currency: "USD" } as const;

describe("parseCheckout", () => {
  it("accepts Plus and Supporter within the public facts", () => {
    expect(parseCheckout({ plan: "plus", currency: "CAD", storageBlocks: 2 })).toMatchObject({
      plan: "plus",
      currency: "CAD",
      storageBlocks: 2,
      extraMailboxes: 0,
    });
    const s = parseCheckout({ plan: "supporter", currency: "USD", supporterAmountMinor: 5000 });
    expect(s).toMatchObject({ plan: "supporter", amountMinor: 5000, supporterAmountMinor: 5000 });
  });

  it.each([
    [{ plan: "free", currency: "USD" }, "Choose Plus or Supporter."],
    [{ plan: "plus", currency: "EUR" }, "Choose USD or CAD."],
    [{ plan: "plus", currency: "USD", storageBlocks: -1 }, "Storage blocks"],
    [{ plan: "plus", currency: "USD", extraMailboxes: 1.5 }, "Extra mailboxes"],
    [{ plan: "plus", currency: "USD", storageBlocks: 999 }, "Storage blocks"],
    [{ plan: "plus", currency: "USD", supporterAmountMinor: 5000 }, "only with the Supporter plan"],
    [{ plan: "supporter", currency: "USD" }, "how much"],
    [{ plan: "supporter", currency: "USD", supporterAmountMinor: 1 }, "whole amount"],
    [{ plan: "supporter", currency: "USD", supporterAmountMinor: 100 }, "Choose an amount from"],
    [{ plan: "supporter", currency: "USD", supporterAmountMinor: 100_000_000 }, "Choose an amount from"],
  ])("refuses %j", (input, message) => {
    expect(() => parseCheckout(input)).toThrow(message);
  });

  it("gives the same intent for the same request within the hour and state, a new one after either changes", () => {
    const c = parseCheckout(plus);
    const t = new Date("2026-11-05T10:00:00Z");
    const since = new Date("2026-01-01T00:00:00Z");
    expect(checkoutIntentId(ACCOUNT_A, c, t, since)).toBe(
      checkoutIntentId(ACCOUNT_A, c, new Date(t.getTime() + 60_000), since),
    );
    expect(checkoutIntentId(ACCOUNT_A, c, t, since)).not.toBe(
      checkoutIntentId(ACCOUNT_A, c, new Date(t.getTime() + 3_600_000), since),
    );
    expect(checkoutIntentId(ACCOUNT_A, c, t, since)).not.toBe(checkoutIntentId(ACCOUNT_B, c, t, since));
    expect(checkoutIntentId(ACCOUNT_A, c, t, since)).not.toBe(checkoutIntentId(ACCOUNT_A, c, t, new Date(1)));
    expect(checkoutIntentId(ACCOUNT_A, c, t, since)).not.toBe(
      checkoutIntentId(ACCOUNT_A, parseCheckout({ ...plus, storageBlocks: 1 }), t, since),
    );
  });
});

describe("startCheckout", () => {
  it("creates the provider customer once, returns the fake checkout URL, marks it pending and audits it", async () => {
    const { d, ctx, audit, fake } = world();
    const out = await startCheckout(d, ctx, owner, ACCOUNT_A, { ...plus, extraMailboxes: 2 }, req);
    expect(out.url).toMatch(new RegExp(`^${APP}/dev/billing/checkout/`));
    const row = d.uow.state.billing.find((b) => b.accountId === ACCOUNT_A);
    expect(row?.providerCustomerId).toMatch(/^cus_fake_/);
    expect(row?.checkoutPendingUntil?.getTime()).toBe(new Date("2026-11-05T10:00:00Z").getTime() + CHECKOUT_PENDING_MS);
    expect(row?.state).toBe("free"); // the plan starts only when the sync sees it paid
    expect(audit("billing.customer_created")).toHaveLength(1);
    const [started] = audit("billing.checkout_started");
    expect(started?.result).toBe("success");
    expect(started?.meta).toMatchObject({ plan: "plus", currency: "USD", extraMailboxes: 2, storageBlocks: 0 });
    expect(JSON.stringify(started?.meta)).not.toContain("example.test"); // never the payer's email
    const view = await fake.describe("checkout", out.url.split("/").pop() ?? "");
    expect(view).toMatchObject({ accountId: ACCOUNT_A, checkout: { plan: "plus", extraMailboxes: 2, open: true } });
  });

  it("refuses a second checkout within the hour (409 checkout_pending), allows one after it, same customer", async () => {
    const { d, ctx, clock, audit } = world();
    await startCheckout(d, ctx, owner, ACCOUNT_A, plus, req);
    const customer = d.uow.state.billing.find((b) => b.accountId === ACCOUNT_A)?.providerCustomerId;
    await expect(startCheckout(d, ctx, billingAdmin, ACCOUNT_A, plus, req)).rejects.toMatchObject({
      code: "checkout_pending",
    });
    expect(audit("billing.checkout_started").filter((e) => e.result === "denied")).toHaveLength(1);
    clock.set(new Date(clock.now().getTime() + CHECKOUT_PENDING_MS + 1000));
    await startCheckout(d, ctx, billingAdmin, ACCOUNT_A, plus, req);
    expect(d.uow.state.billing.find((b) => b.accountId === ACCOUNT_A)?.providerCustomerId).toBe(customer);
    expect(audit("billing.customer_created")).toHaveLength(1);
  });

  it("refuses an account that already pays (409 already_subscribed), but lets a comp subscribe", async () => {
    const { d, ctx } = world({ plan: "plus" });
    await expect(startCheckout(d, ctx, owner, ACCOUNT_A, plus, req)).rejects.toMatchObject({
      code: "already_subscribed",
    });
    d.uow.state.billing.push({
      ...defaultBilling(ACCOUNT_A, "plus", d.clock.now()),
      planSource: "comp",
      compUntil: new Date("2027-01-01"),
    });
    await expect(startCheckout(d, ctx, owner, ACCOUNT_A, plus, req)).resolves.toHaveProperty("url");
  });

  it("keeps the account's currency once it has one", async () => {
    const { d, ctx } = world();
    d.uow.state.billing.push({ ...defaultBilling(ACCOUNT_A, "free", d.clock.now()), currency: "CAD", state: "lapsed" });
    await expect(startCheckout(d, ctx, owner, ACCOUNT_A, plus, req)).rejects.toThrow("This account pays in CAD.");
    await expect(startCheckout(d, ctx, owner, ACCOUNT_A, { ...plus, currency: "CAD" }, req)).resolves.toHaveProperty(
      "url",
    );
  });

  it("needs a confirmed console email (403 email_unverified, audited denied)", async () => {
    const { d, ctx, audit } = world();
    d.uow.state.unverifiedEmails.push(owner.userId);
    await expect(startCheckout(d, ctx, owner, ACCOUNT_A, plus, req)).rejects.toMatchObject({
      code: "email_unverified",
    });
    expect(audit("billing.checkout_started")[0]).toMatchObject({ result: "denied", errorCode: "email_unverified" });
    expect(d.uow.state.billing.find((b) => b.accountId === ACCOUNT_A)?.providerCustomerId ?? null).toBeNull();
  });

  it("is refused for Auditors and Members (403), outsiders (404) and staff acting as someone (403), all audited", async () => {
    const { d, ctx, audit } = world();
    await expect(startCheckout(d, ctx, auditor, ACCOUNT_A, plus, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(startCheckout(d, ctx, member, ACCOUNT_A, plus, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(startCheckout(d, ctx, outsider, ACCOUNT_A, plus, req)).rejects.toMatchObject({ code: "not_found" });
    const staff = actingStaff(ACCOUNT_A);
    await expect(startCheckout(d, ctx, staff, ACCOUNT_A, plus, req)).rejects.toMatchObject({ code: "forbidden" });
    // Even with a manager's role, an act-as session changes nothing (ADR-0023).
    const actingOwner = { ...owner, actingAs: actAs(ACCOUNT_A) };
    await expect(startCheckout(d, ctx, actingOwner, ACCOUNT_A, plus, req)).rejects.toMatchObject({ code: "forbidden" });
    expect(audit("billing.checkout_started").map((e) => e.result)).toEqual([
      "denied",
      "denied",
      "denied",
      "denied",
      "denied",
    ]);
    expect(audit("billing.checkout_started").at(-1)?.errorCode).toBe("act_as");
  });

  it("answers 503 billing_unavailable when billing is off, audited denied", async () => {
    const { d, audit } = world();
    await expect(
      startCheckout(
        d,
        { provider: null, appUrl: APP, redirectOrigins: [], paidPlansOpen: true },
        owner,
        ACCOUNT_A,
        plus,
        req,
      ),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(audit("billing.checkout_started")[0]).toMatchObject({ result: "denied", errorCode: "billing_unavailable" });
  });

  it("an outage is a 503, audited failed, and stores nothing", async () => {
    const { d, ctx, audit, fake } = world();
    const down: BillingProvider = {
      ...fake,
      ensureCustomer: () => Promise.reject(new BillingProviderError("unavailable", "timeout")),
    };
    await expect(startCheckout(d, { ...ctx, provider: down }, owner, ACCOUNT_A, plus, req)).rejects.toMatchObject({
      code: "billing_unavailable",
    });
    // The claim, the provider failure, then the claim released: the person can try again at once.
    expect(audit("billing.checkout_started").map((e) => [e.result, e.errorCode, e.meta.released ?? null])).toEqual([
      ["success", null, null],
      ["failed", "billing_unavailable", null],
      ["success", null, true],
    ]);
    expect(d.uow.state.billing.find((b) => b.accountId === ACCOUNT_A)?.checkoutPendingUntil ?? null).toBeNull();
    await expect(startCheckout(d, ctx, owner, ACCOUNT_A, plus, req)).resolves.toHaveProperty("url");
  });

  it("refuses a provider URL from an unexpected origin (no open redirect) and marks nothing pending", async () => {
    const { d, ctx, fake, audit } = world();
    const evil: BillingProvider = {
      ...fake,
      createCheckout: async () => ({ url: "https://evil.example/pay" }),
    };
    // Answered like a provider failure (security review run-62 F4): 503, audited failed, never a bare 500.
    await expect(startCheckout(d, { ...ctx, provider: evil }, owner, ACCOUNT_A, plus, req)).rejects.toMatchObject({
      code: "billing_unavailable",
    });
    expect(
      audit("billing.checkout_started").some((e) => e.result === "failed" && e.errorCode === "billing_unavailable"),
    ).toBe(true);
    expect(d.uow.state.billing.find((b) => b.accountId === ACCOUNT_A)?.checkoutPendingUntil ?? null).toBeNull();
  });

  it("the portal refuses a URL from an unexpected origin the same way", async () => {
    const { d, ctx, fake, audit } = world();
    await startCheckout(d, ctx, owner, ACCOUNT_A, plus, req);
    const evil: BillingProvider = { ...fake, createPortalSession: async () => ({ url: "https://evil.example/p" }) };
    await expect(openBillingPortal(d, { ...ctx, provider: evil }, owner, ACCOUNT_A, req)).rejects.toMatchObject({
      code: "billing_unavailable",
    });
    expect(audit("billing.portal_opened").at(-1)).toMatchObject({ result: "failed", errorCode: "billing_unavailable" });
  });

  it("two concurrent checkouts open one session: the second is 409 checkout_pending (security review run-62 F3)", async () => {
    const { d, ctx, fake } = world();
    let sessions = 0;
    const counting: BillingProvider = {
      ...fake,
      createCheckout: async (i) => {
        sessions++;
        return fake.createCheckout(i);
      },
    };
    const both = await Promise.allSettled([
      startCheckout(d, { ...ctx, provider: counting }, owner, ACCOUNT_A, plus, req),
      startCheckout(d, { ...ctx, provider: counting }, billingAdmin, ACCOUNT_A, { ...plus, storageBlocks: 1 }, req),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = both.find((r) => r.status === "rejected");
    expect(refused?.status === "rejected" ? (refused.reason as { code: string }).code : null).toBe("checkout_pending");
    expect(sessions).toBe(1);
  });

  it("passes the success and cancel URLs of the account's billing page and a Supporter amount", async () => {
    const { d, ctx, fake } = world();
    const seen: unknown[] = [];
    const spy: BillingProvider = {
      ...fake,
      createCheckout: async (i) => {
        seen.push(i);
        return fake.createCheckout(i);
      },
    };
    await startCheckout(
      d,
      { ...ctx, provider: spy },
      owner,
      ACCOUNT_A,
      { plan: "supporter", currency: "USD", supporterAmountMinor: 6000 },
      req,
    );
    expect(seen[0]).toMatchObject({
      plan: "supporter",
      supporterAmountMinor: 6000,
      successUrl: `${APP}/accounts/${ACCOUNT_A}/billing?checkout=done`,
      cancelUrl: `${APP}/accounts/${ACCOUNT_A}/billing?checkout=cancelled`,
    });
  });
});

describe("paid plans not open on this deployment (run-67 N3)", () => {
  it("refuses a checkout (503, audited denied) before anything is claimed or created", async () => {
    const { d, ctx, audit } = world();
    await expect(startCheckout(d, { ...ctx, paidPlansOpen: false }, owner, ACCOUNT_A, plus, req)).rejects.toMatchObject(
      { code: "billing_unavailable" },
    );
    expect(audit("billing.checkout_started")).toMatchObject([{ result: "denied", errorCode: "not_open" }]);
    expect(d.uow.state.billing).toEqual([]);
  });
});

describe("openBillingPortal", () => {
  it("opens the portal for an account with a provider customer, audited", async () => {
    const { d, ctx, audit } = world();
    await startCheckout(d, ctx, owner, ACCOUNT_A, plus, req);
    const out = await openBillingPortal(d, ctx, billingAdmin, ACCOUNT_A, req);
    expect(out.url).toMatch(new RegExp(`^${APP}/dev/billing/portal/cus_fake_`));
    expect(audit("billing.portal_opened")[0]?.result).toBe("success");
  });

  it("answers 409 not_subscribed without a customer, 403/404 to the wrong people, 503 when billing is off", async () => {
    const { d, ctx, audit } = world();
    await expect(openBillingPortal(d, ctx, owner, ACCOUNT_A, req)).rejects.toMatchObject({ code: "not_subscribed" });
    await expect(openBillingPortal(d, ctx, auditor, ACCOUNT_A, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(openBillingPortal(d, ctx, outsider, ACCOUNT_A, req)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      openBillingPortal(
        d,
        { provider: null, appUrl: APP, redirectOrigins: [], paidPlansOpen: true },
        owner,
        ACCOUNT_A,
        req,
      ),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(audit("billing.portal_opened").map((e) => e.errorCode)).toEqual([
      "not_subscribed",
      "forbidden",
      "not_found",
      "billing_unavailable",
    ]);
  });
});

describe("billingOverview", () => {
  it("shows Free to read roles and stays out of reach of others", async () => {
    const { d, ctx } = world();
    const o = await billingOverview(d, ctx, auditor, ACCOUNT_A);
    expect(o).toMatchObject({
      available: true,
      state: "free",
      plan: "free",
      portal: false,
      checkoutBlocked: null,
      holds: [],
      refund: { mayBeEligible: false, windowEndsAt: null },
    });
    await expect(billingOverview(d, ctx, member, ACCOUNT_A)).rejects.toMatchObject({ code: "forbidden" });
    await expect(billingOverview(d, ctx, outsider, ACCOUNT_A)).rejects.toMatchObject({ code: "not_found" });
    await expect(billingOverview(d, ctx, actingStaff(ACCOUNT_A), ACCOUNT_A)).resolves.toHaveProperty("state");
  });

  it("shows a paid subscription with its renewal, add-ons in force and the refund window from our row", async () => {
    const { d, ctx, clock } = world({ plan: "plus" });
    const periodEnd = new Date(clock.now().getTime() + 360 * 86_400_000);
    d.uow.state.billing.push({
      ...defaultBilling(ACCOUNT_A, "plus", clock.now()),
      planSource: "stripe",
      providerCustomerId: "cus_x",
      providerSubscriptionId: "sub_x",
      currency: "USD",
      planAmountMinor: 4000,
      storageBlocks: 1,
      periodPaidStorageBlocks: 2,
      periodPaidFor: periodEnd,
      currentPeriodEnd: periodEnd,
      lastInvoiceStatus: "paid",
    });
    const o = await billingOverview(d, ctx, owner, ACCOUNT_A);
    expect(o).toMatchObject({
      state: "active",
      paidPlan: "plus",
      portal: true,
      checkoutBlocked: "already_subscribed",
      renewal: { storageBlocks: 1, extraMailboxes: 0 },
      entitled: { storageBlocks: 2, extraMailboxes: 0 },
      refund: { mayBeEligible: true },
    });
    clock.set(new Date(clock.now().getTime() + 10 * 86_400_000));
    expect((await billingOverview(d, ctx, owner, ACCOUNT_A)).refund.mayBeEligible).toBe(false);
  });

  it("says billing is unavailable when it is off", async () => {
    const { d } = world();
    expect((await billingOverview(d, { provider: null }, owner, ACCOUNT_A)).available).toBe(false);
  });
});

describe("guards", () => {
  it("maps provider errors to house errors without the provider's message", () => {
    expect(providerError(new BillingProviderError("card_declined", "secret detail"))).toMatchObject({
      code: "card_declined",
    });
    expect(providerError(new BillingProviderError("rate_limited", "x"))).toBeInstanceOf(BillingError);
    expect(providerError(new BillingProviderError("invalid_request", "x"))).toBeInstanceOf(BillingProviderError);
    expect(providerError("boom")).toBeInstanceOf(Error);
    expect(providerError(new BillingProviderError("card_declined", "secret detail")).message).not.toContain("secret");
  });

  it("accepts only the expected origins", () => {
    const ctx: BillingContext = {
      provider: null,
      appUrl: APP,
      redirectOrigins: ["https://checkout.example"],
      paidPlansOpen: true,
    };
    expect(assertRedirect(ctx, "https://checkout.example/c/pay/1")).toBe("https://checkout.example/c/pay/1");
    expect(() => assertRedirect(ctx, "https://checkout.example.evil.test/x")).toThrow();
    expect(() => assertRedirect(ctx, "javascript:alert(1)")).toThrow();
    expect(() => assertRedirect(ctx, "not a url")).toThrow("invalid URL");
  });
});
