// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { AVATAR } from "@anhourmail/shared/profile";

import { ACCOUNT_A, ACCOUNT_B, anonymous, deps, fixedClock, req, user } from "../__tests__/helpers";
import type { Actor } from "../actor";
import {
  BusyError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import type { Mailbox } from "../mailboxes";
import { OTHER_ACCOUNT_PROFILE, ROLE_PROFILE } from "../people/profile-service";
import {
  avatarPath,
  avatarVersion,
  isAvatarId,
  MAX_AVATAR_UPLOAD_BYTES,
  sniffImage,
  type StoredAvatar,
} from "./entity";
import type { ImageNormaliser, NormalisedImage } from "./repository";
import {
  WEBMAIL_NOT_MEMBER,
  WEBMAIL_OTHER_ACCOUNT,
  accountAvatars,
  avatarImage,
  ownAvatar,
  PERSON_MAILBOX,
  prepareAvatar,
  removeMailboxAvatar,
  removeOwnAvatar,
  removePersonAvatar,
  removeWebmailAvatar,
  setMailboxAvatar,
  setOwnAvatar,
  setPersonAvatar,
  setWebmailAvatar,
  webmailAvatarImage,
  webmailAvatarLookup,
  webmailOwnAvatars,
} from "./service";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6]);
const WEBP = new TextEncoder().encode("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ");
const text = (s: string) => new TextEncoder().encode(s);

/** Stands in for the sharp adapter: counts decodes and answers a fixed WebP (or what the test asks for). */
function fakeImages(answer?: NormalisedImage): ImageNormaliser & { calls: number } {
  const fake = {
    calls: 0,
    normalise: async (input: Uint8Array): Promise<NormalisedImage> => {
      fake.calls += 1;
      return answer ?? { ok: true, contentType: "image/webp", bytes: new Uint8Array([...WEBP, input.length % 251]) };
    },
  };
  return fake;
}

const MBX_SHARED = "aaaaaaaa-0000-4000-8000-000000000001";
const MBX_KID = "aaaaaaaa-0000-4000-8000-000000000002";
const MBX_B = "bbbbbbbb-0000-4000-8000-000000000001";
const MBX_SOLO = "aaaaaaaa-0000-4000-8000-000000000003";
/** A mailbox in A still linked to `gone`, who was removed from A (`removeMember` keeps the owner link). */
const MBX_GONE = "aaaaaaaa-0000-4000-8000-000000000004";

const mailbox = (id: string, accountId: string, address: string, userId: string | null): Mailbox => ({
  id,
  accountId,
  userId,
  address,
  status: "active",
  quotaBytes: 1024,
  stalwartId: null,
  lastError: null,
  purgeAfter: null,
  createdAt: new Date(0),
});

/**
 * Account A: an Owner, a User Admin, an Auditor and two Members (`solo` only in A, `kid` also in B), a shared mailbox
 * without a person and `kid`'s mailbox. Account B: its Owner and a shared mailbox. Staff: a support admin.
 */
