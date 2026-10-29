// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";

import { ConflictError } from "@anhourmail/core";
import {
  ACT_AS_ALREADY_OPEN,
  type ActAsEndReason,
  type ActAsRepository,
  type ActAsSession,
} from "@anhourmail/core/platform";
import { COMPANY_DOMAIN } from "@anhourmail/shared/platform";
import { PLATFORM_ROLES, type PlatformRole } from "@anhourmail/shared/rbac";

import type { Executor } from "./client";
import { isUniqueViolation } from "./errors";
import {
  accountMembership,
  actAsSession,
  authSession,
  authUser,
  customerAccount,
  platformRoleAssignment,
} from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const END_REASONS: readonly ActAsEndReason[] = ["staff", "expired", "signed_out", "role_removed", "staff_account"];

/**
 * Someone in the account (`accountId`, a uuid column or value) holds a platform role or signs in at the company domain
 * or a subdomain of it (rule 28; same rule as core `isCompanyAddress`). The domain is compared, not pattern-matched.
 */
function staffIn(accountId: SQL | typeof actAsSession.accountId): SQL {
  const domain = sql`rtrim(lower(substring(${authUser.email} from '@([^@]+)$')), '.')`;
  const sub = `.${COMPANY_DOMAIN}`;
  return sql`exists (select 1 from ${accountMembership} join ${authUser} on ${authUser.id} = ${accountMembership.userId} where ${accountMembership.accountId} = ${accountId} and (${domain} = ${COMPANY_DOMAIN} or right(${domain}, ${sub.length}) = ${sub} or exists (select 1 from ${platformRoleAssignment} where ${platformRoleAssignment.userId} = ${accountMembership.userId})))`;
}

const fields = {
  id: actAsSession.id,
  staffUserId: actAsSession.staffUserId,
  staffEmail: authUser.email,
  staffRole: actAsSession.staffRole,
  authSessionId: actAsSession.authSessionId,
  accountId: actAsSession.accountId,
  accountName: customerAccount.name,
  reason: actAsSession.reason,
  startedAt: actAsSession.startedAt,
  expiresAt: actAsSession.expiresAt,
  endedAt: actAsSession.endedAt,
  endReason: actAsSession.endReason,
};

const selectSessions = (x: Executor) =>
  x
    .select(fields)
    .from(actAsSession)
    .innerJoin(authUser, eq(authUser.id, actAsSession.staffUserId))
    .innerJoin(customerAccount, eq(customerAccount.id, actAsSession.accountId));

type Row = Awaited<ReturnType<typeof selectSessions>>[number];

/** A stored row as the domain type; null for a role or end reason this code doesn't know (never trusted). */
function toSession(r: Row): ActAsSession | null {
  if (!(PLATFORM_ROLES as readonly string[]).includes(r.staffRole)) return null;
  if (r.endReason !== null && !(END_REASONS as readonly string[]).includes(r.endReason)) return null;
  return { ...r, staffRole: r.staffRole as PlatformRole, endReason: r.endReason as ActAsEndReason | null };
}

/** Staff act-as sessions (ADR-0023): the `act_as_session` table. */
export class PgActAsRepository implements ActAsRepository {
  constructor(private readonly x: Executor) {}

  private select() {
    return selectSessions(this.x);
  }

  private open(now: Date) {
    return and(isNull(actAsSession.endedAt), gt(actAsSession.expiresAt, now));
  }

  async active(staffUserId: string, authSessionId: string, now: Date): Promise<ActAsSession | null> {
    const [r] = await this.select()
      .where(
        and(eq(actAsSession.staffUserId, staffUserId), eq(actAsSession.authSessionId, authSessionId), this.open(now)),
      )
      .limit(1);
    return r ? toSession(r) : null;
  }

  async openFor(staffUserId: string, now: Date): Promise<ActAsSession | null> {
    const [r] = await this.select()
      .where(and(eq(actAsSession.staffUserId, staffUserId), this.open(now)))
      .limit(1);
    return r ? toSession(r) : null;
  }

