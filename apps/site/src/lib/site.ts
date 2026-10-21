// SPDX-License-Identifier: AGPL-3.0-only
import { BRAND, PRODUCT_DOMAIN } from "@anhourmail/shared";

/** Canonical origin of the marketing site. Overridable for local and staging builds. */
export const SITE_URL = process.env.SITE_URL ?? `https://${PRODUCT_DOMAIN}`;

export const SITE_NAME = BRAND.product;

export const SITE_DESCRIPTION = "Private, fast email with your own domain. Open source, no ads, no tracking.";

/** Top-level header links after the Features menu. */
export const NAV_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
] as const;
