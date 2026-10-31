// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Remote images while writing (docs/internal/05-webmail.md "Compose"): HTML someone pastes or inserts may point at
 * images on other servers (https, or `cid:` parts of another message). They are sent as written, with a warning, but
 * nothing loads them while the message is being written or previewed: the page's and the preview frame's CSP would
 * block them anyway, and every blocked load is an error in the console. So for display each one is "parked": its
 * address moves to `data-am-src` and a blank placeholder takes its place (`data-am-blocked`, styled like the reader's
 * blocked images); a CSS background with a remote `url()` keeps its original style in `data-am-style`.
 * `unparkRemoteImages` puts everything back before the HTML is sanitised and saved.
 *
 * Both work on outgoing-sanitiser output or the editor's `innerHTML` (attributes double-quoted, `"` escaped), scan
 * each tag once, and insert addresses with replacer functions (a `$&` in a URL stays literal). The `data-am-*` attributes never leave the browser: the outgoing sanitiser drops every `data-*` attribute.
 */

/**
 * An empty SVG with no size of its own: the placeholder takes the image's width and height attributes (and their
 * aspect ratio), else the CSS minimum. A raster pixel would force a square.
 */
export const PLACEHOLDER_SRC = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

const IMG_TAG = /<img\b[^>]*>/gi;
/** Any start tag (one linear scan; attributes are then looked up inside the matched tag). */
const START_TAG = /<[a-z][a-z0-9]*\b[^>]*>/gi;
const SRC_ATTR = /\ssrc="([^"]*)"/i;
const STYLE_ATTR = /\sstyle="([^"]*)"/i;
const PARKED_SRC = /\sdata-am-src="([^"]*)"/i;
const PARKED_STYLE = /\sdata-am-style="([^"]*)"/i;
const BLOCKED_ATTR = /\sdata-am-blocked="[^"]*"/i;
/** A `url(…)` that isn't an embedded data image (its quotes may be escaped as `&quot;`). */
const REMOTE_URL = /url\((?!\s*(?:&quot;|["'])?\s*data:)[^)]*\)/gi;

/** Shows `html` without loading anything remote (see the module comment). */
export function parkRemoteImages(html: string): string {
  const imgs = html.replace(IMG_TAG, (tag) => {
    const src = SRC_ATTR.exec(tag)?.[1];
    if (src === undefined || /^data:/i.test(src.trim()) || PARKED_SRC.test(tag)) return tag;
    return tag.replace(SRC_ATTR, () => ` src="${PLACEHOLDER_SRC}" data-am-src="${src}" data-am-blocked="1"`);
  });
  return imgs.replace(START_TAG, (tag) => {
    const style = STYLE_ATTR.exec(tag)?.[1];
    if (style === undefined || PARKED_STYLE.test(tag)) return tag;
    const shown = style.replace(REMOTE_URL, "none");
    if (shown === style) return tag;
    return tag.replace(STYLE_ATTR, () => ` style="${shown}" data-am-style="${style}"`);
  });
}

/** Puts parked images and styles back, for saving and sending. */
export function unparkRemoteImages(html: string): string {
  const imgs = html.replace(IMG_TAG, (tag) => {
    const src = PARKED_SRC.exec(tag)?.[1];
    if (src === undefined) return tag;
    const bare = tag.replace(PARKED_SRC, "").replace(BLOCKED_ATTR, "");
    return SRC_ATTR.test(bare)
      ? bare.replace(SRC_ATTR, () => ` src="${src}"`)
      : bare.replace(/^<img\b/i, () => `<img src="${src}"`);
  });
  return imgs.replace(START_TAG, (tag) => {
    const style = PARKED_STYLE.exec(tag)?.[1];
    if (style === undefined) return tag;
    const bare = tag.replace(PARKED_STYLE, "");
    return STYLE_ATTR.test(bare)
      ? bare.replace(STYLE_ATTR, () => ` style="${style}"`)
      : bare.replace(/^<([a-z][a-z0-9]*)\b/i, (_m, name: string) => `<${name} style="${style}"`);
  });
}

// ---- reading: images loaded through the image proxy -----------------------------------------------------------

/**
 * Remote images while reading (docs/internal/05-webmail.md "Remote images"): the server's sanitiser leaves each
 * blocked image as a placeholder with a signed image link (`data-am-img`) and no address. "Load images" sends each
 * link to the image proxy and puts the answer back as a `data:` image, so the message frame (no scripts, opaque
 * origin, `img-src data:`) still makes no request of its own.
 */

/** Raster types the image proxy serves; anything else is never put into the frame. */
const LOADED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
export const isLoadedImageType = (type: string): boolean => LOADED_TYPES.has(type);

const LINK_ATTR = /\sdata-am-img="([A-Za-z0-9._-]+)"/;
const LOADED_URL = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/]*={0,2}$/;

/** The image links in sanitised message HTML, each once, in order. */
export function imageLinks(html: string): string[] {
  const out = new Set<string>();
  for (const tag of html.match(IMG_TAG) ?? []) {
    const link = LINK_ATTR.exec(tag)?.[1];
    if (link) out.add(link);
  }
  return [...out];
}

/** The HTML with every loaded link's placeholder turned into its image (others stay blocked). */
export function withLoadedImages(html: string, loaded: ReadonlyMap<string, string>): string {
  if (loaded.size === 0) return html;
  return html.replace(IMG_TAG, (tag) => {
    const link = LINK_ATTR.exec(tag)?.[1];
    const url = link ? loaded.get(link) : undefined;
    if (url === undefined || !LOADED_URL.test(url)) return tag;
    const bare = tag.replace(BLOCKED_ATTR, "").replace(LINK_ATTR, "").replace(SRC_ATTR, "");
    return bare.replace(/^<img\b/i, () => `<img src="${url}"`);
  });
}

export type ImagePolicy = {
  mode: "ask" | "contacts" | "always";
  /** Remembered senders' keys (the `imageSenders` preference). */
  senders: readonly string[];
};

/** Whether a message's images load without asking: always, a remembered sender, or (if chosen) a contact. */
export function loadsWithoutAsking(
  policy: ImagePolicy,
  senderKey: string | null,
  from: string | undefined,
  contacts: ReadonlySet<string>,
  verified = false,
): boolean {
  if (policy.mode === "always") return true;
  // The server sends a sender key only for a verified From.
  if (senderKey !== null && policy.senders.includes(senderKey)) return true;
  return policy.mode === "contacts" && verified && from !== undefined && contacts.has(from.toLowerCase());
}

/**
 * What "Load images" can offer about remembering the sender:
 * - `choose`: a verified sender not yet remembered — ask "Just this once" or "Always for <sender>";
 * - `remembered`: already remembered — load, and offer "Stop loading from this sender" afterwards;
 * - `unverified`: the From isn't verified (no sender key), so it can't be remembered — load once and say why
 *   (`domain` is the From address's domain, or null when there is none);
 * - `none`: nothing to remember (no image settings here, every message's images load anyway, or the message is the
 *   person's own: it sits in their Sent folder, so there is no sender to confirm or remember).
 */
export type RememberOffer =
  | { kind: "choose"; sender: string }
  | { kind: "remembered" }
  | { kind: "unverified"; domain: string | null }
  | { kind: "none" };

/** Direction controls and zero-width characters: they can reorder or hide parts of an address on screen. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * A domain as the notice shows it: invisible characters removed and, when it isn't plain ASCII, its `xn--` form, so a
 * lookalike (a Cyrillic "а" for "a") can't pass for a familiar name.
 */
export function shownDomain(domain: string): string {
  const clean = domain.replace(INVISIBLE, "").toLowerCase();
  if (/^[\x21-\x7e]*$/.test(clean)) return clean;
  try {
    return new URL(`http://${clean}`).hostname;
  } catch {
    return clean;
  }
}

/** An address as the notice shows it: the domain through `shownDomain`, invisible characters removed. */
export function shownAddress(address: string): string {
  const at = address.lastIndexOf("@");
  const local = (at > 0 ? address.slice(0, at) : address).replace(INVISIBLE, "");
  return at > 0 ? `${local}@${shownDomain(address.slice(at + 1))}` : local;
}

/**
 * `own` is true for a message in the mailbox's Sent folder (decided from its mailbox, never from the From address,
 * which anyone can forge into an inbox): its images still wait for "Load images", but nothing is said or remembered.
 */
export function rememberOffer(
  policy: ImagePolicy | undefined,
  senderKey: string | null,
  from: string | undefined,
  own = false,
): RememberOffer {
  if (policy === undefined || own) return { kind: "none" };
  if (senderKey !== null) {
    if (policy.senders.includes(senderKey)) return { kind: "remembered" };
    return from ? { kind: "choose", sender: shownAddress(from) } : { kind: "none" };
  }
  if (policy.mode === "always") return { kind: "none" };
  const at = from?.lastIndexOf("@") ?? -1;
  const domain = from !== undefined && at > 0 && at < from.length - 1 ? shownDomain(from.slice(at + 1)) : null;
  return { kind: "unverified", domain };
}
