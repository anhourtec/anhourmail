// SPDX-License-Identifier: AGPL-3.0-only
import { BRAND, HOSTS, PRODUCT_DOMAIN } from "@anhourmail/shared";

/** Canonical origin of the marketing site. Overridable for local and staging builds. */
export const SITE_URL = process.env.SITE_URL ?? `https://${PRODUCT_DOMAIN}`;

/** Origin of the console (sign-up, sign-in, account). Same `APP_URL` the console itself uses; overridable for local and staging builds. */
export const APP_URL = (process.env.APP_URL ?? `https://${HOSTS.app}`).replace(/\/+$/, "");

/** Console sign-up: where every "Get started" action goes. */
export const SIGN_UP_URL = `${APP_URL}/sign-up`;

/** Console sign-in. */
export const SIGN_IN_URL = `${APP_URL}/sign-in`;

export const SITE_NAME = BRAND.product;

export const SITE_DESCRIPTION = "Private, fast email with your own domain. Open source, no ads, no tracking.";

/** Top-level header links after the Features menu. */
export const NAV_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
] as const;
