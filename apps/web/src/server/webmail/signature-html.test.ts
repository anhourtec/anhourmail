// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { SIGNATURE_HTML_MAX, SIGNATURE_IMAGE_URI_MAX, WEBMAIL_SIGNATURES } from "@anhourmail/shared/signatures";

import { dataImageMatchesType, sanitizeOutgoingHtml } from "./outgoing-html";
import { cleanSignature, IDENTITY_SIGNATURE_MAX_BYTES, identitySignature, textAsHtml } from "./signature-html";

const b64 = (bytes: number[], pad = 12) =>
  Buffer.from([...bytes, ...new Array<number>(pad).fill(0)]).toString("base64");
const PNG = `data:image/png;base64,${b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])}`;
const JPEG = `data:image/jpeg;base64,${b64([0xff, 0xd8, 0xff, 0xe0])}`;
const GIF = `data:image/gif;base64,${Buffer.from("GIF89a\0\0\0\0\0\0\0\0").toString("base64")}`;
const WEBP = `data:image/webp;base64,${Buffer.from("RIFF\0\0\0\0WEBPVP8 ").toString("base64")}`;
/** Bytes that say PNG in the type but are HTML. */
const FAKE_PNG = `data:image/png;base64,${Buffer.from("<html><script>alert(1)</script>").toString("base64")}`;

describe("signature HTML", () => {
  it("keeps formatting, links and embedded images, and makes a text version", () => {
    const r = cleanSignature(
      `<div style="font-family: serif; color: rgb(37, 99, 235)"><b>Sam Lee</b></div><div><a href="https://anhourtec.com">Site</a></div><img src="${PNG}" alt="Logo">`,
    );
    expect(r.problem).toBeNull();
    expect(r.html).toContain("<b>Sam Lee</b>");
    expect(r.html).toContain(`src="${PNG}"`);
    expect(r.html).toContain('href="https://anhourtec.com"');
    expect(r.text).toBe("Sam Lee\nSite (https://anhourtec.com)");
    expect(r.removedImages).toBe(0);
  });

  it("removes remote and attached images, CSS urls, scripts, styles and handlers", () => {
    const r = cleanSignature(
      `<p onclick="x()">Hi</p><img src="https://tracker.example/p.gif"><img src="cid:logo@x"><img src="http://x.example/a.png">` +
        `<div style="background-image: url(https://tracker.example/bg.png); color: red">Bg</div>` +
        `<div style="background: url(${PNG})">Data bg</div><script>alert(1)</script><style>p{color:red}</style>` +
        `<img src="${FAKE_PNG}"><img src="data:image/svg+xml;base64,PHN2Zz4=">`,
    );
    expect(r.problem).toBeNull();
    expect(r.html).not.toMatch(/https?:\/\/[^"]*\.(?:gif|png)|cid:|url\(|script|style>|onclick|svg/i);
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain('<div style="color: red">Bg</div>');
    expect(r.removedImages).toBe(5);
  });

  it("keeps PNG, JPEG, GIF and WebP whose bytes match their type", () => {
    for (const uri of [PNG, JPEG, GIF, WEBP]) expect(dataImageMatchesType(uri)).toBe(true);
    expect(dataImageMatchesType(FAKE_PNG)).toBe(false);
    expect(dataImageMatchesType(JPEG.replace("image/jpeg", "image/png"))).toBe(false);
    expect(dataImageMatchesType("data:image/png;base64,AAAA")).toBe(false);
    expect(dataImageMatchesType("https://x.example/a.png")).toBe(false);
  });

  it("refuses an image over the per-image cap, too many images, or a signature over the total cap", () => {
    const big = `data:image/png;base64,${b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)}${"A".repeat(SIGNATURE_IMAGE_URI_MAX)}`;
    expect(cleanSignature(`<img src="${big}">`).problem).toMatch(/up to 64 KB/);
    const many = new Array(WEBMAIL_SIGNATURES.imagesPerSignature + 1).fill(`<img src="${PNG}">`).join("");
    expect(cleanSignature(many).problem).toMatch(/up to 3 images/);
    const long = `<p>${"x".repeat(SIGNATURE_HTML_MAX + 10)}</p>`;
    expect(cleanSignature(long).problem).toMatch(/up to 300 KB/);
    expect(cleanSignature("x".repeat(SIGNATURE_HTML_MAX * 2 + 1)).problem).toMatch(/up to 300 KB/);
  });

  it("treats a signature with nothing visible as empty", () => {
    expect(cleanSignature("<div><br></div><p>&nbsp;</p>")).toMatchObject({ html: "", text: "", problem: null });
    expect(cleanSignature(`<div><img src="${PNG}"></div>`).html).toContain("<img");
  });

  it("leaves message HTML as it was: remote images stay allowed outside signatures", () => {
    const r = sanitizeOutgoingHtml(`<img src="https://x.example/a.png"><img src="${PNG}">`);
    expect(r.remoteImages).toBe(1);
    expect(r.embeddedImages).toBe(1);
  });
});

describe("the identity copy (other mail apps)", () => {
  it("is the signature as it is when it fits the mail server's limit", () => {
    expect(identitySignature({ html: "<p><b>Sam</b></p>", text: "Sam" })).toEqual({
      html: "<p><b>Sam</b></p>",
      text: "Sam",
      complete: true,
    });
    expect(identitySignature(null)).toEqual({ html: "", text: "", complete: true });
  });

  it("drops images, then formatting, to fit; cuts the text at a line break", () => {
    const img = `<img src="data:image/png;base64,${"A".repeat(4000)}">`;
    expect(identitySignature({ html: `<p>Sam</p>${img}`, text: "Sam" })).toEqual({
      html: "<p>Sam</p>",
      text: "Sam",
      complete: false,
    });
    const lines = Array.from({ length: 400 }, (_, i) => `Line ${String(i)}`).join("\n");
    const big = identitySignature({ html: `<p>${"x".repeat(3000)}</p>`, text: lines });
    const size = (v: string) => new TextEncoder().encode(v).length;
    expect(size(big.text)).toBeLessThanOrEqual(IDENTITY_SIGNATURE_MAX_BYTES);
    expect(big.text.endsWith("…")).toBe(true);
    expect(big.text.split("\n").at(-1)).toMatch(/^Line \d+…$/);
    expect(size(big.html)).toBeLessThanOrEqual(IDENTITY_SIGNATURE_MAX_BYTES);
    expect(big.html.startsWith("<div>Line 0</div><div>Line 1</div>")).toBe(true);
    expect(big.complete).toBe(false);
    // Multi-byte text is measured in bytes.
    expect(size(identitySignature({ html: "", text: "é".repeat(2000) }).text)).toBeLessThanOrEqual(2047);
  });

  it("turns text into escaped lines", () => {
    expect(textAsHtml("Sam <b>\r\n\nCo & co")).toBe("<div>Sam &lt;b&gt;</div><div><br></div><div>Co &amp; co</div>");
  });
});
