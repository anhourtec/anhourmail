// SPDX-License-Identifier: MIT
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Secrets at rest (CLAUDE.md rule 16, docs/internal/07-security.md "Standards"): AES-256-GCM with a key ring.
 *
 * - The ring holds master keys by id; the first is active (new encryptions), the rest only decrypt (rotation).
 * - Each use derives its own key with HKDF-SHA256 (`purpose`), so one master key never encrypts two kinds of data
 *   directly.
 * - Every ciphertext is bound to AAD (e.g. the row or session it belongs to): moving it elsewhere fails to decrypt.
 * - Output: `v1.<keyId>.<iv>.<ciphertext+tag>` (base64url parts), so the key id travels with the data and a
 *   re-encryption job can find rows under a retired key.
 *
 * Configuration: `SECRETS_KEYRING="k2:<base64 32 bytes>,k1:<base64 32 bytes>"`. Required in production; in dev and
 * tests a fallback key is derived from another local secret so nothing extra has to be set up.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export class KeyRingError extends Error {
  override readonly name = "KeyRingError";
}

export type KeyRing = {
  readonly activeKeyId: string;
  /** Encrypts `plaintext` for `purpose`, bound to `aad`. */
  encrypt(purpose: string, plaintext: string, aad: string): string;
  /** Decrypts; throws `KeyRingError` on an unknown key, a wrong AAD or tampering. */
  decrypt(purpose: string, sealed: string, aad: string): string;
  /** The key id a sealed value was written with (for re-encryption), or null when it is not ours. */
  keyIdOf(sealed: string): string | null;
};

export function createKeyRing(keys: readonly { id: string; key: Buffer }[]): KeyRing {
  const first = keys[0];
  if (!first) throw new KeyRingError("Key ring is empty");
  const byId = new Map<string, Buffer>();
  for (const k of keys) {
    if (!KEY_ID.test(k.id)) throw new KeyRingError(`Invalid key id "${k.id}"`);
    if (k.key.length !== 32) throw new KeyRingError(`Key ${k.id} must be 32 bytes`);
    if (byId.has(k.id)) throw new KeyRingError(`Duplicate key id "${k.id}"`);
    byId.set(k.id, k.key);
  }
  const derive = (master: Buffer, purpose: string) =>
    Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `anhourmail:${purpose}`, 32));

  return {
    activeKeyId: first.id,
    encrypt(purpose, plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", derive(first.key, purpose), iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
      return [VERSION, first.id, iv.toString("base64url"), body.toString("base64url")].join(".");
    },
    decrypt(purpose, sealed, aad) {
      const [version, keyId, ivPart, bodyPart, ...rest] = sealed.split(".");
      if (version !== VERSION || !keyId || !ivPart || !bodyPart || rest.length > 0) {
        throw new KeyRingError("Not a sealed value");
      }
      const master = byId.get(keyId);
      if (!master) throw new KeyRingError(`Unknown key id "${keyId}"`);
      const iv = Buffer.from(ivPart, "base64url");
      const body = Buffer.from(bodyPart, "base64url");
      if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new KeyRingError("Malformed sealed value");
      try {
        const decipher = createDecipheriv("aes-256-gcm", derive(master, purpose), iv);
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString(
          "utf8",
        );
      } catch {
        throw new KeyRingError("Decryption failed");
      }
    },
    keyIdOf(sealed) {
      const [version, keyId] = sealed.split(".");
      return version === VERSION && keyId && byId.has(keyId) ? keyId : null;
    },
  };
}

/** Parses `id:base64key[,id:base64key…]` (whitespace ignored). */
export function parseKeyRing(spec: string): { id: string; key: Buffer }[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((entry) => {
      const i = entry.indexOf(":");
      if (i <= 0) throw new KeyRingError("Key ring entries look like id:base64key");
      return { id: entry.slice(0, i), key: Buffer.from(entry.slice(i + 1), "base64") };
    });
}

/**
 * The ring from `SECRETS_KEYRING`. Outside production, a missing ring falls back to one key ("dev") derived from
 * `devFallbackSecret` — never in production, where a missing ring is a startup error.
 */
export function keyRingFromEnv(opts: {
  spec: string | undefined;
  production: boolean;
  devFallbackSecret?: string | undefined;
}): KeyRing {
  if (opts.spec && opts.spec.trim() !== "") return createKeyRing(parseKeyRing(opts.spec));
  if (opts.production) throw new KeyRingError("SECRETS_KEYRING is required in production");
  if (!opts.devFallbackSecret) throw new KeyRingError("SECRETS_KEYRING is not set");
  const key = Buffer.from(hkdfSync("sha256", opts.devFallbackSecret, "anhourmail-dev-keyring", "dev", 32));
  return createKeyRing([{ id: "dev", key }]);
}
