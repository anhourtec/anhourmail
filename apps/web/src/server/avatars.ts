// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { NextResponse } from "next/server";

import { sharpImageNormaliser } from "@anhourmail/adapters/image";
import { ValidationError } from "@anhourmail/core";
import {
  type AvatarOwner,
  type AvatarRef,
  avatarPath,
  avatarVersion,
  type ImageNormaliser,
  isAvatarKind,
  MAX_AVATAR_UPLOAD_BYTES,
  type StoredAvatar,
} from "@anhourmail/core/avatars";
import { AVATAR } from "@anhourmail/shared/profile";

import { BodyTooLargeError, readCappedBytes } from "./webmail/http";

/**
 * Profile photos over HTTP (ADR-0022; docs/internal/07-security.md "Profile photos"). Uploads are the raw image as
 * the request body (no multipart), read with a hard cap before anything is buffered past it; the service checks and
 * re-encodes it. Photos are served same-origin by the console (`/api/avatars/:kind/:id`) and the webmail
 * (`/api/webmail/avatars/:kind/:id`) with the content-hash version in the URL.
 */

let images: ImageNormaliser | null = null;

/** The image decoder (sharp), created on first use so processes that never take an upload never load it. */
export function avatarImages(): ImageNormaliser {
  images ??= sharpImageNormaliser();
  return images;
}

export function setAvatarImagesForTests(next: ImageNormaliser | null): void {
  images = next;
}

/** Photo uploads being read or decoded in this process (each holds up to the 5 MB cap in memory). */
export const MAX_AVATAR_UPLOADS = 4;
let uploads = 0;

/**
 * Reads an upload body — refused past the shared size cap without buffering the excess — and hands it to `use`,
 * holding one of `MAX_AVATAR_UPLOADS` slots meanwhile (429 beyond). Call it only once the caller is known to be signed
 * in: per-caller rate limits key on the session cookie, so a request with an unknown cookie must never get this far.
 */
export async function withAvatarUpload(req: Request, use: (bytes: Uint8Array) => Promise<Response>): Promise<Response> {
  if (uploads >= MAX_AVATAR_UPLOADS) {
    return NextResponse.json(
      { error: { code: "rate_limited", message: "Several photos are uploading already. Try again in a moment." } },
      { status: 429, headers: { "Retry-After": "2" } },
    );
  }
  uploads += 1;
  try {
    let bytes: Uint8Array;
    try {
      bytes = await readCappedBytes(req, MAX_AVATAR_UPLOAD_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        throw new ValidationError(`Choose an image up to ${String(AVATAR.maxUploadMb)} MB.`);
      }
      throw err;
    }
    return await use(bytes);
  } finally {
    uploads -= 1;
  }
}

/** `{ kind, id }` from route params; null when they can't name a photo. */
export function avatarOwnerParam(params: Record<string, string | string[] | undefined>): AvatarOwner | null {
  const kind = typeof params.kind === "string" ? params.kind : "";
  const id = typeof params.id === "string" ? params.id : "";
  return isAvatarKind(kind) && id !== "" ? { kind, id } : null;
}

/** What upload and remove routes answer: the photo's URL on this origin, or null when there is none now. */
export const avatarUrl = (base: "/api/avatars" | "/api/webmail/avatars", ref: AvatarRef | null): string | null =>
  ref ? avatarPath(base, ref) : null;

/**
 * The photo as an image response. Only ever a WebP we encoded, sent with that type, `nosniff`, a CSP that allows
 * nothing and sandboxes it if opened directly, same-origin only. The URL carries the version: when the request names
 * the current one it is cached privately for a year (a change makes a new URL); otherwise it must be revalidated.
 */
export function avatarResponse(image: StoredAvatar, req: Request): Response {
  const version = avatarVersion(image.sha256);
  const etag = `"${version}"`;
  const requested = new URL(req.url).searchParams.get("v");
  const headers: Record<string, string> = {
    "Content-Type": image.contentType,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    ETag: etag,
    "Cache-Control": requested === version ? "private, max-age=31536000, immutable" : "private, no-cache",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(image.bytes), {
    status: 200,
    headers: { ...headers, "Content-Length": String(image.bytes.length) },
  });
}
