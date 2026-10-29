// SPDX-License-Identifier: AGPL-3.0-only
import { AVATAR } from "@anhourmail/shared/profile";

/** The side of the square we send (the server re-encodes it to `AVATAR.size` anyway). */
const SEND_SIDE = 512;

export const PHOTO_ACCEPT = AVATAR.types.join(",");

/** What's wrong with a chosen file before we read it, or null. */
export function photoFileProblem(file: { type: string; size: number }): string | null {
  if (!(AVATAR.types as readonly string[]).includes(file.type)) return "Use a PNG, JPEG or WebP image.";
  if (file.size > AVATAR.maxUploadMb * 1024 * 1024) {
    return `Choose an image up to ${String(AVATAR.maxUploadMb)} MB.`;
  }
  return null;
}

/** The centred square of a `width`×`height` image: where to crop from and how big. */
export function centreSquare(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/**
 * Crops a chosen photo to its centred square in the browser and re-encodes it (WebP where the browser can, else PNG),
 * so what we send is small and carries none of the original's metadata (location, camera). The server checks and
 * re-encodes it again; this only saves bandwidth and keeps the original on the device.
 */
export async function squarePhoto(file: File): Promise<Blob> {
  const problem = photoFileProblem(file);
  if (problem) throw new Error(problem);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That image couldn't be read. Try another, or save it again as PNG or JPEG.");
  }
  try {
    if (Math.min(bitmap.width, bitmap.height) < AVATAR.minSide) {
      throw new Error(`Use an image at least ${String(AVATAR.minSide)} pixels wide and tall.`);
    }
    const { x, y, side } = centreSquare(bitmap.width, bitmap.height);
    const out = Math.min(side, SEND_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't prepare the photo. Try another browser.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, x, y, side, side, 0, 0, out, out);
    const encode = (type: string) =>
      new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, type, 0.9);
      });
    const webp = await encode("image/webp");
    const blob = webp?.type === "image/webp" ? webp : await encode("image/png");
    if (!blob) throw new Error("This browser can't prepare the photo. Try another browser.");
    return blob;
  } finally {
    bitmap.close();
  }
}

/**
 * Uploads (a blob) or removes (null) a photo at `endpoint`; the new photo's URL (null once removed) or the server's
 * message on failure.
 */
export async function sendPhoto(
  endpoint: string,
  photo: Blob | null,
): Promise<{ ok: true; url: string | null } | { ok: false; message: string }> {
  try {
    const res = await fetch(endpoint, {
      method: photo ? "POST" : "DELETE",
      ...(photo ? { headers: { "Content-Type": photo.type }, body: photo } : {}),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: { url?: string | null };
      error?: { message?: string };
    } | null;
    if (res.ok) return { ok: true, url: json?.data?.url ?? null };
    return { ok: false, message: json?.error?.message ?? "Something went wrong. Try again." };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection." };
  }
}
