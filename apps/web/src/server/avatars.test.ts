// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, ANONYMOUS, systemClock, type UserActor, ValidationError } from "@anhourmail/core";
import { MAX_AVATAR_UPLOAD_BYTES, type StoredAvatar } from "@anhourmail/core/avatars";
import { memoryMailer } from "@anhourmail/adapters/mail";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { GET as photoGet } from "../app/api/avatars/[kind]/[id]/route";
import { DELETE as ownDelete, GET as ownGet, POST as ownPost } from "../app/api/me/avatar/route";
import {
  avatarOwnerParam,
  avatarResponse,
  MAX_AVATAR_UPLOADS,
  setAvatarImagesForTests,
  withAvatarUpload,
} from "./avatars";
import { setContainerForTests } from "./container";
import { resetEnvForTests } from "./env";

let viewer: Actor = ANONYMOUS;
vi.mock("./auth/actor", () => ({ getActor: async () => viewer }));

const WEBP = new TextEncoder().encode("RIFF\u0010\u0000\u0000\u0000WEBPVP8 data");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const SHA = "ab".repeat(32);
const VERSION = SHA.slice(0, 16);
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const photo = (id: string): StoredAvatar => ({
  owner: { kind: "person", id },
  contentType: "image/webp",
  bytes: WEBP,
  sha256: SHA,
  updatedAt: new Date(0),
});

const member = (id: string, role: "owner" | "member"): UserActor => ({
  kind: "user",
  userId: id,
  email: `${id}@a.test`,
  platformRoles: [],
  memberships: [{ accountId: ACCOUNT, role }],
  suspended: false,
});

let uow: MemoryUnitOfWork;
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const APP = "http://localhost:43200";

beforeEach(() => {
  vi.stubEnv("APP_URL", APP);
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  resetEnvForTests();
  uow = new MemoryUnitOfWork();
  for (const [id, role] of [
    ["sam", "member"],
    ["olu", "owner"],
  ] as const) {
    uow.state.userEmails[id] = `${id}@a.test`;
    uow.state.memberships.push({ userId: id, accountId: ACCOUNT, role });
  }
  uow.state.accounts.push({ id: ACCOUNT, name: "A", plan: "plus" });
  uow.state.userEmails.stranger = "stranger@b.test";
  uow.state.avatars.push(photo("sam"));
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer: memoryMailer(),
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
    breaches: { check: () => Promise.resolve("unknown") },
  });
  setAvatarImagesForTests({ normalise: async () => ({ ok: true, contentType: "image/webp", bytes: WEBP }) });
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setContainerForTests(null);
  setAvatarImagesForTests(null);
  setLogSinkForTests(null);
  viewer = ANONYMOUS;
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("avatarResponse", () => {
  it("serves a sandboxed, nosniff WebP, cached for a year only under its current version", async () => {
    const current = avatarResponse(photo("sam"), new Request(`${APP}/api/avatars/person/sam?v=${VERSION}`));
    expect(current.status).toBe(200);
    expect(Object.fromEntries(current.headers)).toMatchObject({
      "content-type": "image/webp",
      "content-length": String(WEBP.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "content-disposition": "inline",
      "cache-control": "private, max-age=31536000, immutable",
      etag: `"${VERSION}"`,
    });
    expect(new Uint8Array(await current.arrayBuffer())).toEqual(WEBP);
    const stale = avatarResponse(photo("sam"), new Request(`${APP}/api/avatars/person/sam?v=old`));
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");
    const revalidated = avatarResponse(
      photo("sam"),
      new Request(`${APP}/api/avatars/person/sam`, { headers: { "if-none-match": `"${VERSION}"` } }),
    );
    expect(revalidated.status).toBe(304);
  });
});

describe("upload helpers", () => {
  it("reads the raw body up to the cap and refuses more", async () => {
    let got: Uint8Array | null = null;
    const small = new Request(`${APP}/x`, { method: "POST", body: PNG });
    await withAvatarUpload(small, async (bytes) => {
      got = bytes;
      return new Response(null, { status: 204 });
    });
    expect(got).toEqual(PNG);
    const big = new Request(`${APP}/x`, { method: "POST", body: new Uint8Array(MAX_AVATAR_UPLOAD_BYTES + 1) });
    await expect(withAvatarUpload(big, async () => new Response(null))).rejects.toBeInstanceOf(ValidationError);
  });

  it("holds at most MAX_AVATAR_UPLOADS uploads at once (429 beyond)", async () => {
    const release: (() => void)[] = [];
    const held = Array.from({ length: MAX_AVATAR_UPLOADS }, () =>
      withAvatarUpload(new Request(`${APP}/x`, { method: "POST", body: PNG }), async () => {
        await new Promise<void>((r) => release.push(r));
        return new Response(null, { status: 204 });
      }),
    );
    await vi.waitFor(() => {
      expect(release).toHaveLength(MAX_AVATAR_UPLOADS);
    });
    const extra = await withAvatarUpload(
      new Request(`${APP}/x`, { method: "POST", body: PNG }),
      async () => new Response(null),
    );
    expect(extra.status).toBe(429);
    for (const r of release) r();
    await Promise.all(held);
  });

  it("an upload from someone signed out is refused before its body is read", async () => {
    let pulled = false;
    // highWaterMark 0: nothing is pulled until someone reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(PNG);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const res = await ownPost(
      new Request(`${APP}/api/me/avatar`, {
        method: "POST",
        headers: { origin: APP, host: "localhost:43200", "content-type": "image/png" },
        body,
        duplex: "half",
      } as RequestInit),
      params({}),
    );
    expect(res.status).toBe(401);
    expect(pulled).toBe(false);
  });

  it("names a photo only with a known kind and an id", () => {
    expect(avatarOwnerParam({ kind: "person", id: "sam" })).toEqual({ kind: "person", id: "sam" });
    expect(avatarOwnerParam({ kind: "mailbox", id: "m" })).toEqual({ kind: "mailbox", id: "m" });
    expect(avatarOwnerParam({ kind: "file", id: "sam" })).toBeNull();
    expect(avatarOwnerParam({ kind: "person" })).toBeNull();
  });
});

