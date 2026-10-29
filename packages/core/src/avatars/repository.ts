// SPDX-License-Identifier: AGPL-3.0-only
import type { AvatarContentType, AvatarOwner, AvatarRef, StoredAvatar } from "./entity";

/** A mailbox as far as photos are concerned: who it belongs to, if anyone. */
export type AvatarMailbox = { id: string; accountId: string; address: string; userId: string | null };

/**
 * Profile photos (ADR-0022). Keyed by the owner (a person or a mailbox); one photo each, replaced on upload. Removed
 * with the person or the mailbox (`ON DELETE CASCADE`).
 */
export type AvatarRepository = {
  get(owner: AvatarOwner): Promise<StoredAvatar | null>;
  /** The given owners that have a photo, with its version (owners without one are left out). */
  versions(owners: readonly AvatarOwner[]): Promise<AvatarRef[]>;
  /** Inserts or replaces the owner's photo. */
  set(
    owner: AvatarOwner,
    image: { contentType: AvatarContentType; bytes: Uint8Array; sha256: string },
    at: Date,
  ): Promise<void>;
  /** Conditional: false when there was no photo. */
  remove(owner: AvatarOwner): Promise<boolean>;
  /** The mailboxes with these (normalised) addresses, in any account; unknown addresses are left out. */
  mailboxesByAddress(addresses: readonly string[]): Promise<AvatarMailbox[]>;
  /** The mailbox with this id, in any account (callers check the viewer may see that account). */
  mailboxById(id: string): Promise<AvatarMailbox | null>;
};

export type NormaliseFailure = "not_image" | "animated" | "too_small" | "too_large" | "decode_failed" | "busy";

export type NormalisedImage =
  { ok: true; contentType: AvatarContentType; bytes: Uint8Array } | { ok: false; reason: NormaliseFailure };

/**
 * Decodes an upload and re-encodes it as a square photo (adapter: sharp, `@anhourmail/adapters/image`). It must
 * refuse anything that isn't a single-frame PNG, JPEG or WebP within the side limits, crop to a centred square of
 * `size` pixels, apply the orientation, drop every bit of metadata (EXIF, GPS, ICC, XMP, comments) and encode WebP.
 */
export type ImageNormaliser = {
  normalise(input: Uint8Array, spec: { size: number; minSide: number; maxSide: number }): Promise<NormalisedImage>;
};
