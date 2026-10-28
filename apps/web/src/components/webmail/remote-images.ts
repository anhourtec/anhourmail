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
 * Both work on outgoing-sanitiser output or the editor's `innerHTML` (attributes double-quoted, `"` escaped), and are
 * linear. The `data-am-*` attributes never leave the browser: the outgoing sanitiser drops every `data-*` attribute.
 */

/** A transparent 1×1 GIF: the placeholder's size comes from the image's own width and height, else from CSS. */
export const PLACEHOLDER_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const IMG_TAG = /<img\b[^>]*>/gi;
const STYLED_TAG = /<[a-z][a-z0-9]*\b[^>]*\sstyle="[^"]*"[^>]*>/gi;
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
    return tag.replace(SRC_ATTR, ` src="${PLACEHOLDER_SRC}" data-am-src="${src}" data-am-blocked="1"`);
  });
  return imgs.replace(STYLED_TAG, (tag) => {
    const style = STYLE_ATTR.exec(tag)?.[1];
    if (style === undefined || PARKED_STYLE.test(tag)) return tag;
    const shown = style.replace(REMOTE_URL, "none");
    if (shown === style) return tag;
    return tag.replace(STYLE_ATTR, ` style="${shown}" data-am-style="${style}"`);
  });
}

/** Puts parked images and styles back, for saving and sending. */
export function unparkRemoteImages(html: string): string {
  const imgs = html.replace(IMG_TAG, (tag) => {
    const src = PARKED_SRC.exec(tag)?.[1];
    if (src === undefined) return tag;
    const bare = tag.replace(PARKED_SRC, "").replace(BLOCKED_ATTR, "");
    return SRC_ATTR.test(bare)
      ? bare.replace(SRC_ATTR, ` src="${src}"`)
      : bare.replace(/^<img\b/i, `<img src="${src}"`);
  });
  return imgs.replace(/<[a-z][a-z0-9]*\b[^>]*\sdata-am-style="[^"]*"[^>]*>/gi, (tag) => {
    const style = PARKED_STYLE.exec(tag)?.[1] ?? "";
    const bare = tag.replace(PARKED_STYLE, "");
    return STYLE_ATTR.test(bare)
      ? bare.replace(STYLE_ATTR, ` style="${style}"`)
      : bare.replace(/^<([a-z][a-z0-9]*)\b/i, `<$1 style="${style}"`);
  });
}
