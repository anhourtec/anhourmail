// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The catalogue check and the drift refusal (ADR-0029 §2): the result recorded and audited only when it changes, an
 * outage changing nothing, and while the provider's prices disagree with `plans.ts`, new checkouts, previews and plan
 * or add-on changes refused with 503 (audited denied `catalogue_drift`) while the portal and cancelling keep working.
 */
import { describe, expect, it } from "vitest";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "../../../adapters/src/billing-fake";
import { ACCOUNT_A, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";

import { catalogueStatus, checkBillingCatalogue } from "./catalogue";
import { changeBilling, previewBillingChange } from "./changes";
import { openBillingPortal, startCheckout } from "./checkout";
import { platformBillingSummary } from "./grants";
import type { BillingContext } from "./guards";
import { BillingProviderError, type CatalogueDrift } from "./ports";
import { syncAccountBilling } from "./sync";

const APP = "http://localhost:43200";
const DAY = 86_400_000;
const owner = user({ id: "owner-1", account: [[ACCOUNT_A, "owner"]] });
const DRIFT: CatalogueDrift[] = [{ item: "plus", problem: "USD amount differs from plans.ts" }];

function world() {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  d.uow.state.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "free" });
  const fake = createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: APP,
    webhookSecret: fakeWebhookSecret("catalogue-test"),
    clock: () => clock.now(),
    nodeEnv: "test",
  });
  let answer: readonly CatalogueDrift[] | Error = [];
  const provider = {
    ...fake,
    checkCatalogue: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const ctx: BillingContext = { provider, appUrl: APP, redirectOrigins: [APP], paidPlansOpen: true };
  const platformAudit = (action: string) =>
    d.uow.state.audit.filter((e) => e.action === action && e.scope === "platform");
  return {
    clock,
    d,
    fake,
    provider,
    ctx,
    platformAudit,
    answer: (a: readonly CatalogueDrift[] | Error) => {
      answer = a;
    },
  };
}

describe("checkBillingCatalogue", () => {
  it("records drift and audits it once; the same drift again is recorded but not audited; a fix is audited", async () => {
    const w = world();
    expect(await checkBillingCatalogue(w.d, w.provider)).toMatchObject({ change: "same", drift: [] });
    expect(await catalogueStatus(w.d)).toMatchObject({ drift: [], driftSince: null });
    expect(w.platformAudit("billing.catalogue_drift")).toHaveLength(0);

    w.answer(DRIFT);
    const first = await checkBillingCatalogue(w.d, w.provider);
    expect(first).toMatchObject({ change: "drift", drift: DRIFT, driftSince: w.clock.now() });
    const entry = w.platformAudit("billing.catalogue_drift")[0];
    expect(entry).toMatchObject({ result: "success", meta: { drift: DRIFT, provider: "fake" } });
    expect(entry?.actor).toMatchObject({ type: "system", email: "billing-catalogue" });

    const since = w.clock.now();
    w.clock.set(new Date(since.getTime() + DAY));
    expect(await checkBillingCatalogue(w.d, w.provider)).toMatchObject({ change: "same", driftSince: since });
    expect(w.platformAudit("billing.catalogue_drift")).toHaveLength(1);
    expect((await catalogueStatus(w.d))?.checkedAt).toEqual(w.clock.now());

    // A different problem is new drift.
    w.answer([...DRIFT, { item: "storage_block", problem: "price is archived" }]);
    expect((await checkBillingCatalogue(w.d, w.provider)).change).toBe("drift");
    expect(w.platformAudit("billing.catalogue_drift")).toHaveLength(2);

    w.answer([]);
    expect((await checkBillingCatalogue(w.d, w.provider)).change).toBe("restored");
    expect(w.platformAudit("billing.catalogue_restored")[0]?.meta).toMatchObject({
      driftSince: since.toISOString(),
    });
    expect(await catalogueStatus(w.d)).toMatchObject({ drift: [], driftSince: null });
  });

  it("Platform billing shows the drift to billing staff", async () => {
    const w = world();
    w.answer(DRIFT);
    await checkBillingCatalogue(w.d, w.provider);
    const staff = user({ id: "staff-billing", platform: ["billing_admin"] });
    expect((await platformBillingSummary(w.d, w.ctx, staff)).catalogue).toMatchObject({ drift: DRIFT });
  });

  it("a provider outage throws and leaves the last result as it was", async () => {
    const w = world();
    w.answer(DRIFT);
    await checkBillingCatalogue(w.d, w.provider);
    w.answer(new BillingProviderError("unavailable", "down"));
    await expect(checkBillingCatalogue(w.d, w.provider)).rejects.toMatchObject({ code: "unavailable" });
    expect((await catalogueStatus(w.d))?.drift).toEqual(DRIFT);
  });
});

describe("refusals while the catalogue drifts", () => {
  it("checkout is refused with 503, audited as denied catalogue_drift; allowed again once in sync", async () => {
    const w = world();
    w.answer(DRIFT);
    await checkBillingCatalogue(w.d, w.provider);
    await expect(
      startCheckout(w.d, w.ctx, owner, ACCOUNT_A, { plan: "plus", currency: "USD" }, req),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(w.d.uow.state.audit.filter((e) => e.action === "billing.checkout_started").at(-1)).toMatchObject({
      result: "denied",
      errorCode: "catalogue_drift",
    });
    w.answer([]);
    await checkBillingCatalogue(w.d, w.provider);
    const { url } = await startCheckout(w.d, w.ctx, owner, ACCOUNT_A, { plan: "plus", currency: "USD" }, req);
    expect(url).toContain("/dev/billing/checkout/");
  });

  it("previews and add-on changes are refused; the portal still opens for a paying account", async () => {
    const w = world();
    const { url } = await startCheckout(w.d, w.ctx, owner, ACCOUNT_A, { plan: "plus", currency: "USD" }, req);
    await w.fake.completeCheckout(url.split("/").pop() ?? "", "pay");
    await w.fake.drainDeliveries();
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    w.answer(DRIFT);
    await checkBillingCatalogue(w.d, w.provider);

    await expect(previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 1 })).rejects.toMatchObject({
      code: "billing_unavailable",
    });
    await expect(
      changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 1, confirmAmountMinor: 0 }, req),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(w.d.uow.state.audit.filter((e) => e.action === "billing.addons_changed").at(-1)).toMatchObject({
      result: "denied",
      errorCode: "catalogue_drift",
    });
    expect((await openBillingPortal(w.d, w.ctx, owner, ACCOUNT_A, req)).url).toContain("/dev/billing/portal/");
  });
});
