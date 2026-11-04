// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail templates (canned replies, ADR-0032 §3): named pieces of text a mailbox keeps and inserts from the composer.
 * Rich text through the outgoing sanitiser, with no images at all (signatures are the place for images). Published in
 * the docs; enforced by the BFF and the control plane.
 */
import { codePoints } from "./signatures";

export const WEBMAIL_TEMPLATES = {
  /** Templates one mailbox can keep. */
  perMailbox: 50,
  /** Longest template name, in characters. */
  nameChars: 64,
  /** Largest template, in KB of HTML. */
  templateKb: 64,
} as const;

/** The longest template HTML, in characters. */
export const TEMPLATE_HTML_MAX = WEBMAIL_TEMPLATES.templateKb * 1024;
/** The longest generated plain-text version kept. */
export const TEMPLATE_TEXT_MAX = 20_000;

export type TemplateView = { id: string; name: string; html: string; text: string };

/** A name as typed, tidied (as signature names are); null when empty or longer than `nameChars`. */
export function templateName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = codePoints(v).length;
  return chars >= 1 && chars <= WEBMAIL_TEMPLATES.nameChars ? v : null;
}

/** Names are unique per mailbox, ignoring case. */
export const sameTemplateName = (a: string, b: string): boolean =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
