// SPDX-License-Identifier: AGPL-3.0-only
/** Mailboxes (Phase 3) on a domain verified through the development DNS (`.test` names answer as configured). */
import { e2eUsers, expect, openNav, panel, panelReady, signIn, test, urls, verifyDomain } from "./fixtures";

test("an owner creates a mailbox, changes its storage, suspends, resumes, deletes and restores it", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000); // waits on the provisioning worker four times
  const u = e2eUsers();
  // A retry gets its own domain: the first attempt's is still there (removed with the run's other fixtures).
  const domain = `${u.run}-mbx-${testInfo.project.name}-${testInfo.retry}.test`;
  await signIn(page, u.users.owner, u.password);

  // A verified domain first.
  await (await openNav(page)).getByRole("link", { name: "Domains" }).click();
  await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Add a domain" }).click();
  await page.getByLabel("Domain name").fill(domain);
  await page.getByRole("button", { name: "Add domain" }).click();
  await verifyDomain(page, domain);

  await page.keyboard.press("Escape");
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await expect(page.getByRole("heading", { name: "Mailboxes", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Add a shared address" }).click();
  const adding = panel(page, "Add a shared address");
  await expect(adding).toBeVisible();
  await page.getByLabel("Address").fill("Jane");
  await page.getByLabel("Domain").selectOption({ label: domain });
  await page.getByLabel("Belongs to").selectOption({ label: u.users.member });
  await page.getByLabel("Storage (GB)").fill("5");
  await page.getByLabel("Password", { exact: true }).fill("e2e mailbox password");
  await page.getByRole("button", { name: "Create shared address" }).click();
  await expect(adding.getByRole("status").filter({ hasText: `jane@${domain}` })).toBeVisible();

  const row = page.getByRole("row", { name: new RegExp(`jane@${domain}`) });
  await expect(row).toBeVisible();

  // The same address can't be taken twice (the panel stays open for the next one).
  await page.getByLabel("Address").fill("jane");
  await page.getByLabel("Domain").selectOption({ label: domain });
  await page.getByLabel("Password", { exact: true }).fill("e2e mailbox password");
  await page.getByRole("button", { name: "Create shared address" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That address is already in use." })).toBeVisible();
  await adding.getByRole("link", { name: "Close" }).click();
  await expect(adding).toHaveCount(0);

  // The worker creates it on the mail server.
  await expect(async () => {
    await page.reload();
    await expect(row.getByText("Active")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });

  // The details open in a panel over the list.
  await row.getByRole("link").click();
  const details = panel(page, `jane@${domain}`);
  await expect(details.getByRole("heading", { name: `jane@${domain}`, level: 2 })).toBeVisible();
  await expect(details.getByText(u.users.member, { exact: true }).first()).toBeVisible();
  await details.getByRole("tab", { name: "Storage" }).click();
  await details.getByLabel("Storage (GB)").fill("3");
  await details.getByRole("button", { name: "Save" }).click();
  await expect(details.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  // Lined rows: used (not measured yet for a new mailbox), its share of the account's pooled storage, what's left.
  await expect(details.getByRole("definition").filter({ hasText: "3 GB of the account's 10 GB" })).toBeVisible();
  await expect(details.getByRole("definition").filter({ hasText: "not given to any mailbox" })).toBeVisible();
  // The page header shows the account's pool.
  await expect(page.getByRole("region", { name: "Account storage" })).toContainText("assigned to mailboxes");
  await expect(details.getByRole("definition").filter({ hasText: "Not measured yet" })).toBeVisible();

  // The old mailbox address still works: it opens the same panel.
  const id = new URL(page.url()).searchParams.get("mailbox") ?? "";
  const list = new URL(page.url()).pathname;
  await page.goto(`${urls.app}${list}/${id}`);
  await expect(page).toHaveURL(new RegExp(`[?&]mailbox=${id}`));
  await expect(details).toBeVisible();
  await panelReady(page, `jane@${domain}`);

  // Suspend and resume (the worker applies both on the mail server).
  await details.getByRole("tab", { name: "Access" }).click();
  await details.getByRole("button", { name: "Suspend mailbox" }).click();
  await expect(details.getByText("Suspended", { exact: true })).toBeVisible();
  // Wait for the request before polling: the reload below would cancel it while it's in flight (a cold dev server
  // compiles the route on its first call, so the request can take seconds).
  const resumed = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/resume"));
  await details.getByRole("button", { name: "Resume mailbox" }).click();
  expect((await resumed).ok()).toBe(true);
  await expect(async () => {
    await page.reload();
    await expect(details.getByText("Active", { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await panelReady(page, `jane@${domain}`);

  // Delete: two steps, says it can be restored and until when; then it shows as being deleted.
  await details.getByRole("tab", { name: "Access" }).click();
  await details.getByRole("button", { name: "Delete mailbox…" }).click();
  await expect(details.getByText(/you can restore it until/)).toBeVisible();
  await details.getByRole("button", { name: "Cancel" }).click();
  await details.getByRole("button", { name: "Delete mailbox…" }).click();
  await details.getByRole("button", { name: "Delete mailbox", exact: true }).click();
  await expect(details.getByText("Deleting", { exact: true })).toBeVisible();
  await expect(details.getByText(/Restorable until/)).toBeVisible();
  await expect(details.getByRole("button", { name: "Suspend mailbox" })).toHaveCount(0);
  await details.getByRole("link", { name: "Close" }).click();
  await expect(details).toHaveCount(0);

  // A mailbox being deleted is never offered as an alias target.
  await (await openNav(page)).getByRole("link", { name: "Aliases" }).click();
  await expect(page.getByRole("heading", { name: "Aliases", level: 1 })).toBeVisible();
  await expect(page.locator("option", { hasText: `jane@${domain}` })).toHaveCount(0);

  // Restore it from the list's row menu: back to active once the worker has turned it on again.
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await expect(row.getByText("Deleting")).toBeVisible();
  await row.getByRole("button", { name: `Actions for jane@${domain}` }).click();
  await page.getByRole("menuitem", { name: "Restore…" }).click();
  const restored = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/restore"));
  await details.getByRole("button", { name: "Restore mailbox" }).click();
  expect((await restored).ok()).toBe(true);
  await expect(async () => {
    await page.reload();
    await expect(details.getByText("Active", { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await panelReady(page, `jane@${domain}`);
  await details.getByRole("tab", { name: "Access" }).click();
  await expect(details.getByRole("button", { name: "Suspend mailbox" })).toBeVisible();
  await details.getByRole("link", { name: "Close" }).click();
  await expect(details).toHaveCount(0);

  // A domain with a mailbox on it can't be removed.
  await (await openNav(page)).getByRole("link", { name: "Domains" }).click();
  await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: domain, exact: true }).click();
  const domainPanel = panel(page, domain);
  await domainPanel.getByRole("tab", { name: "Overview" }).click();
  await domainPanel.getByRole("button", { name: "Remove domain…" }).click();
  await domainPanel.getByRole("button", { name: "Remove domain", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Remove or move the mailboxes" })).toBeVisible();
});

test("a member has no Mailboxes section", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.member, u.password);
  await expect((await openNav(page)).getByRole("link", { name: "Mailboxes" })).toHaveCount(0);
});
