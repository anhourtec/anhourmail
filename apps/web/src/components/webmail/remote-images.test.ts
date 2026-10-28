// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { sanitizeOutgoingHtml } from "@/server/webmail/outgoing-html";

import { parkRemoteImages, PLACEHOLDER_SRC, unparkRemoteImages } from "./remote-images";

const clean = (html: string) => sanitizeOutgoingHtml(html).html;

describe("remote images while writing", () => {
  it("shows a placeholder instead of a remote or cid: image and keeps embedded ones", () => {
    const html = clean(
      '<p><img src="https://cdn.example/a.png?x=1&amp;y=2" alt="Logo" width="80" height="20">' +
        '<img src="cid:part1@x"><img src="data:image/png;base64,AAAA"></p>',
    );
    const shown = parkRemoteImages(html);
    expect(shown).not.toMatch(/\ssrc="(?:https|cid):/);
    expect(shown.match(new RegExp(`src="${PLACEHOLDER_SRC.replace(/[+/]/g, "\\$&")}"`, "g"))).toHaveLength(2);
    expect(shown).toContain('data-am-src="https://cdn.example/a.png?x=1&amp;y=2"');
    expect(shown).toContain('src="data:image/png;base64,AAAA"');
    expect(shown).toContain('alt="Logo"');
  });

  it("hides remote CSS backgrounds and keeps the style to send", () => {
    const html = clean('<div style="background: url(https://t.example/bg.png) no-repeat; color: red">x</div>');
    const shown = parkRemoteImages(html);
    expect(shown).toMatch(/\sstyle="background: none no-repeat; color: red"/);
    expect(/\sstyle="([^"]*)"/.exec(shown)?.[1]).not.toContain("https:");
    expect(unparkRemoteImages(shown)).toBe(html);
  });

  it("gives back exactly what was parked, and is idempotent", () => {
    const html = clean(
      '<p>Hi <img src="https://cdn.example/a.png" width="10" height="10"></p><div style="color: blue">plain</div>',
    );
    const shown = parkRemoteImages(html);
    expect(parkRemoteImages(shown)).toBe(shown);
    expect(unparkRemoteImages(shown)).toBe(html);
    expect(unparkRemoteImages(html)).toBe(html);
    // What is sent still has the image and nothing of ours.
    const sent = sanitizeOutgoingHtml(unparkRemoteImages(shown));
    expect(sent.html).toBe(html);
    expect(sent.remoteImages).toBe(1);
  });

  it("works on the browser's serialisation, whatever the attribute order", () => {
    const fromEditor = `<p><img data-am-blocked="1" data-am-src="https://cdn.example/a.png" width="4" src="${PLACEHOLDER_SRC}"></p>`;
    expect(unparkRemoteImages(fromEditor)).toBe('<p><img width="4" src="https://cdn.example/a.png"></p>');
    // The sanitiser drops our markers if they were ever pasted in.
    expect(clean('<img src="https://a.example/x.png" data-am-src="https://evil.example/">')).toBe(
      '<img src="https://a.example/x.png" />',
    );
  });
});
