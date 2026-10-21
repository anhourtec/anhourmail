// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Privacy promises on the marketing site (CLAUDE.md rule 29, Phase 2 exit): every request a page makes stays on
 * our own origin (no third-party fonts, analytics, CDNs or embeds), and no cookies are set.
 */
import type { APIRequestContext } from "@playwright/test";

import { expect, test, urls } from "./fixtures";

test.describe.configure({ mode: "serial" });

async function sitemapPaths(request: APIRequestContext): Promise<string[]> {
  const xml = await (await request.get(`${urls.site}/sitemap.xml`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => new URL(m[1] ?? "/").pathname)
    .filter((p, i, all) => all.indexOf(p) === i);
}

test("every marketing page makes same-origin requests only and sets no cookies", async ({ page, request }) => {
  test.setTimeout(240_000);
  const origin = new URL(urls.site).origin;
  const paths = await sitemapPaths(request);
  expect(paths.length).toBeGreaterThan(10);
  const offenders: string[] = [];
  page.on("request", (req) => {
    const u = req.url();
    if (u.startsWith("data:") || u.startsWith("blob:")) return;
    if (new URL(u).origin !== origin) offenders.push(`${page.url()} → ${u}`);
  });
  for (const path of paths) {
    await page.goto(`${urls.site}${path}`, { waitUntil: "load" });
    // Scroll to the bottom so lazy and in-view content loads too, then wait for it.
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForLoadState("load");
  }
  expect(offenders, "third-party requests").toEqual([]);
  expect(await page.context().cookies(), "cookies").toEqual([]);
});
