// SPDX-License-Identifier: AGPL-3.0-only
import sanitizeHtml from "sanitize-html";

import { WEBMAIL_HTML } from "@anhourmail/shared";

/**
 * Allow-list sanitiser for HTML the webmail **sends** (docs/internal/05-webmail.md "Compose", 07-security.md
 * "Outgoing HTML"). It runs in two places with the same rules: in the browser (rich-text editor output, pasted
 * HTML and "Insert HTML", so the person sees what will go out) and again on the server for every draft, because
 * the client is never trusted. It is a pure function with no server-only imports, so both bundles share it; the
 * composer loads it lazily.
 *
 * It uses the same engine (sanitize-html on htmlparser2) as the reading-side sanitiser (`sanitize.ts`), with a
 * stricter list, because what we send is rendered by other people's mail apps that we don't control:
 *
 * - Only structural and text elements survive. Unknown or custom elements (e.g. a browser extension's toolbar
 *   pasted along with a page) are unwrapped and keep their text. Script, `<style>` blocks (dropped entirely: mail
 *   apps rewrite or drop them anyway, and they are the main carrier of `@import` and remote fonts), templates,
 *   frames, objects, forms and their controls, SVG and MathML are removed with their content.
 * - Links keep http, https, mailto and tel only, and always open in a new tab without a referrer.
 * - Images keep https, `cid:` and raster `data:` images up to `MAX_DATA_IMAGE_BYTES`; remote images are counted
 *   so the composer can warn that they may be trackers.
 * - Inline `style` keeps only allow-listed CSS properties; `url()` survives only for https and raster data images,
 *   and `expression()`, `behavior`, `-moz-binding`, `@import`, `var()`, `env()`, `attr()` and `position` other than
 *   static/relative are dropped.
 * - The properties the composer's toolbar writes (colour, highlight, font, size, alignment, indent, strikethrough)
 *   and the legacy `<font>` attributes must also match a narrow value grammar (`STRICT_CSS`, `fontAttribute`):
 *   colours as `#hex`, `rgb()`/`rgba()` or a plain colour word; font families as a short list of plain names;
 *   sizes and spacing as bounded, non-negative lengths; alignment and decoration as keywords. Anything else in those
 *   properties is dropped, so no function, escape or unit trick gets through them.
 * - The whole input is capped at `MAX_OUTGOING_HTML` characters.
 */

/** The longest HTML a message body may have (characters, roughly bytes for markup). */
export const MAX_OUTGOING_HTML = WEBMAIL_HTML.maxMb * 1024 * 1024;
/** The largest inline `data:` image (characters of the URI). */
export const MAX_DATA_IMAGE_BYTES = WEBMAIL_HTML.inlineImageKb * 1024;
/** The longest `style` attribute kept. */
export const MAX_OUTGOING_STYLE = 8 * 1024;

export type OutgoingHtml = {
  /** The sanitised HTML ("" when the input was too large). */
  html: string;
  /** The input was over `MAX_OUTGOING_HTML` and nothing was kept. */
  tooLarge: boolean;
  /** Element names that were removed or unwrapped, sorted. */
  removedTags: string[];
  /** Attribute names that were removed (including unsafe link or image addresses and CSS properties), sorted. */
  removedAttributes: string[];
  /** https images (and CSS backgrounds) left in: they load from someone else's server when the mail is read. */
  remoteImages: number;
};

export const OUTGOING_TAGS = [
  "a", "b", "blockquote", "br", "caption", "center", "code", "col", "colgroup", "div", "em", "font", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]; // prettier-ignore

const ALLOWED_TAG_SET = new Set(OUTGOING_TAGS);

const COMMON = ["title", "width", "height", "align", "valign", "bgcolor", "color", "dir", "lang", "style"];