  async get(id: string): Promise<ActAsSession | null> {
    if (!UUID.test(id)) return null;
    const [r] = await this.select().where(eq(actAsSession.id, id)).limit(1);
    return r ? toSession(r) : null;
  }

  async staffInAccount(accountId: string): Promise<boolean> {
    if (!UUID.test(accountId)) return false;
    const rows = await this.x.execute<{ staff: boolean }>(sql`select ${staffIn(sql`${accountId}::uuid`)} as staff`);
    return rows.rows[0]?.staff === true;
  }

  async create(input: Parameters<ActAsRepository["create"]>[0]): Promise<ActAsSession> {
    let row: { id: string } | undefined;
    try {
      [row] = await this.x.insert(actAsSession).values(input).returning({ id: actAsSession.id });
    } catch (err) {
      // act_as_session_one_open_idx: another start for this staff member won the race.
      if (isUniqueViolation(err)) throw new ConflictError(ACT_AS_ALREADY_OPEN);
      throw err;
    }
    if (!row) throw new Error("act-as session not created");
    const created = await this.get(row.id);
    if (!created) throw new Error("act-as session not readable");
    return created;
  }

  async renew(id: string, expiresAt: Date, reason: string, now: Date): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = await this.x
      .update(actAsSession)
      .set({ expiresAt, reason })
      .where(and(eq(actAsSession.id, id), this.open(now)))
      .returning({ id: actAsSession.id });
    return rows.length > 0;
  }

  async end(id: string, at: Date, reason: ActAsEndReason): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = await this.x
      .update(actAsSession)
      .set({ endedAt: at, endReason: reason })
      .where(and(eq(actAsSession.id, id), isNull(actAsSession.endedAt)))
      .returning({ id: actAsSession.id });
    return rows.length > 0;
  }

  async due(
    now: Date,
    roles: readonly PlatformRole[],
    limit: number,
    staffUserId?: string,
  ): Promise<{ session: ActAsSession; reason: Exclude<ActAsEndReason, "staff"> }[]> {
    const signedIn = sql`exists (select 1 from ${authSession} where ${authSession.id} = ${actAsSession.authSessionId} and ${authSession.userId} = ${actAsSession.staffUserId} and ${authSession.expiresAt} > ${now})`;
    const roleHeld =
      roles.length === 0
        ? sql`false`
        : sql`exists (select 1 from ${platformRoleAssignment} where ${platformRoleAssignment.userId} = ${actAsSession.staffUserId} and ${inArray(platformRoleAssignment.role, [...roles])})`;
    const staffAccount = staffIn(actAsSession.accountId);
    const rows = await this.x
      .select({
        ...fields,
        signedIn: sql<boolean>`${signedIn}`,
        roleHeld: sql<boolean>`${roleHeld}`,
        staffAccount: sql<boolean>`${staffAccount}`,
      })
      .from(actAsSession)
      .innerJoin(authUser, eq(authUser.id, actAsSession.staffUserId))
      .innerJoin(customerAccount, eq(customerAccount.id, actAsSession.accountId))
      .where(
        and(
          isNull(actAsSession.endedAt),
          staffUserId === undefined ? undefined : eq(actAsSession.staffUserId, staffUserId),
          or(lte(actAsSession.expiresAt, now), sql`not ${signedIn}`, sql`not ${roleHeld}`, staffAccount),
        ),
      )
      .orderBy(asc(actAsSession.startedAt))
      .limit(limit);
    return rows.flatMap(({ signedIn: inSession, roleHeld: held, staffAccount: staffThere, ...r }) => {
      const session = toSession(r);
      if (!session) return [];
      const reason =
        session.expiresAt <= now
          ? "expired"
          : !inSession
            ? "signed_out"
            : !held
              ? "role_removed"
              : staffThere
                ? "staff_account"
                : null;
      return reason ? [{ session, reason }] : [];
    });
  }
}