describe("console photo routes", () => {
  it("GET /api/avatars/:kind/:id keeps its cache header and policy; 401, 403 and 404 otherwise", async () => {
    const get = (kind: string, id: string, v = VERSION) =>
      photoGet(new Request(`${APP}/api/avatars/${kind}/${id}?v=${v}`), params({ kind, id }));
    expect((await get("person", "sam")).status).toBe(401);
    viewer = member("olu", "owner");
    const ok = await get("person", "sam");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(ok.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    // A Member can't see colleagues (no member.read): 403 inside the account; someone outside: 404.
    viewer = { ...member("stranger", "member"), memberships: [] };
    expect((await get("person", "sam")).status).toBe(404);
    viewer = member("x", "member");
    uow.state.memberships.push({ userId: "x", accountId: ACCOUNT, role: "member" });
    const denied = await get("person", "sam");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    viewer = member("olu", "owner");
    expect((await get("nonsense", "sam")).status).toBe(404);
    expect((await get("person", "olu")).status).toBe(404);
  });

  it("POST, GET and DELETE /api/me/avatar: the person's own photo, audited", async () => {
    viewer = member("olu", "owner");
    const upload = await ownPost(
      new Request(`${APP}/api/me/avatar`, {
        method: "POST",
        headers: { origin: APP, host: "localhost:43200", "content-type": "image/png" },
        body: PNG,
      }),
      params({}),
    );
    expect(upload.status).toBe(200);
    const { data } = (await upload.json()) as { data: { url: string } };
    expect(data.url).toMatch(/^\/api\/avatars\/person\/olu\?v=[0-9a-f]{16}$/);
    const own = await ownGet(new Request(`${APP}/api/me/avatar`), params({}));
    expect(((await own.json()) as { data: { url: string } }).data.url).toBe(data.url);
    expect(uow.state.audit.map((e) => e.action)).toContain("account.avatar_changed");

    const bad = await ownPost(
      new Request(`${APP}/api/me/avatar`, {
        method: "POST",
        headers: { origin: APP, host: "localhost:43200", "content-type": "image/svg+xml" },
        body: "<svg xmlns='http://www.w3.org/2000/svg'/>",
      }),
      params({}),
    );
    expect(bad.status).toBe(400);

    const removed = await ownDelete(
      new Request(`${APP}/api/me/avatar`, { method: "DELETE", headers: { origin: APP, host: "localhost:43200" } }),
      params({}),
    );
    expect(((await removed.json()) as { data: { url: null } }).data.url).toBeNull();
    expect(uow.state.avatars.some((a) => a.owner.id === "olu")).toBe(false);
  });
});
