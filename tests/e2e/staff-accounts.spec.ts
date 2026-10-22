// SPDX-License-Identifier: AGPL-3.0-only
/** Staff: customer accounts (look-up is audited in the account's own log, rule 49) and the platform audit. */
import { e2eUsers, expect, openNav, signIn, signOut, test, urls } from "./fixtures";

test("a Global Administrator finds an account, opens it, and its owner sees the staff view in the audit log", async ({
  page,
  consoleErrors,
}) => {
  const u = e2eUsers();
  await signIn(page, u.users.globalAdmin, u.password);
  await (await openNav(page)).getByRole("link", { name: "Customer accounts" }).click();
  await expect(page.getByRole("heading", { name: "Customer accounts", level: 1 })).toBeVisible();
  await page.getByLabel("Search accounts").fill(u.run);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: u.accountName }).click();
  await expect(page.getByRole("heading", { name: u.accountName, level: 1 })).toBeVisible();
  await expect(page.getByText("Opening this page is recorded in the account's audit log")).toBeVisible();
  await expect(page.getByText(u.users.owner)).toBeVisible();

  // The platform audit is a filterable table with a details drawer.
  await (await openNav(page)).getByRole("link", { name: "Platform audit" }).click();
  await expect(page.getByRole("heading", { name: "Platform audit", level: 1 })).toBeVisible();
  await page.getByLabel("Who").selectOption({ label: "Anhourtec staff" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/actor=staff/);
  expect(consoleErrors).toEqual([]);
  await signOut(page);

  // The owner sees it labelled as Anhourtec staff, and the drawer shows the entry.
  await signIn(page, u.users.owner, u.password);
  await (await openNav(page)).getByRole("link", { name: "Audit log" }).click();
  await page.getByLabel("Who").selectOption({ label: "Anhourtec staff" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  const row = page.getByRole("row", { name: /Staff viewed the account/ }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /^Details/ }).click();
  const drawer = page.getByRole("dialog", { name: "Staff viewed the account" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Anhourtec staff")).toBeVisible();
  await expect(drawer.getByText("staff.account_viewed")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("a Reports Reader reads the platform audit but not customer accounts", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.reportsReader, u.password);
  const nav = await openNav(page);
  await expect(nav.locator(`[data-nav="platform.accounts.read"]`)).toHaveCount(0);
  await nav.getByRole("link", { name: "Platform audit" }).click();
  await expect(page.getByRole("heading", { name: "Platform audit", level: 1 })).toBeVisible();
  await page.goto(`${urls.app}/platform/accounts`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
