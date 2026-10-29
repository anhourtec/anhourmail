// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { outgoingText, sanitizeOutgoingHtml } from "@/server/webmail/outgoing-html";
import { sanitizeMessageHtml } from "@/server/webmail/sanitize";

import {
  escapeHtml,
  hasFormatting,
  linkUrl,
  MAX_QUOTE_HTML,
  quoteHtml,
  removedSummary,
  SIGNATURE_ATTR,
  signatureHtml,
  textToHtml,
} from "./rich-text";

const a = (email: string, name: string | null = null) => ({ email, name });
const msg = {
  from: [a("sam@x.test", "Sam <boss>")],
  to: [a("me@x.test")],
  cc: [],
  subject: "Hi <b>",
  receivedAt: "2026-10-20T10:00:00Z",
  quote: "line one\n<script>x</script>",
  html: "<p>Rich <b>original</b></p>",
};

describe("rich-text helpers", () => {
  it("escapes text and keeps line breaks", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(textToHtml("a\n<b>\r\nc")).toBe("a<br>&lt;b&gt;<br>c");
  });

  it("builds a marked signature block from escaped text", () => {
    expect(signatureHtml(undefined)).toBe("");
    expect(signatureHtml("  ")).toBe("");
    const s = signatureHtml("Sam\n<img src=x onerror=alert(1)>");
    expect(s).toContain(`${SIGNATURE_ATTR}="1"`);
    expect(s).toContain("-- <br>Sam<br>&lt;img");
    expect(s).not.toContain("<img");
  });

  it("quotes a reply's HTML in a blockquote under an escaped header", () => {
    const q = quoteHtml(msg, "reply");
    expect(q).toContain("Sam &lt;boss&gt; &lt;sam@x.test&gt; wrote:");
    expect(q).toContain("<blockquote");
    expect(q).toContain("<p>Rich <b>original</b></p>");
    expect(sanitizeOutgoingHtml(q).html).toContain('<blockquote type="cite" style=');
  });

  it('sends a quote that readers fold and a text part with "> " lines', () => {
    const sent = sanitizeOutgoingHtml(`<div>Sounds good</div>${quoteHtml(msg, "reply")}`).html;
    // Our reading view (and other mail apps) fold `blockquote type=cite`.
    expect(sanitizeMessageHtml(sent).html).toMatch(/<details[^>]*data-am-quote="1"/);
    const text = outgoingText(sent);
    expect(text).toMatch(/^Sounds good\n\nOn .+, Sam <boss> <sam@x\.test> wrote:\n> Rich original$/);
  });

  it("quotes the text when there is no HTML or it is too long", () => {
    expect(quoteHtml({ ...msg, html: null }, "reply")).toContain("line one<br>&lt;script&gt;x&lt;/script&gt;");
    expect(quoteHtml({ ...msg, html: "x".repeat(MAX_QUOTE_HTML + 1) }, "reply")).toContain("line one");
  });

  it("builds a forward header", () => {
    const f = quoteHtml({ ...msg, cc: [a("c@x.test")] }, "forward");
    expect(f).toContain("---------- Forwarded message ----------");
    expect(f).toContain("Subject: Hi &lt;b&gt;");
    expect(f).toContain("Cc: c@x.test");
    expect(quoteHtml(msg, "new")).toBe("");
  });

  it.each([
    ["https://example.com/a?b=c", "https://example.com/a?b=c"],
    ["http://example.com", "http://example.com/"],
    ["example.com/path", "https://example.com/path"],
    ["sam@example.com", "mailto:sam@example.com"],
    ["mailto:sam@example.com", "mailto:sam@example.com"],
    ["tel:+1 555", null],
    ["tel:+1555123", "tel:+1555123"],
    ["javascript:alert(1)", null],
    ["JavaScript:alert(1)", null],
    ["data:text/html,x", null],
    ["ftp://example.com", null],
    ["/relative", null],
    ["intranet", null],
    ["https://exa mple.com", null],
    ['https://example.com/"onmouseover', null],
    ["", null],
  ])("validates link %s", (input, out) => {
    expect(linkUrl(input)).toBe(out);
  });

  it("summarises what the sanitiser removed in plain words", () => {
    expect(removedSummary(sanitizeOutgoingHtml("<p>ok</p>"))).toEqual([]);
    const r = sanitizeOutgoingHtml(
      '<script>x</script><p onclick="x" class="c" style="position:fixed">a</p><form><input></form><iframe></iframe>' +
        '<style>p{}</style><svg></svg><a href="javascript:x">l</a><img src="http://x/a.png"><x-bar>t</x-bar>',
    );
    expect(removedSummary(r)).toEqual([
      "Scripts",
      "Event handlers (on… attributes)",
      "Forms and form fields",
      "Embedded frames and objects",
      "Style sheets (inline styles are kept)",
      "SVG and MathML",
      "Links that weren't http, https, mailto or tel",
      "Images that weren't https or embedded",
      "Unsupported styles (position)",
      "Other elements, text kept (x-bar)",
      "Other attributes (class)",
    ]);
  });

  it("knows when switching to plain text would lose formatting", () => {
    expect(hasFormatting("<div>Hi</div><div><br /></div><p>there</p>")).toBe(false);
    expect(hasFormatting("")).toBe(false);
    expect(hasFormatting("<div>Hi <b>you</b></div>")).toBe(true);
    expect(hasFormatting('<a href="https://x.test">x</a>')).toBe(true);
    expect(hasFormatting('<blockquote type="cite">q</blockquote>')).toBe(true);
    expect(hasFormatting("<ul><li>a</li></ul>")).toBe(true);
  });

  it("counts the toolbar's styles as formatting, a styled line included", () => {
    expect(hasFormatting('<div style="text-align: center">Hi</div>')).toBe(true);
    expect(hasFormatting('<p align="right">Hi</p>')).toBe(true);
    expect(hasFormatting('<div><span style="color: rgb(220, 38, 38)">red</span></div>')).toBe(true);
    expect(hasFormatting('<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px">in</blockquote>')).toBe(
      true,
    );
    expect(hasFormatting("<div><s>old</s></div>")).toBe(true);
    expect(hasFormatting('<div title="style=x">Hi</div>')).toBe(false);
  });
});
