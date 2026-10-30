// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Search and sharing metadata for the marketing site and docs (docs/internal/docs-site.md "SEO"): one helper builds
 * every page's title, description, canonical URL, Open Graph and Twitter tags, and the JSON-LD builders describe the
 * product with facts from `@anhourmail/shared` only (CLAUDE.md rule 32). Everything here is rendered inline: no
 * third-party script, font or image is ever referenced (rule 29). Relative imports only, so the unit tests can load it.
 */
import type { Metadata } from "next";

import {
  BILLING,
  BRAND,
  type Currency,
  formatPrice,
  PLAN_ORDER,
  PLANS,
  type Plan,
  SUPPORT_EMAIL,
} from "@anhourmail/shared";

import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "./site";

/** The share card every page uses (packages/ui/assets/brand/og-image.png, synced into public/). */
export const OG_IMAGE = { url: "/og-image.png", width: 1200, height: 630, alt: `${SITE_NAME} logo` } as const;

/** The public source repository (the Organization's `sameAs`, docs "Edit this page"). */
export const REPO_URL = "https://github.com/anhourtec/anhourmail";

/** Absolute URL on the marketing site for a path ("/pricing" → "https://anhourmail.com/pricing"). */
export const absoluteUrl = (path: string) => new URL(path, SITE_URL).toString();

export type PageMeta = {
  /** Page title; the root layout's template adds " · AnhourMail" unless `absoluteTitle` is set. */
  title: string;
  description: string;
  /** Canonical path on the site, e.g. "/pricing". */
  path: string;
  /** Use `title` as the whole <title> (the home page), without the template. */
  absoluteTitle?: boolean;
  /** Open Graph type: "article" for blog posts and docs, "website" otherwise. */
  type?: "website" | "article";
  /** Keep the page out of search results (it still passes link equity). */
  noindex?: boolean;
  /** Articles: ISO dates for `article:published_time` / `article:modified_time`. */
  publishedTime?: string;
  modifiedTime?: string;
};

/**
 * Full metadata for one page. Next merges metadata shallowly (a page's `openGraph` replaces the layout's whole
 * object), so every page gets the complete set here rather than relying on the layout.
 */
export function pageMetadata(m: PageMeta): Metadata {
  const shareTitle = m.absoluteTitle ? m.title : `${m.title} · ${SITE_NAME}`;
  return {
    title: m.absoluteTitle ? { absolute: m.title } : m.title,
    description: m.description,
    alternates: { canonical: m.path },
    openGraph: {
      type: m.type ?? "website",
      siteName: SITE_NAME,
      title: shareTitle,
      description: m.description,
      url: m.path,
      images: [OG_IMAGE],
      ...(m.publishedTime ? { publishedTime: m.publishedTime } : {}),
      ...(m.modifiedTime ? { modifiedTime: m.modifiedTime } : {}),
    },
    twitter: { card: "summary_large_image", title: shareTitle, description: m.description, images: [OG_IMAGE.url] },
    ...(m.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

/** Title and description of the home page: what people search for, said plainly. */
export const HOME_TITLE = `${SITE_NAME}: private, low-cost email hosting on your own domain`;
export const HOME_DESCRIPTION = SITE_DESCRIPTION;

// ---- JSON-LD ------------------------------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = Record<string, Json>;
export type JsonLd = { "@context": "https://schema.org"; "@type": string } & JsonObject;

const ORG_ID = `${SITE_URL}/#organization`;
const SITE_ID = `${SITE_URL}/#website`;
const APP_ID = `${SITE_URL}/#software`;

/**
 * Serialised for an inline `<script type="application/ld+json">`: `<` is escaped so no value can close the tag
 * (the Next.js JSON-LD guide). Data blocks are never executed, so the nonce CSP doesn't need to cover them.
 */
export function serializeJsonLd(data: JsonLd | readonly JsonLd[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/** The company behind the product. No address or location, by product decision (never state where we are). */
export function organizationJsonLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORG_ID,
    name: BRAND.company,
    url: SITE_URL,
    logo: absoluteUrl("/icon-512.png"),
    email: SUPPORT_EMAIL,
    sameAs: [REPO_URL],
  };
}

export function websiteJsonLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": SITE_ID,
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@id": ORG_ID },
  };
}

/** schema.org prices are decimal strings in the currency's major unit ("9", "12", "20"). */
const major = (minor: number) => String(minor / 100);

function planOffers(plan: Plan): Json[] {
  const url = absoluteUrl("/pricing");
  if (!plan.price) {
    return [{ "@type": "Offer", name: plan.name, description: plan.tagline, price: "0", priceCurrency: "USD", url }];
  }
  const price = plan.price;
  return BILLING.currencies.map((currency: Currency) => {
    const amount = major(price[currency]);
    const spec: JsonObject = {
      "@type": "UnitPriceSpecification",
      priceCurrency: currency,
      // Billed once a year: one unit is one year ("ANN", UN/CEFACT).
      referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "ANN" },
      ...(plan.payWhatYouWant ? { minPrice: amount } : { price: amount }),
    };
    return {
      "@type": "Offer",
      name: plan.name,
      description: `${plan.tagline} ${plan.payWhatYouWant ? "From " : ""}${formatPrice(price[currency], currency)} per ${BILLING.interval}.`,
      price: amount,
      priceCurrency: currency,
      priceSpecification: spec,
      url,
    };
  });
}

