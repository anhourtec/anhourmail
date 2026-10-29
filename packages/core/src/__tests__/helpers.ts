// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { platformFacts } from "@anhourmail/shared/platform";
import { ACT_AS_ACCOUNT_ROLE, type AccountRole, type PlatformRole } from "@anhourmail/shared/rbac";

import { MemoryUnitOfWork } from "../../../adapters/src/memory";
import type { ActingAs, Actor, UserActor } from "../actor";
import type { Clock, Deps, RequestMeta } from "../ports";

export const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
export const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

export const req: RequestMeta = { requestId: "req-test-1", ip: "203.0.113.5", userAgent: "vitest" };

export function fixedClock(iso = "2026-10-21T12:00:00Z"): Clock & { set(d: Date): void } {
  let now = new Date(iso);
  return { now: () => now, set: (d) => (now = d) };
}

/** A deployment on its own domain (not the product's), so tests prove hostnames come from configuration. */
export const TEST_PLATFORM = platformFacts("platform-mail.test");

export function deps(clock: Clock = fixedClock()): Deps & { uow: MemoryUnitOfWork } {
  return { uow: new MemoryUnitOfWork(), clock, platform: TEST_PLATFORM };
}

export function user(
  opts: { platform?: PlatformRole[]; account?: [string, AccountRole][]; suspended?: boolean; id?: string } = {},
): UserActor {
  return {
    kind: "user",
    userId: opts.id ?? "user-1",
    email: `${opts.id ?? "user-1"}@example.test`,
    platformRoles: opts.platform ?? [],
    memberships: (opts.account ?? []).map(([accountId, role]) => ({ accountId, role })),
    suspended: opts.suspended ?? false,
  };
}

export const anonymous: Actor = { kind: "anonymous" };

/** An act-as record for `accountId` (ADR-0023), for tests that check a service refuses during act-as. */
export function actAs(accountId: string, staffRole: PlatformRole = "support_admin", staffUserId = "staff-1"): ActingAs {
  return {
    sessionId: "act-as-1",
    accountId,
    staffUserId,
    staffEmail: `${staffUserId}@anhourtec.test`,
    staffRole,
    reason: "Customer ticket 1234",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
  };
}

/** Staff acting in `accountId` as the server builds them: platform roles set aside, read-only membership there only. */
export function actingStaff(accountId: string, staffRole: PlatformRole = "support_admin", id = "staff-1"): UserActor {
  return {
    ...user({ id, account: [[accountId, ACT_AS_ACCOUNT_ROLE]] }),
    email: `${id}@anhourtec.test`,
    actingAs: actAs(accountId, staffRole, id),
  };
}

/**
 * Stands in for the argon2id hasher (`@anhourmail/adapters` `mailboxPasswordHasher`): an argon2id-shaped PHC string
 * from a SHA-256 of the password, so tests can tell hashes apart and prove the password itself is never kept.
 */
export const fakeHasher = {
  hash: async (password: string): Promise<string> =>
    `$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$${createHash("sha256").update(password).digest("base64").replace(/=+$/, "")}`,
  /** Stands in for the web app's HMAC grant: names the account it was made for. */
  grant: ({ externalId }: { externalId: string; passwordHash: string }): string => `grant-for-${externalId}`,
};

/** A breached-password check (core `BreachedPasswords`) for service tests: lists what it was asked, never the network. */
export function fakeBreaches(breached: string[], verdictWhenListed: "breached" | "unknown" = "breached") {
  const asked: string[] = [];
  return {
    asked,
    check: (password: string): Promise<"breached" | "clean" | "unknown"> => {
      asked.push(password);
      return Promise.resolve(breached.includes(password) ? verdictWhenListed : "clean");
    },
  };
}

/** A password that passes the mailbox password rules but appears in the breached-password corpus (`fakeBreaches`). */
export const BREACHED_PW = "password1234";

/** A password that passes the mailbox password rules. */
export const MAILBOX_PW = "correct horse battery staple";
