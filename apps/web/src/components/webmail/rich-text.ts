// SPDX-License-Identifier: AGPL-3.0-only
import type { Address } from "@/server/webmail/view";

import { type ComposeMode, fullDate } from "./format";

/**
 * Pure helpers for the rich-text composer: text ↔ HTML for mode switches, the quoted original for replies and
 * forwards, signatures and link validation. Everything that reaches the editor or the server still goes through
 * the outgoing sanitiser (`server/webmail/outgoing-html.ts`); these only build trusted wrappers around escaped text.
 */

/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text as HTML: escaped, line breaks kept. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/** Marks the signature block inside the editor so changing the sender can swap it (removed when sanitised). */
export const SIGNATURE_ATTR = "data-am-signature";

/** The inside of a signature block: the conventional "-- " line, then the text. */
export const signatureInner = (signature: string): string => `-- <br>${textToHtml(signature)}`;

/** The signature block a rich message starts with (empty when there is none). */
export function signatureHtml(signature: string | undefined): string {
  return signature && signature.trim() !== ""
    ? `<div><br></div><div ${SIGNATURE_ATTR}="1">${signatureInner(signature)}</div>`
    : "";
}

/**
 * Whether sanitised HTML has anything plain text can't keep: any element besides paragraphs, line breaks and the
 * `div`s the editor makes for lines (a signature block is a `div` too).
 */
export function hasFormatting(html: string): boolean {
  return /<(?!\/?(?:div|p|br)\b)[a-z]/i.test(html);
}

/** The largest original carried into a reply as HTML; longer ones are quoted as text. */
export const MAX_QUOTE_HTML = 256 * 1024;

const QUOTE_STYLE = "margin: 0 0 0 0.8ex; padding-left: 1ex; border-left: 2px solid rgb(204, 204, 204)";

/**
 * The quoted original for a rich reply or forward: a header line, then the original's HTML (the reading view's
 * sanitised copy, which has no remote images) or its text. The caller sanitises the result for sending.
 */
export function quoteHtml(
  msg: {
    from: Address[];
    to: Address[];
    cc: Address[];
    subject: string;
    receivedAt: string;
    quote: string;
    html: string | null;
  },
  mode: ComposeMode,
): string {
  if (mode === "new") return "";
  const who = (list: Address[]) =>
    escapeHtml(list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", "));
  const original =
    msg.html !== null && msg.html.trim() !== "" && msg.html.length <= MAX_QUOTE_HTML ? msg.html : textToHtml(msg.quote);
  if (mode === "forward") {
    const head = [
      "---------- Forwarded message ----------",
      `From: ${who(msg.from)}`,
      `Date: ${escapeHtml(fullDate(msg.receivedAt))}`,
      `Subject: ${escapeHtml(msg.subject)}`,
      `To: ${who(msg.to)}`,
      ...(msg.cc.length > 0 ? [`Cc: ${who(msg.cc)}`] : []),
    ].join("<br>");
    return `<div><br></div><div>${head}</div><br><div>${original}</div>`;
  }
  return `<div><br></div><div>On ${escapeHtml(fullDate(msg.receivedAt))}, ${who(msg.from)} wrote:</div><blockquote type="cite" style="${QUOTE_STYLE}">${original}</blockquote>`;
}

/**
 * A link address someone typed, made safe: http(s), mailto and tel only; a bare domain becomes https. Returns
 * null for anything else (javascript:, data:, relative paths, spaces).
 */
export function linkUrl(input: string): string | null {
  const v = input.trim();
  if (v === "" || v.length > 2048 || /[\s<>"'`\\]/.test(v)) return null;
  if (/^(?:mailto:[^@]+@[^@]+\.[^@]+|tel:\+?[0-9().-]{3,32})$/i.test(v)) return v;
  if (/^[^@:/]+@[^@:/]+\.[a-z]{2,}$/i.test(v)) return `mailto:${v}`;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Plain-language names for the elements and attributes the sanitiser reports, for the "what was removed" notice. */
export function removedSummary(r: { removedTags: string[]; removedAttributes: string[] }): string[] {
  const tags = new Set(r.removedTags);
  const attrs = new Set(r.removedAttributes);
  const out: string[] = [];
  if (tags.has("script") || tags.has("noscript")) out.push("Scripts");
  if ([...attrs].some((a) => a.startsWith("on"))) out.push("Event handlers (on… attributes)");
  if (["form", "input", "button", "textarea", "select", "option"].some((t) => tags.has(t))) {
    out.push("Forms and form fields");
  }
  if (["iframe", "frame", "frameset", "object", "embed", "applet"].some((t) => tags.has(t))) {
    out.push("Embedded frames and objects");
  }
  if (tags.has("style") || tags.has("link")) out.push("Style sheets (inline styles are kept)");
  if (tags.has("svg") || tags.has("math")) out.push("SVG and MathML");
  if (attrs.has("href")) out.push("Links that weren't http, https, mailto or tel");
  if (attrs.has("src")) out.push("Images that weren't https or embedded");
  const css = [...attrs].filter((a) => a.startsWith("style:")).map((a) => a.slice(6));
  if (css.length > 0 || attrs.has("style")) {
    out.push(`Unsupported styles${css.length > 0 ? ` (${css.slice(0, 6).join(", ")})` : ""}`);
  }
  const known = new Set([
    "script", "noscript", "form", "input", "button", "textarea", "select", "option", "iframe", "frame", "frameset",
    "object", "embed", "applet", "style", "link", "svg", "math",
  ]); // prettier-ignore
  const other = [...tags].filter((t) => !known.has(t));
  if (other.length > 0) out.push(`Other elements, text kept (${other.slice(0, 6).join(", ")})`);
  const otherAttrs = [...attrs].filter(
    (a) => !a.startsWith("on") && !a.startsWith("style") && a !== "href" && a !== "src",
  );
  if (otherAttrs.length > 0) out.push(`Other attributes (${otherAttrs.slice(0, 6).join(", ")})`);
  return out;
}
