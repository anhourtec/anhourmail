// SPDX-License-Identifier: AGPL-3.0-only
import { PRODUCT_DOMAIN } from "@anhourmail/shared";

/** The public legal pages. Drafts until counsel signs off; the banner on each page says so. */
export const LEGAL_UPDATED = "2026-10-21";

export const LEGAL_CONTACTS = {
  privacy: `privacy@${PRODUCT_DOMAIN}`,
  abuse: `abuse@${PRODUCT_DOMAIN}`,
  legal: `legal@${PRODUCT_DOMAIN}`,
  support: `support@${PRODUCT_DOMAIN}`,
} as const;

export const LEGAL_PAGES = [
  {
    href: "/legal/terms",
    title: "Terms of Service",
    summary: "The agreement between you and us: plans, billing, refunds, your data and ending the service.",
  },
  {
    href: "/legal/privacy",
    title: "Privacy Policy",
    summary: "What we collect, what we never do with it, how long we keep it and how to get it back.",
  },
  {
    href: "/legal/acceptable-use",
    title: "Acceptable Use Policy",
    summary: "What you can't send through AnhourMail, how we enforce it and how to report abuse.",
  },
] as const;
