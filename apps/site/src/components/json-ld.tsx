// SPDX-License-Identifier: AGPL-3.0-only
import { type JsonLd as JsonLdData, serializeJsonLd } from "@/lib/seo";

/**
 * Structured data for search engines, inline in the page (never an external script). The payload is built from
 * `@anhourmail/shared` facts and escaped by `serializeJsonLd`, so nothing in it can close the tag.
 */
export function JsonLd({ data }: { data: JsonLdData | readonly JsonLdData[] }) {
  return (
    <script
      type="application/ld+json"
      // The documented Next.js pattern for JSON-LD; serializeJsonLd escapes "<" so the payload stays data.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
