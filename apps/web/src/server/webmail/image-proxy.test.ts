// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REMOTE_IMAGES } from "@anhourmail/shared/webmail";
import { setLogSinkForTests } from "@anhourmail/server/log";

import {
  IMAGE_LINK_TTL_SEC,
  linkingSanitizer,
  MAX_IMAGE_FETCHES,
  MAX_SESSION_IMAGE_FETCHES,
  senderKey,
  serveImage,
  type ServeDeps,
  signImageLink,
  verifyImageLink,
  senderVerified,
  withSenderKey,
} from "./image-proxy";
import type { FetchResult } from "./remote-image";
import { buildMessageView, type JmapEmail } from "./view";

const SECRET = "s".repeat(40);
const MINE = { sessionId: "sess-a", accountId: "acc-1" };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const NOW = 1_800_000_000_000;

let logs: Record<string, unknown>[] = [];
beforeEach(() => {
  logs = [];
  setLogSinkForTests((line) => {
    logs.push(JSON.parse(line) as Record<string, unknown>);
  });
});
afterEach(() => {
  setLogSinkForTests(null);
});

describe("image links", () => {
  it("round-trips an address for the session and mailbox it was made for", () => {
    const link = signImageLink(SECRET, MINE, "https://cdn.example.org/a.png?u=8f2a", NOW);
    expect(link).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyImageLink(SECRET, MINE, link ?? "", NOW)).toEqual({
      ok: true,
      url: "https://cdn.example.org/a.png?u=8f2a",
    });
  });

  it("treats a protocol-relative address as https and refuses ones that can never be fetched", () => {
    const link = signImageLink(SECRET, MINE, "//cdn.example.org/a.png", NOW) ?? "";
    expect(verifyImageLink(SECRET, MINE, link, NOW)).toEqual({ ok: true, url: "https://cdn.example.org/a.png" });
    expect(signImageLink(SECRET, MINE, "ftp://cdn.example.org/a.png", NOW)).toBeNull();
    expect(signImageLink(SECRET, MINE, "https://cdn.example.org:8443/a.png", NOW)).toBeNull();
    expect(signImageLink(SECRET, MINE, "cid:part1", NOW)).toBeNull();
  });

  it("is refused for another session, another mailbox, another secret, or when altered", () => {
    const link = signImageLink(SECRET, MINE, "https://cdn.example.org/a.png", NOW) ?? "";
    const invalid = { ok: false, reason: "invalid" };
    expect(verifyImageLink(SECRET, { ...MINE, sessionId: "sess-b" }, link, NOW)).toEqual(invalid);
    expect(verifyImageLink(SECRET, { ...MINE, accountId: "acc-2" }, link, NOW)).toEqual(invalid);
    expect(verifyImageLink("t".repeat(40), MINE, link, NOW)).toEqual(invalid);
    const [v, exp, enc, mac] = link.split(".");
    const other = Buffer.from("http://169.254.169.254/").toString("base64url");
    expect(verifyImageLink(SECRET, MINE, [v, exp, other, mac].join("."), NOW)).toEqual(invalid);
    expect(verifyImageLink(SECRET, MINE, [v, String(Number(exp) + 3600), enc, mac].join("."), NOW)).toEqual(invalid);
    expect(verifyImageLink(SECRET, MINE, [v, exp, enc, `${mac?.slice(0, -1) ?? ""}A`].join("."), NOW)).toEqual(invalid);
    for (const bad of ["", "v1", "v2.1.a.b", `${link}.x`, "v1.x.a.b", "v1.1.a+b.c", `v1.1.${"a".repeat(5000)}.c`]) {
      expect(verifyImageLink(SECRET, MINE, bad, NOW)).toEqual(invalid);
    }
  });

  it("expires after the link lifetime", () => {
    const link = signImageLink(SECRET, MINE, "https://cdn.example.org/a.png", NOW) ?? "";
    expect(IMAGE_LINK_TTL_SEC).toBe(REMOTE_IMAGES.linkMinutes * 60);
    expect(verifyImageLink(SECRET, MINE, link, NOW + IMAGE_LINK_TTL_SEC * 1000).ok).toBe(true);
    expect(verifyImageLink(SECRET, MINE, link, NOW + IMAGE_LINK_TTL_SEC * 1000 + 1001)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

describe("sender keys", () => {
  it("are per mailbox, case-insensitive and never the address", () => {
    const k = senderKey(SECRET, "me@a.test", "News@Shop.example");
    expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(senderKey(SECRET, "ME@a.test", " news@shop.example ")).toBe(k);
    expect(senderKey(SECRET, "you@a.test", "news@shop.example")).not.toBe(k);
    expect(senderKey("t".repeat(40), "me@a.test", "news@shop.example")).not.toBe(k);
    expect(k).not.toContain("shop");
  });
});

const email = (html: string, from = "news@shop.example"): JmapEmail => ({
  id: "e1",
  threadId: "t1",
  mailboxIds: {},
  keywords: {},
  from: [{ name: null, email: from }],
  to: null,
  cc: null,
  replyTo: null,
  subject: "Hi",
  sentAt: null,
  receivedAt: "2026-10-29T00:00:00Z",
  htmlBody: [{ partId: "1", blobId: "b1", size: 1, name: null, type: "text/html", disposition: null, cid: null }],
  textBody: null,
  attachments: null,
  bodyValues: { "1": { value: html } },
});

describe("the reader's linking sanitiser", () => {
  const sanitize = linkingSanitizer(SECRET, MINE);

  it("replaces remote images with signed links, never the address; trackers get none", () => {
    const r = sanitize(
      '<img src="https://cdn.example.org/a.png?u=1" width="100" height="50" alt="A"><img src="//cdn.example.org/b.png"><img src="https://t.example.org/o.gif" width="1" height="1"><img src="cid:missing">',
      new Map(),
    );
    expect(r.html).not.toContain("cdn.example.org");
    expect(r.html).not.toContain("t.example.org");
    expect(r.blockedImages).toBe(3);
    expect(r.blockedTrackers).toBe(1);
    expect(r.loadableImages).toBe(2);
    const links = [...r.html.matchAll(/data-am-img="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(links.map((l) => verifyImageLink(SECRET, MINE, l))).toEqual([
      { ok: true, url: "https://cdn.example.org/a.png?u=1" },
      { ok: true, url: "https://cdn.example.org/b.png" },
    ]);
  });

  it("links at most the per-message number of images", () => {
    const many = Array.from(
      { length: REMOTE_IMAGES.perMessage + 5 },
      (_, i) => `<img src="https://c.example.org/${String(i)}.png">`,
    );
    const r = sanitize(many.join(""), new Map());
    expect(r.loadableImages).toBe(REMOTE_IMAGES.perMessage);
    expect(r.blockedImages).toBe(REMOTE_IMAGES.perMessage + 5);
  });

  it("gives the view its sender key only when there is something to load", () => {
    const loadable = buildMessageView(email('<img src="https://c.example.org/a.png">'), (h) => sanitize(h, new Map()));
    const passed = {
      spf: { result: "none", detail: null, domain: null },
      dkim: { result: "none", detail: null, domain: null },
      dmarc: { result: "pass", detail: null, domain: "shop.example" },
    };
    expect(withSenderKey(loadable, SECRET, "me@a.test", passed).senderKey).toBe(
      senderKey(SECRET, "me@a.test", "news@shop.example"),
    );
    const none = buildMessageView(email("<p>Hello</p>"), (h) => sanitize(h, new Map()));
    expect(withSenderKey(none, SECRET, "me@a.test", null).senderKey).toBeNull();
    const noSender = { ...loadable, from: [] };
    expect(withSenderKey(noSender, SECRET, "me@a.test", null).senderKey).toBeNull();
  });

  it("gives a sender key only for a From our own results verify", () => {
    const loadable = buildMessageView(email('<img src="https://c.example.org/a.png">'), (h) => sanitize(h, new Map()));
    const check = (result: string, domain: string | null) => ({ result, detail: null, domain });
    const none = check("none", null);
    const auth = (dmarc: ReturnType<typeof check>, dkim: ReturnType<typeof check>) => ({ spf: none, dkim, dmarc });
    const key = (a: Parameters<typeof withSenderKey>[3]) => withSenderKey(loadable, SECRET, "me@a.test", a);
    expect(key(auth(check("pass", "shop.example"), none)).senderVerified).toBe(true);
    expect(key(auth(none, check("pass", "shop.example"))).senderKey).not.toBeNull();
    // DKIM for a parent domain aligns; another domain's signature doesn't.
    expect(senderVerified("news@mail.shop.example", auth(none, check("pass", "shop.example")))).toBe(true);
    expect(key(auth(none, check("pass", "evil.example"))).senderKey).toBeNull();
    // A forged From: DMARC failed for the domain.
    const forged = key(auth(check("fail", "shop.example"), none));
    expect(forged.senderKey).toBeNull();
    expect(forged.senderVerified).toBe(false);
    // DMARC passed for some other domain than the From's.
    expect(key(auth(check("pass", "other.example"), none)).senderKey).toBeNull();
    // Results that couldn't be read, or none of ours (a copy forwarded by a redirect rule looks like that): not verified.
    expect(key(undefined).senderKey).toBeNull();
    expect(key(null).senderVerified).toBe(false);
  });

  it("gives a sender key for mail our server vouches was submitted here by its From (internal-mail marker)", () => {
    const loadable = buildMessageView(email('<img src="https://c.example.org/a.png">'), (h) => sanitize(h, new Map()));
    const internal = withSenderKey(loadable, SECRET, "me@a.test", null, true);
    expect(internal.senderVerified).toBe(true);
    expect(internal.senderKey).toBe(senderKey(SECRET, "me@a.test", "news@shop.example"));
    expect(senderVerified("news@shop.example", undefined, true)).toBe(true);
    // Without the marker, no results of ours is still not verified (the run-32 redirect case).
    expect(withSenderKey(loadable, SECRET, "me@a.test", null, false).senderVerified).toBe(false);
    expect(senderVerified("news@shop.example", null)).toBe(false);
    // Nothing to load: unchanged either way.
    const none = buildMessageView(email("<p>Hello</p>"), (h) => sanitize(h, new Map()));
    expect(withSenderKey(none, SECRET, "me@a.test", null, true).senderKey).toBeNull();
  });
});

describe("serveImage", () => {
  const ok: FetchResult = { ok: true, type: "image/png", bytes: PNG };
  const serve = (token: unknown, over: Partial<ServeDeps> = {}) =>
    serveImage(token, {
      secret: SECRET,
      binding: async () => MINE,
      fetch: async () => ok,
      ...over,
    });
  const link = () => signImageLink(SECRET, MINE, "https://cdn.example.org/a.png?uid=42") ?? "";

  it("answers 401 when signed out, before looking at the link", async () => {
    let fetched = false;
    const res = await serve(link(), {
      binding: async () => null,
      fetch: async () => {
        fetched = true;
        return ok;
      },
    });
    expect(res.status).toBe(401);
    expect(fetched).toBe(false);
  });

  it("answers 404 for a link another session or mailbox made, and for garbage", async () => {
    const theirs = signImageLink(SECRET, { sessionId: "sess-b", accountId: "acc-9" }, "https://c.example.org/a.png");
    for (const token of [theirs, "nope", 42, null, undefined, "x".repeat(10_000)]) {
      const res = await serve(token, {
        fetch: () => Promise.reject(new Error("must not fetch")),
      });
      expect(res.status).toBe(404);
    }
  });

  it("answers 410 for an expired link", async () => {
    const old = signImageLink(
      SECRET,
      MINE,
      "https://c.example.org/a.png",
      Date.now() - (IMAGE_LINK_TTL_SEC + 5) * 1000,
    );
    const res = await serve(old);
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: { code: "expired" } });
  });

  it("serves the image with headers that let it be nothing but an image", async () => {
    let asked = "";
    const res = await serve(link(), {
      fetch: async (url) => {
        asked = url;
        return ok;
      },
    });
    expect(asked).toBe("https://cdn.example.org/a.png?uid=42");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("set-cookie")).toBeNull();
    // Logged: the size, never the address.
    expect(JSON.stringify(logs)).not.toMatch(/cdn\.example|uid=42/);
    expect(logs.at(-1)).toMatchObject({ msg: "image proxy served", bytes: PNG.length });
  });

  it("answers 502 when the fetch is refused, logging only why", async () => {
    const res = await serve(link(), { fetch: async () => ({ ok: false, reason: "blocked_address" }) });
    expect(res.status).toBe(502);
    expect(logs.at(-1)).toMatchObject({ reason: "blocked_address" });
    expect(JSON.stringify(logs)).not.toMatch(/cdn\.example|uid=42/);
  });

  it("asks callers to retry when too many fetches are in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = async (): Promise<FetchResult> => {
      await gate;
      return ok;
    };
    // Spread over sessions so only the process-wide limit applies.
    const as = (i: number) => {
      const b = { sessionId: `s${String(i)}`, accountId: MINE.accountId };
      return serve(signImageLink(SECRET, b, "https://cdn.example.org/a.png") ?? "", {
        fetch: slow,
        binding: async () => b,
      });
    };
    const busy = Array.from({ length: MAX_IMAGE_FETCHES }, (_, i) => as(i));
    const extra = await serve(link());
    expect(extra.status).toBe(429);
    expect(extra.headers.get("retry-after")).toBe("1");
    release();
    expect((await Promise.all(busy)).map((r) => r.status)).toEqual(Array(MAX_IMAGE_FETCHES).fill(200));
    // The slots are free again.
    expect((await serve(link())).status).toBe(200);
  });

  it("lets one session hold only a few fetches at once", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = async (): Promise<FetchResult> => {
      await gate;
      return ok;
    };
    const busy = Array.from({ length: MAX_SESSION_IMAGE_FETCHES }, () => serve(link(), { fetch: slow }));
    expect((await serve(link())).status).toBe(429);
    // Another reader still gets theirs.
    const other = { sessionId: "other", accountId: MINE.accountId };
    const res = await serve(signImageLink(SECRET, other, "https://cdn.example.org/a.png") ?? "", {
      binding: async () => other,
    });
    expect(res.status).toBe(200);
    release();
    await Promise.all(busy);
    expect((await serve(link())).status).toBe(200);
  });
});
