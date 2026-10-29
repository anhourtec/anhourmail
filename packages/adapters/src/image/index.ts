// SPDX-License-Identifier: AGPL-3.0-only
import sharp from "sharp";

import type { ImageNormaliser, NormalisedImage } from "@anhourmail/core/avatars";

/**
 * Profile photo re-encoding with sharp (libvips), ADR-0022. The core has already refused anything whose first bytes
 * aren't PNG, JPEG or WebP; here the image is decoded once more under hard limits and written out as a new file:
 *
 * - **only PNG, JPEG and WebP decoders' output is accepted** (the decoded format is checked again), a single frame
 *   (animated WebP and multi-page input are refused), and `failOn: "error"` turns a corrupt or truncated file into a
 *   refusal instead of a half-decoded image;
 * - **a pixel ceiling** (`limitInputPixels`, the largest allowed side squared) refuses decompression bombs before
 *   the pixels are allocated, and each side must be within the shared limits;
 * - **the output is a new WebP**: auto-oriented, cropped to a centred square of `size` pixels, with no metadata at
 *   all (sharp drops EXIF, GPS, ICC, XMP and comments unless asked to keep them), so nothing from the upload —
 *   including whatever a polyglot hid after the image data — survives.
 *
 * At most `MAX_ACTIVE` decodes run at once in this process; more answer `busy` (the route turns that into a 429).
 */

const MAX_ACTIVE = 2;
let active = 0;

const FORMATS = new Set(["png", "jpeg", "webp"]);

export function sharpImageNormaliser(): ImageNormaliser {
  return {
    async normalise(input, spec): Promise<NormalisedImage> {
      if (active >= MAX_ACTIVE) return { ok: false, reason: "busy" };
      active += 1;
      try {
        const options = { failOn: "error", limitInputPixels: spec.maxSide * spec.maxSide, pages: 1 } as const;
        // Metadata without `pages: 1`, so `pages` is the file's frame count whatever the decoder option does (with sharp
        // 0.35.5 it reports every frame either way). Reading metadata doesn't decode pixels.
        const meta = await sharp(input, { failOn: "error", limitInputPixels: options.limitInputPixels }).metadata();
        if (!FORMATS.has(meta.format)) return { ok: false, reason: "not_image" };
        if ((meta.pages ?? 1) > 1) return { ok: false, reason: "animated" };
        const { width, height } = meta.autoOrient;
        if (Math.min(width, height) < spec.minSide) return { ok: false, reason: "too_small" };
        if (Math.max(width, height) > spec.maxSide) return { ok: false, reason: "too_large" };
        const out = await sharp(input, options)
          .autoOrient()
          .resize(spec.size, spec.size, { fit: "cover", position: "centre" })
          .webp({ quality: 82, effort: 4 })
          .toBuffer();
        return { ok: true, contentType: "image/webp", bytes: new Uint8Array(out) };
      } catch (err) {
        // Corrupt, truncated, over the pixel ceiling or not an image at all: refused, never logged (personal data).
        const overLimit = err instanceof Error && /pixel limit/i.test(err.message);
        return { ok: false, reason: overLimit ? "too_large" : "decode_failed" };
      } finally {
        active -= 1;
      }
    },
  };
}