function world() {
  const d = deps(fixedClock("2026-10-29T12:00:00Z"));
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  const people: [string, "owner" | "user_admin" | "auditor" | "member" | "domain_admin", string][] = [
    ["owner", "owner", ACCOUNT_A],
    ["admin", "user_admin", ACCOUNT_A],
    ["domains", "domain_admin", ACCOUNT_A],
    ["auditor", "auditor", ACCOUNT_A],
    ["kid", "member", ACCOUNT_A],
    ["solo", "member", ACCOUNT_A],
    ["kid", "member", ACCOUNT_B],
    ["owner-b", "owner", ACCOUNT_B],
    ["gone", "member", ACCOUNT_B],
  ];
  for (const [id, role, accountId] of people) {
    s.userEmails[id] = `${id}@a.test`;
    s.memberships.push({ userId: id, accountId, role });
  }
  s.userEmails.staff = "staff@anhourtec.test";
  s.mailboxes.push(
    mailbox(MBX_SHARED, ACCOUNT_A, "hello@a.test", null),
    mailbox(MBX_KID, ACCOUNT_A, "kid@a.test", "kid"),
    mailbox(MBX_B, ACCOUNT_B, "team@b.test", null),
    mailbox(MBX_SOLO, ACCOUNT_A, "solo@a.test", "solo"),
    mailbox(MBX_GONE, ACCOUNT_A, "gone@a.test", "gone"),
  );
  const as = (id: string): Actor => {
    const u = user({
      id,
      account: s.memberships
        .filter((m) => m.userId === id)
        .map((m) => [m.accountId, m.role] as [string, typeof m.role]),
    });
    return { ...u, email: s.userEmails[id] ?? u.email };
  };
  const staff: Actor = { ...user({ id: "staff", platform: ["support_admin"] }), email: "staff@anhourtec.test" };
  const audit = (action: string) => s.audit.filter((e) => e.action === action);
  return { d, s, as, staff, audit };
}

const stored = (s: { avatars: StoredAvatar[] }, kind: string, id: string) =>
  s.avatars.find((a) => a.owner.kind === kind && a.owner.id === id);

describe("avatar entity", () => {
  it("sniffs PNG, JPEG and WebP by their bytes, nothing else", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(JPEG)).toBe("jpeg");
    expect(sniffImage(WEBP)).toBe("webp");
    expect(sniffImage(text("GIF89a...."))).toBeNull();
    expect(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(text("<!doctype html><script>x</script>"))).toBeNull();
    expect(sniffImage(text("RIFF....AVI LIST"))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });

  it("versions, ids and paths", () => {
    expect(avatarVersion("0123456789abcdef0123")).toBe("0123456789abcdef");
    expect(isAvatarId("user_123-abc")).toBe(true);
    expect(isAvatarId("../etc")).toBe(false);
    expect(isAvatarId("x".repeat(65))).toBe(false);
    expect(avatarPath("/api/avatars", { kind: "person", id: "u1", version: "abc" })).toBe(
      "/api/avatars/person/u1?v=abc",
    );
    expect(avatarPath("/api/webmail/avatars", { kind: "mailbox", id: MBX_SHARED, version: "v" })).toBe(
      `/api/webmail/avatars/mailbox/${MBX_SHARED}?v=v`,
    );
  });
});

