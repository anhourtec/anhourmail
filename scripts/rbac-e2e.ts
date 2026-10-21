// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RBAC harness (CLAUDE.md rules 35–37): `npm run test:rbac` against a running apps/web (WEB_URL, default
 * http://127.0.0.1:43200) and its database.
 *
 *   1. Builds a throwaway tree: 2 customer accounts × every account role, every platform role, a free user and a
 *      suspended member (plus anonymous). Users are created directly (sign-up is closed), then each one signs in
 *      through the real HTTP sign-in endpoint.
 *   2. For every route in apps/web/src/server/routes.ts × every persona, the expected status is DERIVED from the
 *      permission matrix via the core `authorize()` (401 / 403 / 404 / 2xx) — a new route or permission without
 *      a registry entry fails the unit test in routes.test.ts; a wrong guard fails here.
 *   3. Mutating routes must write their audit entry (matched by the request id we send).
 *   4. Deletes the tree (audit rows stay: append-only by design, scoped by random ids).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { inArray, like } from "drizzle-orm";

import { hashPassword } from "@anhourmail/adapters/auth";
import { createDb, schema } from "@anhourmail/adapters/postgres";
import { type Actor, authorize, DomainError } from "@anhourmail/core";
import { ACCOUNT_ROLES, type AccountRole, PLATFORM_ROLES, type PlatformRole } from "@anhourmail/shared/rbac";

import { ROUTES, type RouteSpec } from "../apps/web/src/server/routes";

const WEB = (process.env.WEB_URL ?? "http://127.0.0.1:43200").replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");

const run = `rbac-${randomBytes(4).toString("hex")}`;
const { db, pool } = createDb(DATABASE_URL);

type Persona = {
  label: string;
  email: string | null;
  actor: Actor;
  cookie: string | null;
};

const STATUS: Record<string, number> = { unauthorized: 401, forbidden: 403, not_found: 404 };

function expectedStatus(route: RouteSpec, p: Persona, accountId: string): number {
  const okStatus = route.probeStatus ?? (route.method === "POST" ? 202 : 200);
  if (route.guard === "public") return okStatus;
  if (route.guard === "session") return p.actor.kind === "user" ? 200 : 401;
  if (route.guard === "infra") return 200;
  try {
    authorize(p.actor, route.guard, route.accountParam ? accountId : undefined);
    return okStatus;
  } catch (err) {
    if (err instanceof DomainError) return STATUS[err.code] ?? 500;
    throw err;
  }
}

async function createUser(email: string, password: string, suspended = false): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.authUser).values({ id, name: email, email, emailVerified: true });
  await db.insert(schema.authAccount).values({
    id: randomUUID(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(password),
  });
  await db.insert(schema.userProfile).values({ userId: id, state: suspended ? "suspended" : "paid", suspended });
  return id;
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${WEB}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB },
    body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c?.includes("session_token"));
  if (!res.ok || !cookie) throw new Error(`sign-in failed for ${email}: HTTP ${res.status}`);
  return cookie;
}

const results: { route: string; persona: string; expected: number; got: number }[] = [];
const auditFailures: string[] = [];

