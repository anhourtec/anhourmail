// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole, PlatformRole } from "@anhourmail/shared/rbac";

import { MemoryUnitOfWork } from "../../../adapters/src/memory";
import type { Actor, UserActor } from "../actor";
import type { Clock, Deps, RequestMeta } from "../ports";

export const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
export const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

export const req: RequestMeta = { requestId: "req-test-1", ip: "203.0.113.5", userAgent: "vitest" };

export function fixedClock(iso = "2026-10-21T12:00:00Z"): Clock & { set(d: Date): void } {
  let now = new Date(iso);
  return { now: () => now, set: (d) => (now = d) };
}

export function deps(clock: Clock = fixedClock()): Deps & { uow: MemoryUnitOfWork } {
  return { uow: new MemoryUnitOfWork(), clock };
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
