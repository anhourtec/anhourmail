// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import { linkingSanitizer } from "@/server/webmail/image-proxy";

import { createMailClient, IMAGE_LINK_EXPIRED, imageDataUrl } from "./mail-client";
import { frameDocument } from "./message-frame";
import {
  imageLinks,
  isLoadedImageType,
  loadsWithoutAsking,
  rememberOffer,
  shownAddress,
  shownDomain,
  withLoadedImages,
} from "./remote-images";

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

  const KEY = "k".repeat(22);
  /** What the server sends: a sender key and a Safe senders match only for a verified From. */
  const unverified = { senderKey: null, senderVerified: false, safeSender: null };
  const verified = (
    over: Partial<{ senderKey: string | null; safeSender: { kind: "address" | "domain"; value: string } | null }> = {},
  ) => ({
    senderKey: KEY,
    senderVerified: true,
    safeSender: null,
    ...over,
  });
  const safeDomain = { kind: "domain" as const, value: "club.example" };

  it("decides when images load without asking", () => {
    const contacts = new Set(["friend@example.org"]);
    const ask = { mode: "ask" as const, senders: [] };
    const contactsMode = { mode: "contacts" as const, senders: [] };
    expect(loadsWithoutAsking(ask, verified(), "friend@example.org", contacts)).toBe(false);
    expect(loadsWithoutAsking(contactsMode, verified(), "Friend@Example.org", contacts)).toBe(true);
    // A contact's address on a message whose From isn't verified asks first.
    expect(loadsWithoutAsking(contactsMode, unverified, "friend@example.org", contacts)).toBe(false);
    expect(loadsWithoutAsking(contactsMode, verified(), "x@example.org", contacts)).toBe(false);
    expect(loadsWithoutAsking(contactsMode, unverified, undefined, contacts)).toBe(false);
    expect(loadsWithoutAsking({ mode: "always", senders: [] }, unverified, undefined, contacts)).toBe(true);
  });

  it("loads Safe senders' images in every mode, only for a verified From", () => {
    const none = new Set<string>();
    for (const mode of ["ask", "contacts", "always"] as const) {
      expect(
        loadsWithoutAsking({ mode, senders: [] }, verified({ safeSender: safeDomain }), "news@club.example", none),
      ).toBe(true);
    }
    // A forged From matching a Safe sender: the server sends no match, and nothing loads by itself.
    expect(loadsWithoutAsking({ mode: "ask", senders: [] }, unverified, "news@club.example", none)).toBe(false);
    expect(
      loadsWithoutAsking(
        { mode: "ask", senders: [] },
        { ...unverified, safeSender: safeDomain },
        "news@club.example",
        none,
      ),
    ).toBe(false);
  });

  it("still loads a sender remembered by fingerprint before Safe senders loaded images", () => {
    const none = new Set<string>();
    expect(loadsWithoutAsking({ mode: "ask", senders: [KEY] }, verified(), "x@example.org", none)).toBe(true);
    expect(loadsWithoutAsking({ mode: "ask", senders: [] }, verified(), "x@example.org", none)).toBe(false);
    expect(rememberOffer({ mode: "ask", senders: [KEY] }, verified(), "News@Club.example")).toEqual({
      kind: "legacy",
      sender: "News@club.example",
      key: KEY,
      canChange: true,
    });
    // On Safe senders as well: the Safe senders entry is what the notice talks about.
    expect(
      rememberOffer({ mode: "ask", senders: [KEY] }, verified({ safeSender: safeDomain }), "news@club.example").kind,
    ).toBe("safe");
  });

  it("offers once or always only for a verified sender, and says why not otherwise", () => {
    const ask = { mode: "ask", senders: [] } as const;
    expect(rememberOffer(ask, verified(), "news@club.example")).toEqual({
      kind: "choose",
      sender: "news@club.example",
    });
    expect(rememberOffer(ask, verified({ safeSender: safeDomain }), "news@club.example")).toEqual({
      kind: "safe",
      sender: "news@club.example",
      match: safeDomain,
      canChange: true,
    });
    // No verification: load once, never remember, explain.
    expect(rememberOffer(ask, unverified, "news@Club.Example")).toEqual({ kind: "unverified", domain: "club.example" });
    expect(rememberOffer({ mode: "contacts", senders: [] }, unverified, "friend@example.org")).toEqual({
      kind: "unverified",
      domain: "example.org",
    });
    expect(rememberOffer(ask, unverified, undefined)).toEqual({ kind: "unverified", domain: null });
    expect(rememberOffer(ask, unverified, "no-at-sign")).toEqual({ kind: "unverified", domain: null });
    expect(rememberOffer(ask, unverified, "trailing@")).toEqual({ kind: "unverified", domain: null });
    // Images load anyway, so there is nothing to ask about next time.
    expect(rememberOffer({ mode: "always", senders: [] }, unverified, "x@example.org")).toEqual({ kind: "none" });
    expect(rememberOffer({ mode: "always", senders: [] }, verified(), "x@example.org")).toEqual({ kind: "none" });
    // Without image settings (an attached message) nothing is remembered or explained.
    expect(rememberOffer(undefined, verified(), "x@example.org")).toEqual({ kind: "none" });
    expect(rememberOffer(undefined, unverified, "x@example.org")).toEqual({ kind: "none" });
  });

  it("offers just this once in a mailbox shared with the person, whose Safe senders aren't theirs to change", () => {
    const ask = { mode: "ask", senders: [] } as const;
    expect(rememberOffer(ask, verified(), "news@club.example", false, false)).toEqual({ kind: "once" });
    expect(rememberOffer(ask, verified({ safeSender: safeDomain }), "news@club.example", false, false)).toMatchObject({
      kind: "safe",
      canChange: false,
    });
    expect(rememberOffer(ask, unverified, "news@club.example", false, false).kind).toBe("unverified");
  });

  it("loads the person's own sent mail by itself, saying nothing about its sender", () => {
    const ask = { mode: "ask", senders: [] } as const;
    const none = new Set<string>();
    // In the Sent folder: loaded in every mode, no "can't confirm" line and no remember choice, whatever the From.
    for (const mode of ["ask", "contacts", "always"] as const) {
      expect(loadsWithoutAsking({ mode, senders: [] }, unverified, "me@anhourmail.com", none, true)).toBe(true);
    }
    expect(rememberOffer(ask, unverified, "me@anhourmail.com", true)).toEqual({ kind: "none" });
    expect(rememberOffer({ mode: "contacts", senders: [] }, unverified, undefined, true)).toEqual({ kind: "none" });
    expect(rememberOffer(ask, verified(), "me@anhourmail.com", true)).toEqual({ kind: "none" });
    expect(rememberOffer({ mode: "ask", senders: [KEY] }, verified(), "me@anhourmail.com", true)).toEqual({
      kind: "none",
    });
    // An inbox message with a forged own From isn't the person's own: it asks, and says it can't be confirmed.
    expect(loadsWithoutAsking(ask, unverified, "me@anhourmail.com", new Set(["me@anhourmail.com"]))).toBe(false);
    expect(rememberOffer(ask, unverified, "me@anhourmail.com")).toEqual({
      kind: "unverified",
      domain: "anhourmail.com",
    });
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

describe("shown sender and domain", () => {
  it("drops invisible characters and shows lookalike domains in their xn-- form", () => {
    expect(shownDomain("Harbour-Reading.example")).toBe("harbour-reading.example");
    expect(shownDomain("p\u0430ypal.example")).toBe("xn--pypal-4ve.example");
    expect(shownDomain("evil\u202Eelpmaxe.com")).toBe("evilelpmaxe.com");
    expect(shownAddress("news\u200B@p\u0430ypal.example")).toBe("news@xn--pypal-4ve.example");
  });
});
