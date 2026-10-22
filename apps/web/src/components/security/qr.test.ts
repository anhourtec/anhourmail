// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { qrMatrix, qrPath } from "./qr";

const finderAt = (m: boolean[][], x0: number, y0: number) =>
  Array.from({ length: 7 }, (_, y) =>
    Array.from({ length: 7 }, (_, x) => {
      const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      return m[y0 + y]?.[x0 + x] === (d !== 2);
    }).every(Boolean),
  ).every(Boolean);

const fingerprint = (m: boolean[][]) =>
  createHash("sha256")
    .update(m.map((r) => r.map((c) => (c ? "1" : "0")).join("")).join("\n"))
    .digest("hex")
    .slice(0, 16);

describe("QR encoder", () => {
  it("picks the smallest version and draws the three finder patterns", () => {
    const small = qrMatrix("A");
    expect(small).toHaveLength(21);
    const uri =
      "otpauth://totp/AnhourMail:kim%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDG&issuer=AnhourMail&digits=6&period=30";
    const m = qrMatrix(uri);
    expect(m.length).toBe(4 * 8 + 17);
    const n = m.length;
    expect(finderAt(m, 0, 0) && finderAt(m, n - 7, 0) && finderAt(m, 0, n - 7)).toBe(true);
    // The dark module next to the bottom-left format area is always set.
    expect(m[n - 8]?.[8]).toBe(true);
    expect(qrMatrix("x".repeat(2300))).toHaveLength(40 * 4 + 17);
    expect(() => qrMatrix("x".repeat(3000))).toThrow(RangeError);
  });

  it("is stable (these matrices were checked with an independent decoder)", () => {
    expect(fingerprint(qrMatrix("Hello, world!"))).toMatchInlineSnapshot(`"60e12c4292e42968"`);
    expect(
      fingerprint(
        qrMatrix(
          "otpauth://totp/AnhourMail:kim%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDG&issuer=AnhourMail&digits=6&period=30",
        ),
      ),
    ).toMatchInlineSnapshot(`"8b65f7f43f4d0382"`);
  });

  it("draws one path of unit squares inside the quiet zone", () => {
    const path = qrPath([
      [true, false],
      [false, true],
    ]);
    expect(path).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");
    expect(qrPath([[true]], 0)).toBe("M0 0h1v1h-1z");
  });
});
