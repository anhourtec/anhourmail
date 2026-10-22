// SPDX-License-Identifier: AGPL-3.0-only
import type { SignInPolicy } from "@anhourmail/shared/security";

/** The console sign-in factors a person has set up (never the secrets themselves). */
export type SecurityFactors = {
  /** An authenticator app is set up and verified (two-factor sign-in is on). */
  totp: boolean;
  passkeys: number;
  /** Unused recovery codes; 0 when two-factor sign-in is off. */
  recoveryCodesLeft: number;
};

/** A console session (never its token). */
export type SessionRecord = {
  id: string;
  createdAt: Date;
  /** Last time the session was refreshed (better-auth refreshes at most once a day). */
  lastActiveAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
};

/** A registered passkey or security key (never its public key or credential id). */
export type PasskeyRecord = {
  id: string;
  name: string | null;
  createdAt: Date | null;
  /** `singleDevice` (a security key) or `multiDevice` (synced, e.g. a password manager). */
  deviceType: string;
  backedUp: boolean;
  /** Authenticator model id (AAGUID) when the authenticator shares it. */
  aaguid: string | null;
};

export type AccountSignInPolicy = { accountId: string; policy: SignInPolicy };

export type MissingFactor = "two_factor" | "passkey";
