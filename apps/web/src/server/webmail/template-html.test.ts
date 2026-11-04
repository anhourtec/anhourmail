// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { TEMPLATE_HTML_MAX } from "@anhourmail/shared/templates";

import { cleanTemplate } from "./template-html";

describe("template HTML", () => {
  it("keeps formatted text and makes the plain-text version", () => {
    const out = cleanTemplate("<p>Thanks for <b>writing</b>.</p><ul><li>One</li></ul>");
    expect(out.problem).toBeNull();
    expect(out.html).toContain("<b>writing</b>");
    expect(out.text).toContain("Thanks for writing.");
  });

  it("removes every image, remote, attached or embedded, and scripts and handlers", () => {
    const out = cleanTemplate(
      '<p>Hi<img src="https://t.example/p.gif"><img src="cid:x"><img src="data:image/png;base64,iVBORw0KGgo="></p>' +
        '<script>alert(1)</script><a href="javascript:alert(1)" onclick="x()">link</a>' +
        '<div style="background:url(https://t.example/bg.png)">x</div>',
    );
    expect(out.html).not.toMatch(/<img|<script|javascript:|onclick|url\(/i);
    expect(out.removedImages).toBe(3);
    expect(out.problem).toBeNull();
  });

  it("refuses an empty template and one over the size cap", () => {
    expect(cleanTemplate("<p> </p><img src='data:image/png;base64,AAAA'>").problem).toBe("Write the template's text.");
    expect(cleanTemplate(`<p>${"x".repeat(TEMPLATE_HTML_MAX + 10)}</p>`).problem).toMatch(/64 KB/);
    expect(cleanTemplate("x".repeat(TEMPLATE_HTML_MAX * 2 + 1)).problem).toMatch(/64 KB/);
  });
});
