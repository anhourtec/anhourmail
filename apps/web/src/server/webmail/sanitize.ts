// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import sanitizeHtml from "sanitize-html";

/**
 * Server-side allow-list sanitiser for message HTML (docs/internal/05-webmail.md "Rendering safety", CLAUDE.md
 * rule 29). Its output is rendered in a sandboxed `srcdoc` iframe with no scripts, no same-origin and its own CSP,
 * so this is one of three layers, not the only one.
 *
 * - Only presentational tags and attributes survive; scripts, event handlers, forms, frames, objects, SVG, MathML,
 *   `<base>`, `<meta>` and `<link>` are removed.
 * - Links keep http(s)/mailto only and open in a new tab without a referrer.
 * - **Remote content is blocked**: remote `<img>` sources become placeholders (`data-am-blocked`), 1×1 trackers
 *   are dropped, `srcset`/`background` attributes are removed, and CSS `url()`, `image-set()` and `@import` are
 *   neutralised. Inline images come from `cid:` parts the caller resolved to `data:` URIs.
 * - CSS (style attributes and `<style>` blocks) is scrubbed of comments, escapes, `expression()`, `behavior`,
 *   `-moz-binding` and `javascript:`.
 */

export type SanitizeResult = {
  html: string;
  /** Remote images (and CSS backgrounds) that were blocked. */
  blockedImages: number;
  /** Tracking pixels that were removed outright. */
  blockedTrackers: number;
};

const ALLOWED_TAGS = [
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center",
  "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure",
  "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main",
  "mark", "nav", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "span", "strike",
  "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt",
  "u", "ul", "var", "wbr",
]; // prettier-ignore

const COMMON_ATTRS = [
  "style",
  "class",
  "id",
  "dir",
  "lang",
  "title",
  "align",
  "valign",
  "width",
  "height",
  "data-am-sig",
];

const ALLOWED_ATTRS: Record<string, string[]> = {
  "*": COMMON_ATTRS,
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "border", "data-am-blocked", "data-am-drop"],
  table: ["border", "cellpadding", "cellspacing", "bgcolor", "summary"],
  td: ["bgcolor", "colspan", "rowspan", "nowrap", "abbr", "headers", "scope"],
  th: ["bgcolor", "colspan", "rowspan", "nowrap", "abbr", "headers", "scope"],
  tr: ["bgcolor"],
  font: ["color", "face", "size"],
  col: ["span"],
  colgroup: ["span"],
  ol: ["start", "type", "reversed"],
  ul: ["type"],
  li: ["value"],
  time: ["datetime"],
  hr: ["noshade", "size"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
  details: ["open", "data-am-quote"],
};

/** Inline image data we render: raster only (no SVG, which can carry script in other contexts). */
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/i;
const REMOTE = /^\s*(?:https?:)?\/\//i;

/** Private-use placeholder for safe data: URLs while the rest of the CSS is scrubbed (stripped from input first). */
const MARK = "\uE000";

/** Decodes CSS escapes (`\75 rl(` → `url(`) so filters see what the browser would. */
function decodeCssEscapes(css: string): string {
  return css
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\\(.)/g, "$1")
    .replace(/\\/g, "");
}

/** Longest CSS we scrub: a style attribute, and a whole `<style>` block. Longer CSS is dropped (and counted). */
export const MAX_STYLE_ATTR = 8 * 1024;
export const MAX_STYLE_BLOCK = 64 * 1024;

/**
 * `indexOf` with a per-character memo, so repeated searches from increasing positions stay linear in total (an
 * adversarial run of `url(` without a closing `)` must not rescan the tail for every opener).
 */
