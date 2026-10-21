// SPDX-License-Identifier: AGPL-3.0-only
import { loader } from "fumadocs-core/source";
import { blogPosts, docs } from "fumadocs-mdx:collections/server";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

/** Public docs (repo-root docs/public), served at /docs. */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

/** "Edit this page" base: the public repository on GitHub. */
export const REPO_EDIT_BASE = "https://github.com/anhourtec/anhourmail/edit/main/docs/public/";

/** Blog posts (apps/site/content/blog), served at /blog. */
export const blog = loader({
  baseUrl: "/blog",
  source: toFumadocsSource(blogPosts, []),
});

/** Posts newest first. */
export const blogIndex = () => [...blog.getPages()].sort((a, b) => b.data.date.localeCompare(a.data.date));
