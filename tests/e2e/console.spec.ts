// SPDX-License-Identifier: AGPL-3.0-only
import { e2eUsers, expect, signIn, test, urls } from "./fixtures";

test("signed-out visitors land on sign-in; a wrong password shows an error", async ({ page }) => {
  await page.goto(urls.app);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel("Email").fill("nobody@e2e.test");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is wrong.")).toBeVisible();
});

test("Global Administrator sees every staff section", async ({ page, consoleErrors }) => {
  const u = e2eUsers();
  await signIn(page, u.users.globalAdmin, u.password);
  for (const label of ["Waitlist", "Platform audit", "Staff roles", "Abuse queue"]) {
    await expect(page.locator(`[data-nav]`, { hasText: label }).first()).toBeVisible();
  }
  expect(consoleErrors).toEqual([]);
});

test("Reports Reader sees read-only staff sections only", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.reportsReader, u.password);
  await expect(page.locator(`[data-nav="waitlist.read"]`)).toBeVisible();
  await expect(page.locator(`[data-nav="platform.staff.manage"]`)).toHaveCount(0);
});

test("Owner sees account admin sections and the audit log", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.owner, u.password);
  await expect(page.getByRole("heading", { name: u.accountName })).toBeVisible();
  await expect(page.locator(`[data-nav="audit.read"]`)).toBeVisible();
  await expect(page.locator(`[data-nav="account.admins.manage"]`)).toBeVisible();
});

test("Member sees only their own aliases", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.member, u.password);
  await expect(page.locator(`[data-nav="alias.manage.own"]`)).toBeVisible();
  await expect(page.locator(`[data-nav="audit.read"]`)).toHaveCount(0);
  await expect(page.locator(`[data-nav="domain.read"]`)).toHaveCount(0);
});

test("sign out returns to sign-in", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.owner, u.password);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("webmail origin serves the webmail", async ({ page }) => {
  await page.goto(urls.webmail);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("sign-up creates a personal Free account and lands on the console as its Owner", async ({
  page,
  consoleErrors,
}, testInfo) => {
  const u = e2eUsers();
  const who = `${u.run}-${testInfo.project.name}`;
  // Name and email carry the run prefix so global teardown removes the user and the personal account.
  await page.goto(`${urls.app}/sign-up`);
  await page.getByLabel("First name").fill(who);
  await page.getByLabel("Last name").fill("Signup");
  await expect(page.getByLabel("Display name")).toHaveValue(`${who} Signup`);
  await page.getByLabel("Email").fill(`${who}-signup@e2e.test`);
  await page.getByLabel("Password", { exact: true }).fill(`${u.password}-signup`);
  await expect(page.getByText("By creating an account, you agree to our")).toBeVisible();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: `${who} Signup` })).toBeVisible();
  await expect(page.locator(`[data-nav="audit.read"]`)).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("sign-in links to sign-up and shows the legal consent", async ({ page }) => {
  await page.goto(`${urls.app}/sign-in`);
  await expect(page.getByText("By signing in, you agree to our")).toBeVisible();
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
});

test("forgot password always answers the same and links back to sign-in", async ({ page }) => {
  await page.goto(`${urls.app}/sign-in`);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel("Email").fill("nobody-here@e2e.test");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("If an account uses that address");
});

test("the password eye toggles visibility", async ({ page }) => {
  await page.goto(`${urls.app}/sign-in`);
  const field = page.getByLabel("Password", { exact: true });
  await field.fill("secret-value");
  await expect(field).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(field).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(field).toHaveAttribute("type", "password");
});
