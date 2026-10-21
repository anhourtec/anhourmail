// SPDX-License-Identifier: AGPL-3.0-only
import type { MetadataRoute } from "next";

import { SITE_ROUTES } from "@/lib/ia";
import { SITE_URL } from "@/lib/site";
import { blog, source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [...SITE_ROUTES, ...blog.getPages().map((p) => p.url), ...source.getPages().map((p) => p.url)];
  return pages.map((path) => ({ url: new URL(path, SITE_URL).toString() }));
}
