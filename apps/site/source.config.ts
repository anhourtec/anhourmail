// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

const run = promisify(execFile);

/**
 * "Last updated" from git history, when there is one. Image builds have neither git nor `.git`, so a missing
 * history means no date, never a failed build.
 */
async function gitLastModified(filePath: string): Promise<Date | null> {
  try {
    const { stdout } = await run("git", ["log", "-1", "--format=%cI", "--", filePath], { timeout: 5000 });
    const date = new Date(stdout.trim());
    return stdout.trim() && !Number.isNaN(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

export default defineConfig({
  plugins: [lastModified({ versionControl: gitLastModified })],
});
