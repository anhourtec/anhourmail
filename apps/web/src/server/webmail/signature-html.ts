// SPDX-License-Identifier: AGPL-3.0-only
import {
  SIGNATURE_HTML_MAX,
  SIGNATURE_IMAGE_URI_MAX,
  SIGNATURE_TEXT_MAX,
  WEBMAIL_SIGNATURES,
} from "@anhourmail/shared/signatures";

import { outgoingText, sanitizeOutgoingHtml } from "./outgoing-html";

/**
 * Signature HTML (docs/internal/05-webmail.md "Signatures", 07-security.md "Signatures"): the outgoing allow-list
 * sanitiser in its strictest mode, plus the signature caps. Pure, like `outgoing-html.ts`: the signature editor runs it
 * to show what will be kept, and the BFF runs it again on every save (the browser's copy is never trusted).
 *
 * - Everything the outgoing sanitiser removes is removed (scripts, `<style>`, frames, forms, event handlers, unsafe
 *   links and CSS).
 * - Images are kept only when embedded: a `data:` PNG, JPEG, GIF or WebP whose bytes match its type, each within
 *   `imageKb`, at most `imagesPerSignature`. https and `cid:` images and every CSS `url()` are dropped, so a signature
 *   never loads anything from another server (no tracking, nothing to fetch when it is read or written).
 * - The whole HTML is capped at `signatureKb`; the plain-text version is generated from it.
 */

export type CleanSignature = {
  /** The sanitised HTML ("" when it has no visible content). */
  html: string;
  /** The plain-text version (for plain-text messages and the identity's `textSignature`). */
  text: string;
  /** Why it can't be saved, in words for the person; null when it can. */
  problem: string | null;
  /** Remote or attached images that were removed (only embedded images are allowed). */
  removedImages: number;
};

const kb = (n: number) => `${String(n)} KB`;

/** Whether sanitised HTML shows anything: text, or an image. */
const hasContent = (html: string) => /<img\b/i.test(html) || html.replace(/<[^>]*>|&nbsp;|\s/g, "") !== "";

/** Sanitises a signature and checks its caps. */
export function cleanSignature(input: string): CleanSignature {
  if (input.length > SIGNATURE_HTML_MAX * 2) {
    return {
      html: "",
      text: "",
      problem: `A signature can be up to ${kb(WEBMAIL_SIGNATURES.signatureKb)}.`,
      removedImages: 0,
    };
  }
  const r = sanitizeOutgoingHtml(input, { embeddedImagesOnly: true, maxDataImage: SIGNATURE_IMAGE_URI_MAX });
  const removedImages = (input.match(/<img\b/gi)?.length ?? 0) - r.embeddedImages - r.oversizedImages;
  const html = hasContent(r.html) ? r.html : "";
  const text = html === "" ? "" : outgoingText(html).slice(0, SIGNATURE_TEXT_MAX);
  let problem: string | null = null;
  if (r.oversizedImages > 0) {
    problem = `Each image in a signature can be up to ${kb(WEBMAIL_SIGNATURES.imageKb)}. Use a smaller image.`;
  } else if (r.embeddedImages > WEBMAIL_SIGNATURES.imagesPerSignature) {
    problem = `A signature can have up to ${String(WEBMAIL_SIGNATURES.imagesPerSignature)} images.`;
  } else if (html.length > SIGNATURE_HTML_MAX) {
    problem = `A signature can be up to ${kb(WEBMAIL_SIGNATURES.signatureKb)}, images included.`;
  }
  return { html, text, problem, removedImages: Math.max(0, removedImages) };
}

/** Plain text as signature HTML: escaped, one `div` per line (an empty line keeps its height). */
export function textAsHtml(text: string): string {
  const esc = (v: string) =>
    v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => `<div>${l === "" ? "<br>" : esc(l)}</div>`)
    .join("");
}

/**
 * The most a JMAP identity's `htmlSignature` or `textSignature` may hold on the mail server, in UTF-8 bytes (measured
 * on Stalwart v0.16.27: 2,047 is stored, 2,048 is refused with `invalidProperties`).
 */
export const IDENTITY_SIGNATURE_MAX_BYTES = 2047;

const bytes = (v: string) => new TextEncoder().encode(v).length;

/** Text cut to fit `max` bytes, at a line break when there is one in the second half, with "…" when cut. */
function fitText(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let out = "";
  let size = 0;
  for (const ch of text) {
    size += bytes(ch);
    if (size > max - 3) break;
    out += ch;
  }
  const nl = out.lastIndexOf("\n");
  return `${(nl > out.length / 2 ? out.slice(0, nl) : out).trimEnd()}…`;
}

/**
 * What the mail server's identities get for a signature (the default for new messages), so other JMAP mail apps see
 * it: the HTML as it is when it fits; else without its images; else its text as HTML. `complete` is false when it had
 * to be shortened. Empty for "(No signature)".
 */
export function identitySignature(sig: { html: string; text: string } | null): {
  html: string;
  text: string;
  complete: boolean;
} {
  if (!sig) return { html: "", text: "", complete: true };
  const max = IDENTITY_SIGNATURE_MAX_BYTES;
  const text = fitText(sig.text, max);
  const noImages = sig.html.replace(/<img\b[^>]*>/gi, "");
  let html = [sig.html, noImages].find((h) => bytes(h) <= max);
  // Else the text as HTML, cut shorter until its markup fits too (a few rounds at most).
  for (let budget = max; html === undefined && budget > 16; budget = Math.floor(budget * 0.8)) {
    const candidate = textAsHtml(fitText(sig.text, budget));
    if (bytes(candidate) <= max) html = candidate;
  }
  html ??= "";
  return { html, text, complete: html === sig.html && text === sig.text };
}
