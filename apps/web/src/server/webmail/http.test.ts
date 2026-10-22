// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { BodyTooLargeError, MAX_UPLOADS, readCappedBytes, withUploadSlot } from "./http";

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
