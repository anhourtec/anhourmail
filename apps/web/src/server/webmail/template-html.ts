// SPDX-License-Identifier: AGPL-3.0-only
import { TEMPLATE_HTML_MAX, TEMPLATE_TEXT_MAX, WEBMAIL_TEMPLATES } from "@anhourmail/shared/templates";

import { outgoingText, sanitizeOutgoingHtml } from "./outgoing-html";

/**
 * Template HTML (canned replies, ADR-0032 §3): the outgoing allow-list sanitiser in its strictest mode, then every
 * image removed — templates hold text only (no remote, attached or embedded images; signatures are the place for
 * images). Pure: the template editor runs it to show what will be kept, and the BFF runs it again on every save.
 */
export type CleanTemplate = { html: string; text: string; problem: string | null; removedImages: number };

/** Whether sanitised HTML shows any text. */
const hasText = (html: string) => html.replace(/<[^>]*>|&nbsp;|\s/g, "") !== "";

export function cleanTemplate(input: string): CleanTemplate {
  const tooLong = `A template can be up to ${String(WEBMAIL_TEMPLATES.templateKb)} KB.`;
  if (input.length > TEMPLATE_HTML_MAX * 2) return { html: "", text: "", problem: tooLong, removedImages: 0 };
  // Embedded images only, and none of those either: `maxDataImage: 0` drops every image's source, then the tags go.
  const r = sanitizeOutgoingHtml(input, { embeddedImagesOnly: true, maxDataImage: 0 });
  const removedImages = input.match(/<img\b/gi)?.length ?? 0;
  const stripped = r.html.replace(/<img\b[^>]*>/gi, "");
  const html = hasText(stripped) ? stripped : "";
  const text = html === "" ? "" : outgoingText(html).slice(0, TEMPLATE_TEXT_MAX);
  let problem: string | null = null;
  if (html === "") problem = "Write the template's text.";
  else if (html.length > TEMPLATE_HTML_MAX) problem = tooLong;
  return { html, text, problem, removedImages };
}
