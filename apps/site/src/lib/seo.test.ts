// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { BILLING, BRAND, HOSTS, PLAN_ORDER, PLANS, SUPPORT_EMAIL } from "@anhourmail/shared";

import {
  absoluteUrl,
  breadcrumbJsonLd,
  faqJsonLd,
  isSiteUrl,
  OG_IMAGE,
  organizationJsonLd,
  pageMetadata,
  routePriority,
  serializeJsonLd,
  softwareJsonLd,
  websiteJsonLd,
} from "./seo";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "./site";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("expected an object");
  return v as Obj;
};
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new Error("expected an array");
  return v;
};

describe("pageMetadata", () => {
  it("gives every page its canonical URL and complete share tags", () => {
    const m = pageMetadata({ title: "Pricing", description: "Plans.", path: "/pricing" });
    expect(m.title).toBe("Pricing");
    expect(m.description).toBe("Plans.");
    expect(m.alternates).toEqual({ canonical: "/pricing" });
    expect(m.openGraph).toMatchObject({
      type: "website",
      siteName: SITE_NAME,
      title: `Pricing · ${SITE_NAME}`,
      description: "Plans.",
      url: "/pricing",
      images: [OG_IMAGE],
    });
    expect(m.twitter).toMatchObject({ card: "summary_large_image", images: [OG_IMAGE.url] });
    expect(m.robots).toBeUndefined();
  });

  it("uses an absolute title without the template, and marks articles and noindex pages", () => {
    const m = pageMetadata({
      title: "Whole title",
      description: "d",
      path: "/blog/x",
      absoluteTitle: true,
      type: "article",
      publishedTime: "2026-10-21",
      noindex: true,
    });
    expect(m.title).toEqual({ absolute: "Whole title" });
    expect(m.openGraph).toMatchObject({ type: "article", title: "Whole title", publishedTime: "2026-10-21" });
    expect(m.robots).toEqual({ index: false, follow: true });
  });

  it("keeps the default description short enough for search results", () => {
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(SITE_DESCRIPTION).not.toMatch(/!/);
  });
});

describe("JSON-LD", () => {
  it("escapes < so no value can close the script tag", () => {
    const out = serializeJsonLd(faqJsonLd([{ q: "</script><script>alert(1)</script>", a: "a" }]));
    expect(out).not.toContain("<");
    expect(JSON.parse(out)).toMatchObject({ mainEntity: [{ name: "</script><script>alert(1)</script>" }] });
  });

  it("describes the company without any address or location", () => {
    const org = organizationJsonLd();
    expect(org).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: BRAND.company,
      url: SITE_URL,
      email: SUPPORT_EMAIL,
      logo: absoluteUrl("/icon-512.png"),
    });
    for (const key of ["address", "location", "areaServed", "foundingLocation", "telephone"]) {
      expect(org).not.toHaveProperty(key);
    }
  });

  it("links the website to its publisher", () => {
    const org = organizationJsonLd();
    expect(websiteJsonLd()).toMatchObject({ "@type": "WebSite", name: SITE_NAME, publisher: { "@id": org["@id"] } });
  });

  it("offers every plan in every billing currency at the prices in packages/shared", () => {
    const app = softwareJsonLd();
    expect(app).toMatchObject({ "@type": "WebApplication", name: SITE_NAME, isAccessibleForFree: true });
    expect(app).not.toHaveProperty("aggregateRating");
    expect(app).not.toHaveProperty("review");
    const offers = list(app.offers).map(obj);
    const expected = PLAN_ORDER.flatMap((id) => {
      const p = PLANS[id];
      const price = p.price;
      return price
        ? BILLING.currencies.map((c) => ({
            name: p.name,
            currency: c,
            amount: String(price[c] / 100),
            pwyw: p.payWhatYouWant,
          }))
        : [{ name: p.name, currency: "USD", amount: "0", pwyw: false }];
    });
    expect(offers).toHaveLength(expected.length);
    expected.forEach((e, i) => {
      const o = offers[i] ?? {};
      expect(o).toMatchObject({ "@type": "Offer", name: e.name, price: e.amount, priceCurrency: e.currency });
      expect(o.url).toBe(absoluteUrl("/pricing"));
      if (e.amount === "0") return;
      const spec = obj(o.priceSpecification);
      expect(spec).toMatchObject({ "@type": "UnitPriceSpecification", priceCurrency: e.currency });
      expect(spec.referenceQuantity).toMatchObject({ value: 1, unitCode: "ANN" });
      expect(spec[e.pwyw ? "minPrice" : "price"]).toBe(e.amount);
    });
  });

  it("builds an FAQPage from the visible questions and answers", () => {
    const faq = faqJsonLd([
      { q: "One?", a: "Yes." },
      { q: "Two?", a: "No." },
    ]);
    expect(faq).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "One?", acceptedAnswer: { "@type": "Answer", text: "Yes." } },
        { "@type": "Question", name: "Two?", acceptedAnswer: { "@type": "Answer", text: "No." } },
      ],
    });
  });

  it("numbers breadcrumbs from 1 with absolute URLs", () => {
    const crumbs = breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Docs", path: "/docs" },
      { name: "Aliases", path: "/docs/aliases" },
    ]);
    expect(list(crumbs.itemListElement)).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") },
      { "@type": "ListItem", position: 2, name: "Docs", item: absoluteUrl("/docs") },
      { "@type": "ListItem", position: 3, name: "Aliases", item: absoluteUrl("/docs/aliases") },
    ]);
  });
});

describe("sitemap helpers", () => {
  it("ranks the pages people land on above the legal pages", () => {
    expect(routePriority("/").priority).toBe(1);
    expect(routePriority("/pricing").priority).toBeGreaterThan(routePriority("/docs/aliases").priority);
    expect(routePriority("/features/aliases").priority).toBeGreaterThan(routePriority("/legal/terms").priority);
    expect(routePriority("/legal/terms").changeFrequency).toBe("yearly");
    for (const p of ["/", "/pricing", "/docs", "/docs/features", "/changelog", "/about", "/credits"]) {
      const r = routePriority(p);
      expect(r.priority).toBeGreaterThan(0);
      expect(r.priority).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the console and webmail hosts out of the marketing sitemap", () => {
    expect(isSiteUrl(absoluteUrl("/pricing"))).toBe(true);
    expect(isSiteUrl(`https://${HOSTS.app}/sign-up`)).toBe(false);
    expect(isSiteUrl(`https://${HOSTS.webmail}/`)).toBe(false);
  });
});
