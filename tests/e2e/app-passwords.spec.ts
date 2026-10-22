// SPDX-License-Identifier: AGPL-3.0-only
/**
 * App passwords and catch-all (Phase 3). An owner makes a mailbox of their own, creates an app password for it (seen
 * once), and revokes it; an owner turns catch-all on and off on a verified domain. Development DNS answers for `.test`
 * names (adapters/dns devResolver); the worker applies mailboxes, revocations and catch-alls to the dev mail server.
 */
import { e2eUsers, expect, openNav, panel, signIn, test } from "./fixtures";

test("an owner creates an app password for their own mailbox, sees it once, and revokes it", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000); // waits on the provisioning worker three times
  const u = e2eUsers();
  const domain = `${u.run}-apw-${testInfo.project.name}-${String(testInfo.retry)}.test`;
  const address = `me@${domain}`;
  await signIn(page, u.users.owner, u.password);

  // A verified domain and a mailbox that belongs to the owner.
  await (await openNav(page)).getByRole("link", { name: "Domains" }).click();
  await page.getByRole("link", { name: "Add a domain" }).click();
  await page.getByLabel("Domain name").fill(domain);
  await page.getByRole("button", { name: "Add domain" }).click();
  await panel(page, domain).getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Verified." })).toBeVisible();
  await page.keyboard.press("Escape");
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await page.getByRole("link", { name: "Add a mailbox" }).click();
  await page.getByLabel("Address").fill("me");
  await page.getByLabel("Domain").selectOption({ label: domain });
  await page.getByLabel("Belongs to").selectOption({ label: u.users.owner });
  await page.getByRole("button", { name: "Create mailbox" }).click();
  await expect(panel(page, "Add a mailbox").getByRole("status").filter({ hasText: address })).toBeVisible();
  await panel(page, "Add a mailbox").getByRole("link", { name: "Close" }).click();
  await expect(panel(page, "Add a mailbox")).toHaveCount(0);
  const row = page.getByRole("row", { name: new RegExp(address) });
  await expect(async () => {
    await page.reload();
    await expect(row.getByText("Active")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  // App passwords: create one, choosing what it can do.
  await (await openNav(page)).getByRole("link", { name: "App passwords" }).click();
  await expect(page.getByRole("heading", { name: "App passwords", level: 1 })).toBeVisible();
  const section = page.getByRole("region", { name: address });
  await expect(section.getByText("No app passwords yet.")).toBeVisible();
  await section.getByRole("button", { name: "Create app password" }).click();
  await section.getByLabel(/^Name/).fill("Phone");
  await expect(section.getByLabel("Read mail (IMAP)")).toBeChecked();
  await expect(section.getByLabel("Download mail (POP3)")).not.toBeChecked();
  await section.getByRole("button", { name: "Create password" }).click();
  // Signing in just now counts as confirming it's you (a few minutes later the console asks for the password again).
  const reveal = section.getByRole("status").filter({ hasText: "Your app password for Phone" });
  await expect(reveal).toBeVisible();
  const secret = ((await reveal.locator("code").textContent()) ?? "").replace(/\s+/g, "");
  expect(secret).toMatch(/^app_[a-z0-9]{36}$/);
  await expect(reveal.getByRole("button", { name: "Copy password" })).toBeVisible();

  // Done: it's gone from the page for good; the list shows its name and what it's for.
  await reveal.getByRole("button", { name: "Done" }).click();
  await expect(reveal).toHaveCount(0);
  const list = section.getByRole("list", { name: `App passwords for ${address}` });
  const item = list.getByRole("listitem").filter({ hasText: "Phone" });
  await expect(item).toBeVisible();
  await expect(item.getByText(/IMAP, SMTP, Contacts and calendars · created/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(secret)).toHaveCount(0);
  expect(await page.content()).not.toContain(secret);

  // The mail-app settings come from the public facts.
  const settings = page.getByRole("region", { name: "Settings for your mail app" });
  await expect(settings.getByText("imap.anhourmail.com").first()).toBeVisible();
  await expect(settings.getByRole("listitem").filter({ hasText: "IMAP" }).getByText("993")).toBeVisible();

  // The mailbox panel lists it for people who manage mailboxes (no secret there either).
  await (await openNav(page)).getByRole("link", { name: "Mailboxes" }).click();
  await row.getByRole("link").click();
  const details = panel(page, address);
  await details.getByRole("tab", { name: "App passwords" }).click();
  await expect(details.getByRole("listitem").filter({ hasText: "Phone" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Revoke it: it shows as revoking, then the worker takes it off the mail server.
  await (await openNav(page)).getByRole("link", { name: "App passwords" }).click();
  await section.getByRole("button", { name: "Revoke Phone" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Revoke Phone?" });
  await dialog.getByRole("button", { name: "Revoke app password" }).click();
  await expect(dialog).toHaveCount(0);
  // Revoking (or, with a fast worker, already gone).
  await expect(section.getByText("Revoking").or(section.getByText("No app passwords yet."))).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(section.getByText("No app passwords yet.")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
});

test("an owner turns catch-all on for a verified domain, then off again", async ({ page }) => {
  const u = e2eUsers();
  const domain = u.recipient.address.slice(u.recipient.address.indexOf("@") + 1);
  await signIn(page, u.users.owner, u.password);
  await (await openNav(page)).getByRole("link", { name: "Domains" }).click();
  await page
    .getByRole("row", { name: new RegExp(domain.replace(/\./g, "\\.")) })
    .getByRole("link")
    .click();
  const details = panel(page, domain);
  const section = details.getByRole("region", { name: "Catch-all" });
  await expect(section.getByText(/Off: mail to an address/)).toBeVisible();
  await expect(section.getByText(/receives a lot of spam/)).toBeVisible();
  await section.getByLabel("Send unknown addresses to").selectOption({ label: u.recipient.address });
  await section.getByRole("button", { name: "Turn on catch-all" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Catch-all is on." })).toBeVisible();
  await expect(details.getByText(`On, to ${u.recipient.address}`)).toBeVisible();

  await section.getByRole("button", { name: "Turn off" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Catch-all is off." })).toBeVisible();
  await expect(section.getByText(/Off: mail to an address/)).toBeVisible();
});

test("a member sees App passwords for their own mailboxes only", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.member, u.password);
  await (await openNav(page)).getByRole("link", { name: "App passwords" }).click();
  await expect(page.getByRole("heading", { name: "App passwords", level: 1 })).toBeVisible();
  // Mailboxes that belong to others (the owner's from the first journey, the run's unassigned one) never show.
  await expect(page.getByText(`@${u.run}-apw-`)).toHaveCount(0);
  await expect(page.getByText(u.recipient.address)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Settings for your mail app" })).toBeVisible();
});
