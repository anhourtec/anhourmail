// SPDX-License-Identifier: AGPL-3.0-only
import { HOSTS } from "../../packages/shared/src/platform";
import { expect, test, urls } from "./fixtures";

test("marketing home renders with a single h1 and no region claims", async ({ page, consoleErrors }) => {
  await page.goto(urls.site);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByText(/hosted in canada|canadian data/i)).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("docs show client settings from packages/shared", async ({ page, consoleErrors }) => {
  await page.goto(`${urls.site}/docs/clients/imap-smtp-settings`);
  await expect(page.getByText(HOSTS.imap).first()).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("changelog and credits pages load", async ({ page }) => {
  for (const path of ["/changelog", "/credits"]) {
    const res = await page.goto(`${urls.site}${path}`);
    expect(res?.status()).toBe(200);
  }
});

test("hero get started links to the console sign-up", async ({ page, consoleErrors }) => {
  await page.goto(urls.site);
  const hero = page.locator("section").filter({ has: page.locator("h1") });
  const cta = hero.getByRole("link", { name: "Get started" });
  await expect(cta).toHaveAttribute("href", `${urls.app}/sign-up`);
  await expect(page.locator('a[href*="waitlist"]')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("the waitlist pages are gone", async ({ request }) => {
  for (const path of ["/waitlist", "/waitlist/confirm"]) {
    const res = await request.get(`${urls.site}${path}`);
    expect(res.status()).toBe(404);
  }
});

test("trust pages load", async ({ page }) => {
  for (const path of ["/transparency", "/costs"]) {
    const res = await page.goto(`${urls.site}${path}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveCount(1);
  }
});
