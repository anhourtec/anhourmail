// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gt, like, ne, sql } from "drizzle-orm";

import type { PasskeyRecord, SecurityRepository, SessionRecord } from "@anhourmail/core/security";
import { isSignInPolicy, type SignInPolicy } from "@anhourmail/shared/security";

import { recoveryCodesLeft } from "../auth/recovery-codes";
import type { Executor } from "./client";
import {
  accountMembership,
  authPasskey,
  authSession,
  authTwoFactor,
  authUser,
  authVerification,
  customerAccount,
} from "./schema";

/** The identity tables seen through the core port: never tokens, secrets, public keys or credential ids. */
const isId = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const policyOf = (v: string): SignInPolicy => (isSignInPolicy(v) ? v : "none");

const sessionColumns = {
  id: authSession.id,
  createdAt: authSession.createdAt,
  lastActiveAt: authSession.updatedAt,
  expiresAt: authSession.expiresAt,
  ip: authSession.ipAddress,
  userAgent: authSession.userAgent,
};

const passkeyColumns = {
  id: authPasskey.id,
  name: authPasskey.name,
  createdAt: authPasskey.createdAt,
  deviceType: authPasskey.deviceType,
  backedUp: authPasskey.backedUp,
  aaguid: authPasskey.aaguid,
};

export class PgSecurityRepository implements SecurityRepository {
  constructor(private readonly x: Executor) {}

  async factors(userId: string) {
    const [user] = await this.x
      .select({ enabled: authUser.twoFactorEnabled })
      .from(authUser)
      .where(eq(authUser.id, userId));
    const [tf] = await this.x
      .select({ verified: authTwoFactor.verified, codes: authTwoFactor.backupCodes })
      .from(authTwoFactor)
      .where(eq(authTwoFactor.userId, userId));
    const [keys] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(authPasskey)
      .where(eq(authPasskey.userId, userId));
    const totp = (user?.enabled ?? false) && tf?.verified === true;
    return { totp, passkeys: keys?.n ?? 0, recoveryCodesLeft: totp ? recoveryCodesLeft(tf.codes) : 0 };
  }

  async sessions(userId: string, now: Date): Promise<SessionRecord[]> {
    return this.x
      .select(sessionColumns)
      .from(authSession)
      .where(and(eq(authSession.userId, userId), gt(authSession.expiresAt, now)))
      .orderBy(desc(authSession.updatedAt));
  }

  async revokeSession(userId: string, sessionId: string): Promise<SessionRecord | null> {
    const [row] = await this.x
      .delete(authSession)
      .where(and(eq(authSession.userId, userId), eq(authSession.id, sessionId)))
      .returning(sessionColumns);
    return row ?? null;
  }

  async revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    const rows = await this.x
      .delete(authSession)
      .where(and(eq(authSession.userId, userId), ne(authSession.id, keepSessionId)))
      .returning({ id: authSession.id });
    return rows.length;
  }

  async forgetTrustedDevices(userId: string): Promise<number> {
    // better-auth keeps one verification row per trusted browser: identifier `trust-device-…`, value = user id.
    const rows = await this.x
      .delete(authVerification)
      .where(and(like(authVerification.identifier, "trust-device-%"), eq(authVerification.value, userId)))
      .returning({ id: authVerification.id });
    return rows.length;
  }

  async passkeys(userId: string): Promise<PasskeyRecord[]> {
    return this.x
      .select(passkeyColumns)
      .from(authPasskey)
      .where(eq(authPasskey.userId, userId))
      .orderBy(desc(authPasskey.createdAt), authPasskey.id);
  }

  async renamePasskey(userId: string, passkeyId: string, name: string): Promise<PasskeyRecord | null> {
    const [row] = await this.x
      .update(authPasskey)
      .set({ name })
      .where(and(eq(authPasskey.userId, userId), eq(authPasskey.id, passkeyId)))
      .returning(passkeyColumns);
    return row ?? null;
  }

  async removePasskey(userId: string, passkeyId: string): Promise<PasskeyRecord | null> {
    const [row] = await this.x
      .delete(authPasskey)
      .where(and(eq(authPasskey.userId, userId), eq(authPasskey.id, passkeyId)))
      .returning(passkeyColumns);
    return row ?? null;
  }

  async policies(userId: string) {
    const rows = await this.x
      .select({ accountId: accountMembership.accountId, policy: customerAccount.signInPolicy })
      .from(accountMembership)
      .innerJoin(customerAccount, eq(customerAccount.id, accountMembership.accountId))
      .where(eq(accountMembership.userId, userId));
    return rows.map((r) => ({ accountId: r.accountId, policy: policyOf(r.policy) }));
  }

  async accountPolicy(accountId: string): Promise<SignInPolicy | null> {
    if (!isId(accountId)) return null;
    const [row] = await this.x
      .select({ policy: customerAccount.signInPolicy })
      .from(customerAccount)
      .where(eq(customerAccount.id, accountId));
    return row ? policyOf(row.policy) : null;
  }

  async setAccountPolicy(accountId: string, policy: SignInPolicy): Promise<void> {
    if (!isId(accountId)) return;
    await this.x.update(customerAccount).set({ signInPolicy: policy }).where(eq(customerAccount.id, accountId));
  }
}
