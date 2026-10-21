// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where a waitlist signup or invite came from. Kept free of zod so browser code (the site's waitlist form) can
 * import it without shipping the validation library; the server validates with schemas.ts.
 */
export const KNOWN_SOURCES = [
  "reddit",
  "hacker-news",
  "lemmy",
  "mastodon",
  "friend",
  "search",
  "blog",
  "other",
] as const;

export type KnownSource = (typeof KNOWN_SOURCES)[number];