const ATTRS: Record<string, string[]> = {
  a: [...COMMON, "href", "target", "rel"],
  // `type="cite"` marks a quoted reply, which mail apps (ours included) fold when reading; any other value is dropped.
  blockquote: [...COMMON, "type"],
  img: [...COMMON, "src", "alt", "border"],
  table: [...COMMON, "border", "cellpadding", "cellspacing"],
  td: [...COMMON, "colspan", "rowspan"],
  th: [...COMMON, "colspan", "rowspan"],
  col: [...COMMON, "span"],
  colgroup: [...COMMON, "span"],
  font: [...COMMON, "face", "size"],
};
const attrsFor = (tag: string): string[] => ATTRS[tag] ?? COMMON;

/**
 * Removed together with everything inside them (their text is code, data or a control label, not prose; `summary`
 * is the reading view's quote toggle when a reply quotes it).
 */
const DROP_WITH_CONTENT = [
  "script", "style", "template", "textarea", "select", "option", "button", "noscript", "noembed", "noframes",
  "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "title", "head", "xmp", "plaintext",
  "summary",
]; // prettier-ignore

/** The reading view's marker on a folded quote (`server/webmail/sanitize.ts`). */
const QUOTE_MARK = "data-am-quote";

const LINK = /^(?:https?:\/\/|mailto:|tel:)/i;
const IMG_HTTPS = /^https:\/\//i;
const IMG_CID = /^cid:[^\s"'<>]{1,250}$/i;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

/** Control characters and whitespace a browser ignores inside a URL scheme ("java\tscript:"). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const URL_NOISE = /[\u0000- \u007f-\u009f]/g;

const CSS_PROPS = new Set([
  "background", "background-color", "background-image", "background-position", "background-repeat",
  "background-size", "border", "border-bottom", "border-bottom-color", "border-bottom-style", "border-bottom-width",
  "border-collapse", "border-color", "border-left", "border-left-color", "border-left-style", "border-left-width",
  "border-radius", "border-right", "border-right-color", "border-right-style", "border-right-width",
  "border-spacing", "border-style", "border-top", "border-top-color", "border-top-style", "border-top-width",
  "border-width", "box-sizing", "caption-side", "clear", "color", "direction", "display", "empty-cells", "float",
  "font", "font-family", "font-size", "font-style", "font-variant", "font-weight", "height", "letter-spacing",
  "line-height", "list-style", "list-style-position", "list-style-type", "margin", "margin-bottom", "margin-left",
  "margin-right", "margin-top", "max-height", "max-width", "min-height", "min-width", "opacity", "overflow",
  "padding", "padding-bottom", "padding-left", "padding-right", "padding-top", "position", "table-layout",
  "text-align", "text-decoration", "text-decoration-color", "text-decoration-line", "text-decoration-style",
  "text-indent", "text-transform", "vertical-align", "white-space", "width", "word-break", "word-spacing",
  "overflow-wrap",
]); // prettier-ignore

/** Decodes CSS escapes (`\75 rl(` → `url(`) and drops comments, so checks see what a mail app would. */
function decodeCss(css: string): string {
  return (
    css
      .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")
      .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) => {
        const code = Number.parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      })
      .replace(/\\(.)/g, "$1")
      .replace(/\\/g, "")
      // An escaped `/*` decodes into a comment opener the recipient's parser would honour: drop it too.
      .replace(/\/\*[\s\S]*$/, "")
  );
}

/** Splits declarations on `;` outside quotes and parentheses (a `data:` URL has its own `;`). Linear. */
function declarations(css: string): string[] {
  const out: string[] = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(css.slice(start, i));
      start = i + 1;
    }
  }
  out.push(css.slice(start));
  return out;
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** `rgb(185, 28, 28)` / `rgba(0, 0, 0, 0.5)` as browsers write them: numbers (or percentages) and commas only. */
const RGB_COLOR =
  /^rgba?\(\s*\d{1,3}(?:\.\d{1,3})?%?\s*,\s*\d{1,3}(?:\.\d{1,3})?%?\s*,\s*\d{1,3}(?:\.\d{1,3})?%?\s*(?:,\s*(?:\d|\d?\.\d{1,3}|\d{1,3}%)\s*)?\)$/i;
