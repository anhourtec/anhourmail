// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing on the dev fake provider (ADR-0029, slices 8–11), driven from the console's Billing page as customers use it:
 *
 * 1. An Owner chooses Plus on the Billing page, pays on the fake checkout page and comes back to Billing, where the
 *    plan turns active once the signed events have gone through the real webhook and the worker's sync. They add a
 *    storage block (preview, then confirm the amount), cancel at period end behind the password step-up, and after
 *    the fake clock passes the period end the account is Free again (nothing to hold).
 * 2. Roles (rule 35): a Billing Administrator manages billing; a Member has no Billing in the navigation and gets the
 *    403 page (and 403 from the API); when a renewal fails the Billing Administrator sees the "payment failed" banner and the Member doesn't,
 *    and once retries run out ("sending paused") everyone does, the Member told who can fix it.
 * 3. Holds: an account with two platform-domain mailboxes subscribes, cancels and lapses; the Billing page lists what's
 *    held, the banner says the plan ended, and "Choose what stays on" swaps the kept mailbox.
 *
 * No payment processor is involved anywhere. The fake's clock is shared by every fake customer, as a test clock is.
 */
import type { Page } from "@playwright/test";

import { e2eUsers, expect, openNav, signIn, signOut, test, urls } from "./fixtures";

type Overview = { state: string; plan: string; cancelAt: string | null; entitled: { storageBlocks: number } };

const overviewOf = (page: Page, accountId: string) => async (): Promise<Overview> => {
  const res = await page.request.get(`${urls.app}/api/accounts/${accountId}/billing`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: Overview }).data;
};

/** Reloads the Billing page until its state line reads `text` (the worker's sync runs after each provider event). */
async function waitForState(page: Page, text: string) {
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("billing-state")).toHaveText(text, { timeout: 2_000 });
  }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 3_000] });
}

