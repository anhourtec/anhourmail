// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { MetadataRoute } from "next";

import { getChangelog } from "@/lib/changelog";
import { SITE_ROUTES } from "@/lib/ia";
import { absoluteUrl, isSiteUrl, routePriority } from "@/lib/seo";
import { blog, blogIndex, source } from "@/lib/source";

const run = promisify(execFile);

/** Source files a marketing route renders from (its page, plus shared content where it has some). */
function routeFiles(route: string): string[] {
  const app = path.join("src", "app", "(site)");
  if (route.startsWith("/features/")) {
    return [path.join(app, "features", "[slug]", "page.tsx"), path.join("src", "lib", "feature-content.tsx")];
  }
  return [path.join(app, ...route.split("/").filter(Boolean), "page.tsx")];
}

/**
 * Last commit that touched a route's files. Deterministic for a given history; image builds have no git, so a
 * missing history leaves the date out rather than inventing one (the same rule as the docs' "Last updated").
 */
async function gitDate(files: readonly string[]): Promise<Date | undefined> {
  try {
    const { stdout } = await run("git", ["log", "-1", "--format=%cI", "--", ...files], { timeout: 5000 });
    const date = new Date(stdout.trim());
    return stdout.trim() && !Number.isNaN(date.getTime()) ? date : undefined;
  } catch {
    return undefined;
  }
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * Every public page of the marketing site and docs, on the site's own origin only: the console and webmail are
 * separate hosts with their own robots rules and never appear here. Changelog entries have no pages of their own;
 * the changelog index carries the newest entry's date.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const changelog = await getChangelog();
  const posts = blogIndex();
  const dated: Record<string, Date | undefined> = {
    "/changelog": changelog[0] ? day(changelog[0].date) : undefined,
    "/blog": posts[0] ? day(posts[0].data.date) : undefined,
  };

  const site = await Promise.all(
    SITE_ROUTES.map(async (route) => ({
      route,
      lastModified: route in dated ? dated[route] : await gitDate(routeFiles(route)),
    })),
  );
  const blogPages = blog.getPages().map((p) => ({ route: p.url, lastModified: day(p.data.date) }));
  const docsPages = source.getPages().map((p) => ({ route: p.url, lastModified: p.data.lastModified }));

  return [...site, ...blogPages, ...docsPages]
    .map(({ route, lastModified }) => ({
      url: absoluteUrl(route),
      ...(lastModified ? { lastModified } : {}),
      ...routePriority(route),
    }))
    .filter((e) => isSiteUrl(e.url));
}
