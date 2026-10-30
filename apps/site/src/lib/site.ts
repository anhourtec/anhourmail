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

/** The default meta description (home page, share cards): what it is, for whom, in search words, under 160 characters. */
export const SITE_DESCRIPTION =
  "Private, low-cost email hosting on your own domain: masked aliases, fast open-source webmail, IMAP, SMTP and JMAP. A free address, no ads, no tracking.";

/** Top-level header links after the Features menu. */
export const NAV_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
] as const;
