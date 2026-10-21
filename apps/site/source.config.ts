// SPDX-License-Identifier: AGPL-3.0-only
import { pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineConfig, defineDocs } from "fumadocs-mdx/config";
import lastModified from "fumadocs-mdx/plugins/last-modified";
import { z } from "zod";

/**
 * Public docs live at the repo root (docs/public), outside this app, so the same Markdown is the source for
 * anhourmail.com/docs and is reviewable next to the code it documents. See docs/internal/docs-site.md.
 */
export const docs = defineDocs({
  dir: "../../docs/public",
});

/**
 * Blog posts: apps/site/content/blog/*.mdx. Front matter is validated at build time — a bad post fails the
 * build. Real posts only: no placeholder or invented content.
 */
export const blogPosts = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: pageSchema.extend({
    description: z.string().min(1).max(300),
    date: z.iso.date(),
    author: z.string().min(1).max(80),
  }),
});

export default defineConfig({
  plugins: [lastModified()],
});
