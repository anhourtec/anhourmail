// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Staff suspension (`platform.account.suspend`, Global Administrator): suspend an account and one of its people from
 * Platform → account, see what the customer sees (the notice, a refused sign-in with the appeal address), then lift
 * both. Each browser project has its own account (scripts/e2e-fixtures.ts), so nobody else's sign-in changes.
 */
import type { Page } from "@playwright/test";

import { e2eUsers, expect, homeHeading, SIGN_IN_TIMEOUT, signIn, signOut, test, urls } from "./fixtures";

/** Submits a suspension panel, confirming it's you if the server asks for a fresh step-up. */
async function submitPanel(page: Page, panelName: string, button: string, password: string) {
  const dialog = page.getByRole("dialog", { name: panelName });
  await dialog.getByRole("button", { name: button, exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  // Either the change went through (the panel closes) or the server asked for a fresh step-up.
  await expect
    .poll(async () => (await confirm.isVisible()) || (await dialog.count()) === 0, { timeout: SIGN_IN_TIMEOUT })
    .toBe(true);
  if (await confirm.isVisible()) {
    await confirm.getByLabel("Console password").fill(password);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  }
  await expect(dialog).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
}

async function openAccount(page: Page, run: string, accountName: string) {
  await page.goto(`${urls.app}/platform/accounts`);
  await page.getByLabel("Search accounts").fill(run);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: accountName }).click();
  await expect(page.getByRole("heading", { name: accountName, level: 1 })).toBeVisible();
}

test("a Global Administrator suspends an account and a person, the customer sees why, then it is lifted", async ({
  page,
}, testInfo) => {
  const u = e2eUsers();
  const s = u.suspension[testInfo.project.name] ?? { accountName: "", owner: "", member: "" };

  await signIn(page, u.users.globalAdmin, u.password);
  await openAccount(page, u.run, s.accountName);

  // The account.
  await page.getByRole("button", { name: "Suspend account…" }).click();
  const accountPanel = page.getByRole("dialog", { name: "Suspend this account" });
  await accountPanel.getByLabel("Reason").selectOption({ label: "Sending spam" });
  await accountPanel.getByLabel(/Internal note/).fill("e2e: reported by a receiving provider");
  await submitPanel(page, "Suspend this account", "Suspend account", u.password);
  await expect(page.getByText("Internal note: e2e: reported by a receiving provider")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lift suspension" }).first()).toBeVisible();

  // The person (their row in the People tab).
  const memberRow = page.getByRole("row", { name: new RegExp(s.member.replace(/[.]/g, "\\.")) });
  await memberRow.getByRole("button", { name: "Suspend person…" }).click();
  await page.getByRole("dialog", { name: "Suspend this person" }).getByLabel("Reason").selectOption("abuse");
  await submitPanel(page, "Suspend this person", "Suspend person", u.password);
  await expect(memberRow.getByRole("button", { name: "Lift suspension" })).toBeVisible();
  await signOut(page);

  // The suspended person can't sign in, and is told how to appeal.
  await page.getByLabel("Email").fill(s.member);
  await page.getByLabel("Password", { exact: true }).fill(u.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(/sign-in is suspended/)).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await expect(page.getByText(/support@anhourtec\.com/)).toBeVisible();

  // The owner signs in and sees the notice with the reason, never the internal note.
  await signIn(page, s.owner, u.password);
  const notice = page.getByRole("alert").filter({ hasText: "This account is suspended" });
  await expect(notice).toBeVisible();
  await expect(notice.getByText("Sending spam")).toBeVisible();
  await expect(notice.getByText("support@anhourtec.com")).toBeVisible();
  await expect(page.getByText("receiving provider")).toHaveCount(0);
  await signOut(page);

  // Lift both.
  await signIn(page, u.users.globalAdmin, u.password);
  await openAccount(page, u.run, s.accountName);
  await page
    .getByRole("row", { name: new RegExp(s.member.replace(/[.]/g, "\\.")) })
    .getByRole("button", { name: "Lift suspension" })
    .click();
  await submitPanel(page, "Lift the suspension of this person", "Lift suspension", u.password);
  await page.getByRole("button", { name: "Lift suspension" }).first().click();
  await submitPanel(page, "Lift the suspension of this account", "Lift suspension", u.password);
  await expect(page.getByRole("button", { name: "Suspend account…" })).toBeVisible();
  await signOut(page);

  // Everything works again.
  await signIn(page, s.member, u.password);
  await expect(homeHeading(page)).toBeVisible();
  await expect(page.getByText("This account is suspended")).toHaveCount(0);
});

test("a Reports Reader can't suspend (403) and customers can't reach the staff routes", async ({ page }) => {
  const u = e2eUsers();
  const tryIt = async () =>
    (
      await page.request.post(`${urls.app}/api/platform/people/${encodeURIComponent("anyone")}/suspension`, {
        headers: { origin: urls.app },
        data: { reason: "spam" },
      })
    ).status();
  await signIn(page, u.users.reportsReader, u.password);
  expect(await tryIt()).toBe(403);
  await signOut(page);
  await signIn(page, u.users.owner, u.password);
  expect(await tryIt()).toBe(403);
  await page.goto(`${urls.app}/platform/accounts`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