/** A colour keyword (`red`, `transparent`, `windowtext`): letters only, so nothing can hide in it. */
const COLOR_WORD = /^[a-z]{3,20}$/i;

/** A colour value: `#hex`, `rgb()`/`rgba()` or a colour keyword. */
export const isSafeColor = (v: string): boolean => HEX_COLOR.test(v) || RGB_COLOR.test(v) || COLOR_WORD.test(v);

/** One font family: a plain name (letters, digits, spaces, `-`, `_`), optionally in quotes. */
const FAMILY = /^(?:[a-z0-9][a-z0-9 _-]{0,39}|"[a-z0-9][a-z0-9 _-]{0,39}"|'[a-z0-9][a-z0-9 _-]{0,39}')$/i;
/** The most families one `font-family` may list. */
const MAX_FAMILIES = 8;

/** A `font-family` list of plain names (the composer writes `sans-serif`, `serif` or `monospace`). */
export function isSafeFontFamily(v: string): boolean {
  const parts = v.split(",");
  return parts.length <= MAX_FAMILIES && parts.every((p) => FAMILY.test(p.trim()));
}

type Units = Partial<Record<"px" | "pt" | "em" | "rem" | "ex" | "%", number>>;

/** Largest font size per unit (the composer writes keywords; pasted mail uses px and pt). */
const FONT_SIZE_MAX: Units = { px: 96, pt: 72, em: 6, rem: 6, ex: 12, "%": 600 };
/** Largest margin or padding per unit (indent steps are 40px; quotes use ex). */
const SPACING_MAX: Units = { px: 400, pt: 300, em: 25, rem: 25, ex: 50, "%": 100 };

const LENGTH = /^(\d{1,4}(?:\.\d{1,3})?|\.\d{1,3})(px|pt|em|rem|ex|%)$/i;

/** A non-negative length within `max` for its unit; a bare `0` too. */
function isLength(v: string, max: Units): boolean {
  if (/^0(?:\.0+)?$/.test(v)) return true;
  const m = LENGTH.exec(v);
  if (!m?.[1] || !m[2]) return false;
  const limit = max[m[2].toLowerCase() as keyof Units];
  return limit !== undefined && Number(m[1]) <= limit;
}

const FONT_SIZE_WORDS = new Set([
  "xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "xxx-large", "smaller", "larger",
]); // prettier-ignore

/** A font size: a size keyword or a bounded length (0 is not a size). */
export const isSafeFontSize = (v: string): boolean =>
  FONT_SIZE_WORDS.has(v.toLowerCase()) || (!/^0(?:\.0+)?$/.test(v) && isLength(v, FONT_SIZE_MAX));

/** One to four bounded, non-negative lengths (`auto` too, for margins). */
const spacing =
  (auto: boolean) =>
  (v: string): boolean => {
    const parts = v.split(/\s+/);
    return parts.length <= 4 && parts.every((p) => (auto && p.toLowerCase() === "auto") || isLength(p, SPACING_MAX));
  };

const DECORATION_LINES = new Set(["none", "underline", "overline", "line-through"]);
const DECORATION_STYLES = new Set(["solid", "double", "dotted", "dashed", "wavy"]);

/** `text-decoration`: line and style keywords plus at most one colour. */
function isSafeDecoration(v: string): boolean {
  const functions = v.match(/rgba?\([^()]*\)/gi) ?? [];
  if (!functions.every((m) => RGB_COLOR.test(m))) return false;
  const parts = v
    .replace(/rgba?\([^()]*\)/gi, " #000 ")
    .trim()
    .split(/\s+/);
  if (parts.length > 4) return false;
  const words = parts.filter((p) => DECORATION_LINES.has(p.toLowerCase()) || DECORATION_STYLES.has(p.toLowerCase()));
  const colors = parts.filter((p) => !words.includes(p));
  return colors.length <= 1 && colors.every(isSafeColor) && words.length >= 1;
}

const keywords =
  (...words: string[]) =>
  (v: string): boolean =>
    v
      .toLowerCase()
      .split(/\s+/)
      .every((w) => words.includes(w));

