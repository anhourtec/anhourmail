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

test("pages carry a canonical URL, share tags and valid structured data", async ({ page, consoleErrors }) => {
  const cases = [
    { path: "/", types: ["Organization", "WebSite", "WebApplication", "FAQPage"] },
    { path: "/pricing", types: ["WebApplication", "BreadcrumbList"] },
    { path: "/features/aliases", types: ["BreadcrumbList"] },
    { path: "/docs/features", types: ["BreadcrumbList"] },
  ];
  for (const c of cases) {
    await page.goto(`${urls.site}${c.path}`);
    await expect(page.locator("h1")).toHaveCount(1);
    // Next writes the home page's canonical without the trailing slash.
    const canonical = new URL(c.path, urls.site).toString().replace(/\/$/, "");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(1);
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    const types = blocks
      .flatMap((b): unknown[] => {
        const data: unknown = JSON.parse(b);
        return Array.isArray(data) ? (data as unknown[]) : [data];
      })
      .map((d) => (d as { "@type": string })["@type"]);
    expect(types).toEqual(c.types);
  }
  expect(consoleErrors).toEqual([]);
});

test("robots.txt and the sitemap cover the site's own pages only", async ({ request }) => {
  const robots = await (await request.get(`${urls.site}/robots.txt`)).text();
  expect(robots).toContain(`Sitemap: ${new URL("/sitemap.xml", urls.site).toString()}`);
  const sitemap = await (await request.get(`${urls.site}/sitemap.xml`)).text();
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? "");
  expect(locs).toContain(new URL("/docs/features", urls.site).toString());
  expect(locs).toContain(new URL("/pricing", urls.site).toString());
  for (const loc of locs) expect(new URL(loc).origin).toBe(new URL(urls.site).origin);
  expect(sitemap).not.toContain(HOSTS.app);
  expect(sitemap).not.toContain(HOSTS.webmail);
});