describe("prepareAvatar", () => {
  it("refuses empty, oversized and non-raster uploads before decoding", async () => {
    const images = fakeImages();
    await expect(prepareAvatar(images, new Uint8Array())).rejects.toThrow("Choose an image.");
    const big = new Uint8Array(MAX_AVATAR_UPLOAD_BYTES + 1);
    big.set(PNG);
    await expect(prepareAvatar(images, big)).rejects.toThrow(`up to ${String(AVATAR.maxUploadMb)} MB`);
    for (const bad of [
      text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
      text("<html><body><img src=x onerror=alert(1)></body></html>"),
      text("GIF89a\u0001\u0000\u0001\u0000"),
      // A polyglot that starts as HTML and carries a PNG later: still not an image by its first bytes.
      new Uint8Array([...text("<script>alert(1)</script>"), ...PNG]),
    ]) {
      await expect(prepareAvatar(images, bad)).rejects.toThrow("Use a PNG, JPEG or WebP image.");
    }
    expect(images.calls).toBe(0);
  });

  it("maps the decoder's refusals and checks its output", async () => {
    const cases: [NormalisedImage, string | typeof BusyError][] = [
      [{ ok: false, reason: "animated" }, "still image"],
      [{ ok: false, reason: "too_small" }, `at least ${String(AVATAR.minSide)} pixels`],
      [{ ok: false, reason: "too_large" }, `at most ${String(AVATAR.maxSide)} pixels`],
      [{ ok: false, reason: "decode_failed" }, "couldn't be read"],
      [{ ok: false, reason: "not_image" }, "PNG, JPEG or WebP"],
      [{ ok: false, reason: "busy" }, BusyError],
      // The decoder answered something that isn't a WebP, or too large: never stored.
      [{ ok: true, contentType: "image/webp", bytes: PNG }, "couldn't be read"],
      [
        { ok: true, contentType: "image/webp", bytes: new Uint8Array([...WEBP, ...new Uint8Array(300_000)]) },
        "couldn't be read",
      ],
    ];
    for (const [answer, expected] of cases) {
      await expect(prepareAvatar(fakeImages(answer), PNG)).rejects.toThrow(expected);
    }
    const ok = await prepareAvatar(fakeImages(), JPEG);
    expect(ok.contentType).toBe("image/webp");
    expect(ok.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("own photo (console Profile page)", () => {
  it("sets and removes the person's photo, audited in each of their accounts without the image", async () => {
    const { d, s, as, audit } = world();
    const ref = await setOwnAvatar(d, fakeImages(), as("kid"), PNG, req);
    expect(ref).toMatchObject({ kind: "person", id: "kid" });
    expect(ref?.version).toHaveLength(16);
    expect(stored(s, "person", "kid")?.contentType).toBe("image/webp");
    expect(await ownAvatar(d, as("kid"))).toEqual(ref);

    const changed = audit("account.avatar_changed");
    expect(changed.map((e) => e.scope).sort()).toEqual([`account:${ACCOUNT_A}`, `account:${ACCOUNT_B}`].sort());
    for (const e of changed) {
      expect(e.result).toBe("success");
      expect(e.target).toEqual({ type: "person", id: "kid", label: "kid@a.test" });
      expect(e.meta).toEqual({ self: true, bytes: (stored(s, "person", "kid")?.bytes ?? []).length });
      expect(JSON.stringify(e)).not.toContain(stored(s, "person", "kid")?.sha256 ?? "x");
    }

    expect(await removeOwnAvatar(d, as("kid"), req)).toBeNull();
    expect(stored(s, "person", "kid")).toBeUndefined();
    expect(await ownAvatar(d, as("kid"))).toBeNull();
    expect(audit("account.avatar_removed").map((e) => e.meta)).toEqual([
      { self: true, removed: true },
      { self: true, removed: true },
    ]);
  });

  it("works for someone in no account (platform log) and refuses anonymous callers", async () => {
    const { d, staff, audit } = world();
    expect(await setOwnAvatar(d, fakeImages(), staff, PNG, req)).toMatchObject({ kind: "person", id: "staff" });
    expect(audit("account.avatar_changed")[0]?.scope).toBe("platform");
    await expect(setOwnAvatar(d, fakeImages(), anonymous, PNG, req)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(ownAvatar(d, anonymous)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("a bad file is refused and audited as failed, with nothing stored", async () => {
    const { d, s, as, audit } = world();
    await expect(setOwnAvatar(d, fakeImages(), as("solo"), text("<svg/>"), req)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(s.avatars).toEqual([]);
    expect(audit("account.avatar_changed").map((e) => [e.result, e.errorCode])).toEqual([["failed", "bad_request"]]);
  });
});

describe("a person's photo (People page)", () => {
  it("an admin may set and remove a Member's photo (only in that account's log)", async () => {
    const { d, s, as, audit } = world();
    expect(await setPersonAvatar(d, fakeImages(), as("admin"), ACCOUNT_A, "solo", PNG, req)).toMatchObject({
      kind: "person",
      id: "solo",
    });
    expect(stored(s, "person", "solo")).toBeDefined();
    expect(audit("account.avatar_changed").map((e) => [e.scope, e.meta.self])).toEqual([
      [`account:${ACCOUNT_A}`, false],
    ]);
    await removePersonAvatar(d, as("admin"), ACCOUNT_A, "solo", req);
    expect(stored(s, "person", "solo")).toBeUndefined();
  });

  it("follows the profile rule: role and other-account refusals are 403, audited as denied, with no decode", async () => {
    const { d, s, as, audit } = world();
    const images = fakeImages();
    await expect(setPersonAvatar(d, images, as("admin"), ACCOUNT_A, "owner", PNG, req)).rejects.toThrow(ROLE_PROFILE);
    await expect(setPersonAvatar(d, images, as("owner"), ACCOUNT_A, "kid", PNG, req)).rejects.toThrow(
      OTHER_ACCOUNT_PROFILE,
    );
    await expect(setPersonAvatar(d, images, as("auditor"), ACCOUNT_A, "solo", PNG, req)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(setPersonAvatar(d, images, as("solo"), ACCOUNT_A, "kid", PNG, req)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(images.calls).toBe(0);
    expect(s.avatars).toEqual([]);
    expect(audit("account.avatar_changed").map((e) => [e.result, e.errorCode])).toEqual([
      ["denied", "forbidden"],
      ["denied", "other_account"],
      ["denied", "forbidden"],
      ["denied", "forbidden"],
    ]);
  });

  it("someone with a platform role, even in this account only, is refused like someone in another account", async () => {
    const { d, s, as, audit } = world();
    s.platformRoles.push({ userId: "solo", role: "global_admin" });
    const images = fakeImages();
    await expect(setPersonAvatar(d, images, as("owner"), ACCOUNT_A, "solo", PNG, req)).rejects.toThrow(
      OTHER_ACCOUNT_PROFILE,
    );
    await expect(removePersonAvatar(d, as("owner"), ACCOUNT_A, "solo", req)).rejects.toThrow(OTHER_ACCOUNT_PROFILE);
    expect(images.calls).toBe(0);
    expect(s.avatars).toEqual([]);
    expect(
      [...audit("account.avatar_changed"), ...audit("account.avatar_removed")].map((e) => [e.result, e.errorCode]),
    ).toEqual([
      ["denied", "other_account"],
      ["denied", "other_account"],
    ]);
    // Their own photo is still theirs to change.
    expect(await setPersonAvatar(d, images, as("solo"), ACCOUNT_A, "solo", PNG, req)).toMatchObject({ kind: "person" });
  });

  it("someone outside the account, or not in it, is a 404 (never confirms them)", async () => {
    const { d, as } = world();
    const images = fakeImages();
    await expect(setPersonAvatar(d, images, as("owner-b"), ACCOUNT_A, "solo", PNG, req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(setPersonAvatar(d, images, as("owner"), ACCOUNT_A, "owner-b", PNG, req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(setPersonAvatar(d, images, as("owner"), ACCOUNT_A, "x".repeat(300), PNG, req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(removePersonAvatar(d, as("owner-b"), ACCOUNT_A, "solo", req)).rejects.toBeInstanceOf(NotFoundError);
    expect(images.calls).toBe(0);
  });

  it("the person may always set their own here, copied to their other accounts", async () => {
    const { d, as, audit } = world();
    await setPersonAvatar(d, fakeImages(), as("kid"), ACCOUNT_A, "kid", PNG, req);
    expect(audit("account.avatar_changed").map((e) => e.scope)).toEqual([
      `account:${ACCOUNT_A}`,
      `account:${ACCOUNT_B}`,
    ]);
    // …but only from an account they're in.
    await expect(setPersonAvatar(d, fakeImages(), as("solo"), ACCOUNT_B, "solo", PNG, req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("a mailbox's photo (Mailboxes page)", () => {
  it("admins with mailbox.manage set and remove a person-less mailbox's photo", async () => {
    const { d, s, as, audit } = world();
    expect(await setMailboxAvatar(d, fakeImages(), as("admin"), ACCOUNT_A, MBX_SHARED, PNG, req)).toMatchObject({
      kind: "mailbox",
      id: MBX_SHARED,
    });
    expect(audit("mailbox.avatar_changed")[0]?.target).toEqual({
      type: "mailbox",
      id: MBX_SHARED,
      label: "hello@a.test",
    });
    await removeMailboxAvatar(d, as("owner"), ACCOUNT_A, MBX_SHARED, req);
    expect(stored(s, "mailbox", MBX_SHARED)).toBeUndefined();
    expect(audit("mailbox.avatar_removed")).toHaveLength(1);
  });

  it("a mailbox with a person is refused (409); another account's mailbox is 404; no permission is 403", async () => {
    const { d, as } = world();
    await expect(setMailboxAvatar(d, fakeImages(), as("owner"), ACCOUNT_A, MBX_KID, PNG, req)).rejects.toThrow(
      PERSON_MAILBOX,
    );
    await expect(setMailboxAvatar(d, fakeImages(), as("owner"), ACCOUNT_A, MBX_B, PNG, req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      setMailboxAvatar(d, fakeImages(), as("owner"), ACCOUNT_A, "not-a-uuid", PNG, req),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      setMailboxAvatar(d, fakeImages(), as("owner-b"), ACCOUNT_A, MBX_SHARED, PNG, req),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      setMailboxAvatar(d, fakeImages(), as("domains"), ACCOUNT_A, MBX_SHARED, PNG, req),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeMailboxAvatar(d, as("solo"), ACCOUNT_A, MBX_SHARED, req)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a mailbox that changed hands between the check and the write is a conflict", async () => {
    const { d, s, as } = world();
    const images: ImageNormaliser = {
      normalise: async () => {
        const m = s.mailboxes.find((x) => x.id === MBX_SHARED);
        if (m) m.userId = "solo";
        return { ok: true, contentType: "image/webp", bytes: WEBP };
      },
    };
    await expect(setMailboxAvatar(d, images, as("owner"), ACCOUNT_A, MBX_SHARED, PNG, req)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(s.avatars).toEqual([]);
  });
});

describe("the webmail", () => {
  it("a person's mailbox changes the person's photo (the console's) when they are in that account only", async () => {
    const { d, s, as, audit } = world();
    const ref = await setWebmailAvatar(d, fakeImages(), "SOLO@a.test", PNG, req);
    expect(ref).toMatchObject({ kind: "person", id: "solo" });
    expect(await ownAvatar(d, as("solo"))).toEqual(ref);
    expect(audit("account.avatar_changed").map((e) => [e.scope, e.target.label, e.meta, e.actor.type])).toEqual([
      [
        `account:${ACCOUNT_A}`,
        "solo@a.test",
        { self: true, via: "webmail", bytes: stored(s, "person", "solo")?.bytes.length },
        "system",
      ],
    ]);
    await removeWebmailAvatar(d, "solo@a.test", req);
    expect(stored(s, "person", "solo")).toBeUndefined();
  });

  it("a person also in another account is refused (403, denied, no decode): only they change it, in the console", async () => {
    // An admin of A can reset kid's mailbox password and sign in to its webmail: that must not change what B shows.
    const { d, s, audit } = world();
    const images = fakeImages();
    await expect(setWebmailAvatar(d, images, "kid@a.test", PNG, req)).rejects.toThrow(WEBMAIL_OTHER_ACCOUNT);
    await expect(removeWebmailAvatar(d, "kid@a.test", req)).rejects.toThrow(WEBMAIL_OTHER_ACCOUNT);
    expect(images.calls).toBe(0);
    expect(s.avatars).toEqual([]);
    expect(
      [...audit("account.avatar_changed"), ...audit("account.avatar_removed")].map((e) => [
        e.scope,
        e.result,
        e.errorCode,
      ]),
    ).toEqual([
      [`account:${ACCOUNT_A}`, "denied", "other_account"],
      [`account:${ACCOUNT_A}`, "denied", "other_account"],
    ]);
  });

  it("a person holding a platform role is refused from the webmail too, and their photo shows as not editable", async () => {
    const { d, s, audit } = world();
    s.platformRoles.push({ userId: "solo", role: "global_admin" });
    await expect(setWebmailAvatar(d, fakeImages(), "solo@a.test", PNG, req)).rejects.toThrow(WEBMAIL_OTHER_ACCOUNT);
    expect(s.avatars).toEqual([]);
    expect(audit("account.avatar_changed").map((e) => [e.result, e.errorCode])).toEqual([["denied", "other_account"]]);
    expect(await webmailOwnAvatars(d, ["solo@a.test"])).toEqual([
      { address: "solo@a.test", owner: { kind: "person", id: "solo" }, ref: null, editable: false },
    ]);
  });

  it("a mailbox whose person left its account can't change that person's photo", async () => {
    const { d, s, audit } = world();
    await expect(setWebmailAvatar(d, fakeImages(), "gone@a.test", PNG, req)).rejects.toThrow(WEBMAIL_NOT_MEMBER);
    expect(s.avatars).toEqual([]);
    expect(audit("account.avatar_changed").map((e) => [e.result, e.errorCode])).toEqual([["denied", "not_member"]]);
  });

  it("a shared mailbox changes its own photo", async () => {
    const { d, s, audit } = world();
    expect(await setWebmailAvatar(d, fakeImages(), "hello@a.test", PNG, req)).toMatchObject({
      kind: "mailbox",
      id: MBX_SHARED,
    });
    expect(audit("mailbox.avatar_changed")).toHaveLength(1);
    await removeWebmailAvatar(d, "hello@a.test", req);
    expect(s.avatars).toEqual([]);
    await expect(setWebmailAvatar(d, fakeImages(), "ghost@a.test", PNG, req)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("shows each session mailbox's photo, and looks up only addresses in the same accounts", async () => {
    const { d, as } = world();
    const kid = await setOwnAvatar(d, fakeImages(), as("kid"), PNG, req);
    const team = await setMailboxAvatar(d, fakeImages(), as("owner-b"), ACCOUNT_B, MBX_B, JPEG, req);
    const gone = await setOwnAvatar(d, fakeImages(), as("gone"), PNG, req);
    expect(gone).not.toBeNull();
    expect(
      await webmailOwnAvatars(d, ["kid@a.test", "hello@a.test", "solo@a.test", "gone@a.test", "ghost@a.test"]),
    ).toEqual([
      { address: "kid@a.test", owner: { kind: "person", id: "kid" }, ref: kid, editable: false },
      { address: "hello@a.test", owner: { kind: "mailbox", id: MBX_SHARED }, ref: null, editable: true },
      { address: "solo@a.test", owner: { kind: "person", id: "solo" }, ref: null, editable: true },
      // Its person left A: initials, and nothing to change here.
      { address: "gone@a.test", owner: null, ref: null, editable: false },
    ]);
    // From hello@a.test (account A): kid's photo yes, B's team mailbox no.
    expect(
      await webmailAvatarLookup(d, ["hello@a.test"], ["Kid@a.test", "team@b.test", "gone@a.test", "nobody@x.test"]),
    ).toEqual({ "kid@a.test": kid });
    expect(await webmailAvatarLookup(d, ["hello@a.test"], [])).toEqual({});
    expect(await webmailAvatarLookup(d, ["team@b.test"], ["team@b.test"])).toEqual({ "team@b.test": team });

    expect((await webmailAvatarImage(d, ["hello@a.test"], { kind: "person", id: "kid" })).contentType).toBe(
      "image/webp",
    );
    await expect(webmailAvatarImage(d, ["hello@a.test"], { kind: "mailbox", id: MBX_B })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(webmailAvatarImage(d, ["team@b.test"], { kind: "person", id: "solo" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(webmailAvatarImage(d, ["hello@a.test"], { kind: "person", id: "../x" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // kid is also in B: B's mailboxes may see kid's photo.
    expect(await webmailAvatarImage(d, ["team@b.test"], { kind: "person", id: "kid" })).toBeDefined();
    // gone left A (only their old mailbox's owner link remains): A's mailboxes no longer see their photo; B's do.
    await expect(webmailAvatarImage(d, ["hello@a.test"], { kind: "person", id: "gone" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await webmailAvatarImage(d, ["team@b.test"], { kind: "person", id: "gone" })).toBeDefined();
  });
});

describe("reading photos in the console", () => {
  it("accountAvatars: people with member.read, mailboxes with mailbox.read (a person's mailbox shows theirs)", async () => {
    const { d, as, staff } = world();
    const kid = await setOwnAvatar(d, fakeImages(), as("kid"), PNG, req);
    const shared = await setMailboxAvatar(d, fakeImages(), as("owner"), ACCOUNT_A, MBX_SHARED, JPEG, req);
    const both = { people: { kid: kid?.version }, mailboxes: { [MBX_SHARED]: shared?.version } };
    expect(await accountAvatars(d, as("admin"), ACCOUNT_A)).toEqual(both);
    expect(await accountAvatars(d, as("auditor"), ACCOUNT_A)).toEqual(both);
    expect(await accountAvatars(d, staff, ACCOUNT_A)).toEqual(both);
    expect(await accountAvatars(d, as("owner-b"), ACCOUNT_B)).toEqual({ people: { kid: kid?.version }, mailboxes: {} });
    // A former member's photo (their old mailbox in A still links to them) isn't A's to show.
    const gone = await setOwnAvatar(d, fakeImages(), as("gone"), PNG, req);
    expect(await accountAvatars(d, as("admin"), ACCOUNT_A)).toEqual(both);
    await expect(avatarImage(d, as("owner"), { kind: "person", id: "gone" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await accountAvatars(d, as("owner-b"), ACCOUNT_B)).toEqual({
      people: { kid: kid?.version, gone: gone?.version },
      mailboxes: {},
    });
    await expect(accountAvatars(d, as("solo"), ACCOUNT_A)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(accountAvatars(d, as("owner-b"), ACCOUNT_A)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("avatarImage: self, colleagues who may see people or mailboxes, staff; 403 inside, 404 outside", async () => {
    const { d, as, staff } = world();
    await setOwnAvatar(d, fakeImages(), as("solo"), PNG, req);
    await setMailboxAvatar(d, fakeImages(), as("owner"), ACCOUNT_A, MBX_SHARED, PNG, req);
    const solo = { kind: "person" as const, id: "solo" };
    const shared = { kind: "mailbox" as const, id: MBX_SHARED };
    for (const viewer of [as("solo"), as("admin"), as("auditor"), as("domains"), staff]) {
      expect((await avatarImage(d, viewer, solo)).owner).toEqual(solo);
    }
    expect((await avatarImage(d, as("domains"), shared)).owner).toEqual(shared);
    await expect(avatarImage(d, as("kid"), solo)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(avatarImage(d, as("kid"), shared)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(avatarImage(d, as("owner-b"), solo)).rejects.toBeInstanceOf(NotFoundError);
    await expect(avatarImage(d, as("owner-b"), shared)).rejects.toBeInstanceOf(NotFoundError);
    await expect(avatarImage(d, anonymous, solo)).rejects.toBeInstanceOf(UnauthenticatedError);
    // No photo, unknown owner, malformed id: all 404.
    await expect(avatarImage(d, as("owner"), { kind: "person", id: "kid" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(avatarImage(d, staff, { kind: "mailbox", id: MBX_B })).rejects.toBeInstanceOf(NotFoundError);
    await expect(avatarImage(d, staff, { kind: "person", id: "a/b" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(avatarImage(d, staff, null)).rejects.toBeInstanceOf(NotFoundError);
    await expect(avatarImage(d, anonymous, null)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(avatarImage(d, { ...as("solo"), suspended: true } as Actor, solo)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