/**
 * The value grammar for the properties the composer writes (and the closely related ones a pasted message uses).
 * A declaration of one of these properties is kept only when its whole value matches.
 */
export const STRICT_CSS: Readonly<Record<string, (value: string) => boolean>> = {
  color: isSafeColor,
  "background-color": isSafeColor,
  "font-family": isSafeFontFamily,
  "font-size": isSafeFontSize,
  "text-align": (v) => /^(?:left|right|center|justify|start|end)$/i.test(v),
  margin: spacing(true),
  "margin-left": spacing(true),
  "margin-right": spacing(true),
  "margin-top": spacing(true),
  "margin-bottom": spacing(true),
  padding: spacing(false),
  "padding-left": spacing(false),
  "padding-right": spacing(false),
  "padding-top": spacing(false),
  "padding-bottom": spacing(false),
  "text-decoration": isSafeDecoration,
  "text-decoration-line": (v) => v.split(/\s+/).length <= 3 && keywords(...DECORATION_LINES)(v),
  "text-decoration-style": keywords(...DECORATION_STYLES),
  "text-decoration-color": isSafeColor,
};

/**
 * The legacy `<font>` attributes (and `color`/`bgcolor` on any element) with the same grammar as their CSS
 * counterparts; `size` is HTML's 1–7 (or a relative step). Returns false to drop the attribute.
 */
export function fontAttribute(name: string, value: string): boolean {
  const v = value.trim();
  if (name === "color" || name === "bgcolor") return isSafeColor(v);
  if (name === "face") return isSafeFontFamily(v);
  if (name === "size") return /^(?:[1-7]|[+-][1-6])$/.test(v);
  return true;
}

const balancedQuotes = (v: string) => (v.split('"').length - 1) % 2 === 0 && (v.split("'").length - 1) % 2 === 0;

/**
 * Every `url(…)` in a value, or null when one is malformed. Linear: one scan, no backtracking patterns.
 */
