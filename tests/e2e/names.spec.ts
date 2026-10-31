// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Names as one source (CLAUDE.md rule 61; core `people/names.ts`): the person's name edited on the console Profile is
 * the sender name in the webmail of their own mailbox, one changed in webmail Settings → Account → Sender name shows on
 * the console Profile when that tab is shown again (no reload), and a console change reaches a webmail tab left open.
 * Uses this run's own person and mailbox (scripts/e2e-fixtures.ts), never demo data.
 */
import type { Page, TestInfo } from "@playwright/test";

import { e2eUsers, expect, signIn, SIGN_IN_TIMEOUT, test, urls } from "./fixtures";

test.use({ trace: "off" });

const who = (info: TestInfo) => {
  const n = e2eUsers().names[info.project.name];
  if (!n) throw new Error(`no names fixture for ${info.project.name}`);
  return n;
};

async function signInWebmail(page: Page, address: string, password: string) {
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

/** What a tab does when the person comes back to it: the page sees it shown and focused again. */
async function comeBack(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
  });
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

async function editProfileName(page: Page, name: string) {
  await page.getByRole("button", { name: "Edit name" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Name saved." })).toBeVisible();
  await expect(page.getByTestId("person-name")).toHaveText(name);
}

test("a name edited on the console Profile is the webmail sender name, and one edited in the webmail shows in the console", async ({
  page,
  context,
  // Requested so the run fails on any console error, CSP violation or page error.
  consoleErrors: _consoleErrors,
}, info) => {
  const { password } = e2eUsers();
  const me = who(info);
  const suffix = info.project.name.replace(/[^a-z0-9]/gi, "");

  // Console: edit the name on Profile; the heading and the app bar's person show it at once.
  await signIn(page, me.person, password);
  await page.goto(`${urls.app}/profile`);
  await editProfileName(page, `Ada Lovelace ${suffix}`);
  await expect(page.getByRole("heading", { name: `Ada Lovelace ${suffix}`, level: 2 })).toBeVisible();

  // Webmail of their own mailbox: the sender name is that name, editable there.
  const mail = await context.newPage();
  await signInWebmail(mail, me.mailbox, me.mailboxPassword);
  await openAccountSettings(mail);
  const field = settings(mail).getByLabel("Sender name, as people see it on your mail");
  await expect(field).toHaveValue(`Ada Lovelace ${suffix}`);

  // Webmail: change it; the console Profile, still open, shows it when that tab is shown again.
  await field.fill(`Ada King ${suffix}`);
  await settings(mail).getByRole("button", { name: "Save name" }).click();
  await expect(settings(mail).getByText("Name saved.")).toBeVisible();
  await comeBack(page);
  await expect(page.getByTestId("person-name")).toHaveText(`Ada King ${suffix}`);
  await expect(page.getByRole("heading", { name: `Ada King ${suffix}`, level: 2 })).toBeVisible();

  // Console again: the webmail's settings, left open, pick it up when that tab is shown again.
  await editProfileName(page, `Grace Hopper ${suffix}`);
  await comeBack(mail);
  await expect(field).toHaveValue(`Grace Hopper ${suffix}`);
});
