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

test("waitlist posts same-origin through the site and answers 202", async ({ request }) => {
  const res = await request.post(`${urls.site}/api/public/waitlist`, {
    data: { email: `e2e-${Date.now()}@waitlist.test`, startedAt: Date.now() - 10_000 },
    headers: { origin: urls.site },
  });
  expect(res.status()).toBe(202);
});
