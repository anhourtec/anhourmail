// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Domains (Phase 3). Development DNS answers for `.test` names as if every record were published, except names
 * starting with `unverified-` (adapters/dns devResolver), so both paths run without real DNS. DKIM keys exist only
 * once the worker has added the domain to the mail server (after ownership and MX pass), so verifying takes a check,
 * the worker, and a second check, as for a customer.
 */
import { e2eUsers, expect, openNav, panel, panelReady, recordStatus, signIn, test, urls } from "./fixtures";

test("an owner adds a domain, verifies it, sees it set up, then removes it", async ({ page }, testInfo) => {
  const u = e2eUsers();
  const name = `${u.run}-${testInfo.project.name}.test`;
  await signIn(page, u.users.owner, u.password);

  await (await openNav(page)).getByRole("link", { name: "Domains" }).click();
  await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Add a domain" }).click();
  await page.getByLabel("Domain name").fill(`  ${name.toUpperCase()}  `);
  await page.getByRole("button", { name: "Add domain" }).click();

  // The new domain opens in its details panel, on its DNS records.
  const details = panel(page, name);
  await expect(details.getByRole("heading", { name, level: 2 })).toBeVisible();
  await expect(details.getByText("Waiting for DNS")).toBeVisible();
  await expect(details.getByRole("tab", { name: "DNS records" })).toHaveAttribute("aria-selected", "true");
  const required = details.getByRole("region", { name: "Required records" });
  // Ownership, MX and SPF are found; the DKIM keys don't exist yet.
  await expect(required.getByText("Found", { exact: true })).toHaveCount(3);
  await expect(required.getByText("Not ready yet")).toBeVisible();

  await details.getByRole("button", { name: "Check now" }).click();
  await expect(details.getByRole("status").filter({ hasText: "Your DKIM keys are being created" })).toBeVisible();
  // The worker adds the domain to the mail server and caches its two keys (Ed25519 and RSA), shown as TXT records.
  await expect(async () => {
    await page.reload();
    await expect(recordStatus(page, name, "Found")).toHaveCount(5, { timeout: 2000 });
  }).toPass({ timeout: 30_000, intervals: [2000, 3000, 5000] });
  await expect(details.getByRole("button", { name: /^Copy DKIM value for v1-rsa-\d{8}\._domainkey$/ })).toBeVisible();

  await details.getByRole("button", { name: "Check now" }).click();
  await expect(details.getByRole("status").filter({ hasText: "Verified." })).toBeVisible();
  await expect(details.getByText(/Setting up|Active/).first()).toBeVisible();

  await details.getByRole("tab", { name: "Overview" }).click();
  await details.getByRole("button", { name: "Remove domain…" }).click();
  await details.getByRole("button", { name: "Remove domain", exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
  // Removal is a job: the row says "Removing" until the worker finishes, and a fast worker can finish before the
  // list renders, so assert the outcome — the domain goes away.
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(async () => {
    await page.reload();
    await expect(row).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
});

test("a domain without its DNS records stays waiting and says what's missing", async ({ page }, testInfo) => {
  const u = e2eUsers();
  const name = `unverified-${u.run}-${testInfo.project.name}.test`;
  await signIn(page, u.users.owner, u.password);
  const accountUrl = await (await openNav(page)).getByRole("link", { name: "Domains" }).getAttribute("href");
  await page.goto(`${urls.app}${accountUrl ?? ""}?new=1`);
  await page.getByLabel("Domain name").fill(name);
  await page.getByRole("button", { name: "Add domain" }).click();
  const details = panel(page, name);
  await expect(details.getByRole("heading", { name, level: 2 })).toBeVisible();
  const required = details.getByRole("region", { name: "Required records" });
  await expect(required.getByText("Missing", { exact: true })).toHaveCount(3);
  await expect(required.getByText("Not ready yet")).toBeVisible();

  await details.getByRole("button", { name: "Check now" }).click();
  await expect(
    details.getByRole("status").filter({ hasText: "4 required records are not in place yet" }),
  ).toBeVisible();
  await expect(details.getByText("Waiting for DNS")).toBeVisible();

  // The old domain address opens the same panel.
  const id = new URL(page.url()).searchParams.get("domain") ?? "";
  await page.goto(`${urls.app}${accountUrl ?? ""}/${id}`);
  await expect(page).toHaveURL(new RegExp(`[?&]domain=${id}`));
  await expect(details).toBeVisible();
  await panelReady(page, name);

  await details.getByRole("button", { name: "Remove", exact: true }).click();
  await details.getByRole("button", { name: "Remove domain…" }).click();
  await details.getByRole("button", { name: "Remove domain", exact: true }).click();
  await expect(page.getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
});

test("a member has no Domains section", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.member, u.password);
  await expect((await openNav(page)).getByRole("link", { name: "Domains" })).toHaveCount(0);
});
