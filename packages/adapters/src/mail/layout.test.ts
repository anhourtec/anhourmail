// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { LOGO_CID, systemEmail, type SystemEmailInput } from "./layout";
import { EMAIL_LOGO_DARK, EMAIL_LOGO_LIGHT } from "./logo.generated";

const base: SystemEmailInput = {
  to: "kim@example.test",
  subject: "Reset your AnhourMail password",
  preheader: "Use this link within an hour.",
  greeting: "Hi Kim,",
  lines: ["First line.", "Second line."],
  action: { label: "Reset your password", url: "https://app.example.test/reset?token=abc&next=%2F" },
  note: "If you didn't ask, ignore this email.",
  reason: "You got this email because a reset was asked for.",
  site: "example.test",
};

const pngBytes = (b64: string) => Buffer.from(b64, "base64");

describe("systemEmail layout", () => {
  it("is a 560 px table layout with lang, colour scheme and presentation roles", () => {
    const { html } = systemEmail(base);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("max-width:560px");
    expect(html).toContain('<table role="presentation" width="560"');
    const tables = html.match(/<table\b[^>]*>/g) ?? [];
    expect(tables.length).toBeGreaterThan(3);
    for (const t of tables) expect(t).toContain('role="presentation"');
    // Display headings are weight 500, never bold.
    expect(html).toMatch(/<h1[^>]*font-weight:500/);
    expect(html).toContain("<h1");
    expect(html).toContain("Reset your AnhourMail password</h1>");
  });

  it("escapes every interpolated value in the HTML part", () => {
    const { html, text } = systemEmail({
      ...base,
      subject: "Hi <script>",
      preheader: '"pre" <b>',
      greeting: "Hi <i>Kim</i>,",
      lines: ["<a href=x>link</a> & more"],
      facts: [{ label: "Name given:", value: "<b>Laptop</b>" }],
      closing: "Close <hr>",
      note: "Note <p>",
      reason: "Reason <em>",
      action: { label: "Go <now>", url: 'https://x.test/?a=1&b="2"' },
    });
    for (const raw of [
      "<script>",
      "<i>Kim</i>",
      "<a href=x>",
      "<b>Laptop</b>",
      "<hr>",
      "Note <p>",
      "<em>",
      "<now>",
      '<b>"',
    ]) {
      expect(html).not.toContain(raw);
    }
    expect(html).toContain("&#60;b&#62;Laptop&#60;/b&#62;");
    expect(html).toContain('href="https://x.test/?a=1&#38;b=&#34;2&#34;"');
    // The text part is plain: values as given.
    expect(text).toContain('Name given: "<b>Laptop</b>"');
  });

  it("puts the action URL, unchanged, in the button, the VML fallback and the copy-paste link", () => {
    const { html, text } = systemEmail(base);
    const href = 'href="https://app.example.test/reset?token=abc&#38;next=%2F"';
    expect(html.split(href).length - 1).toBe(3);
    expect(html).toContain("<!--[if mso]>");
    expect(html).toMatch(/<v:roundrect[^>]+href="https:\/\/app\.example\.test\/reset\?token=abc&#38;next=%2F"/);
    expect(html).toMatch(/<td class="am-btn" bgcolor="#0077c8"/);
    expect(text).toContain("Reset your password: https://app.example.test/reset?token=abc&next=%2F");
  });

  it("hides the preheader at the top of the body", () => {
    const { html } = systemEmail(base);
    const body = html.slice(html.indexOf("<body"));
    expect(body).toMatch(/^<body[^>]*>\n<div style="display:none;[^"]*">Use this link within an hour\./);
  });

  it("embeds the logo as inline attachments with alt text and size; no remote images", () => {
    const m = systemEmail(base);
    expect(m.attachments).toEqual([
      expect.objectContaining({ cid: LOGO_CID.light, contentType: "image/png", content: EMAIL_LOGO_LIGHT.base64 }),
      expect.objectContaining({ cid: LOGO_CID.dark, contentType: "image/png", content: EMAIL_LOGO_DARK.base64 }),
    ]);
    const imgs = m.html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img).toMatch(/src="cid:logo-(light|dark)@anhourmail"/);
      expect(img).toContain('alt="AnhourMail"');
      expect(img).toContain(`width="${String(EMAIL_LOGO_LIGHT.width)}"`);
      expect(img).toContain(`height="${String(EMAIL_LOGO_LIGHT.height)}"`);
    }
    expect(m.html).not.toMatch(/src="(https?:)?\/\//);
    expect(m.html).not.toMatch(/url\(/);
    // The PNGs are real, 2x and small.
    for (const logo of [EMAIL_LOGO_LIGHT, EMAIL_LOGO_DARK]) {
      const png = pngBytes(logo.base64);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(logo.width * 2);
      expect(png.length).toBeLessThan(20_000);
    }
  });

  it("adds no tracking: every link is the action URL or the plain site, with no added parameters", () => {
    const { html } = systemEmail(base);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((h) => h[1]);
    expect(new Set(hrefs)).toEqual(
      new Set(["https://app.example.test/reset?token=abc&#38;next=%2F", "https://example.test"]),
    );
    expect(html).not.toMatch(/utm_[a-z]+=|[?&]ref=|beacon|width="1" height="1"/i);
  });

  it("writes a footer with why, who and where, and a plain-text part that mirrors the content", () => {
    const m = systemEmail({ ...base, facts: [{ label: "Mailbox:", value: "k***@family.test" }], closing: "Last." });
    expect(m.html).toContain("You got this email because a reset was asked for.");
    expect(m.html).toContain("AnhourMail by Anhourtec · Vancouver/Victoria, BC, Canada");
    expect(m.html).toContain(">example.test</a>");
    expect(m.text).toBe(
      [
        "Hi Kim,",
        "",
        "First line.",
        "Second line.",
        "",
        'Mailbox: "k***@family.test"',
        "",
        "Last.",
        "",
        "Reset your password: https://app.example.test/reset?token=abc&next=%2F",
        "",
        "If you didn't ask, ignore this email.",
        "",
        "You got this email because a reset was asked for.",
        "AnhourMail by Anhourtec · Vancouver/Victoria, BC, Canada",
        "https://example.test",
        "",
      ].join("\n"),
    );
  });

  it("uses a custom heading when given and leaves out an empty note", () => {
    const { note: _note, ...noNote } = base;
    const m = systemEmail({ ...noNote, heading: "Welcome" });
    expect(m.html).toContain("Welcome</h1>");
    expect(m.html).not.toContain("border-top:1px solid");
    expect(m.text).not.toContain("ignore this email");
  });

  it("swaps to dark colours and the dark logo only through the progressive <style> block", () => {
    const { html } = systemEmail(base);
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toContain(".am-logo-dark{display:block!important");
    expect(html).toMatch(/class="am-logo-dark" style="display:none;/);
  });

  it("refuses an action URL that isn't http(s) and a site that isn't a host", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "/relative", "not a url"]) {
      expect(() => systemEmail({ ...base, action: { label: "x", url } })).toThrow(/action URL/);
    }
    for (const site of ["https://example.test", "example.test/path", 'x" onclick="y', ""]) {
      expect(() => systemEmail({ ...base, site })).toThrow(/site must be a host/);
    }
  });
});
