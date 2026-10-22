// SPDX-License-Identifier: AGPL-3.0-only
import type { SignInPolicy } from "@anhourmail/shared/security";

import type { AccountSignInPolicy, PasskeyRecord, SecurityFactors, SessionRecord } from "./entity";

/**
 * Console sign-in security (port). The identity adapter owns the factor and session tables; services read them and
 * make the person's own changes (sessions, passkey names and removal) through this port so the audit entry commits in
 * the same unit of work. Every method is scoped to `userId`: another person's ids behave as unknown.
 */
export type SecurityRepository = {
  factors(userId: string): Promise<SecurityFactors>;
  /** Unexpired sessions, most recently active first. */
  sessions(userId: string, now: Date): Promise<SessionRecord[]>;
  /** Deletes one of the person's sessions; null when it isn't theirs (or doesn't exist). */
  revokeSession(userId: string, sessionId: string): Promise<SessionRecord | null>;
  /** Deletes every session of the person except `keepSessionId`; returns how many. */
  revokeOtherSessions(userId: string, keepSessionId: string): Promise<number>;
  /** Forgets every "trusted device" (they ask for the second step again); returns how many. */
  forgetTrustedDevices(userId: string): Promise<number>;
  /** Newest first. */
  passkeys(userId: string): Promise<PasskeyRecord[]>;
  renamePasskey(userId: string, passkeyId: string, name: string): Promise<PasskeyRecord | null>;
  removePasskey(userId: string, passkeyId: string): Promise<PasskeyRecord | null>;
  /** The sign-in policy of every account the person belongs to. */
  policies(userId: string): Promise<AccountSignInPolicy[]>;
  /** null for an unknown account. */
  accountPolicy(accountId: string): Promise<SignInPolicy | null>;
  setAccountPolicy(accountId: string, policy: SignInPolicy): Promise<void>;
};
