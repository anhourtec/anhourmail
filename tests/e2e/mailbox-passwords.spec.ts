// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailbox passwords (07-security.md "Mailbox passwords"): an owner creates a mailbox with a generated password, its
 * person signs in to the webmail with it and changes it in Settings → Account (staying signed in), then the owner sets
 * a new one from the console (confirming it's them if asked) and the person is emailed and signs in with that. No
 * wrong password is ever sent (the dev forwarder's address is shared and Stalwart bans repeated failures).
 */
import type { Page } from "@playwright/test";

import { e2eUsers, expect, linkFromMail, openNav, panel, signIn, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

test.use({ trace: "off" });

async function signInWebmail(page: Page, address: string, password: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });

async function openAccountSettings(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await settings(page)
    .getByRole("tab", { name: /^Account/ })
    .click();
  await expect(settings(page).getByRole("tabpanel").getByRole("heading", { name: "Account", level: 2 })).toBeVisible();
}

test("create with a password, sign in, change it in the webmail, and an owner's reset", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(150_000); // waits on the provisioning worker three times
  const u = e2eUsers();
  const domain = `${u.run}-pw-${testInfo.project.name}-${testInfo.retry}.test`;
  const address = `pat@${domain}`;
  const people = u.passwords[testInfo.project.name] ?? { owner: "", member: "" };
  await signIn(page, people.owner, u.password);

  await (await openNav(page)).getByRole("link", { name: "Domains" }).click();
  await page.getByRole("link", { name: "Add a domain" }).first().click();
  await page.getByLabel("Domain name").fill(domain);
  await page.getByRole("button", { name: "Add domain" }).click();
  await panel(page, domain).getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Verified." })).toBeVisible();
  await page.keyboard.press("Escape");

  // Create with a generated password, shown once.
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Add a shared address" }).click();
  const adding = panel(page, "Add a shared address");
  await page.getByLabel("Address").fill("pat");
  await page.getByLabel("Domain").selectOption({ label: domain });
  await page.getByLabel("Belongs to").selectOption({ label: people.member });
  await expect(adding.getByText("A passphrase works well.", { exact: false })).toBeVisible();
  await adding.getByRole("button", { name: "Generate a strong password" }).click();
  const generated = (await adding.getByTestId("generated-password").textContent()) ?? "";
  expect(generated).toMatch(/^[A-Za-z2-9]{20}$/);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(generated);
  await page.getByRole("button", { name: "Create shared address" }).click();
  await expect(adding.getByRole("status").filter({ hasText: address })).toBeVisible();
  await expect(adding.getByTestId("generated-password")).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await adding.getByRole("link", { name: "Close" }).click();
  await expect(adding).toHaveCount(0);
  const row = page.getByRole("row", { name: new RegExp(address) });
  await expect(async () => {
    await page.reload();
    await expect(row.getByText("Active")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  // The person signs in to the webmail with it (a separate browser context: the webmail is its own origin).
  const person = await browser.newContext();
  const mail = await person.newPage();
  await signInWebmail(mail, address, generated);

  // …and changes it in Settings → Account: this session stays signed in.
  const changed = `pat changed ${u.run}`;
  await openAccountSettings(mail);
  const tab = settings(mail).getByRole("tabpanel");
  await tab.getByLabel("Current password").fill(generated);
  await tab.getByLabel("New password").fill(changed);
  await tab.getByRole("button", { name: "Change password" }).click();
  await expect(tab.getByText("Password changed.")).toBeVisible({ timeout: 30_000 });
  // The person is told at their console address (never the password).
  expect(
    await linkFromMail(request, people.member, new RegExp(`password for ${address} was changed in the webmail`)),
  ).toContain(address);
  await settings(mail).getByRole("button", { name: "Close settings" }).last().click();
  await mail.reload();
  await expect(mail.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });

  // The owner sets a new password from the console.
  await row.getByRole("link").click();
  const details = panel(page, address);
  await details.getByRole("tab", { name: "Password", exact: true }).click();
  const reset = `owner reset ${u.run}`;
  await details.getByLabel("New password").fill(reset);
  await details.getByRole("button", { name: "Save new password" }).click();
  // Signing in just now counts as confirming it's you (later the console asks first; unit-tested).
  const done = details.getByRole("status").filter({ hasText: "New password set." });
  await expect(done).toBeVisible();
  // The person is told (at their console address), never with the password.
  const notice = await linkFromMail(request, people.member, new RegExp(`set a new password for ${address}`));
  expect(notice).toContain(address);

  // Applied by the worker within a moment (the panel stops saying so); then the new password signs in, and the
  // person's earlier webmail session has ended (the mail server revoked its tokens).
  await expect(async () => {
    await page.reload();
    await expect(details.getByRole("tab", { name: "Password", exact: true })).toBeVisible({ timeout: 2000 });
    await details.getByRole("tab", { name: "Password", exact: true }).click();
    await expect(details.getByText("A new password is being applied.")).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 40_000 });
  const fresh = await browser.newPage();
  await signInWebmail(fresh, address, reset);
  await fresh.close();
  await expect(async () => {
    await mail.reload();
    await expect(mail.getByLabel("Mailbox address")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await person.close();
});
