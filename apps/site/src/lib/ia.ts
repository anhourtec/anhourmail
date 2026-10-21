// SPDX-License-Identifier: AGPL-3.0-only
import { CLIENT_ENDPOINTS } from "@anhourmail/shared";

/** Client protocols customers can use, from the single source of truth (ManageSieve is a filter detail). */
export const PROTOCOLS = [...new Set(CLIENT_ENDPOINTS.map((e) => e.protocol))].filter((p) => p !== "ManageSieve");
export const PROTOCOL_LIST = new Intl.ListFormat("en", { type: "conjunction" }).format(PROTOCOLS);
/**
 * Site information architecture: one list drives the header mega-menu, the features overview, the footer and
 * the sitemap. Icons are resolved in components (lib stays framework-free).
 */
export type FeatureSlug = "custom-domains" | "aliases" | "webmail" | "privacy" | "apps";

export const FEATURE_PAGES: readonly { slug: FeatureSlug; title: string; nav: string; blurb: string }[] = [
  {
    slug: "custom-domains",
    title: "Your own domain",
    nav: "Custom domains",
    blurb: "Bring the address you already own, with live DNS checks.",
  },
  {
    slug: "aliases",
    title: "Aliases and masked aliases",
    nav: "Aliases",
    blurb: "A fresh address for every sign-up, switched off in a click.",
  },
  {
    slug: "webmail",
    title: "Fast webmail",
    nav: "Webmail",
    blurb: "Built on JMAP: syncs what changed, keyboard-first.",
  },
  {
    slug: "privacy",
    title: "Private by default",
    nav: "Privacy",
    blurb: "No ads, no tracking pixels, remote images off.",
  },
  { slug: "apps", title: "Works with your apps", nav: "Mail apps", blurb: `${PROTOCOL_LIST} for any mail app.` },
] as const;

export const featureHref = (slug: FeatureSlug) => `/features/${slug}`;

/** Every static marketing route (sitemap; scripts/check-docs.mjs keeps its own copy for link checks). */
export const SITE_ROUTES = [
  "/",
  "/features",
  ...FEATURE_PAGES.map((f) => featureHref(f.slug)),
  "/pricing",
  "/security",
  "/about",
  "/support",
  "/switch",
  "/waitlist",
  "/transparency",
  "/costs",
  "/blog",
  "/changelog",
  "/credits",
  "/legal",
  "/legal/terms",
  "/legal/privacy",
  "/legal/acceptable-use",
] as const;
