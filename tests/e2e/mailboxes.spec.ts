// SPDX-License-Identifier: AGPL-3.0-only
/** Mailboxes (Phase 3) on a domain verified through the development DNS (`.test` names answer as configured). */
import { e2eUsers, expect, openNav, signIn, test } from "./fixtures";

test("an owner creates a mailbox, changes its storage, suspends, resumes, deletes and restores it", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000); // waits on the provisioning worker four times
  const u = e2eUsers();
  const domain = `${u.run}-mbx-${testInfo.project.name}.test`;
  await signIn(page, u.users.owner, u.password);

  // A verified domain first.
  await (await openNav(page)).getByRole("link", { name: "Domains" }).click();
  await page.getByLabel("Add a domain").fill(domain);
  await page.getByRole("button", { name: "Add domain" }).click();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Verified." })).toBeVisible();

  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await expect(page.getByRole("heading", { name: "Mailboxes", level: 1 })).toBeVisible();
  await page.getByLabel("Address").fill("Jane");
  await page.getByLabel("Domain").selectOption({ label: domain });
  await page.getByLabel("Belongs to").selectOption({ label: u.users.member });
  await page.getByLabel("Storage (GB)").fill("5");
  await page.getByRole("button", { name: "Create mailbox" }).click();

  const row = page.getByRole("row", { name: new RegExp(`jane@${domain}`) });
  await expect(row).toBeVisible();
  // The worker creates it on the mail server.
  await expect(async () => {
    await page.reload();
    await expect(row.getByText("Active")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });

  // The same address can't be taken twice.
  await page.getByLabel("Address").fill("jane");
  await page.getByLabel("Domain").selectOption({ label: domain });
  await page.getByRole("button", { name: "Create mailbox" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That address is already in use." })).toBeVisible();

  await row.getByRole("link").click();
  await expect(page.getByRole("heading", { name: `jane@${domain}`, level: 1 })).toBeVisible();
  await expect(page.getByText(u.users.member)).toBeVisible();
  await page.getByLabel("Storage (GB)").fill("3");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(page.getByText("3 GB")).toBeVisible();

  // Suspend and resume (the worker applies both on the mail server).
  await page.getByRole("button", { name: "Suspend mailbox" }).click();
  await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume mailbox" }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Active", { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });

  // Delete: two steps, says it can be restored and until when; then it shows as being deleted.
  await page.getByRole("button", { name: "Delete mailbox…" }).click();
  await expect(page.getByText(/you can restore it until/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Delete mailbox…" }).click();
  await page.getByRole("button", { name: "Delete mailbox", exact: true }).click();
  await expect(page.getByText("Deleting", { exact: true })).toBeVisible();
  await expect(page.getByText(/Restorable until/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Suspend mailbox" })).toHaveCount(0);

  // A mailbox being deleted is never offered as an alias target.
  await (await openNav(page)).getByRole("link", { name: "Aliases" }).click();
  await expect(page.getByRole("heading", { name: "Aliases", level: 1 })).toBeVisible();
  await expect(page.locator("option", { hasText: `jane@${domain}` })).toHaveCount(0);

  // Restore it from the list: back to active once the worker has turned it on again.
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await expect(row.getByText("Deleting")).toBeVisible();
  await row.getByRole("link").click();
  await page.getByRole("button", { name: "Restore mailbox" }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Active", { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Suspend mailbox" })).toBeVisible();

  // A domain with a mailbox on it can't be removed.
  await (await openNav(page)).getByRole("link", { name: "Domains" }).click();
  await page.getByRole("link", { name: domain }).click();
  await page.getByRole("button", { name: "Remove domain…" }).click();
  await page.getByRole("button", { name: "Remove domain", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Remove or move the mailboxes" })).toBeVisible();
});

test("a member has no Mailboxes section", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.member, u.password);
  await expect((await openNav(page)).getByRole("link", { name: "Mailboxes" })).toHaveCount(0);
});
