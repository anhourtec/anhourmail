// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Rules for names people choose that others see: first, last and display names, and account names. They appear in
 * emails we send (invites, notices) and in other people's consoles, so a name must read as a name: no control
 * characters, no bidirectional-text controls that reorder what's shown, no `@` (it would pose as an address) and nothing
 * that looks like a web address. The server checks every name with `nameProblem`; forms may call it for early feedback.
 */

/** C0 and C1 control characters, DEL, and the bidi controls (LRM/RLM, embeddings/overrides, isolates). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/u;

/** `scheme://`, `www.`, or a dotted token whose last label looks like a top-level domain (`example.com`, `x.co.uk`). */
const URL_LIKE = /:\/\/|(?:^|[^\p{L}\p{N}])www\.|[\p{L}\p{N}-]+\.[a-z]{2,24}(?![\p{L}\p{N}-])/iu;

export const NAME_PROBLEMS = {
  control: "Names can't contain control or text-direction characters.",
  at: "Names can't contain @.",
  url: "Names can't contain web addresses.",
  long: "That name is too long.",
} as const;

/** Longest input the checks look at: callers cap names at 60–80 characters, and this bounds the URL-like pattern. */
const MAX_CHECKED_LENGTH = 200;

/** Why `name` can't be used as a name people see (one sentence), or null when it's fine. Empty names are the caller's. */
export function nameProblem(name: string): string | null {
  if (name.length > MAX_CHECKED_LENGTH) return NAME_PROBLEMS.long;
  if (FORBIDDEN_CHARS.test(name)) return NAME_PROBLEMS.control;
  if (name.includes("@") || name.includes("＠")) return NAME_PROBLEMS.at;
  if (URL_LIKE.test(name)) return NAME_PROBLEMS.url;
  return null;
}
