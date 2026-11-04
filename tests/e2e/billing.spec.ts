// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing on the dev fake provider (ADR-0029 §3, slices 8–10): an Owner starts a Plus checkout from Free, pays on the
 * fake checkout page, the signed events go through the real webhook and the worker's sync makes the account active;
 * then cancelling at period end in the fake portal and advancing the fake clock past the period end lapses it back to
 * Free (nothing to hold here). No payment processor is involved anywhere.
 */
import { e2eUsers, expect, signIn, test, urls } from "./fixtures";

type Overview = { state: string; plan: string; cancelAt: string | null; paidPlan: string | null };

test("Free → Plus through the fake checkout, then cancel in the fake portal and lapse at period end", async ({
  page,
  consoleErrors: _errors,
}, info) => {
  test.slow(); // waits on the worker's sync twice
  const { password, billing } = e2eUsers();
  const mine = billing[info.project.name] ?? { accountId: "", owner: "" };
  await signIn(page, mine.owner, password);

  const overview = async (): Promise<Overview> => {
    const res = await page.request.get(`${urls.app}/api/accounts/${mine.accountId}/billing`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { data: Overview }).data;
  };
  expect(await overview()).toMatchObject({ state: "free", plan: "free" });

  const start = await page.request.post(`${urls.app}/api/accounts/${mine.accountId}/billing/checkout`, {
    headers: { origin: urls.app },
    data: { plan: "plus", currency: "USD" },
  });
  expect(start.status()).toBe(200);
  const { url } = ((await start.json()) as { data: { url: string } }).data;
  expect(url).toContain("/dev/billing/checkout/");

  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: "Fake checkout" })).toBeVisible();
  await expect(page.getByText("Development only: no payment is taken")).toBeVisible();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(/\/dev\/billing\/portal\/.+\?checkout=done$/);
  await expect(page.getByRole("heading", { level: 1, name: "Fake billing portal" })).toBeVisible();
  await expect(page.getByTestId("fake-subscription-status")).toHaveText("active");

  // The worker's sync turns the paid subscription into the account's plan.
  await expect.poll(async () => (await overview()).state, { timeout: 30_000 }).toBe("active");
  expect(await overview()).toMatchObject({ plan: "plus", paidPlan: "plus", cancelAt: null });

  // Cancel at period end in the portal: nothing changes until then.
  await page.getByRole("button", { name: "Cancel at period end" }).click();
  await expect(page.getByTestId("fake-renewal")).toContainText("Cancels");
  await expect.poll(async () => (await overview()).cancelAt, { timeout: 30_000 }).not.toBeNull();
  expect((await overview()).state).toBe("active");

  // Past the period end the subscription ends; with nothing to hold, the account is Free again.
  await page.getByLabel("Days to advance").fill("366");
  await page.getByRole("button", { name: "Advance clock" }).click();
  await expect(page.getByTestId("fake-subscription-status")).toHaveText("canceled");
  await expect.poll(async () => (await overview()).state, { timeout: 30_000 }).toBe("free");
  expect(await overview()).toMatchObject({ plan: "free", paidPlan: null });
});
