// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import { linkingSanitizer } from "@/server/webmail/image-proxy";

import { createMailClient, IMAGE_LINK_EXPIRED, imageDataUrl } from "./mail-client";
import { frameDocument } from "./message-frame";
import { imageLinks, isLoadedImageType, loadsWithoutAsking, withLoadedImages } from "./remote-images";

/** The reader's HTML as the server makes it: placeholders with image links, no addresses. */
const served = () =>
  linkingSanitizer("s".repeat(40), { sessionId: "s1", accountId: "a1" })(
    '<p>Hi</p><img src="https://cdn.example.org/a.png" alt="A" width="60" height="20"><img src="https://cdn.example.org/b.png"><img src="https://cdn.example.org/a.png" alt="again">',
    new Map(),
  ).html;

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("loading images into the message frame", () => {
  it("finds each image link once (the same address twice is one link, fetched once)", () => {
    const links = imageLinks(served());
    expect(links).toHaveLength(2);
    expect(imageLinks("<p>no images</p>")).toEqual([]);
  });

  it("turns loaded placeholders into data: images and leaves the rest blocked", () => {
    const html = served();
    const [first, second] = imageLinks(html);
    const out = withLoadedImages(html, new Map([[first ?? "", PNG_URL]]));
    expect(out.match(new RegExp(`<img src="${PNG_URL}"`, "g"))).toHaveLength(2);
    expect(out.match(/data-am-blocked/g)).toHaveLength(1);
    expect(out).toContain(`data-am-img="${second ?? ""}"`);
    expect(out).not.toContain(`data-am-img="${first ?? ""}"`);
    // The frame still loads nothing remote: its own policy allows only data: images.
    expect(frameDocument(out)).toContain("img-src data:;");
    expect(out).not.toMatch(/src="https?:/);
  });

  it("never puts anything but a raster data: URL into the frame", () => {
    const html = served();
    const [first = ""] = imageLinks(html);
    for (const bad of [
      "https://cdn.example.org/a.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      'data:image/png;base64,AAAA" onerror="alert(1)',
      "javascript:alert(1)",
    ]) {
      expect(withLoadedImages(html, new Map([[first, bad]]))).toBe(html);
    }
    expect(withLoadedImages(html, new Map())).toBe(html);
  });

  it("decides when images load without asking", () => {
    const contacts = new Set(["friend@example.org"]);
    const ask = { mode: "ask" as const, senders: ["k".repeat(22)] };
    expect(loadsWithoutAsking(ask, null, "friend@example.org", contacts)).toBe(false);
    expect(loadsWithoutAsking(ask, "k".repeat(22), "x@example.org", contacts)).toBe(true);
    expect(loadsWithoutAsking({ mode: "contacts", senders: [] }, null, "Friend@Example.org", contacts, true)).toBe(
      true,
    );
    // A contact's address on a message whose From isn't verified asks first.
    expect(loadsWithoutAsking({ mode: "contacts", senders: [] }, null, "friend@example.org", contacts)).toBe(false);
    expect(loadsWithoutAsking({ mode: "contacts", senders: [] }, null, "x@example.org", contacts, true)).toBe(false);
    expect(loadsWithoutAsking({ mode: "contacts", senders: [] }, null, undefined, contacts)).toBe(false);
    expect(loadsWithoutAsking({ mode: "always", senders: [] }, null, undefined, contacts)).toBe(true);
  });

  it("knows the raster types the proxy serves", () => {
    expect(isLoadedImageType("image/png")).toBe(true);
    expect(isLoadedImageType("image/svg+xml")).toBe(false);
    expect(isLoadedImageType("text/html")).toBe(false);
  });
});

describe("the mail client's remoteImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const reply = (status: number, body: BodyInit | null = null, type = "application/json") =>
    new Response(body, { status, headers: { "Content-Type": type } });

  it("posts the link in the body (never the URL) and returns a data: URL", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return reply(200, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");
    });
    const client = createMailClient("http://mail.test");
    expect(await client.remoteImage("v1.1.abc.def")).toBe("data:image/png;base64,iVBORw==");
    expect(calls[0]?.url).toBe("http://mail.test/api/webmail/img");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ token: "v1.1.abc.def" }));
  });

  it("says when links expired, throws when signed out, and gives up on errors", async () => {
    const statuses = [410, 401, 502, 404];
    vi.stubGlobal("fetch", async () => reply(statuses.shift() ?? 500, "{}"));
    const client = createMailClient("http://mail.test");
    expect(await client.remoteImage("t")).toBe(IMAGE_LINK_EXPIRED);
    await expect(client.remoteImage("t")).rejects.toMatchObject({ name: "SignedOutError" });
    expect(await client.remoteImage("t")).toBeNull();
    expect(await client.remoteImage("t")).toBeNull();
  });

  it("retries a busy proxy twice, then gives up", async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n += 1;
      return reply(429, "{}");
    });
    const client = createMailClient("http://mail.test");
    const p = client.remoteImage("t");
    await vi.runAllTimersAsync();
    expect(await p).toBeNull();
    expect(n).toBe(3);
  });

  it("refuses anything that isn't a raster image", async () => {
    expect(await imageDataUrl(new Blob(["<svg/>"], { type: "image/svg+xml" }))).toBeNull();
    expect(await imageDataUrl(new Blob(["<p>"], { type: "text/html" }))).toBeNull();
    expect(await imageDataUrl(new Blob([new Uint8Array([1, 2, 3])], { type: "image/gif" }))).toBe(
      "data:image/gif;base64,AQID",
    );
  });
});
