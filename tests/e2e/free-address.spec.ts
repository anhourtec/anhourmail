// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Free platform-domain addresses (ADR-0021): a new sign-up confirms their email from the emailed link, claims a free
 * address from the console home (live availability check, generated password), and signs in to the webmail with it;
 * a second one is refused by the Free plan. Staff create a free address in another new account, which its owner sees
 * as an Anhourtec staff action in the audit log. Each browser project signs up its own people (names carry the run id,
 * so global teardown removes them, their accounts and their mailboxes on the dev mail server).
 */
import type { Page } from "@playwright/test";

import {
  e2eUsers,
  expect,
  homeHeading,
  linkFromMail,
  openNav,
  panel,
  signIn,
  signOut,
  SIGN_IN_TIMEOUT,
  test,
  urls,
} from "./fixtures";

test.use({ trace: "off" });

async function signUp(page: Page, who: string, email: string, password: string) {
  await page.goto(`${urls.app}/sign-up`);
  await page.getByLabel("First name").fill(who);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(homeHeading(page)).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
}

/** The platform domain the console offers (read from the card, so the test follows `PLATFORM_DOMAIN`). */
async function freeDomain(page: Page): Promise<string> {
  const title =
    (await page
      .getByRole("heading", { name: /^Get your free @/ })
      .first()
      .textContent()) ?? "";
  const domain = /@(\S+) address$/.exec(title)?.[1];
  if (!domain) throw new Error(`no free address card: ${title}`);
  return domain;
}

test("sign up, confirm the email, claim a free address and sign in to the webmail with it", async ({
  page,
  browser,
  request,
  consoleErrors,
}, testInfo) => {
  test.setTimeout(120_000); // waits on the provisioning worker
  const u = e2eUsers();
  const who = `${u.run}-${testInfo.project.name}-free`;
  const email = `${who}@e2e.test`;
  const name = `${u.run}-${testInfo.project.name}`.slice(0, 32);
  await signUp(page, who, email, `${u.password}-free`);

  // Before confirming: the claim panel says so and won't create anything.
  const domain = await freeDomain(page);
  await page.getByRole("link", { name: "Choose your address" }).first().click();
  const claim = panel(page, `Get your free @${domain} address`);
  await expect(claim.getByText("Confirm your email address first.")).toBeVisible();
  await expect(claim.getByRole("button", { name: "Get this address" })).toBeDisabled();

  // The link sent at sign-up confirms it.
  const link = await linkFromMail(request, email, /https?:\/\/\S+\/api\/auth\/verify-email\?\S+/);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Email address confirmed", level: 1 })).toBeVisible();

  // Claim from the home page: availability is checked as you type; a short name breaks the rule.
  await page.goto(urls.app);
  await page.getByRole("link", { name: "Choose your address" }).first().click();
  await expect(claim.getByText("Confirm your email address first.")).toHaveCount(0);
  await claim.getByLabel("Address", { exact: true }).fill("abc");
  await expect(claim.getByText("Use at least 4 characters.")).toBeVisible();
  await claim.getByLabel("Address", { exact: true }).fill("postmaster");
  await expect(claim.getByText("That name is reserved.")).toBeVisible();
  await claim.getByLabel("Address", { exact: true }).fill(name.toUpperCase());
  const address = `${name}@${domain}`;
  await expect(claim.getByText(`${address} is available.`)).toBeVisible();
  await claim.getByRole("button", { name: "Generate a strong password" }).click();
  const password = (await claim.getByTestId("generated-password").textContent()) ?? "";
  expect(password).toMatch(/^[A-Za-z2-9]{20}$/);
  await claim.getByRole("button", { name: "Get this address" }).click();
  await expect(claim.getByRole("status").filter({ hasText: `${address} is yours` })).toBeVisible();
  await claim.getByRole("link", { name: "Close" }).click();

  // The worker sets it up; the home page no longer offers a free address and the plan refuses a second.
  const row = page.getByRole("row", { name: new RegExp(address) });
  await expect(async () => {
    await page.reload();
    await expect(row.getByText("Active")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 40_000 });
  await page.goto(urls.app);
  await expect(page.getByRole("heading", { name: /^Get your free @/ })).toHaveCount(0);

  // The webmail sign-in takes the address and the password chosen.
  const person = await browser.newContext();
  const mail = await person.newPage();
  await mail.goto(`${urls.webmail}/sign-in`);
  await mail.getByLabel("Mailbox address").fill(address);
  await mail.getByLabel("Password", { exact: true }).fill(password);
  await mail.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(mail.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await person.close();
  expect(consoleErrors).toEqual([]);
});

test("staff create a free address in a customer's account; its owner sees it as a staff action", async ({
  page,
}, testInfo) => {
  const u = e2eUsers();
  const who = `${u.run}-${testInfo.project.name}-staffmade`;
  const email = `${who}@e2e.test`;
  const name = `${u.run}-${testInfo.project.name}-s`.slice(0, 32);
  await signUp(page, who, email, `${u.password}-staffmade`);
  const domain = await freeDomain(page);
  await signOut(page);

  await signIn(page, u.users.globalAdmin, u.password);
  await (await openNav(page)).getByRole("link", { name: "Customer accounts" }).click();
  await page.getByLabel("Search accounts").fill(who);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: who }).click();
  await expect(page.getByRole("heading", { name: who, level: 1 })).toBeVisible();
  await page.getByRole("tab", { name: /^Mailboxes/ }).click();
  const form = page.getByRole("form", { name: `Create a free @${domain} address` });
  await form.getByLabel("Address", { exact: true }).fill(name);
  await form.getByLabel("Belongs to").selectOption({ label: email });
  await form.getByRole("button", { name: "Create address" }).click();
  await expect(form.getByRole("status").filter({ hasText: `${name}@${domain}` })).toBeVisible();
  await signOut(page);

  // The owner sees the mailbox and, in the audit log, that Anhourtec staff created it.
  await signIn(page, email, `${u.password}-staffmade`);
  await (await openNav(page)).getByRole("link", { name: "Audit log" }).click();
  await page.getByLabel("Who").selectOption({ label: "Anhourtec staff" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("row", { name: /Mailbox created/ }).first()).toBeVisible();
});
