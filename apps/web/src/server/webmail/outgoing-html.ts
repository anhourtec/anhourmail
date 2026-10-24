// SPDX-License-Identifier: AGPL-3.0-only
import sanitizeHtml from "sanitize-html";

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
 *   and `expression()`, `behavior`, `-moz-binding`, `@import` and `position` other than static/relative are dropped.
 * - The whole input is capped at `MAX_OUTGOING_HTML` characters.
 */

/** The longest HTML a message body may have (characters, roughly bytes for markup). */
export const MAX_OUTGOING_HTML = 1024 * 1024;
/** The largest inline `data:` image (characters of the URI). */
export const MAX_DATA_IMAGE_BYTES = 512 * 1024;
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
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\\(.)/g, "$1")
    .replace(/\\/g, "");
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
    onOpenTag: (name) => {
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/**
 * The text/plain alternative for sanitised HTML: block ends become line breaks, list items get a dash, links keep
 * their address in brackets when it differs from the text. Expects `sanitizeOutgoingHtml` output (attributes
 * double-quoted and escaped), and is linear on it.
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
  return withLinks
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|tr|h[1-6]|blockquote|table|ul|ol|pre)>|<br\s*\/?>|<hr\s*\/?>/gi, "$&\n")
    .replace(/<(?:p|div|h[1-6]|blockquote|table|ul|ol|pre)\b[^>]*>/gi, "\n$&")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]*>/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, e: string) => ENTITIES[e] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/^[ \t]+/gm, (s) => (s.includes("\t") ? "" : s))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
