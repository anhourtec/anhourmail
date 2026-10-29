// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Data export and account deletion (ADR-0025). An Owner asks for an account export, schedules the account for deletion
 * (typing its name), its Member sees the notice, and the Owner cancels; a person who is alone in an empty account of
 * their own deletes their login. Each browser project has its own accounts and logins (scripts/e2e-fixtures.ts). The
 * archive build and the removal after the grace period are scheduler jobs, covered by the integration tests.
 */
import { readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { e2eUsers, expect, openNav, SIGN_IN_TIMEOUT, signIn, signOut, test, urls } from "./fixtures";

/** Confirms it's you when the server asks for a fresh step-up (signing in just now usually counts). */
async function confirmIfAsked(page: Page, password: string, done: () => Promise<boolean>) {
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect.poll(async () => (await confirm.isVisible()) || (await done()), { timeout: SIGN_IN_TIMEOUT }).toBe(true);
  if (await confirm.isVisible()) {
    await confirm.getByLabel("Console password").fill(password);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  }
}

/** Opens the webmail settings window from the sidebar footer (a drawer on phones). */
async function openWebmailSettings(page: Page) {
  const nav = page.getByRole("navigation", { name: "Folders" });
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle folders" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Settings" });
}

test("an Owner exports the account, schedules it for deletion, its Member sees it, then the Owner cancels", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const u = e2eUsers();
  const d = u.data[testInfo.project.name] ?? { accountName: "", owner: "", member: "", leaver: "" };
  await signIn(page, d.owner, u.password);
  await (await openNav(page)).getByRole("link", { name: "Account settings" }).click();
  await expect(page.getByRole("heading", { name: "Account settings", level: 1 })).toBeVisible();

  // Export: queued, and a second one can't be asked for while it's being prepared.
  const exportSection = page.getByRole("region", { name: "Export your data" });
  await exportSection.getByRole("button", { name: "Request an export" }).click();
  await expect(exportSection.getByText("Waiting to be prepared")).toBeVisible();
  await expect(exportSection.getByRole("button", { name: "Request an export" })).toBeDisabled();

  // Delete: the button waits for the exact name.
  const deleteSection = page.getByRole("region", { name: "Delete account" });
  const button = deleteSection.getByRole("button", { name: "Delete this account" });
  await expect(button).toBeDisabled();
  await deleteSection.getByLabel(/^Type .* to confirm$/).fill(d.accountName.toLowerCase());
  await expect(button).toBeDisabled();
  await deleteSection.getByLabel(/^Type .* to confirm$/).fill(d.accountName);
  await button.click();
  await confirmIfAsked(page, u.password, () =>
    page.getByText("This account is scheduled for deletion").first().isVisible(),
  );
  await expect(
    page.getByRole("status").filter({ hasText: "This account is scheduled for deletion" }).first(),
  ).toBeVisible();
  await expect(deleteSection.getByRole("button", { name: "Cancel deletion" })).toBeVisible();
  await signOut(page);

  // The Member sees when it goes, and has no cancel link.
  await signIn(page, d.member, u.password);
  const notice = page.getByRole("status").filter({ hasText: "This account is scheduled for deletion" });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("link", { name: /Cancel the deletion/ })).toHaveCount(0);
  await signOut(page);

  // The Owner cancels: the notice goes.
  await signIn(page, d.owner, u.password);
  await page
    .getByRole("status")
    .filter({ hasText: "This account is scheduled for deletion" })
    .getByRole("link", { name: "Cancel the deletion in Account settings" })
    .click();
  await page.getByRole("region", { name: "Delete account" }).getByRole("button", { name: "Cancel deletion" }).click();
  await expect(
    page.getByRole("region", { name: "Delete account" }).getByRole("button", { name: "Delete this account" }),
  ).toBeVisible();
  await expect(page.getByText("This account is scheduled for deletion")).toHaveCount(0);
});

test("a person alone in an empty account of their own deletes their login", async ({ page }, testInfo) => {
  const u = e2eUsers();
  const d = u.data[testInfo.project.name] ?? { accountName: "", owner: "", member: "", leaver: "" };
  await signIn(page, d.leaver, u.password);
  await page.getByRole("button", { name: "Your account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Your data" }).click();
  await expect(page.getByRole("heading", { name: "Your data", level: 1 })).toBeVisible();
  const section = page.getByRole("region", { name: "Delete your login" });
  await section.getByLabel(/^Type .* to confirm$/).fill(d.leaver);
  await section.getByRole("button", { name: "Delete my login" }).click();
  await confirmIfAsked(page, u.password, async () => page.url().includes("/sign-in"));
  await expect(page).toHaveURL(/\/sign-in/, { timeout: SIGN_IN_TIMEOUT });
  // The login is gone: signing in with it fails.
  await page.getByLabel("Email").fill(d.leaver);
  await page.getByLabel("Password", { exact: true }).fill(u.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
});

test("the webmail exports the signed-in mailbox as a ZIP from Settings, Export", async ({ page }) => {
  const u = e2eUsers();
  await page.goto(`${urls.webmail}/sign-in`);
  await page.getByLabel("Mailbox address").fill(u.recipient.address);
  await page.getByLabel("Password", { exact: true }).fill(u.recipient.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible({ timeout: SIGN_IN_TIMEOUT });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const settings = await openWebmailSettings(page);
  await settings.getByRole("tab", { name: /^Export/ }).click();
  await expect(settings.getByRole("tabpanel").getByRole("heading", { name: "Export", level: 2 })).toBeVisible();
  const download = page.waitForEvent("download");
  await settings.getByRole("link", { name: "Download all mail and contacts" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^anhourmail-mail-export-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(
    readFileSync(await file.path())
      .subarray(0, 4)
      .toString("hex"),
  ).toBe("504b0304");
});
