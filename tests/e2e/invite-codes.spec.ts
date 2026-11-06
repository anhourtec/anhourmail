// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Invite codes (ADR-0029 §8, rule 35): a Global Administrator creates a code that comps Plus on the Invite codes page
 * (behind the password step-up); it's shown once; someone signs up with the link that carries it (the proof-of-work
 * still runs) and their new account is on complimentary Plus at once; staff then see the code as used (a used code
 * gets the same 404 as any wrong one: unit-tested). Platform billing opens for the Global Administrator; a Support
 * Administrator sees Invite codes but can't make comp codes.
 */
import type { Page } from "@playwright/test";

import { confirmSignUp, e2eUsers, expect, openNav, signIn, signOut, test, urls } from "./fixtures";

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

test("a staff comp code redeemed at sign-up gives the new account Plus", async ({
  page,
  consoleErrors: _errors,
}, info) => {
  test.slow();
  const u = e2eUsers();
  const who = `${u.run}-${info.project.name}-code`;

  await signIn(page, u.users.globalAdmin, u.password);
  await (await openNav(page)).getByRole("link", { name: "Invite codes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Invite codes" })).toBeVisible();
  await page.getByLabel("Note for staff (optional)").fill(`${who} beta`);
  await page.getByLabel("Complimentary plan").selectOption("plus");
  await page.getByLabel(/For how many days/).fill("30");
  await page.getByRole("button", { name: "Create code" }).click();
  await confirmIfAsked(page, u.password);
  const shown = page.getByTestId("new-invite-code");
  await expect(shown).toContainText("it can't be shown again");
  const code = ((await shown.locator("code").first().textContent()) ?? "").trim();
  expect(code).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  await expect(page.getByTestId("invite-codes")).toContainText(`${who} beta`);

  // Platform billing is there for the Global Administrator.
  await (await openNav(page)).getByRole("link", { name: "Platform billing" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Platform billing" })).toBeVisible();
  await signOut(page);

  // Sign up with the link that carries the code.
  await page.goto(`${urls.app}/sign-up?code=${encodeURIComponent(code)}`);
  await expect(page.getByLabel(/Invite code/)).toHaveValue(code);
  await expect(page.locator('[data-testid="sign-up-check"]')).toHaveAttribute("data-status", "ready", {
    timeout: 30_000,
  });
  await page.getByLabel("First name").fill(who);
  await page.getByLabel("Email").fill(`${who}@e2e.test`);
  await page.getByLabel("Password", { exact: true }).fill(`${u.password}-code`);
  await page.getByRole("button", { name: "Create account" }).click();
  await confirmSignUp(page, `${who}@e2e.test`, `${u.password}-code`);

  await (await openNav(page)).getByRole("link", { name: "Billing" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
  await expect(page.getByTestId("billing-state")).toHaveText("Active");
  await expect(page.getByText("Complimentary (invite code)")).toBeVisible();
  const accountId = /\/accounts\/([^/]+)\/billing/.exec(page.url())?.[1] ?? "";

  await signOut(page);

  await signIn(page, u.users.globalAdmin, u.password);
  await page.goto(`${urls.app}/platform/invite-codes`);
  const row = page
    .getByTestId("invite-codes")
    .getByRole("row")
    .filter({ hasText: `${who} beta` });
  await expect(row).toContainText("Used");

  // Platform → account → Billing: staff see the comp and end it (step-up); the account drops to Free.
  await page.goto(`${urls.app}/platform/accounts/${accountId}?tab=billing`);
  const staff = page.getByTestId("staff-billing");
  await expect(staff).toContainText("Complimentary (invite code)");
  await staff.getByRole("button", { name: "End the granted plan" }).click();
  await page.getByRole("button", { name: "End it now" }).click();
  await confirmIfAsked(page, u.password);
  await expect(page.getByTestId("staff-billing")).toContainText("No paid plan");
});

test("a Support Administrator makes sign-up codes only", async ({ page, consoleErrors: _errors }) => {
  const u = e2eUsers();
  await signIn(page, u.users.supportAdmin, u.password);
  await (await openNav(page)).getByRole("link", { name: "Invite codes" }).click();
  await expect(page.getByLabel("Lets someone sign up while sign-up is closed")).toBeChecked();
  await expect(page.getByLabel("Complimentary plan")).toHaveCount(0);
  await expect((await openNav(page)).getByRole("link", { name: "Platform billing" })).toHaveCount(0);
  const comp = await page.request.post(`${urls.app}/api/platform/invite-codes`, {
    headers: { origin: urls.app },
    data: { compPlan: "plus", compDays: 10, expiresInDays: 10 },
  });
  expect(comp.status()).toBe(403);
});