function urlsIn(value: string): string[] | null {
  const out: string[] = [];
  const opener = /url\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(value)) !== null) {
    const close = value.indexOf(")", m.index + m[0].length);
    if (close === -1) return null;
    out.push(
      value
        .slice(m.index + m[0].length, close)
        .trim()
        .replace(/^(["'])([\s\S]*)\1$/, "$2")
        .trim(),
    );
    opener.lastIndex = close + 1;
  }
  return out;
}

/**
 * Keeps the allow-listed declarations of a `style` attribute. Returns the kept CSS and the names it dropped
 * (as `style:<property>`), and counts https backgrounds as remote images.
 */
export function cleanOutgoingCss(input: string, counter: { remote: number } = { remote: 0 }) {
  const dropped: string[] = [];
  if (input.length > MAX_OUTGOING_STYLE) return { css: "", dropped: ["style"] };
  const kept: string[] = [];
  for (const decl of declarations(decodeCss(input))) {
    if (decl.trim() === "") continue;
    const colon = decl.indexOf(":");
    const prop = (colon === -1 ? decl : decl.slice(0, colon)).trim().toLowerCase();
    const value = colon === -1 ? "" : decl.slice(colon + 1).trim();
    const lower = value.toLowerCase().replace(URL_NOISE, "");
    const label = /^[a-z-]{1,40}$/.test(prop) ? `style:${prop}` : "style";
    const urls = urlsIn(value);
    const bad =
      !CSS_PROPS.has(prop) ||
      value === "" ||
      /[<>{}@\\]/.test(value) ||
      // A ";" belongs only inside a data: URL; elsewhere (in a quoted font name) a naive parser would split on it.
      value.replace(/url\s*\([^)]*\)/gi, "").includes(";") ||
      !balancedQuotes(value) ||
      /expression\s*\(|javascript:|vbscript:|behavior|-moz-binding|image-set\s*\(|element\s*\(/.test(lower) ||
      // Custom properties and environment or attribute lookups would let the reader's app style the message.
      /(?:var|env|attr)\s*\(/i.test(value) ||
      (Object.hasOwn(STRICT_CSS, prop) && STRICT_CSS[prop]?.(value) !== true) ||
      (prop === "position" && !/^(?:static|relative)$/.test(lower)) ||
      urls === null ||
      urls.some((u) => !IMG_HTTPS.test(u) && !(DATA_IMAGE.test(u) && u.length <= MAX_DATA_IMAGE_BYTES)) ||
      urls.some((u) => /["'()\s]/.test(u));
    if (bad) {
      dropped.push(label);
      continue;
    }
    counter.remote += urls.filter((u) => IMG_HTTPS.test(u)).length;
    kept.push(`${prop}: ${value}`);
  }
  return { css: kept.join("; "), dropped };
}

/** Sanitises HTML for sending. Pure; safe to run in the browser and on the server. */
export function sanitizeOutgoingHtml(input: string): OutgoingHtml {
  if (input.length > MAX_OUTGOING_HTML) {
    return { html: "", tooLarge: true, removedTags: [], removedAttributes: [], remoteImages: 0 };
  }
  const removedTags = new Set<string>();
  const removedAttributes = new Set<string>();
  const counter = { remote: 0 };

  const filter = (tag: string, attribs: Record<string, string>): Record<string, string> => {
    const allowed = attrsFor(tag);
    const out: Record<string, string> = {};
    for (const [name, raw] of Object.entries(attribs)) {
      if (!allowed.includes(name)) {
        removedAttributes.add(/^[a-z][a-z0-9:_-]{0,40}$/i.test(name) ? name.toLowerCase() : "attribute");
        continue;
      }
      if (name === "style") {
        const { css, dropped } = cleanOutgoingCss(raw, counter);
        for (const d of dropped) removedAttributes.add(d);
        if (css !== "") out.style = css;
        continue;
      }
      if (name === "href" || name === "src" || name === "target" || name === "rel") continue;
      if (!fontAttribute(name, raw)) {
        removedAttributes.add(name);
        continue;
      }
      if (name === "type") {
        if (raw.trim().toLowerCase() === "cite") out.type = "cite";
        else removedAttributes.add("type");
        continue;
      }
      out[name] = raw;
    }
    return out;
  };

  const html = sanitizeHtml(input, {
    allowedTags: OUTGOING_TAGS,
    allowedAttributes: Object.fromEntries(OUTGOING_TAGS.map((t) => [t, attrsFor(t)])),
    disallowedTagsMode: "discard",
    nonTextTags: DROP_WITH_CONTENT,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https", "cid", "data"] },
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    enforceHtmlBoundary: true,
    onOpenTag: (name, attribs) => {
      if (name === "details" && attribs[QUOTE_MARK] !== undefined) return; // a quote the reading view folded
      if (name === "strike") return; // becomes `<s>`
      if (!ALLOWED_TAG_SET.has(name) && name !== "html" && name !== "body") {
        removedTags.add(/^[a-z][a-z0-9-]{0,40}$/i.test(name) ? name.toLowerCase() : "element");
      }
    },
    // sanitize-html runs a tag's own transform and then "*", so every allowed tag gets exactly one here.
    transformTags: {
      ...Object.fromEntries(
        OUTGOING_TAGS.map((t): [string, sanitizeHtml.Transformer] => [
          t,
          (tagName, attribs) => ({ tagName, attribs: filter(tagName, attribs) }),
        ]),
      ),
      a: (tagName, attribs) => {
        const out = filter(tagName, attribs);
        const href = (attribs.href ?? "").replace(URL_NOISE, "");
        if (LINK.test(href)) out.href = (attribs.href ?? "").trim();
        else if (attribs.href !== undefined) removedAttributes.add("href");
        return { tagName, attribs: { ...out, target: "_blank", rel: "noopener noreferrer" } };
      },
      // `<strike>` (what some editors write for strikethrough) is the same as `<s>`.
      strike: (_tagName, attribs) => ({ tagName: "s", attribs: filter("s", attribs) }),
      // The reading view folds quoted replies into `<details data-am-quote>`; quoting that message again keeps them
      // quotes (its `summary` toggle is dropped with its label).
      details: (tagName, attribs) =>
        attribs[QUOTE_MARK] !== undefined
          ? { tagName: "blockquote", attribs: { type: "cite" } }
          : { tagName, attribs: {} },
      img: (tagName, attribs) => {
        const out = filter(tagName, attribs);
        const src = (attribs.src ?? "").trim();
        if (IMG_HTTPS.test(src) && !/[\s"'<>]/.test(src)) {
          out.src = src;
          counter.remote += 1;
        } else if (IMG_CID.test(src) || (DATA_IMAGE.test(src) && src.length <= MAX_DATA_IMAGE_BYTES)) {
          out.src = src;
        } else if (attribs.src !== undefined) {
          removedAttributes.add("src");
        }
        return { tagName, attribs: out };
      },
    },
    // An image whose source was removed has nothing to show.
    exclusiveFilter: (frame) => frame.tag === "img" && frame.attribs.src === undefined,
  });

  return {
    html: html.trim(),
    tooLarge: false,
    removedTags: [...removedTags].sort(),
    removedAttributes: [...removedAttributes].sort(),
    remoteImages: counter.remote,
  };
}

/** A line without its trailing spaces and tabs (a linear scan). */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line.slice(0, end);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/**
 * The most "> " levels a line gets: deeper quotes keep this many. Bounds the text part to a small multiple of the
 * HTML however deeply someone nests quotes (each line's prefix would otherwise grow with the depth).
 */
export const MAX_QUOTE_PREFIX = 8;

/** Private-use markers for the start and end of a quote while the text is built (removed from the input first). */
const QUOTE_OPEN = "\uE000";
const QUOTE_CLOSE = "\uE001";
/** Private-use markers for a line boundary (a `div` edge; a run of them is one line break) and an empty line. */
const LINE = "\uE002";
const EMPTY_LINE = "\uE003";

/**
 * Prefixes the lines between quote markers with "> " per level (">" alone on an empty line) and drops the markers.
 * Blank lines next to a quote's start or end go; a blank line separates the end of a quote from the text after it.
 */
function quoteLines(text: string): string {
  type Item = { kind: "open" | "close" | "text"; text: string };
  const items: Item[] = text.split("\n").map((line) => {
    const t = line.trim();
    if (t === QUOTE_OPEN) return { kind: "open", text: "" };
    if (t === QUOTE_CLOSE) return { kind: "close", text: "" };
    return { kind: "text", text: line };
  });
  const blank = (i: Item | undefined) => i?.kind === "text" && i.text.trim() === "";
  // The nearest non-blank item before and after each index, in two passes (a long run of blank lines stays linear).
  const before: (Item | undefined)[] = new Array<Item | undefined>(items.length);
  const after: (Item | undefined)[] = new Array<Item | undefined>(items.length);
  let last: Item | undefined;
  for (let i = 0; i < items.length; i++) {
    before[i] = last;
    if (!blank(items[i])) last = items[i];
  }
  last = undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    after[i] = last;
    if (!blank(items[i])) last = items[i];
  }
  const marker = (i: Item | undefined) => i?.kind === "open" || i?.kind === "close";
  const kept = items.filter((item, i) => !blank(item) || (!marker(before[i]) && !marker(after[i])));
  const out: string[] = [];
  let depth = 0;
  let separate = false;
  for (const item of kept) {
    if (item.kind === "open") depth += 1;
    else if (item.kind === "close") {
      depth = Math.max(0, depth - 1);
      separate = depth === 0;
    } else {
      if (separate && depth === 0) out.push("");
      separate = false;
      out.push(depth > 0 ? `${">".repeat(Math.min(depth, MAX_QUOTE_PREFIX))} ${item.text}`.trimEnd() : item.text);
    }
  }
  return out.join("\n");
}

/**
 * Whether a sanitised `<blockquote …>` opening tag is an indent rather than a quote: it says `border: none` and
 * isn't a cited reply. Browsers' "indent" command writes exactly that (`margin: 0 0 0 40px; border: none; …`).
 */
export function isIndentBlock(tag: string): boolean {
  const style = /\sstyle="([^"]*)"/i.exec(tag)?.[1] ?? "";
  return /(?:^|;)\s*border:\s*none\s*(?:;|$)/i.test(style) && !/\stype="cite"/i.test(tag);
}

/**
 * The text/plain alternative for sanitised HTML: block ends become line breaks, list items get a dash or a number, links keep
 * their address in brackets when it differs from the text, and quoted replies (`blockquote`) get "> " per level
 * (indents don't). Expects `sanitizeOutgoingHtml` output (attributes double-quoted and escaped), and is linear on it.
 */
export function outgoingText(html: string): string {
  const withLinks = html.replace(
    /<a\b[^>]*?\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const text = inner.replace(/<[^>]*>/g, "").trim();
      const url = href.replace(/&amp;/g, "&");
      const shown = url.replace(/^mailto:|^tel:/i, "");
      return text === "" ? url : text === shown || text === url ? text : `${inner} (${url})`;
    },
  );
  // An indent (the editor's "Indent" writes a borderless `<blockquote>`) is not a quote: its lines get no "> ".
  const quotes: boolean[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  const text = withLinks
    .replace(/[\uE000-\uE003]/g, "")
    // Editors write one `div` per line: its edges are line breaks, not paragraph breaks. A `div` holding only a
    // `<br>` is an empty line; any other `<br>` that ends a block adds nothing (it only gives the block a height).
    .replace(/<div\b[^>]*>\s*<br\s*\/?>\s*<\/div>/gi, `${LINE}${EMPTY_LINE}${LINE}`)
    .replace(/<br\s*\/?>(?=\s*<\/(?:div|p|li|h[1-6])>)/gi, "")
    .replace(/<\/?div\b[^>]*>/gi, LINE)
    .replace(/<blockquote\b[^>]*>|<\/blockquote>/gi, (tag) => {
      if (tag[1] === "/") return (quotes.pop() ?? true) ? `\n${QUOTE_CLOSE}\n` : LINE;
      const quote = !isIndentBlock(tag);
      quotes.push(quote);
      return quote ? `\n${QUOTE_OPEN}\n` : LINE;
    })
    // List items get "- " (or "1. " in a numbered list), indented two spaces per nested list (capped).
    .replace(/<(?:ul|ol)\b[^>]*>|<\/(?:ul|ol)>|<li\b[^>]*>/gi, (tag) => {
      const t = tag.toLowerCase();
      if (t.startsWith("</")) {
        lists.pop();
        return lists.length === 0 ? "\n\n" : "";
      }
      if (t.startsWith("<li")) {
        const list = lists.at(-1);
        if (!list) return "\n- ";
        list.n += 1;
        const indent = "  ".repeat(Math.min(lists.length - 1, MAX_QUOTE_PREFIX));
        return `\n${indent}${list.ordered ? `${String(list.n)}.` : "-"} `;
      }
      lists.push({ ordered: t.startsWith("<ol"), n: 0 });
      return lists.length === 1 ? "\n\n" : "";
    })
    .replace(/<\/(?:p|tr|h[1-6]|blockquote|table|pre)>|<br\s*\/?>|<hr\s*\/?>/gi, "$&\n")
    .replace(/<(?:p|h[1-6]|blockquote|table|pre)\b[^>]*>/gi, "\n$&")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]*>/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, e: string) => ENTITIES[e] ?? "")
    .replace(/[ \t]*\uE002(?:[ \t]*\uE002)*[ \t]*/g, "\n")
    .replace(/\uE003/g, "")
    // Trailing spaces and tabs go per line by a scan: a regex like /[ \t]+\n/ is quadratic on a long run of spaces.
    .split("\n")
    .map(trimLineEnd)
    .join("\n")
    .replace(/^[ \t]+/gm, (s) => (s.includes("\t") ? "" : s))
    .replace(/\n{3,}/g, "\n\n");
  return quoteLines(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
