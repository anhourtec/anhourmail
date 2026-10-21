// SPDX-License-Identifier: AGPL-3.0-only
import { e2eUsers, expect, linkFromMail, openNav, signIn, signOut, test, urls } from "./fixtures";

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
  const nav = await openNav(page);
  for (const label of ["Platform audit", "Staff roles", "Abuse queue", "Customer accounts"]) {
    await expect(nav.locator(`[data-nav]`, { hasText: label }).first()).toBeVisible();
  }
  expect(consoleErrors).toEqual([]);
});

test("Reports Reader sees read-only staff sections only", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.reportsReader, u.password);
  const nav = await openNav(page);
  await expect(nav.locator(`[data-nav="platform.audit.read"]`)).toBeVisible();
  await expect(nav.locator(`[data-nav="platform.staff.manage"]`)).toHaveCount(0);
});

test("Owner sees account admin sections and the audit log", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.owner, u.password);
  await expect(page.getByRole("heading", { name: u.accountName })).toBeVisible();
  const nav = await openNav(page);
  await expect(nav.locator(`[data-nav="audit.read"]`)).toBeVisible();
  await expect(nav.locator(`[data-nav="account.admins.manage"]`)).toBeVisible();
});

test("Member sees only their own aliases", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.member, u.password);
  const nav = await openNav(page);
  await expect(nav.locator(`[data-nav="alias.manage.own"]`)).toBeVisible();
  await expect(nav.locator(`[data-nav="audit.read"]`)).toHaveCount(0);
  await expect(nav.locator(`[data-nav="domain.read"]`)).toHaveCount(0);
});

test("sign out returns to sign-in", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.owner, u.password);
  await signOut(page);
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
  const nav = await openNav(page);
  await expect(nav.locator(`[data-nav="audit.read"]`)).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("sign-in links to sign-up and shows the legal consent", async ({ page }) => {
  await page.goto(`${urls.app}/sign-in`);
  await expect(page.getByText("By signing in, you agree to our")).toBeVisible();
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
});

test("forgot password asks for an address before sending anything", async ({ page }) => {
  await page.goto(`${urls.app}/forgot-password`);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Enter the email address you sign in with." })).toBeVisible();
  await expect(page.getByText("If an account uses that address")).toHaveCount(0);
});

test("forgot password always answers the same and links back to sign-in", async ({ page }) => {
  await page.goto(`${urls.app}/sign-in`);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel("Email").fill("nobody-here@e2e.test");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("If an account uses that address");
});

test("password reset: the emailed link sets a new password that then signs in", async ({ page }, testInfo) => {
  const u = e2eUsers();
  const who = `${u.run}-${testInfo.project.name}-reset`;
  const email = `${who}@e2e.test`;
  // A fresh account (sign-up is open in dev); the run prefix lets global teardown remove it.
  await page.goto(`${urls.app}/sign-up`);
  await page.getByLabel("First name").fill(who);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(`${u.password}-old`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await signOut(page);
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("If an account uses that address");

  const link = await linkFromMail(page.request, email, /https?:\/\/\S+\/reset-password[^\s"<]*/);
  await page.goto(link);
  await page.getByLabel("New password", { exact: true }).fill(`${u.password}-new`);
  await page.getByLabel("Confirm new password").fill(`${u.password}-new`);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("status")).toContainText("Your password has been changed.");

  await signIn(page, email, `${u.password}-new`);
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

test("the person's menu lists their account with its role and opens it", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.owner, u.password);
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Your account" });
  await expect(menu.getByText(u.users.owner)).toBeVisible();
  await menu.getByRole("menuitem", { name: new RegExp(u.accountName) }).click();
  await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+\//);
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await expect(
    page.getByRole("menu", { name: "Your account" }).getByRole("menuitem", { name: new RegExp(u.accountName) }),
  ).toHaveAttribute("aria-current", "true");
});

// The sidebar width is a wide-screen preference (a drawer on small screens): desktop project only.
test("preferences switch the sidebar between expanded and icons only @desktop-only", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.owner, u.password);
  await page.getByRole("button", { name: "Preferences" }).click();
  await page.getByRole("radio", { name: "Icons only" }).click();
  await expect(page.locator("aside").first()).toHaveClass(/w-16/);
  await page.getByRole("radio", { name: "Expanded" }).click();
  await expect(page.locator("aside").first()).toHaveClass(/w-64/);
});
