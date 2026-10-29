// SPDX-License-Identifier: AGPL-3.0-only
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { prepareAvatar, sniffImage } from "@anhourmail/core/avatars";
import { AVATAR } from "@anhourmail/shared/profile";

import { sharpImageNormaliser } from "./index";

const spec = { size: AVATAR.size, minSide: AVATAR.minSide, maxSide: AVATAR.maxSide };
const solid = (width: number, height: number, background = { r: 200, g: 30, b: 30 }) =>
  sharp({ create: { width, height, channels: 3, background } });

describe("sharpImageNormaliser", () => {
  const images = sharpImageNormaliser();

  it("re-encodes PNG, JPEG and WebP as a square WebP of the shared size", async () => {
    for (const input of [
      await solid(300, 120).png().toBuffer(),
      await solid(120, 300).jpeg().toBuffer(),
      await solid(64, 64).webp().toBuffer(),
    ]) {
      const out = await images.normalise(new Uint8Array(input), spec);
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect(out.contentType).toBe("image/webp");
      expect(sniffImage(out.bytes)).toBe("webp");
      const meta = await sharp(out.bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", AVATAR.size, AVATAR.size]);
    }
  });

  it("applies the orientation and drops every bit of metadata", async () => {
    const input = await solid(80, 40)
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "home-address-gps" } } })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await images.normalise(new Uint8Array(input), spec);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(Buffer.from(out.bytes).includes("home-address-gps")).toBe(false);
  });

  it("refuses animations, tiny and huge images, and broken files", async () => {
    const frames = [await solid(40, 40).png().toBuffer(), await solid(40, 40, { r: 0, g: 0, b: 255 }).png().toBuffer()];
    const animated = await sharp(frames, { join: { animated: true } })
      .webp()
      .toBuffer();
    expect(await images.normalise(new Uint8Array(animated), spec)).toEqual({ ok: false, reason: "animated" });
    const tiny = await solid(AVATAR.minSide - 1, 200)
      .png()
      .toBuffer();
    expect(await images.normalise(new Uint8Array(tiny), spec)).toEqual({ ok: false, reason: "too_small" });
    const wide = await solid(AVATAR.maxSide + 1, 40)
      .png()
      .toBuffer();
    expect(await images.normalise(new Uint8Array(wide), spec)).toEqual({ ok: false, reason: "too_large" });
    // A pixel bomb: refused by the pixel ceiling before its pixels are allocated.
    const bomb = await solid(400, 400).png().toBuffer();
    expect(await images.normalise(new Uint8Array(bomb), { ...spec, maxSide: 100 })).toEqual({
      ok: false,
      reason: "too_large",
    });
    const png = await solid(100, 100).png().toBuffer();
    const truncated = new Uint8Array(png.subarray(0, Math.floor(png.length / 2)));
    expect(await images.normalise(truncated, spec)).toEqual({ ok: false, reason: "decode_failed" });
  });

  it("refuses SVG and GIF even past the core's byte check", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>');
    expect((await images.normalise(svg, spec)).ok).toBe(false);
    const gif = await solid(64, 64).gif().toBuffer();
    expect(await images.normalise(new Uint8Array(gif), spec)).toEqual({ ok: false, reason: "not_image" });
  });

  it("with prepareAvatar: a PNG/HTML polyglot comes out as a clean WebP with none of the HTML", async () => {
    const png = await solid(64, 64).png().toBuffer();
    const html = "<html><script>alert(document.cookie)</script></html>";
    const polyglot = new Uint8Array(Buffer.concat([png, Buffer.from(html)]));
    const out = await prepareAvatar(images, polyglot);
    expect(sniffImage(out.bytes)).toBe("webp");
    expect(Buffer.from(out.bytes).includes("<script")).toBe(false);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
