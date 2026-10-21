// SPDX-License-Identifier: AGPL-3.0-only
import { e2eUsers, expect, linkFromMail, openNav, signIn, test, urls } from "./fixtures";

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
  for (const label of ["Waitlist", "Platform audit", "Staff roles", "Abuse queue"]) {
    await expect(nav.locator(`[data-nav]`, { hasText: label }).first()).toBeVisible();
  }
  expect(consoleErrors).toEqual([]);
});

test("Reports Reader sees read-only staff sections only", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.reportsReader, u.password);
  const nav = await openNav(page);
  await expect(nav.locator(`[data-nav="waitlist.read"]`)).toBeVisible();
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

test("waitlist → confirm → staff invite → sign-up from the invite with the email locked", async ({
  page,
  request,
  browser,
}, testInfo) => {
  const u = e2eUsers();
  const who = `${u.run}-${testInfo.project.name}-invitee`;
  const email = `${who}@waitlist.test`;

  // 1. Join from the site and confirm through the emailed link.
  const joined = await request.post(`${urls.site}/api/public/waitlist`, {
    data: { email, startedAt: Date.now() - 10_000 },
    headers: { origin: urls.site },
  });
  expect(joined.status()).toBe(202);
  const confirm = await linkFromMail(request, email, /https?:\/\/\S+\/waitlist\/confirm\?token=[^\s"<]+/);
  await page.goto(confirm);
  await expect(page.getByText("You’re on the list.")).toBeVisible();

  // 2. A Global Administrator invites the confirmed sign-up from the console.
  await signIn(page, u.users.globalAdmin, u.password);
  await page.getByRole("button", { name: `Invite ${email}` }).click();
  await expect(page.getByRole("button", { name: `Invite ${email}` })).toHaveCount(0);

  // 3. The invitee signs up from the invite link (fresh browser context): the email is fixed.
  const inviteUrl = await linkFromMail(request, email, /https?:\/\/\S+\/sign-up\?invite=[^\s"<]+/);
  const invitee = await browser.newPage();
  await invitee.goto(inviteUrl);
  await expect(invitee.getByRole("heading", { name: "You're invited" })).toBeVisible();
  await expect(invitee.getByLabel("Email")).toHaveValue(email);
  await expect(invitee.getByLabel("Email")).toHaveAttribute("readonly", "");
  await invitee.getByLabel("First name").fill(who);
  await invitee.getByLabel("Password", { exact: true }).fill(`${u.password}-invitee`);
  await invitee.getByRole("button", { name: "Create account" }).click();
  await expect(invitee.getByRole("heading", { name: "Overview" })).toBeVisible();

  // 4. The invite is single-use.
  const again = await browser.newPage();
  await again.goto(inviteUrl);
  await expect(again.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(again.getByLabel("Email")).not.toHaveAttribute("readonly", "");
});
