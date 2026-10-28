// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_HEADER,
  BLOCKED_NOTICES,
  blockedNoticeFor,
  BodyTooLargeError,
  MAX_UPLOADS,
  noAccount,
  readCappedBytes,
  shownAccount,
  withUploadSlot,
} from "./http";

describe("upload slots and capped bodies", () => {
  it("runs at most MAX_UPLOADS uploads at once and asks the rest to retry", async () => {
    const releases: (() => void)[] = [];
    const running = Array.from({ length: MAX_UPLOADS }, () =>
      withUploadSlot(
        () =>
          new Promise<Response>((resolve) => {
            releases.push(() => {
              resolve(new Response("ok"));
            });
          }),
      ),
    );
    const refused = await withUploadSlot(async () => new Response("should not run"));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("2");
    for (const r of releases) r();
    expect((await Promise.all(running)).map((r) => r.status)).toEqual(Array(MAX_UPLOADS).fill(200));
    // Slots free up again, also after a failure.
    await expect(withUploadSlot(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await withUploadSlot(async () => new Response("again"))).status).toBe(200);
  });

  it("reads a body once into one buffer and refuses more than the cap", async () => {
    const req = (body: Uint8Array<ArrayBuffer>) => new Request("http://x/", { method: "POST", body });
    const bytes = await readCappedBytes(req(new Uint8Array([1, 2, 3])), 10);
    expect([...bytes]).toEqual([1, 2, 3]);
    await expect(readCappedBytes(req(new Uint8Array(11)), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect((await readCappedBytes(new Request("http://x/"), 10)).byteLength).toBe(0);
  });
});

describe("the account a contacts change is for", () => {
  const req = (v?: string) => new Request("http://x/", { headers: v === undefined ? {} : { [ACCOUNT_HEADER]: v } });

  it("reads a plain id from the header and refuses anything else", async () => {
    expect(shownAccount(req("a1_B-2"))).toBe("a1_B-2");
    expect(shownAccount(req())).toBeNull();
    expect(shownAccount(req(""))).toBeNull();
    expect(shownAccount(req("a b"))).toBeNull();
    expect(shownAccount(req("x".repeat(256)))).toBeNull();
    const res = noAccount();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: "Reload the page and try again." } });
  });
});

describe("why a mailbox can't use the webmail", () => {
  it("maps a notice cookie or reason to its message, refusing anything else", () => {
    expect(blockedNoticeFor("person_suspended")).toBe(BLOCKED_NOTICES.person_suspended);
    expect(blockedNoticeFor("deleting")).toBe(BLOCKED_NOTICES.deleting);
    expect(blockedNoticeFor("gone")).toBe(BLOCKED_NOTICES.gone);
    // The older notice value still means a suspended mailbox.
    expect(blockedNoticeFor("unavailable")).toBe(BLOCKED_NOTICES.suspended);
    expect(blockedNoticeFor(undefined)).toBeNull();
    expect(blockedNoticeFor("toString")).toBeNull();
    expect(blockedNoticeFor("<b>")).toBeNull();
  });
});
