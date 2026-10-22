// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Renders server-sanitised message HTML in a sandboxed `srcdoc` frame (docs/internal/05-webmail.md "Rendering
 * safety", CLAUDE.md rule 29):
 *
 * - `sandbox` without `allow-scripts` and without `allow-same-origin`: no script runs, and the frame is an opaque
 *   origin that can't read this page, its cookies or storage. `allow-popups(-to-escape-sandbox)` only lets links
 *   (already `target=_blank rel=noopener noreferrer`) open as normal tabs.
 * - Its own CSP: nothing loads except `data:` images and inline styles; the page's CSP is inherited on top.
 * - No referrer, light colour scheme (mail is designed on white), system colours instead of hard-coded ones.
 */
const FRAME_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

const FRAME_STYLE = `
html { color-scheme: light; background: Canvas; color: CanvasText; }
body { margin: 0; padding: 4px 2px 16px; font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
img[data-am-blocked] { display: inline-block; min-width: 24px; min-height: 24px; vertical-align: middle;
  background: repeating-linear-gradient(135deg, rgb(0 0 0 / 0.035) 0 8px, rgb(0 0 0 / 0.07) 8px 16px);
  outline: 1px dashed rgb(0 0 0 / 0.2); outline-offset: -1px; color: GrayText; font-size: 12px; }
table { max-width: 100%; }
pre { white-space: pre-wrap; }
blockquote { margin: 0 0 0 0.25em; padding-left: 1em; border-left: 3px solid rgb(0 0 0 / 0.12); }
a { color: LinkText; }
[data-am-sig] { opacity: 0.6; }
details[data-am-quote] > summary { list-style: none; display: inline-flex; align-items: center; justify-content: center;
  width: 2.25rem; height: 1.25rem; border-radius: 6px; background: rgb(0 0 0 / 0.07); color: rgb(0 0 0 / 0.6);
  cursor: pointer; font-size: 12px; letter-spacing: 1px; user-select: none; }
details[data-am-quote] > summary::-webkit-details-marker { display: none; }
details[data-am-quote][open] > summary { margin-bottom: 8px; }
`;

export function frameDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light"><style>${FRAME_STYLE}</style></head><body>${html}</body></html>`;
}

/**
 * The frame can't report its content height (no scripts, no same-origin: the parent can't read it), so it takes the
 * reading pane's height: the reader's header and attachments scroll away above it and the message then fills the
 * pane, scrolling inside. True auto-height is an open maintainer decision (05-webmail.md "Reading").
 */
export function MessageFrame({ html, title, height }: { html: string; title: string; height: number }) {
  return (
    <iframe
      title={title}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={frameDocument(html)}
      referrerPolicy="no-referrer"
      style={{ height }}
      className="block w-full shrink-0 rounded-lg"
    />
  );
}
