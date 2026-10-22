// SPDX-License-Identifier: AGPL-3.0-only
import type { MdBlock, MdInline } from "./body";
import type { Address, MessageView } from "./view";

/**
 * A printable page for one message (`GET /api/webmail/messages/:id/print`). Headers and text are escaped here; an
 * HTML body is the same server-sanitised fragment the reader frames. The response is served with a sandboxing CSP
 * (`sandbox`, no scripts, no remote loads), so the page is an opaque origin exactly like the reader's frame.
 */
export const PRINT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const who = (list: Address[]) => list.map((a) => escapeHtml(a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");

function inline(nodes: MdInline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return escapeHtml(n.v);
        case "code":
          return `<code>${escapeHtml(n.v)}</code>`;
        case "br":
          return "<br>";
        case "link":
          return `${inline(n.c)} (${escapeHtml(n.href)})`;
        default:
          return `<${n.t === "strong" ? "strong" : n.t === "em" ? "em" : "del"}>${inline(n.c)}</${n.t === "strong" ? "strong" : n.t === "em" ? "em" : "del"}>`;
      }
    })
    .join("");
}

function blocks(nodes: MdBlock[]): string {
  return nodes
    .map((b) => {
      switch (b.t) {
        case "h":
          return `<h${String(b.level)}>${inline(b.c)}</h${String(b.level)}>`;
        case "p":
          return `<p>${inline(b.c)}</p>`;
        case "list": {
          const tag = b.ordered ? "ol" : "ul";
          return `<${tag}>${b.items.map((it) => `<li>${blocks(it)}</li>`).join("")}</${tag}>`;
        }
        case "quote":
          return `<blockquote>${blocks(b.c)}</blockquote>`;
        case "code":
          return `<pre>${escapeHtml(b.v)}</pre>`;
        default:
          return "<hr>";
      }
    })
    .join("");
}

/** The whole printable document. */
export function printDocument(m: MessageView): string {
  const date = new Date(m.sentAt ?? m.receivedAt).toUTCString();
  let body: string;
  if (m.html !== null) body = m.html;
  else if (m.markdown) body = blocks(m.markdown);
  else body = `<div class="text">${escapeHtml(m.text ?? "")}</div>`;
  const events = m.events
    .map(
      (e) =>
        `<div class="event"><strong>${escapeHtml(e.summary || "Event")}</strong><br>${escapeHtml(
          [e.start, e.end].filter(Boolean).join(" – ") + (e.timeZone ? ` (${e.timeZone})` : ""),
        )}${e.location ? `<br>${escapeHtml(e.location)}` : ""}</div>`,
    )
    .join("");
  const attachments = m.attachments.length
    ? `<p class="meta">Attachments: ${m.attachments.map((a) => escapeHtml(a.name)).join(", ")}</p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escapeHtml(
    m.subject || "(no subject)",
  )}</title><style>
html { color-scheme: light; }
body { font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 24px auto; max-width: 760px; padding: 0 16px; color: CanvasText; background: Canvas; }
h1.subject { font-size: 20px; font-weight: 500; margin: 0 0 8px; }
.meta { color: rgb(0 0 0 / 0.62); font-size: 12.5px; margin: 2px 0; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.event { border: 1px solid rgb(0 0 0 / 0.2); border-radius: 8px; padding: 10px 12px; margin: 12px 0; }
hr.rule { border: 0; border-top: 1px solid rgb(0 0 0 / 0.15); margin: 16px 0; }
img { max-width: 100%; height: auto; }
img[data-am-blocked] { display: none; }
details > summary { display: none; }
details { display: block; }
.hint { color: rgb(0 0 0 / 0.5); font-size: 12px; margin-bottom: 16px; }
@media print { .hint { display: none; } }
</style></head><body>
<p class="hint">Use your browser's Print command (Ctrl+P or ⌘P) to print this message.</p>
<h1 class="subject">${escapeHtml(m.subject || "(no subject)")}</h1>
<p class="meta">From: ${who(m.from)}</p>
<p class="meta">To: ${who(m.to)}</p>
${m.cc.length ? `<p class="meta">Cc: ${who(m.cc)}</p>` : ""}
<p class="meta">Date: ${escapeHtml(date)}</p>
${attachments}
<hr class="rule">
${events}
${body}
</body></html>`;
}