function finder(css: string) {
  const memo = new Map<string, number>();
  return (ch: string, from: number): number => {
    const known = memo.get(ch);
    if (known !== undefined && (known === -1 || known >= from)) return known;
    const at = css.indexOf(ch, from);
    memo.set(ch, at);
    return at;
  };
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * Replaces every `url(…)` in linear time: a safe raster `data:` image is parked behind a placeholder (restored at
 * the end), anything else becomes `none`. An unterminated `url(` makes the rest of the CSS invalid anyway, so the
 * remainder is dropped.
 */
function neutraliseUrls(css: string, counter: { remote: number }, kept: string[]): string {
  const find = finder(css);
  const opener = /url\s*\(/gi;
  let out = "";
  let i = 0;
  for (;;) {
    opener.lastIndex = i;
    const m = opener.exec(css);
    if (!m) return out + css.slice(i);
    out += css.slice(i, m.index);
    let j = m.index + m[0].length;
    while (isSpace(css[j])) j++;
    const q = css[j];
    let target: string | null = null;
    let end: number;
    if (q === '"' || q === "'") {
      const close = find(q, j + 1);
      if (close === -1) {
        counter.remote += 1;
        return `${out}none`;
      }
      const paren = find(")", close + 1);
      if (paren === -1) {
        counter.remote += 1;
        return `${out}none`;
      }
      end = paren + 1;
      // Text after the quoted URL makes it malformed: the whole call is dropped below.
      if (css.slice(close + 1, paren).trim() === "") target = css.slice(j + 1, close);
    } else {
      const paren = find(")", j);
      if (paren === -1) {
        counter.remote += 1;
        return `${out}none`;
      }
      target = css.slice(j, paren);
      end = paren + 1;
    }
    const t = (target ?? "").trim();
    if (SAFE_DATA_IMAGE.test(t)) {
      kept.push(t.replace(/\s/g, ""));
      out += `${MARK}${String(kept.length - 1)}${MARK}`;
    } else {
      counter.remote += 1;
      out += "none";
    }
    i = end;
  }
}

/**
 * Scrubs a CSS fragment; counts remote references it removed. Every pattern here is linear (no nested or
 * back-referenced quantifiers), and callers cap the input length first (`MAX_STYLE_ATTR`, `MAX_STYLE_BLOCK`).
 */
export function cleanCss(input: string, counter: { remote: number } = { remote: 0 }): string {
  let css = decodeCssEscapes(input.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")).replaceAll(MARK, "");
  // Nothing in CSS needs "<": dropping it means no text can ever reopen markup.
  css = css.replace(/</g, "");
  css = css.replace(/@import[^;]*;?/gi, () => {
    counter.remote += 1;
    return "";
  });
  // Safe data: images are parked behind a placeholder so the catch-all below can't touch them.
  const kept: string[] = [];
  css = neutraliseUrls(css, counter, kept);
  // Belt and braces: never let a url( survive.
  css = css.replace(/url\s*\(/gi, () => {
    counter.remote += 1;
    return "none(";
  });
  css = css.replace(/(?:-webkit-)?image-set\s*\(/gi, () => {
    counter.remote += 1;
    return "none(";
  });
  css = css.replace(/expression\s*\(/gi, "none(");
  css = css.replace(/(?:behavior|-moz-binding)\s*:[^;}]*/gi, "");
  css = css.replace(/javascript\s*:/gi, "");
  return css.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_m, i: string) => `url("${kept[Number(i)] ?? ""}")`);
}

const QUOTE_CLASS = /(?:^|\s)(?:gmail_quote(?:_container)?|yahoo_quoted|moz-cite-prefix)(?:\s|$)/;
const SIG_CLASS = /(?:^|\s)(?:gmail_signature|moz-signature)(?:\s|$)/;

/**
 * Quoted replies (`blockquote type=cite`, Gmail/Yahoo quote containers, Outlook's reply header block) become a
 * `<details>` toggle, collapsed; signatures (Gmail, Thunderbird) are marked to be dimmed. Only our own marker
 * attributes are added (the input's look-alikes were renamed before parsing).
 */
function quoteOrSig(
  tagName: string,
  attribs: Record<string, string>,
): { tagName: string; attribs: Record<string, string> } {
  const cls = attribs.class ?? "";
  const quote =
    (tagName === "blockquote" && (attribs.type ?? "").toLowerCase() === "cite") ||
    QUOTE_CLASS.test(cls) ||
    attribs.id === "divRplyFwdMsg";
  if (quote) return { tagName: "details", attribs: { ...attribs, "data-am-quote": "1" } };
  if (SIG_CLASS.test(cls) || attribs["data-smartmail"] === "gmail_signature") {
    return { tagName, attribs: { ...attribs, "data-am-sig": "1" } };
  }
  return { tagName, attribs };
}

/**
 * Sanitises message HTML. `inlineImages` maps a Content-ID (without `<>`) to a `data:` URI the caller fetched for
 * that part; unresolved `cid:` references become placeholders like remote images.
 */
export function sanitizeMessageHtml(
  input: string,
  inlineImages: ReadonlyMap<string, string> = new Map(),
): SanitizeResult {
  const css = { remote: 0 };
  let blockedImages = 0;
  let blockedTrackers = 0;

  // sanitize-html runs one transform per tag (a specific one, else "*"), so every transform cleans styles.
  const withCleanStyle = (attribs: Record<string, string>): Record<string, string> => {
    if (attribs.style === undefined) return attribs;
    const out = { ...attribs };
    if (attribs.style.length > MAX_STYLE_ATTR) {
      css.remote += 1;
      delete out.style;
      return out;
    }
    const style = cleanCss(attribs.style, css).trim();
    if (style === "") delete out.style;
    else out.style = style;
    return out;
  };

  const html = sanitizeHtml(input.replace(/data-am-(?:quote|sig|blocked|drop)/gi, "data-x"), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowVulnerableTags: true, // <style> only: its contents are scrubbed below
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "template", "xmp"],
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    enforceHtmlBoundary: true,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...withCleanStyle(attribs), target: "_blank", rel: "noopener noreferrer" },
      }),
      img: (tagName, attribs) => {
        const out: Record<string, string> = withCleanStyle(attribs);
        const src = (attribs.src ?? "").trim();
        const cid = /^cid:(.+)$/i.exec(src)?.[1]?.replace(/^<|>$/g, "");
        const resolved = cid ? inlineImages.get(cid) : undefined;
        if (resolved && SAFE_DATA_IMAGE.test(resolved)) {
          out.src = resolved;
        } else if (SAFE_DATA_IMAGE.test(src)) {
          out.src = src.replace(/\s/g, "");
        } else {
          delete out.src;
          const w = Number(attribs.width);
          const h = Number(attribs.height);
          if (src !== "" && REMOTE.test(src) && w > 0 && h > 0 && w <= 2 && h <= 2) {
            out["data-am-drop"] = "1";
          } else if (src !== "") {
            out["data-am-blocked"] = "1";
          }
        }
        return { tagName, attribs: out };
      },
      // <style> keeps no attributes, so the post-pass below always recognises it.
      style: (tagName) => ({ tagName, attribs: {} }),
      blockquote: (tagName, attribs) => quoteOrSig(tagName, withCleanStyle(attribs)),
      div: (tagName, attribs) => quoteOrSig(tagName, withCleanStyle(attribs)),
      "*": (tagName, attribs) => ({ tagName, attribs: withCleanStyle(attribs) }),
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === "img" && frame.attribs["data-am-drop"] === "1") {
        blockedTrackers += 1;
        return true;
      }
      if (frame.tag === "img" && frame.attribs["data-am-blocked"] === "1") blockedImages += 1;
      return false;
    },
  });

  // sanitize-html emits <style> contents raw (htmlparser2 ends them at the first "</style"), and only real style
  // elements can produce a literal "<style>" in its output (all other text is escaped).
  const cleaned = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/g, (_m, body: string) => {
    if (body.length > MAX_STYLE_BLOCK) {
      css.remote += 1;
      return "<style></style>";
    }
    return `<style>${cleanCss(body, css)}</style>`;
  });
  // Quoted replies become native toggles: the frame runs no script, and <details> needs none.
  const toggled = cleaned.replace(
    /<details\b([^>]*\sdata-am-quote="1"[^>]*)>/g,
    '<details$1><summary title="Show quoted text" aria-label="Show quoted text">&#8226;&#8226;&#8226;</summary>',
  );
  return { html: toggled, blockedImages: blockedImages + css.remote, blockedTrackers };
}

/**
 * Message HTML as plain text, for quoting in replies and forwards: tags dropped (block ends become line breaks),
 * entities decoded once, runs of blank lines collapsed. Linear; the input is already capped by the caller.
 */
export function htmlToText(input: string): string {
  const withBreaks = input.replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|table)>|<br\s*\/?>/gi, "$&\n");
  const text = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ["script", "style", "title", "head", "textarea", "noscript", "template"],
  });
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
