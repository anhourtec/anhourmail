// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The choices the composer's formatting toolbar offers (docs/internal/05-webmail.md "Compose") and how each maps to
 * an editing command. Every value here is something the outgoing sanitiser (`server/webmail/outgoing-html.ts`,
 * `STRICT_CSS`) keeps: generic font families (nothing to download), size keywords, fixed `#hex` colours (the
 * browser writes them as `rgb()`), `text-align` keywords and the browser's 40px indent.
 *
 * The colours are message content, not interface colours: they go out in the mail, so they are fixed values rather
 * than theme tokens (which would mean nothing in someone else's mail app).
 */

export type Choice = { label: string; value: string };

/** Font families: generic ones only, so the reader's own fonts are used and nothing is fetched. */
export const FONT_FAMILIES: readonly Choice[] = [
  { label: "Sans serif", value: "sans-serif" },
  { label: "Serif", value: "serif" },
  { label: "Monospace", value: "monospace" },
];

/** Font sizes: the editing command's 1–7 scale; the browser writes the matching CSS keyword. */
export const FONT_SIZES: readonly (Choice & { css: string })[] = [
  { label: "Small", value: "2", css: "small" },
  { label: "Normal", value: "3", css: "medium" },
  { label: "Large", value: "5", css: "x-large" },
  { label: "Huge", value: "6", css: "xx-large" },
];

/** Text colours (fixed, mail-safe values). */
export const TEXT_COLOURS: readonly Choice[] = [
  { label: "Black", value: "#000000" },
  { label: "Dark grey", value: "#4b5563" },
  { label: "Grey", value: "#9ca3af" },
  { label: "White", value: "#ffffff" },
  { label: "Red", value: "#dc2626" },
  { label: "Orange", value: "#ea580c" },
  { label: "Yellow", value: "#ca8a04" },
  { label: "Green", value: "#16a34a" },
  { label: "Teal", value: "#0d9488" },
  { label: "Blue", value: "#2563eb" },
  { label: "Purple", value: "#7c3aed" },
  { label: "Pink", value: "#db2777" },
];

/** Highlight colours; "No highlight" clears one. */
export const HIGHLIGHTS: readonly Choice[] = [
  { label: "No highlight", value: "transparent" },
  { label: "Yellow", value: "#fef08a" },
  { label: "Green", value: "#bbf7d0" },
  { label: "Teal", value: "#99f6e4" },
  { label: "Blue", value: "#bfdbfe" },
  { label: "Purple", value: "#e9d5ff" },
  { label: "Pink", value: "#fbcfe8" },
  { label: "Orange", value: "#fed7aa" },
  { label: "Grey", value: "#e5e7eb" },
];

export type Alignment = "left" | "center" | "right";

/** Alignments and their editing commands. */
export const ALIGNMENTS: readonly { label: string; value: Alignment; command: string }[] = [
  { label: "Align left", value: "left", command: "justifyLeft" },
  { label: "Align centre", value: "center", command: "justifyCenter" },
  { label: "Align right", value: "right", command: "justifyRight" },
];

/**
 * Commands that should write inline CSS (`<span style>`, `text-align`) rather than legacy tags (`<font>`,
 * `<strike>`). Everything else (bold, italic, underline, lists) keeps its semantic tag.
 */
const CSS_COMMANDS = new Set([
  "foreColor", "hiliteColor", "fontName", "fontSize", "justifyLeft", "justifyCenter", "justifyRight",
  "strikeThrough", "indent", "outdent",
]); // prettier-ignore

export const writesCss = (command: string): boolean => CSS_COMMANDS.has(command);

/** Lowercase, without quotes or spaces after commas: how browsers report a family varies. */
const normalFamily = (v: string) => v.toLowerCase().replace(/["']/g, "").replace(/,\s+/g, ",").trim();

/** Which of our families the selection uses (from `queryCommandValue("fontName")`), if any. */
export function matchFamily(reported: string): string | undefined {
  const v = normalFamily(reported);
  return FONT_FAMILIES.find((f) => f.value === v)?.value;
}

/** Which of our sizes the selection uses (from `queryCommandValue("fontSize")`, "1"–"7"), if any. */
export function matchSize(reported: string): string | undefined {
  return FONT_SIZES.find((s) => s.value === reported.trim())?.value;
}

/** `rgb(220, 38, 38)` (how browsers report a colour) as `#dc2626`; other values unchanged, lowercased. */
export function colourHex(reported: string): string {
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(reported.trim());
  if (!m) return reported.trim().toLowerCase();
  if (m[4] !== undefined && Number(m[4]) === 0) return "transparent";
  return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
}

/** Which alignment a computed `text-align` is (start/justify count as left). */
export function alignmentOf(textAlign: string): Alignment {
  const v = textAlign.toLowerCase();
  if (v === "center" || v === "-webkit-center") return "center";
  if (v === "right" || v === "end" || v === "-webkit-right") return "right";
  return "left";
}
