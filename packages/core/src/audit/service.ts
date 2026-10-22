// SPDX-License-Identifier: AGPL-3.0-only
import { type Actor, authorize } from "../actor";
import type { Deps } from "../ports";
import { verifyChain } from "./hash";
import { isAuditArea, partialIp } from "./labels";
import type { AuditActorKind, AuditQuery } from "./repository";
import type { AuditEntry, AuditResult, AuditScope } from "./types";

/** Page size from untrusted input: integers 1–200, default 50 (NaN, Infinity and fractions are rejected). */
export function clampLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return 50;
  return Math.min(Math.max(Math.trunc(input), 1), 200);
}

/**
 * Audit filters, already validated (see `parseAuditFilters`). `actor` is a kind (`staff`, `user`, `system`,
 * `anonymous`) or one person's user id.
 */
export type AuditFilters = {
  area?: string;
  actor?: string;
  result?: AuditResult;
  from?: Date;
  to?: Date;
  limit?: number;
  beforeSeq?: number;
};

const ACTOR_KINDS: readonly AuditActorKind[] = ["staff", "user", "system", "anonymous"];
const RESULTS: readonly AuditResult[] = ["success", "denied", "failed"];
const DAY_MS = 24 * 3600_000;

/** A `YYYY-MM-DD` day in UTC; anything else is ignored. */
function day(v: string | undefined): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Filters from a query string (untrusted). Unknown values are dropped, never passed on: `area` must be a catalogue
 * area, `result` one of the three, dates `YYYY-MM-DD` (UTC; `to` includes the whole day), `before` a positive seq.
 */
export function parseAuditFilters(q: Record<string, string | undefined>): AuditFilters {
  const out: AuditFilters = {};
  if (isAuditArea(q.area)) out.area = q.area;
  const actor = q.actor?.trim();
  if (actor && actor.length <= 200) out.actor = actor;
  if ((RESULTS as readonly string[]).includes(q.result ?? "")) out.result = q.result as AuditResult;
  const from = day(q.from);
  if (from) out.from = from;
  const to = day(q.to);
  if (to) out.to = new Date(to.getTime() + DAY_MS - 1);
  const before = Number(q.before);
  if (Number.isInteger(before) && before > 1) out.beforeSeq = before;
  const limit = Number(q.limit);
  if (q.limit !== undefined && Number.isFinite(limit)) out.limit = clampLimit(limit);
  return out;
}

function toQuery(scope: AuditScope, f: AuditFilters, limit: number): AuditQuery {
  const q: AuditQuery = { scope, limit };
  if (f.area !== undefined) q.area = f.area;
  if (f.actor !== undefined) {
    if ((ACTOR_KINDS as readonly string[]).includes(f.actor)) q.actorKind = f.actor as AuditActorKind;
    else q.actorUserId = f.actor;
  }
  if (f.result !== undefined) q.result = f.result;
  if (f.from !== undefined) q.from = f.from;
  if (f.to !== undefined) q.to = f.to;
  if (f.beforeSeq !== undefined) q.beforeSeq = f.beforeSeq;
  return q;
}

/** Views never carry a full IP (the network part only) or the client's user agent. */
const forView = (e: AuditEntry): AuditEntry => ({ ...e, ip: partialIp(e.ip), userAgent: null });

/** One page, newest first, and the `before` cursor for the next (older) page. */
export type AuditPage = { entries: AuditEntry[]; nextBefore: number | null };

async function page(deps: Deps, scope: AuditScope, f: AuditFilters): Promise<AuditPage> {
  const limit = clampLimit(f.limit);
  const rows = await deps.uow.run((r) => r.audit.list(toQuery(scope, f, limit + 1)));
  const entries = rows.slice(0, limit).map(forView);
  const last = entries.at(-1);
  return { entries, nextBefore: rows.length > limit && last ? last.seq : null };
}

/** Account audit log for Owner / User Admin / Auditor (permission `audit.read`, account scope). */
export async function listAccountAudit(
  deps: Deps,
  actor: Actor,
  accountId: string,
  filters: AuditFilters = {},
): Promise<AuditEntry[]> {
  return (await accountAuditPage(deps, actor, accountId, filters)).entries;
}

export async function accountAuditPage(
  deps: Deps,
  actor: Actor,
  accountId: string,
  filters: AuditFilters = {},
): Promise<AuditPage> {
  authorize(actor, "audit.read", accountId);
  return page(deps, `account:${accountId}`, filters);
}

/** Platform audit for Global Admin and Reports Reader. */
export async function listPlatformAudit(deps: Deps, actor: Actor, filters: AuditFilters = {}): Promise<AuditEntry[]> {
  return (await platformAuditPage(deps, actor, filters)).entries;
}

export async function platformAuditPage(deps: Deps, actor: Actor, filters: AuditFilters = {}): Promise<AuditPage> {
  authorize(actor, "platform.audit.read");
  return page(deps, "platform", filters);
}

/** Scheduled integrity check (system actor only). Returns the first break, or null when the chain is intact. */
export async function verifyAuditScope(deps: Deps, scope: AuditScope) {
  const entries = await deps.uow.run((r) => r.audit.chain(scope));
  return verifyChain(entries);
}
