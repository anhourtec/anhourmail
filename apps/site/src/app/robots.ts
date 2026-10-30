// SPDX-License-Identifier: AGPL-3.0-only
import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/seo";

/**
 * The marketing site and docs are public. `/api/` only holds the docs search endpoint, which has nothing to index.
 * The console and webmail are other hosts and answer for themselves.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: "/api/" }],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