/** Chooses Plus on the Billing page and pays on the fake checkout, coming back to Billing with the plan active. */
async function subscribePlus(page: Page, accountId: string) {
  await page.goto(`${urls.app}/accounts/${accountId}/billing`);
  await expect(page.getByRole("heading", { level: 2, name: /Choose a paid plan|Subscribe again/ })).toBeVisible();
  await page.getByRole("radio", { name: /^Plus/ }).check();
  const go = page.getByRole("button", { name: "Continue to payment" });
  await go.click();
  await expect(page).toHaveURL(/\/dev\/billing\/checkout\//);
  await expect(page.getByRole("heading", { level: 1, name: "Fake checkout" })).toBeVisible();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/accounts/${accountId}/billing\\?checkout=done$`));
  await expect(page.getByText(/Payment received|Your plan is active/)).toBeVisible();
  await waitForState(page, "Active");
}

/** Opens the fake portal from the Billing page ("Manage payment and invoices"). */
async function openPortal(page: Page, label = "Manage payment and invoices") {
  await page.getByRole("button", { name: label }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fake billing portal" })).toBeVisible();
}

/** The fake portal's "Back to Billing" (followed by its address: the portal may still be refreshing after an action). */
async function backToBilling(page: Page, accountId: string) {
  const link = page.getByRole("link", { name: "Back to Billing" });
  await expect(link).toHaveAttribute("href", `/accounts/${accountId}/billing`);
  await page.goto(`${urls.app}/accounts/${accountId}/billing`);
}

/** Confirms the password step-up when the server asks for one (a confirmation counts for a few minutes). */
async function confirmIfAsked(page: Page, password: string) {
  const field = page.getByLabel("Console password");
  const asked = await field.waitFor({ timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  if (!asked) return;
  await field.fill(password);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
}

async function advanceClock(page: Page, days: number) {
  await page.getByLabel("Days to advance").fill(String(days));
  await page.getByRole("button", { name: "Advance clock" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Done: advance clock." })).toBeVisible();
}

test("Free → Plus from the Billing page, a storage block confirmed, cancelled behind the step-up, Free again", async ({
  page,
  consoleErrors: _errors,
}, info) => {
  test.slow(); // waits on the worker's sync several times
  const { password, billing } = e2eUsers();
  const mine = billing[info.project.name] ?? { accountId: "", owner: "", billingAdmin: "", member: "" };
  const overview = overviewOf(page, mine.accountId);
  await signIn(page, mine.owner, password);

  // The navigation leads to Billing; nothing paid yet.
  await (await openNav(page)).getByRole("link", { name: "Billing" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
  await expect(page.getByText("This server uses a test payment setup")).toBeVisible();
  await expect(page.getByTestId("checkout-total")).toHaveText("$9");

  // The Supporter amount is checked as it's typed (the server checks it again).
  await page.getByRole("radio", { name: /^Supporter/ }).check();
  await page.getByLabel(/Supporter amount/).fill("5");
  await expect(page.getByText(/^Choose an amount from /)).toBeVisible();
  await page.getByLabel(/Supporter amount/).fill("20.5");
  await expect(page.getByText("Enter a whole amount (no cents).")).toBeVisible();

  await subscribePlus(page, mine.accountId);
  expect(await overview()).toMatchObject({ state: "active", plan: "plus" });
  await expect(page.getByText(/Renews on/)).toBeVisible();

  // A storage block: preview, then the explicit confirmation of the amount charged now.
  await page
    .getByRole("button", { name: /^More: Storage blocks/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Review the change" }).first().click();
  const pay = page.getByRole("button", { name: /^Pay .+ now$/ });
  await expect(pay).toBeVisible();
  await expect(page.getByTestId("change-amount")).toHaveText(/^\$\d/);
  await pay.click();
  await expect(page.getByRole("status").filter({ hasText: /charged/ })).toBeVisible();
  await expect.poll(async () => (await overview()).entitled.storageBlocks, { timeout: 45_000 }).toBe(1);

  // Cancel at period end: asks first, then the console password.
  await page.reload();
  await page.getByRole("button", { name: "Cancel the plan" }).click();
  await page.getByRole("button", { name: "Cancel at period end" }).click();
  // The server asks for the console password (a fresh step-up) unless one was confirmed in the last few minutes.
  await confirmIfAsked(page, password);
  await expect.poll(async () => (await overview()).cancelAt, { timeout: 45_000 }).not.toBeNull();
  await page.reload();
  await expect(page.getByText(/^Cancelled: the plan stays until/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo the cancellation" })).toBeVisible();

  // Past the period end the subscription ends; with nothing to hold, the account is Free again.
  await openPortal(page);
  await advanceClock(page, 366);
  await expect(page.getByTestId("fake-subscription-status")).toHaveText("canceled");
  await backToBilling(page, mine.accountId);
  await waitForState(page, "Free");
  expect(await overview()).toMatchObject({ plan: "free" });
});

test("roles: a Billing Administrator manages billing, a Member has none; failed payments show the right banners", async ({
  page,
  consoleErrors: _errors,
}, info) => {
  test.slow();
  const { password, billing } = e2eUsers();
  const mine = billing[info.project.name] ?? { accountId: "", owner: "", billingAdmin: "", member: "" };
  const billingUrl = `${urls.app}/accounts/${mine.accountId}/billing`;

  // The Billing Administrator subscribes (the e2e journey above may have run first: Free either way).
  await signIn(page, mine.billingAdmin, password);
  await subscribePlus(page, mine.accountId);

  // A renewal fails: the Billing Administrator sees "A payment failed"; the provider retries.
  await openPortal(page);
  await page.getByRole("button", { name: "Card fails from now" }).click();
  await expect(page.getByTestId("fake-card")).toHaveText("Fails");
  await advanceClock(page, 366);
  await backToBilling(page, mine.accountId);
  await waitForState(page, "Payment failed, retrying");
  await expect(page.getByTestId("billing-banner")).toContainText("A payment failed");

  // Retries run out: sending is paused, and the main action is paying the open invoice.
  await expect(page.getByTestId("billing-banner").getByRole("link")).toHaveText("Update the card on the Billing page");
  await openPortal(page);
  await page.getByRole("button", { name: "Exhaust retries" }).click();
  await expect(page.getByTestId("fake-subscription-status")).toHaveText("unpaid");
  await backToBilling(page, mine.accountId);
  await waitForState(page, "Sending paused");
  await expect(page.getByTestId("billing-banner")).toContainText("Sending is paused");
  await expect(page.getByRole("button", { name: "Pay the open invoice" })).toBeVisible();
  await signOut(page);

  // The Member sees that sending is paused and who can fix it, but no link to Billing.
  await signIn(page, mine.member, password);
  const banner = page.getByTestId("billing-banner");
  await expect(banner).toContainText("Sending is paused");
  await expect(banner).toContainText("An Owner or Billing Administrator of this account can fix it.");
  await expect(banner.getByRole("link")).toHaveCount(0);
  await signOut(page);

  // Paying the open invoice turns sending back on, then the plan is cancelled at the fake (tidy for the next run).
  await signIn(page, mine.billingAdmin, password);
  await page.goto(billingUrl);
  await page.getByRole("button", { name: "Pay the open invoice" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fake billing portal" })).toBeVisible();
  await page.getByRole("button", { name: "Card works again" }).click();
  await expect(page.getByTestId("fake-card")).toHaveText("Works");
  await page.getByRole("button", { name: "Pay open invoice" }).click();
  await expect(page.getByTestId("fake-subscription-status")).toHaveText("active");
  await backToBilling(page, mine.accountId);
  await waitForState(page, "Active");
  await expect(page.getByTestId("billing-banner")).toHaveCount(0);
});

test("a Member has no Billing in the navigation and gets the 403 page", async ({ page }, info) => {
  const { password, billing } = e2eUsers();
  const mine = billing[info.project.name] ?? { accountId: "", owner: "", billingAdmin: "", member: "" };
  await signIn(page, mine.member, password);
  await expect((await openNav(page)).getByRole("link", { name: "Billing" })).toHaveCount(0);
  const refused = await page.goto(`${urls.app}/accounts/${mine.accountId}/billing`);
  expect(refused?.status()).toBe(403);
  await expect(page.getByRole("heading", { level: 1, name: "Not part of your role" })).toBeVisible();
  const api = await page.request.get(`${urls.app}/api/accounts/${mine.accountId}/billing`);
  expect(api.status()).toBe(403);
});

test("holds after a lapse: the Billing page lists what's held and the Owner chooses what stays on", async ({
  page,
  consoleErrors: _errors,
}, info) => {
  test.slow();
  const { password, billingHolds } = e2eUsers();
  const mine = billingHolds[info.project.name] ?? { accountId: "", owner: "", kept: "", other: "" };
  await signIn(page, mine.owner, password);
  await subscribePlus(page, mine.accountId);

  // Cancel in the portal and pass the period end: the plan ends with something to hold.
  await openPortal(page);
  await page.getByRole("button", { name: "Cancel at period end" }).click();
  await expect(page.getByTestId("fake-renewal")).toContainText("Cancels");
  await advanceClock(page, 366);
  await expect(page.getByTestId("fake-subscription-status")).toHaveText("canceled");
  await backToBilling(page, mine.accountId);
  await waitForState(page, "Paid plan ended");

  await expect(page.getByTestId("billing-banner")).toContainText("The paid plan ended");
  const held = page.getByTestId("billing-holds");
  await expect(held).toContainText(mine.other);
  await expect(held).not.toContainText(mine.kept);
  await expect(held).toContainText(/Receiving until/);

  // Choose what stays on: keep the other mailbox instead.
  await expect(page.getByRole("heading", { level: 3, name: "Choose what stays on" })).toBeVisible();
  await page.getByRole("radio", { name: mine.other }).check();
  await page.getByRole("button", { name: "Save what stays on" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("billing-holds")).toContainText(mine.kept);
  await expect(page.getByTestId("billing-holds")).not.toContainText(mine.other);
  await expect(page.getByRole("heading", { level: 2, name: "Subscribe again" })).toBeVisible();
});

test("the person's menu leads to Billing and the Usage tab shows the meters", async ({
  page,
  consoleErrors: _errors,
}, info) => {
  const { password, billing } = e2eUsers();
  const mine = billing[info.project.name] ?? { accountId: "", owner: "", billingAdmin: "", member: "" };
  await signIn(page, mine.owner, password);
  await page.goto(`${urls.app}/accounts/${mine.accountId}/aliases`);

  // Billing in the person's menu is the account's Billing page (it used to say "Soon").
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await page
    .getByRole("menu", { name: "Your account" })
    .getByRole("menuitem", { name: "Billing", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();

  // The two Billing tabs.
  const tabs = page.getByRole("navigation", { name: "Billing" });
  await expect(tabs.getByRole("link", { name: "Plan and payments" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Usage" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
  await expect(page.getByRole("meter", { name: "Mailboxes in use" })).toBeVisible();
  await expect(page.getByRole("meter", { name: "Storage given to mailboxes" })).toBeVisible();
  await page.getByRole("navigation", { name: "Billing" }).getByRole("link", { name: "Plan and payments" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
});

// The 403 page logs its own 403 response, so this one doesn't watch the console (like the Member test above).
test("a Member's menu has no Billing and the Usage page is the 403 page", async ({ page }, info) => {
  const { password, billing } = e2eUsers();
  const mine = billing[info.project.name] ?? { accountId: "", owner: "", billingAdmin: "", member: "" };
  await signIn(page, mine.member, password);
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Your account" });
  await expect(menu.getByRole("menuitem", { name: "Security" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Billing", exact: true })).toHaveCount(0);
  await page.goto(`${urls.app}/accounts/${mine.accountId}/billing/usage`);
  await expect(page.getByRole("heading", { level: 1, name: "Not part of your role" })).toBeVisible();
});
