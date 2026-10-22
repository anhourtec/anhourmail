// SPDX-License-Identifier: AGPL-3.0-only
import { randomInt } from "node:crypto";

import { ValidationError } from "../errors";

/** `alias` is an address someone chose; `masked` is a random one, usually handed to a single website (ADR-0009). */
export type AliasKind = "alias" | "masked";

export type MailAlias = {
  id: string;
  accountId: string;
  /** Where its mail goes: one mailbox of the same account. */
  mailboxId: string;
  address: string;
  kind: AliasKind;
  /** Disabled aliases are refused at SMTP time and can't be sent from; the address stays reserved. */
  enabled: boolean;
  /** The owner's own note ("newsletter", "shop.example"); never shown to anyone outside the account. */
  description: string | null;
  createdAt: Date;
};

// No 0/o, 1/l/i: masked addresses get read aloud and typed from receipts.
const MASK_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const MASK_LENGTH = 12;

/** A random local part for a masked alias: 12 characters (about 59 bits), starting with a letter. */
export function maskedLocalPart(): string {
  let out = MASK_ALPHABET.charAt(randomInt(23)); // the letters come first in the alphabet
  while (out.length < MASK_LENGTH) out += MASK_ALPHABET.charAt(randomInt(MASK_ALPHABET.length));
  return out;
}

/** Optional note: trimmed, at most 100 characters, no control characters. Empty means none. */
export function normaliseDescription(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") throw new ValidationError("The note must be text.");
  const v = input.trim();
  if (v === "") return null;
  let control = false;
  for (let i = 0; i < v.length; i++) control ||= v.charCodeAt(i) < 32 || v.charCodeAt(i) === 127;
  if (v.length > 100 || control) {
    throw new ValidationError("Keep the note to one line of up to 100 characters.");
  }
  return v;
}
