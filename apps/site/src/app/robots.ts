// SPDX-License-Identifier: AGPL-3.0-only
import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/" }], sitemap: new URL("/sitemap.xml", SITE_URL).toString() };
}