/**
 * The product with every plan as an offer, prices straight from `PLANS`. Planned pricing until billing opens: the
 * offers say what the pricing page says, and nothing claims ratings, reviews or availability we can't show.
 */
export function softwareJsonLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "@id": APP_ID,
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    applicationCategory: "CommunicationApplication",
    operatingSystem: "Any (web browser, IMAP, SMTP and JMAP mail apps)",
    browserRequirements: "A current web browser",
    isAccessibleForFree: true,
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    codeRepository: REPO_URL,
    publisher: { "@id": ORG_ID },
    offers: PLAN_ORDER.flatMap((id) => planOffers(PLANS[id])),
  };
}

/** FAQPage from questions shown on the same page. Answers must be the visible text, not a summary of it. */
export function faqJsonLd(items: readonly { q: string; a: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

/** BreadcrumbList; the last crumb is the page itself. */
export function breadcrumbJsonLd(crumbs: readonly { name: string; path: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: absoluteUrl(c.path),
    })),
  };
}

// ---- sitemap ------------------------------------------------------------------------------------------------

export type ChangeFrequency = "daily" | "weekly" | "monthly" | "yearly";

/**
 * How often a marketing route changes and how much it matters relative to the others. Search engines treat both
 * as hints; they mostly keep the sitemap's order of importance honest.
 */
export function routePriority(path: string): { changeFrequency: ChangeFrequency; priority: number } {
  if (path === "/") return { changeFrequency: "weekly", priority: 1 };
  if (path === "/pricing" || path === "/features") return { changeFrequency: "weekly", priority: 0.9 };
  if (path.startsWith("/features/") || path === "/security" || path === "/docs/features") {
    return { changeFrequency: "monthly", priority: 0.8 };
  }
  if (path === "/changelog" || path === "/blog") return { changeFrequency: "weekly", priority: 0.6 };
  if (path === "/docs" || path.startsWith("/docs/")) return { changeFrequency: "weekly", priority: 0.7 };
  if (path.startsWith("/legal") || path === "/credits") return { changeFrequency: "yearly", priority: 0.3 };
  return { changeFrequency: "monthly", priority: 0.5 };
}

/** True when a URL belongs to the marketing site (never the console or webmail hosts). */
export const isSiteUrl = (url: string) => new URL(url).origin === new URL(SITE_URL).origin;
