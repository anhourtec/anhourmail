// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Domains (Phase 3). Development DNS answers for `.test` names as if every record were published, except names
 * starting with `unverified-` (adapters/dns devResolver), so both paths run without real DNS.
 */
import { e2eUsers, expect, signIn, test, urls } from "./fixtures";

test("an owner adds a domain, verifies it, sees it set up, then removes it", async ({ page }, testInfo) => {
  const u = e2eUsers();
  const name = `${u.run}-${testInfo.project.name}.test`;
  await signIn(page, u.users.owner, u.password);

  await page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: "Domains" }).click();
  await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
  await page.getByLabel("Add a domain").fill(`  ${name.toUpperCase()}  `);
  await page.getByRole("button", { name: "Add domain" }).click();

  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText("Waiting for DNS")).toBeVisible();
  const required = page.getByRole("region", { name: "Required records" });
  await expect(required.getByText("Found")).toHaveCount(5);

  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Verified." })).toBeVisible();
  await expect(page.getByText(/Setting up|Active/).first()).toBeVisible();

  await page.getByRole("button", { name: "Remove domain…" }).click();
  await page.getByRole("button", { name: "Remove domain", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Domains", level: 1 })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(name) }).getByText("Removing")).toBeVisible();
});

test("a domain without its DNS records stays waiting and says what's missing", async ({ page }, testInfo) => {
  const u = e2eUsers();
  const name = `unverified-${u.run}-${testInfo.project.name}.test`;
  await signIn(page, u.users.owner, u.password);
  const accountUrl = await page
    .getByRole("navigation", { name: "Console" })
    .getByRole("link", { name: "Domains" })
    .getAttribute("href");
  await page.goto(`${urls.app}${accountUrl ?? ""}`);
  await page.getByLabel("Add a domain").fill(name);
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Required records" }).getByText("Missing")).toHaveCount(5);

  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "5 required records are not in place yet" })).toBeVisible();
  await expect(page.getByText("Waiting for DNS")).toBeVisible();

  await page.getByRole("button", { name: "Remove domain…" }).click();
  await page.getByRole("button", { name: "Remove domain", exact: true }).click();
  await expect(page.getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
});

test("a member has no Domains section", async ({ page }) => {
  const u = e2eUsers();
  await signIn(page, u.users.member, u.password);
  const nav = page.getByRole("navigation", { name: "Console" });
  await expect(nav.getByRole("link", { name: "Domains" })).toHaveCount(0);
});
