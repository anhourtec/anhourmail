// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  cleanOutgoingCss,
  fontAttribute,
  isIndentBlock,
  isSafeColor,
  isSafeFontFamily,
  isSafeFontSize,
  MAX_DATA_IMAGE_BYTES,
  MAX_OUTGOING_HTML,
  MAX_OUTGOING_STYLE,
  MAX_QUOTE_PREFIX,
  outgoingText,
  sanitizeOutgoingHtml,
  STRICT_CSS,
} from "./outgoing-html";

const clean = (html: string) => sanitizeOutgoingHtml(html).html;

/** Anything that could run script, submit data, frame content or reach outside the message. */
const DANGER =
  /<script|<style|<iframe|<frame|<object|<embed|<applet|<svg|<math|<form|<input|<button|<textarea|<select|<base|<meta|<link|<template|<noscript|\son[a-z]+\s*=|javascript:|vbscript:|data:text|expression\(|behavior|-moz-binding|@import|srcdoc|formaction|xlink:href|position:\s*(?:fixed|absolute)/i;

const CORPUS: [name: string, html: string][] = [
  ["script tag", `<p>hi</p><script>alert(1)</script>`],
  ["uppercase script", `<SCRIPT>alert(1)</SCRIPT>`],
  ["split script", `<scr<script>ipt>alert(1)</script>`],
  ["img onerror", `<img src=x onerror="alert(1)">`],
  ["img onerror on valid image", `<img src="https://img.example/a.png" onerror="alert(1)">`],
  ["body onload", `<body onload="alert(1)"><p>x</p></body>`],
  ["div onclick", `<div onclick="alert(1)" onmouseover=alert(1)>x</div>`],
  ["svg onload", `<svg onload="alert(1)"><circle r="1"/></svg>`],
  ["svg script", `<svg><script>alert(1)</script></svg>`],
  ["svg animate href", `<svg><a><animate attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>`],
  ["math mutation", `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`],
  ["javascript href", `<a href="javascript:alert(1)">x</a>`],
  ["javascript href uppercase", `<a href="JaVaScRiPt:alert(1)">x</a>`],
  ["javascript href entity", `<a href="jav&#x61;script:alert(1)">x</a>`],
  ["javascript href decimal entities", `<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:alert(1)">x</a>`],
  ["javascript href named entity colon", `<a href="javascript&colon;alert(1)">x</a>`],
  ["javascript href leading space", `<a href=" javascript:alert(1)">x</a>`],
  ["javascript href tab", `<a href="java\tscript:alert(1)">x</a>`],
  ["javascript href newline entity", `<a href="java&#10;script:alert(1)">x</a>`],
  ["javascript href control char", `<a href="\u0001javascript:alert(1)">x</a>`],
  ["vbscript href", `<a href="vbscript:msgbox(1)">x</a>`],
  ["data html href", `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`],
  ["data html img", `<img src="data:text/html,<script>alert(1)</script>">`],
  ["data svg img", `<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">`],
  ["javascript img", `<img src="javascript:alert(1)">`],
  ["iframe", `<iframe src="https://evil.example"></iframe>`],
  ["iframe srcdoc", `<iframe srcdoc="<script>alert(1)</script>"></iframe>`],
  ["srcdoc on div", `<div srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">x</div>`],
  ["frameset", `<frameset><frame src="https://evil.example"></frameset>`],
  ["object", `<object data="https://evil.example/x.swf"></object>`],
  ["embed", `<embed src="https://evil.example/x">`],
  ["applet", `<applet code="x.class"></applet>`],
  ["form", `<form action="https://evil.example"><input name="password"><button>Go</button></form>`],
  ["button formaction", `<button formaction="javascript:alert(1)">x</button>`],
  ["input formaction", `<input type="submit" formaction="javascript:alert(1)">`],
  ["textarea breakout", `<textarea></textarea><script>alert(1)</script></textarea>`],
  ["select", `<select><option>a</option></select>`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`],
  ["base tag", `<base href="javascript:alert(1)//"><a href="/x">x</a>`],
  ["link stylesheet", `<link rel="stylesheet" href="https://evil.example/x.css">`],
  ["style import", `<style>@import url(https://evil.example/x.css);</style><p>x</p>`],
  ["style block breakout", `<style></style><script>alert(1)</script></style>`],
  ["template", `<template><script>alert(1)</script></template>`],
  ["noscript mutation", `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`],
  ["comment breakout", `<!--<img src=x onerror=alert(1)>--><p>x</p>`],
  ["conditional comment", `<!--[if IE]><script>alert(1)</script><![endif]--><p>x</p>`],
  ["cdata", `<p><![CDATA[<img src=x onerror=alert(1)>]]></p>`],
  ["css expression", `<div style="width: expression(alert(1))">x</div>`],
  ["css javascript url", `<div style="background:url(javascript:alert(1))">x</div>`],
  ["css escaped url", `<div style="background:\\75 rl(javascript:alert(1))">x</div>`],
  ["css escaped expression", `<div style="width:\\65 xpression(alert(1))">x</div>`],
  ["css comment split", `<div style="width:expr/**/ession(alert(1))">x</div>`],
  ["css behavior", `<div style="behavior: url(x.htc)">x</div>`],
  ["css moz-binding", `<div style="-moz-binding: url(https://evil.example/x.xml#x)">x</div>`],
  ["css import in attribute", `<div style="@import 'https://evil.example/x.css'; color: red">x</div>`],
  ["css position fixed", `<div style="position: fixed; top: 0">x</div>`],
  ["css position absolute", `<div style="position:absolute">x</div>`],
  ["css quote breakout", `<div style="font-family: 'a; position: fixed'">x</div>`],
  ["xlink", `<a xlink:href="javascript:alert(1)">x</a>`],
  ["attribute breakout", `<a title='"><script>alert(1)</script>'>x</a>`],
  ["nested form in table", `<table><tr><td><form><input></form></td></tr></table>`],
  ["custom element", `<x-toolbar onclick="alert(1)"><script>alert(1)</script>Toolbar</x-toolbar>`],
]; // prettier-ignore

describe("sanitizeOutgoingHtml: XSS corpus", () => {
  it.each(CORPUS)("removes everything dangerous: %s", (_name, html) => {
    expect(clean(html)).not.toMatch(DANGER);
  });

  it("is idempotent on the corpus", () => {
    for (const [, html] of CORPUS) {
      const once = clean(html);
      expect(clean(once)).toBe(once);
    }
  });
});

describe("sanitizeOutgoingHtml: what is kept", () => {
  it("keeps structural and text formatting", () => {
    const html =
      "<h1>T</h1><p><b>b</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u> <s>x</s> <small>m</small> <sup>1</sup><sub>2</sub></p>" +
      "<ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><pre><code>c</code></pre><hr /><center>c</center>" +
      '<font color="red" face="Arial" size="2">f</font>';
    expect(clean(html)).toBe(html);
  });

  it("keeps tables with their layout attributes", () => {
    const html =
      '<table border="0" cellpadding="4" cellspacing="0" width="600" align="center" bgcolor="#ffffff">' +
      '<caption>c</caption><colgroup span="2"><col span="1" width="50%" /></colgroup>' +
      '<thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td rowspan="2" valign="top" dir="rtl" lang="ar">d</td></tr></tbody>' +
      "<tfoot><tr><td>f</td></tr></tfoot></table>";
    expect(clean(html)).toBe(html);
  });

  it("forces links to open in a new tab without a referrer", () => {
    expect(clean('<a href="https://example.com" target="_self" rel="opener">x</a>')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it.each(["http://example.com/", "https://example.com/a?b=c", "mailto:a@example.com", "tel:+15551234567"])(
    "keeps a %s link",
    (href) => {
      expect(clean(`<a href="${href}">x</a>`)).toContain(`href="${href}"`);
    },
  );

  it.each(["/relative", "#top", "//evil.example/x", "ftp://example.com", "file:///etc/passwd", "sms:123"])(
    "removes a %s link but keeps its text",
    (href) => {
      const r = sanitizeOutgoingHtml(`<a href="${href}">x</a>`);
      expect(r.html).not.toContain("href");
      expect(r.html).toContain(">x</a>");
      expect(r.removedAttributes).toContain("href");
    },
  );

  it("keeps https, cid and raster data images and counts remote ones", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const r = sanitizeOutgoingHtml(
      `<img src="https://img.example/a.png" alt="a" width="10" height="10" border="0"><img src="cid:logo@x"><img src="${png}">`,
    );
    expect(r.html).toBe(
      `<img alt="a" width="10" height="10" border="0" src="https://img.example/a.png" /><img src="cid:logo@x" /><img src="${png}" />`,
    );
    expect(r.remoteImages).toBe(1);
  });

  it.each([
    "http://img.example/a.png",
    "//img.example/a.png",
    "data:image/bmp;base64,AAAA",
    "data:image/png,notbase64",
    "relative.png",
  ])("drops an image with source %s", (src) => {
    const r = sanitizeOutgoingHtml(`<p>a<img src="${src}">b</p>`);
    expect(r.html).toBe("<p>ab</p>");
    expect(r.removedAttributes).toContain("src");
  });

  it("drops a data image over the size cap", () => {
    const big = `data:image/png;base64,${"A".repeat(MAX_DATA_IMAGE_BYTES)}`;
    expect(clean(`<img src="${big}">`)).toBe("");
  });

  it("unwraps unknown elements, keeping their text, and reports them", () => {
    const r = sanitizeOutgoingHtml(
      '<grammar-toolbar data-x="1"><span>Hello</span></grammar-toolbar> <article>a</article>',
    );
    expect(r.html).toBe("<span>Hello</span> a");
    expect(r.removedTags).toEqual(["article", "grammar-toolbar"]);
  });

  it("drops script, style, forms and frames with their content and reports them", () => {
    const r = sanitizeOutgoingHtml(
      "<html><head><title>T</title><style>p{}</style></head><body><p>hi</p><script>x</script><form><button>Go</button></form></body></html>",
    );
    expect(r.html).toBe("<p>hi</p>");
    expect(r.removedTags).toEqual(["button", "form", "head", "script", "style", "title"]);
  });

  it("turns the reading view's quote toggle back into a quote, without its label", () => {
    const r = sanitizeOutgoingHtml(
      '<details data-am-quote="1"><summary title="Show quoted text">&#8226;&#8226;&#8226;</summary><p>old</p></details>',
    );
    expect(r.html).toBe('<blockquote type="cite"><p>old</p></blockquote>');
    expect(r.removedTags).toEqual(["summary"]);
    // Any other details element is unwrapped, its text kept.
    expect(clean("<details open><p>x</p></details>")).toBe("<p>x</p>");
  });

  it("keeps type=cite on a quote (folded by mail apps) and drops any other type", () => {
    expect(clean('<blockquote type="CITE" style="margin: 0">q</blockquote>')).toBe(
      '<blockquote type="cite" style="margin: 0">q</blockquote>',
    );
    const r = sanitizeOutgoingHtml('<blockquote type="x-evil">q</blockquote><p type="cite">p</p>');
    expect(r.html).toBe("<blockquote>q</blockquote><p>p</p>");
    expect(r.removedAttributes).toEqual(["type"]);
  });

  it("reports removed attributes", () => {
    const r = sanitizeOutgoingHtml('<p class="c" id="i" onclick="x" data-track="1">x</p>');
    expect(r.html).toBe("<p>x</p>");
    expect(r.removedAttributes).toEqual(["class", "data-track", "id", "onclick"]);
  });

  it("returns nothing for input over the cap", () => {
    const r = sanitizeOutgoingHtml("a".repeat(MAX_OUTGOING_HTML + 1));
    expect(r).toEqual({
      html: "",
      tooLarge: true,
      removedTags: [],
      removedAttributes: [],
      remoteImages: 0,
      embeddedImages: 0,
      oversizedImages: 0,
    });
  });

  it("escapes text that looks like markup", () => {
    expect(clean("<p>1 &lt; 2 &amp; &lt;script&gt;</p>")).toBe("<p>1 &lt; 2 &amp; &lt;script&gt;</p>");
  });
});

describe("cleanOutgoingCss", () => {
  it("keeps allow-listed properties", () => {
    expect(cleanOutgoingCss("color: #333; font-size: 14px; margin: 0 auto; border: 1px solid #ccc").css).toBe(
      "color: #333; font-size: 14px; margin: 0 auto; border: 1px solid #ccc",
    );
  });

  it("drops unknown properties and names them", () => {
    expect(cleanOutgoingCss("color: red; z-index: 9; top: 0; content: 'x'")).toEqual({
      css: "color: red",
      dropped: ["style:z-index", "style:top", "style:content"],
    });
  });

  it("keeps https and raster data backgrounds and counts remote ones", () => {
    const counter = { remote: 0 };
    const { css } = cleanOutgoingCss(
      "background-image: url('https://img.example/a.png'); background: url(data:image/gif;base64,R0lGOD==)",
      counter,
    );
    expect(css).toBe(
      "background-image: url('https://img.example/a.png'); background: url(data:image/gif;base64,R0lGOD==)",
    );
    expect(counter.remote).toBe(1);
  });

  it.each([
    "background: url(http://img.example/a.png)",
    "background: url(//img.example/a.png)",
    "background: url(javascript:alert(1))",
    "background: url(data:image/svg+xml;base64,AAAA)",
    "background: url(https://a.example/x.png",
    "background: url('https://a.example/x.png' x)",
    "background: image-set('https://a.example/x.png' 1x)",
    "width: expression(alert(1))",
    "behavior: url(x.htc)",
    "-moz-binding: url(x)",
    "position: fixed",
    "position: absolute",
    "position: sticky",
    "font-family: 'a",
    "color: red}body{color:blue",
    "color: <b>",
    "color",
  ])("drops %s", (css) => {
    expect(cleanOutgoingCss(css).css).toBe("");
  });

  it("keeps the safe declarations next to a dropped one", () => {
    expect(cleanOutgoingCss("color: red; position: fixed").css).toBe("color: red");
    expect(cleanOutgoingCss("font-family: 'a; b'; position: fixed; color: red").css).toBe("color: red");
  });

  it("decodes escapes and comments before checking", () => {
    expect(cleanOutgoingCss("width:\\65 xpression(alert(1))").css).toBe("");
    expect(cleanOutgoingCss("pos/**/ition: fixed").css).toBe("");
    expect(cleanOutgoingCss("position: relative").css).toBe("position: relative");
  });

  it("drops a style attribute over the cap", () => {
    expect(cleanOutgoingCss(`color: red;${" ".repeat(MAX_OUTGOING_STYLE)}`)).toEqual({ css: "", dropped: ["style"] });
  });
});

describe("outgoingText", () => {
  it("turns blocks, lists, tables and links into readable text", () => {
    const html = clean(
      '<h1>Title</h1><p>Hi <b>there</b>,<br>see <a href="https://example.com/a?x=1&amp;y=2">the page</a> or <a href="mailto:a@example.com">a@example.com</a>.</p>' +
        "<ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table><p>1 &lt; 2 &amp; 3&nbsp;4</p>",
    );
    expect(outgoingText(html)).toBe(
      "Title\n\nHi there,\nsee the page (https://example.com/a?x=1&y=2) or a@example.com.\n\n- one\n- two\n\na\tb\n\n1 < 2 & 3 4",
    );
  });

  it("uses the address when a link has no text", () => {
    expect(outgoingText(clean('<a href="https://example.com"></a>'))).toBe("https://example.com");
  });

  it("decodes entities only once", () => {
    expect(outgoingText("<p>&amp;lt;b&amp;gt;</p>")).toBe("&lt;b&gt;");
  });

  it('quotes a reply\'s original with "> " per level, after its "On … wrote:" line', () => {
    const html = clean(
      "<div>Thanks!</div><div><br></div><div>On Mon, Oct 27, 2026, Sam &lt;sam@x.test&gt; wrote:</div>" +
        '<blockquote type="cite" style="margin: 0 0 0 0.8ex"><p>First line<br>second line</p><p></p>' +
        '<blockquote type="cite"><div>older</div></blockquote><p>after</p></blockquote><div>-- <br>Me</div>',
    );
    expect(outgoingText(html)).toBe(
      [
        "Thanks!",
        "",
        "On Mon, Oct 27, 2026, Sam <sam@x.test> wrote:",
        "> First line",
        "> second line",
        ">> older",
        "> after",
        "",
        "-- ",
        "Me",
      ]
        .join("\n")
        .replace("-- \n", "--\n"),
    );
  });

  it("caps the quote prefix, so deeply nested quotes can't blow up the text part", () => {
    const depth = 5000;
    const html = `${"<blockquote>x".repeat(depth)}${"</blockquote>".repeat(depth)}`;
    const text = outgoingText(html);
    const lines = text.split("\n");
    expect(lines).toHaveLength(depth);
    expect(lines.at(-1)).toBe(`${">".repeat(MAX_QUOTE_PREFIX)} x`);
    expect(text.length).toBeLessThan(html.length);
  });

  it("ignores stray quote markers in the input", () => {
    expect(outgoingText("<p>a\uE000b\uE001c</p>")).toBe("abc");
  });
});

/** What the composer's toolbar writes in a Chromium-based browser (styleWithCSS on), as the editor holds it. */
const TOOLBAR_HTML =
  '<div><span style="color: rgb(185, 28, 28);">red</span> <span style="background-color: rgb(254, 240, 138);">marked</span></div>' +
  '<div><span style="font-family: serif;">serif</span> <span style="font-family: monospace;">mono</span></div>' +
  '<div><span style="font-size: small;">s</span> <span style="font-size: medium;">n</span> ' +
  '<span style="font-size: x-large;">l</span> <span style="font-size: xx-large;">h</span></div>' +
  '<div style="text-align: center;">centred</div><div style="text-align: right;">right</div>' +
  '<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;"><div>indented</div></blockquote>' +
  '<div><span style="text-decoration-line: line-through;">struck</span> <strike>old</strike></div>' +
  "<ul><li>one</li><ul><li>nested</li></ul></ul>";

describe("sanitizeOutgoingHtml: the composer's formatting", () => {
  it("keeps every style the toolbar writes, unchanged", () => {
    const r = sanitizeOutgoingHtml(TOOLBAR_HTML);
    expect(r.html).toBe(
      TOOLBAR_HTML.replace(/;"/g, '"')
        .replace(/padding: 0px"/, 'padding: 0px"')
        .replace("<strike>old</strike>", "<s>old</s>"),
    );
    expect(r.removedAttributes).toEqual([]);
    expect(r.removedTags).toEqual([]);
  });

  it("is idempotent on the toolbar's output", () => {
    const once = clean(TOOLBAR_HTML);
    expect(clean(once)).toBe(once);
  });

  it("writes a sensible text part: no styles, no quote marks for an indent", () => {
    expect(outgoingText(clean(TOOLBAR_HTML))).toBe(
      [
        "red marked",
        "serif mono",
        "s n l h",
        "centred",
        "right",
        "indented",
        "struck old",
        "",
        "- one",
        "  - nested",
      ].join("\n"),
    );
  });

  it("still quotes a cited reply and a plain quote, even with a borderless style", () => {
    expect(outgoingText(clean('<blockquote type="cite" style="border: none">a</blockquote>'))).toBe("> a");
    expect(outgoingText(clean("<blockquote>a</blockquote>"))).toBe("> a");
    expect(
      outgoingText(clean('<blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc">a</blockquote>')),
    ).toBe("> a");
  });

  it("mixes indents and quotes by nesting", () => {
    const indent = '<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px">';
    expect(
      outgoingText(
        clean(`<div>top</div>${indent}<blockquote>q</blockquote>${indent}deep</blockquote></blockquote><div>end</div>`),
      ),
    ).toBe("top\n> q\n\ndeep\nend");
  });

  it("tells an indent from a quote", () => {
    expect(isIndentBlock('<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px">')).toBe(true);
    expect(isIndentBlock('<blockquote style="border: none">')).toBe(true);
    expect(isIndentBlock('<blockquote type="cite" style="border: none">')).toBe(false);
    expect(isIndentBlock('<blockquote style="border: none 1px">')).toBe(false);
    expect(isIndentBlock('<blockquote style="border-left: none">')).toBe(false);
    expect(isIndentBlock('<blockquote title="border: none">')).toBe(false);
    expect(isIndentBlock("<blockquote>")).toBe(false);
  });

  it("turns <strike> into <s> without reporting it removed", () => {
    const r = sanitizeOutgoingHtml('<strike title="t" onclick="x()">old</strike>');
    expect(r.html).toBe('<s title="t">old</s>');
    expect(r.removedTags).toEqual([]);
    expect(r.removedAttributes).toEqual(["onclick"]);
  });
});

describe("cleanOutgoingCss: value grammars for the composer's properties", () => {
  it.each([
    "color: #b91c1c",
    "color: #FFF",
    "color: #0000ff80",
    "color: rgb(185, 28, 28)",
    "color: rgba(0, 0, 0, 0.5)",
    "color: rgb(10%, 20%, 30%)",
    "color: red",
    "background-color: transparent",
    "background-color: rgb(254, 240, 138)",
    "font-family: sans-serif",
    "font-family: serif",
    "font-family: monospace",
    "font-family: Arial, Helvetica, sans-serif",
    "font-family: 'Segoe UI', \"Helvetica Neue\", sans-serif",
    "font-size: small",
    "font-size: medium",
    "font-size: x-large",
    "font-size: xx-large",
    "font-size: 14px",
    "font-size: 11pt",
    "font-size: 1.2em",
    "font-size: 120%",
    "text-align: left",
    "text-align: center",
    "text-align: right",
    "text-align: justify",
    "margin-left: 40px",
    "margin-left: 2em",
    "padding-left: 1ex",
    "padding-left: 0",
    "margin: 0 0 0 40px",
    "margin: 0 auto",
    "padding: 0px",
    "text-decoration: line-through",
    "text-decoration: underline dotted rgb(0, 0, 0)",
    "text-decoration: underline #333",
    "text-decoration-line: line-through",
    "text-decoration-line: underline line-through",
    "text-decoration-style: wavy",
    "text-decoration-color: #ff0000",
  ])("keeps %s", (css) => {
    expect(cleanOutgoingCss(css)).toEqual({ css, dropped: [] });
  });

  it.each([
    // Colours: no functions besides rgb()/rgba(), no custom properties, no stray text.
    ["color", "var(--primary)"],
    ["color", "rgb(var(--x))"],
    ["color", "hsl(0, 100%, 50%)"],
    ["color", "#ggg"],
    ["color", "#12345"],
    ["color", "red blue"],
    ["color", "red !important"],
    ["color", "rgb(1, 2)"],
    ["color", "rgb(1, 2, 3) url(https://x.example/a.png)"],
    ["color", "currentColor2"],
    ["background-color", "url(https://track.example/p.gif)"],
    ["background-color", "env(safe-area-inset-top)"],
    ["background-color", "attr(data-x)"],
    // Fonts: plain names only.
    ["font-family", "url(https://fonts.example/x.woff)"],
    ["font-family", "var(--font)"],
    ["font-family", "'a'b"],
    ["font-family", "sans-serif, "],
    ["font-family", "Ari@l"],
    ["font-family", "a,b,c,d,e,f,g,h,i"],
    ["font-family", "x".repeat(41)],
    // Sizes: keywords or bounded positive lengths.
    ["font-size", "0"],
    ["font-size", "-1px"],
    ["font-size", "500px"],
    ["font-size", "100em"],
    ["font-size", "calc(100vw)"],
    ["font-size", "10vw"],
    ["font-size", "huge"],
    ["font-size", "var(--s)"],
    // Alignment: left, right, center (and justify/start/end).
    ["text-align", "-webkit-center"],
    ["text-align", "center !important"],
    ["text-align", "var(--a)"],
    // Spacing: bounded, non-negative.
    ["margin-left", "-9999px"],
    ["margin-left", "10000px"],
    ["margin-left", "calc(1px + 2px)"],
    ["margin-left", "1px 2px 3px 4px 5px"],
    ["padding-left", "auto"],
    ["padding-left", "50vw"],
    ["margin", "-20px 0 0 0"],
    // Decoration: keywords and one colour.
    ["text-decoration", "url(https://x.example/a.png)"],
    ["text-decoration", "blink"],
    ["text-decoration", "underline red blue"],
    ["text-decoration", "underline rgb(var(--x))"],
    ["text-decoration-line", "blink"],
    ["text-decoration-line", "underline underline underline underline"],
    ["text-decoration-style", "groove"],
    ["text-decoration-color", "var(--x)"],
  ])("drops %s: %s", (prop, value) => {
    expect(cleanOutgoingCss(`${prop}: ${value}`)).toEqual({ css: "", dropped: [`style:${prop}`] });
  });

  it("drops custom properties and environment lookups anywhere", () => {
    expect(cleanOutgoingCss("border: 1px solid var(--x); width: env(x); height: attr(h); --x: red").css).toBe("");
    expect(cleanOutgoingCss("border: 1px solid v/**/ar(--x)").css).toBe("");
    expect(cleanOutgoingCss("border: 1px solid \\76 ar(--x)").css).toBe("");
  });

  it("checks the decoded value, so escapes can't smuggle a function past a grammar", () => {
    expect(cleanOutgoingCss("color: \\72 gb(1,2,3)").css).toBe("color: rgb(1,2,3)");
    expect(cleanOutgoingCss("color: r\\65 d").css).toBe("color: red");
    expect(cleanOutgoingCss("font-family: \\75 rl(x)").css).toBe("");
    expect(cleanOutgoingCss("font-size: 1\\30 px").css).toBe("font-size: 10px");
  });

  it("keeps the safe declarations of a mixed style", () => {
    expect(
      cleanOutgoingCss("color: rgb(1, 2, 3); font-family: url(x); text-align: center; margin-left: -50px").css,
    ).toBe("color: rgb(1, 2, 3); text-align: center");
  });

  it("covers every property the toolbar writes", () => {
    for (const prop of [
      "color",
      "background-color",
      "font-family",
      "font-size",
      "text-align",
      "margin",
      "margin-left",
      "padding",
      "padding-left",
      "text-decoration",
      "text-decoration-line",
    ]) {
      expect(STRICT_CSS[prop]).toBeTypeOf("function");
    }
  });

  it("checks the grammar helpers directly", () => {
    expect(isSafeColor("#abc")).toBe(true);
    expect(isSafeColor("rgb( 1 , 2 , 3 )")).toBe(true);
    expect(isSafeColor("rgb(1,2,3);x")).toBe(false);
    expect(isSafeFontFamily("serif")).toBe(true);
    expect(isSafeFontFamily('"serif')).toBe(false);
    expect(isSafeFontSize("xx-large")).toBe(true);
    expect(isSafeFontSize("97px")).toBe(false);
    expect(isSafeFontSize("96px")).toBe(true);
  });
});

describe("sanitizeOutgoingHtml: legacy font attributes", () => {
  it("keeps colours, plain faces and HTML sizes", () => {
    const html =
      '<font color="#b91c1c" face="Georgia, serif" size="5">f</font><font size="+1">g</font>' +
      '<table bgcolor="red"><tbody><tr><td bgcolor="#fff">x</td></tr></tbody></table>';
    expect(clean(html)).toBe(html);
  });

  it.each([
    ['<font color="var(--x)">f</font>', "color"],
    ['<font color="expression(alert(1))">f</font>', "color"],
    ['<font face="url(https://x.example/f.woff)">f</font>', "face"],
    ['<font face="a;b">f</font>', "face"],
    ['<font size="8">f</font>', "size"],
    ['<font size="99px">f</font>', "size"],
    ['<table bgcolor="url(https://x.example/p.gif)"><tr><td>x</td></tr></table>', "bgcolor"],
  ])("drops a bad attribute: %s", (html, attr) => {
    const r = sanitizeOutgoingHtml(html);
    expect(r.html).not.toContain(`${attr}=`);
    expect(r.removedAttributes).toContain(attr);
  });

  it("validates attributes on their own", () => {
    expect(fontAttribute("color", " #fff ")).toBe(true);
    expect(fontAttribute("size", "-2")).toBe(true);
    expect(fontAttribute("size", "0")).toBe(false);
    expect(fontAttribute("title", "anything")).toBe(true);
  });
});

describe("outgoingText: editor lines and lists", () => {
  it.each([
    ["<div>a</div><div>b</div>", "a\nb"],
    ["<div>a</div><div><br></div><div>b</div>", "a\n\nb"],
    ["a<div>b</div>c", "a\nb\nc"],
    ["<div><div>a</div></div><div>b</div>", "a\nb"],
    ["<div>a<br></div><div>b</div>", "a\nb"],
    ["<div>a<br>b</div>", "a\nb"],
    ["<p>a</p><p>b</p>", "a\n\nb"],
    ["<div>a</div><p>b</p>", "a\n\nb"],
  ])("writes %s as %j", (html, text) => {
    expect(outgoingText(html)).toBe(text);
  });

  it("numbers ordered lists and indents nested ones", () => {
    expect(outgoingText("<ol><li>a</li><li>b<ol><li>c</li></ol></li><li>d</li></ol><div>after</div>")).toBe(
      "1. a\n2. b\n  1. c\n3. d\n\nafter",
    );
    expect(outgoingText("<div>before</div><ul><li>a</li><ul><li>b</li></ul></ul>")).toBe("before\n\n- a\n  - b");
  });

  it("caps the list indent", () => {
    const depth = 50;
    const text = outgoingText(`${"<ul><li>x".repeat(depth)}${"</li></ul>".repeat(depth)}`);
    expect(text.split("\n").at(-1)).toBe(`${"  ".repeat(MAX_QUOTE_PREFIX)}- x`);
  });

  it("ignores stray line markers in the input", () => {
    expect(outgoingText("<p>a\uE002b\uE003c</p>")).toBe("abc");
  });
});

describe("outgoingText: linear on hostile whitespace", () => {
  it.each([
    ["spaces", `<p>a${" ".repeat(400_000)}b</p>`],
    ["tabs and spaces", `<div>${" \t".repeat(200_000)}x</div>`],
    ["spaces before line breaks", "x   <br>".repeat(50_000)],
    ["empty lines", "<div><br></div>".repeat(50_000)],
    ["unclosed-looking brs", `${"<br>".repeat(20_000)}${" ".repeat(200_000)}`],
    ["lines of no-break spaces", "\u00a0<br>".repeat(100_000)],
    ["lines of ideographic spaces", "\u3000<br>".repeat(100_000)],
  ])("handles %s quickly", (_name, html) => {
    const started = performance.now();
    outgoingText(html);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("cleanOutgoingCss: comment openers made from escapes", () => {
  it("drops a decoded /* so the recipient can't swallow the rest of the style", () => {
    const out = clean('<span style="color: red; font-family: serif \\2f* hidden">x</span>');
    expect(out).not.toContain("/*");
    expect(out).toContain("color: red");
  });
});
