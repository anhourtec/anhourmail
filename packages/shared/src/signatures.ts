// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail signatures (docs/internal/05-webmail.md "Signatures", ADR-0014): a mailbox keeps several named signatures,
 * chosen per message, with one default for new messages and one for replies and forwards. They belong to the mailbox
 * and work with any of its sending addresses. Published in the docs; enforced by the BFF and the control plane.
 *
 * Images in a signature are embedded in it (`data:` PNG, JPEG, GIF or WebP), never links to another server.
 */
export const WEBMAIL_SIGNATURES = {
  /** Signatures one mailbox can keep. */
  perMailbox: 20,
  /** Longest signature name, in characters. */
  nameChars: 32,
  /** Images one signature can embed. */
  imagesPerSignature: 3,
  /** Largest image file in one signature, in KB (1 KB = 1024 bytes; before it is encoded into the signature). */
  imageKb: 64,
  /** Largest signature, images included, in KB of HTML (an embedded image takes about 4/3 of its file size). */
  signatureKb: 300,
  /** All of one mailbox's signatures together, in KB of HTML (they load with the webmail). */
  mailboxKb: 1024,
} as const;

/** Image types a signature can embed. */
export const SIGNATURE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** The longest `data:` URI one embedded image may be: its prefix plus the base64 of `imageKb`. */
export const SIGNATURE_IMAGE_URI_MAX =
  "data:image/jpeg;base64,".length + 4 * Math.ceil((WEBMAIL_SIGNATURES.imageKb * 1024) / 3);
/** The longest signature HTML, in characters. */
export const SIGNATURE_HTML_MAX = WEBMAIL_SIGNATURES.signatureKb * 1024;
/** The longest generated plain-text version kept. */
export const SIGNATURE_TEXT_MAX = 10_000;

/** A signature as the webmail sees it: its HTML (sanitised on save) and the plain-text version made from it. */
export type SignatureView = { id: string; name: string; html: string; text: string };

/** Which signature each kind of message starts with; null is "(No signature)". */
export type SignatureDefaults = { newMessage: string | null; reply: string | null };

export type SignatureSet = { signatures: SignatureView[]; defaults: SignatureDefaults };

/** A string's code points (how Postgres `char_length` counts, so the limits agree). */
export const codePoints = (v: string): string[] => Array.from(v);

/**
 * A name as typed, tidied: control characters out, runs of whitespace as one space, trimmed. Null when it is empty or
 * longer than `nameChars` (counted in characters, so a name of emoji isn't cut in half).
 */
export function signatureName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = codePoints(v).length;
  return chars >= 1 && chars <= WEBMAIL_SIGNATURES.nameChars ? v : null;
}

/** Names are unique per mailbox, ignoring case. */
export const sameSignatureName = (a: string, b: string): boolean =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** A name for a copy that isn't taken yet: "Work (copy)", "Work (copy 2)", … shortened to fit. */
export function copyName(name: string, taken: readonly string[]): string {
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${String(n)})`;
    const room = WEBMAIL_SIGNATURES.nameChars - codePoints(suffix).length;
    const candidate = `${codePoints(name).slice(0, room).join("").trimEnd()}${suffix}`;
    if (!taken.some((t) => sameSignatureName(t, candidate))) return candidate;
  }
  return name;
}

/** The signature a message starts with: the default for its kind, if that signature still exists. */
export function defaultSignature(set: SignatureSet | null, kind: "new" | "reply"): SignatureView | null {
  if (!set) return null;
  const id = kind === "new" ? set.defaults.newMessage : set.defaults.reply;
  return id === null ? null : (set.signatures.find((s) => s.id === id) ?? null);
}
