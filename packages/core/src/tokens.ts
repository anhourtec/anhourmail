// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from "node:crypto";

/** One-time tokens (invites): 32 random bytes; only the sha256 is ever stored. */
export const newToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
/** Cheap shape check before any lookup (43 base64url characters). */
export const isTokenShaped = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
