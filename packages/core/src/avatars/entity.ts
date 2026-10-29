// SPDX-License-Identifier: AGPL-3.0-only
import { AVATAR } from "@anhourmail/shared/profile";

/**
 * Profile photos (ADR-0022): one per person, and one per mailbox that has no person (a shared address). Stored once
 * in the control plane as a small WebP we re-encoded ourselves; never mail content, never a remote URL. Served
 * same-origin by the console and the webmail with the content hash in the URL, so a change shows everywhere at once
 * and an unchanged photo is cached.
 */

export type AvatarKind = "person" | "mailbox";

/** Whose photo: a person (their console user id) or a person-less mailbox (its id). */
export type AvatarOwner = { kind: AvatarKind; id: string };

/** What we store and serve: always a re-encoded WebP. */
export type AvatarContentType = "image/webp";

export type StoredAvatar = {
  owner: AvatarOwner;
  contentType: AvatarContentType;
  bytes: Uint8Array;
  /** sha256 of `bytes`, hex. */
  sha256: string;
  updatedAt: Date;
};

/** A photo that exists, with the version its URL carries. */
export type AvatarRef = AvatarOwner & { version: string };

/** The largest upload, in bytes. */
export const MAX_AVATAR_UPLOAD_BYTES = AVATAR.maxUploadMb * 1024 * 1024;

/** The largest re-encoded photo we keep, in bytes (a 256-pixel WebP is far smaller; this is a backstop). */
export const MAX_AVATAR_STORED_BYTES = 256 * 1024;

/** The cache-busting version in a photo's URL: the start of its content hash. */
export const avatarVersion = (sha256: string): string => sha256.slice(0, 16);

export type SniffedImage = "png" | "jpeg" | "webp";

/**
 * The raster type an upload's first bytes say it is, or null. Only PNG, JPEG and WebP are accepted, by their magic
 * bytes, never by a declared type or file name: SVG, HTML, GIF and anything else are refused here, before decoding.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const b = (i: number) => bytes[i] ?? -1;
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b(i) === v)) return "png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "jpeg";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Ids in avatar URLs are console user ids or mailbox uuids: anything else is not found. */
export const isAvatarId = (id: string): boolean => ID.test(id);

export const isAvatarKind = (kind: string): kind is AvatarKind => kind === "person" || kind === "mailbox";

/** Where a photo is served: `base` is `/api/avatars` (console) or `/api/webmail/avatars` (webmail). */
export function avatarPath(base: "/api/avatars" | "/api/webmail/avatars", ref: AvatarRef): string {
  return `${base}/${ref.kind}/${encodeURIComponent(ref.id)}?v=${ref.version}`;
}