try {
  // ---- 1. throwaway tree ----------------------------------------------------------------------------------
  const accounts = await db
    .insert(schema.customerAccount)
    .values([
      { name: `${run} account A`, plan: "plus" },
      { name: `${run} account B`, plan: "plus" },
    ])
    .returning();
  const [accountA, accountB] = accounts;
  if (!accountA || !accountB) throw new Error("accounts not created");

  const personas: Persona[] = [{ label: "anonymous", email: null, actor: { kind: "anonymous" }, cookie: null }];
  const password = `${randomBytes(12).toString("base64url")}-Rb9`;

  const addUser = async (
    label: string,
    opts: { platform?: PlatformRole; account?: [string, AccountRole]; suspended?: boolean },
  ) => {
    const email = `${run}-${label.replace(/[^a-z0-9]+/gi, "-")}@rbac.test`.toLowerCase();
    const userId = await createUser(email, password, opts.suspended);
    if (opts.platform)
      await db.insert(schema.platformRoleAssignment).values({ userId, role: opts.platform, grantedBy: run });
    if (opts.account) {
      await db.insert(schema.accountMembership).values({ accountId: opts.account[0], userId, role: opts.account[1] });
    }
    personas.push({
      label,
      email,
      cookie: null,
      actor: {
        kind: "user",
        userId,
        email,
        platformRoles: opts.platform ? [opts.platform] : [],
        memberships: opts.account ? [{ accountId: opts.account[0], role: opts.account[1] }] : [],
        suspended: opts.suspended ?? false,
      },
    });
  };

  for (const role of PLATFORM_ROLES) await addUser(`staff ${role}`, { platform: role });
  for (const role of ACCOUNT_ROLES) {
    await addUser(`A ${role}`, { account: [accountA.id, role] });
    await addUser(`B ${role}`, { account: [accountB.id, role] });
  }
  await addUser("free user", {});
  await addUser("suspended A owner", { account: [accountA.id, "owner"], suspended: true });

  for (const p of personas) if (p.email) p.cookie = await signIn(p.email, password);

  // ---- 2. every route × every persona -------------------------------------------------------------------
  for (const route of ROUTES) {
    if (route.guard === "infra") continue;
    for (const p of personas) {
      // The account parameter targets account A; any other parameter gets a random id (probe → probeStatus).
      const path = route.path
        .replace(`:${route.accountParam ?? "_"}`, accountA.id)
        .replace(/:[A-Za-z]+/g, () => randomUUID());
      const requestId = `${run}-${randomBytes(4).toString("hex")}`;
      const headers: Record<string, string> = { "x-request-id": requestId, origin: WEB };
      if (p.cookie) headers.cookie = p.cookie;
      let body: string | undefined;
      if (route.method !== "GET") {
        headers["content-type"] = "application/json";
        // An empty body: allowed callers reach validation (each route's probeStatus), denied ones never get there.
        body = "{}";
      }
      const res = await fetch(`${WEB}${path}`, { method: route.method, headers, ...(body ? { body } : {}) });
      const expected = expectedStatus(route, p, accountA.id);
      results.push({ route: `${route.method} ${route.path}`, persona: p.label, expected, got: res.status });

      // ---- 3. audit entries for mutations ----
      if (route.audits && res.status < 300) {
        const rows = await db
          .select({ action: schema.auditLog.action, result: schema.auditLog.result })
          .from(schema.auditLog)
          .where(inArray(schema.auditLog.requestId, [requestId]));
        if (!rows.some((r) => r.action === route.audits)) {
          auditFailures.push(`${route.method} ${route.path} as ${p.label}: no ${route.audits} audit entry`);
        }
      }
    }
  }
} finally {
  // ---- 4. cleanup -----------------------------------------------------------------------------------------
  await db.delete(schema.authUser).where(like(schema.authUser.email, `${run}-%`));
  await db.delete(schema.customerAccount).where(like(schema.customerAccount.name, `${run} %`));
  await pool.end();
}

const failures = results.filter((r) => r.expected !== r.got);
const byRoute = new Map<string, { pass: number; total: number }>();
for (const r of results) {
  const s = byRoute.get(r.route) ?? { pass: 0, total: 0 };
  s.total += 1;
  if (r.expected === r.got) s.pass += 1;
  byRoute.set(r.route, s);
}
for (const [route, s] of byRoute)
  console.log(`${s.pass === s.total ? "PASS" : "FAIL"}  ${route}  ${s.pass}/${s.total}`);
for (const f of failures) console.log(`  ✗ ${f.route} as ${f.persona}: expected ${f.expected}, got ${f.got}`);
for (const a of auditFailures) console.log(`  ✗ ${a}`);
const total = results.length;
console.log(
  `\ntest:rbac — ${total - failures.length}/${total} checks match the matrix; audit: ${auditFailures.length === 0 ? "ok" : `${auditFailures.length} missing`} (run ${run}).`,
);
process.exit(failures.length === 0 && auditFailures.length === 0 ? 0 : 1);
