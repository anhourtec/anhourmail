// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RBAC harness (CLAUDE.md rules 35–37): `npm run test:rbac` against a running apps/web (WEB_URL, default
 * http://127.0.0.1:43200) and its database.
 *
 *   1. Builds a throwaway tree: 2 customer accounts × every account role, every platform role, a free user and a
 *      suspended member (plus anonymous). Users are created directly (sign-up is closed), then each one signs in
 *      through the real HTTP sign-in endpoint; the suspended member's sign-in must be refused (403), and an Owner of a
 *      staff-suspended account gets 403 `account_suspended` on account routes but 200 on their own profile.
 *   2. For every route in apps/web/src/server/routes.ts × every persona, the expected status is DERIVED from the
 *      permission matrix via the core `authorize()` (401 / 403 / 404 / 2xx) — a new route or permission without
 *      a registry entry fails the unit test in routes.test.ts; a wrong guard fails here.
 *   3. Mutating routes must write their audit entry (matched by the request id we send).
 *   4. Deletes the tree (audit rows stay: append-only by design, scoped by random ids).
 *
 * Staff support access (ADR-0023): a Support and a Global Administrator start act-as into account A, and a Support
 * Administrator into account B, through the real HTTP flow; their personas are then "staff acting read-only in that
 * account" (platform roles set aside, one Auditor-like membership), so every route's expectation comes from the same
 * matrix: reads allowed in their account, changes and owner-only actions 403, account A for the B persona 404, staff
 * routes 403. Starting into a staff account is refused (403), and account A's Owner sees the session as Anhourtec staff.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { inArray, like } from "drizzle-orm";

import { hashPassword } from "@anhourmail/adapters/auth";
import { createDb, schema } from "@anhourmail/adapters/postgres";
import { type Actor, authorize, DomainError } from "@anhourmail/core";
import {
  ACCOUNT_ROLES,
  ACT_AS_ACCOUNT_ROLE,
  type AccountRole,
  type Permission,
  PLATFORM_ROLES,
  type PlatformRole,
} from "@anhourmail/shared/rbac";

import { ROUTES, type RouteSpec } from "../apps/web/src/server/routes";

const WEB = (process.env.WEB_URL ?? "http://127.0.0.1:43200").replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");

const run = `rbac-${randomBytes(4).toString("hex")}`;
const HARNESS_IP = `198.51.100.${String(1 + ((randomBytes(1)[0] ?? 0) % 254))}`;
const { db, pool } = createDb(DATABASE_URL);

type Persona = {
  label: string;
  email: string | null;
  actor: Actor;
  cookie: string | null;
};

const STATUS: Record<string, number> = { unauthorized: 401, forbidden: 403, not_found: 404 };

function authorizes(actor: Actor, permission: Permission): boolean {
  try {
    authorize(actor, permission);
    return true;
  } catch {
    return false;
  }
}

function expectedStatus(route: RouteSpec, p: Persona, accountId: string): number {
  const okStatus = route.probeStatus ?? (route.method === "POST" ? 202 : 200);
  if (route.guard === "public") return okStatus;
  if (route.guard === "session") return p.actor.kind === "user" ? 200 : 401;
  // Webmail routes need a webmail session; no console session (any role) ever grants one.
  if (route.guard === "webmail") return 401;
  // Only a staff member with support access open; anyone else signed in gets 404 (nothing open).
  if (route.guard === "act_as") return p.actor.kind !== "user" ? 401 : p.actor.actingAs ? okStatus : 404;
  if (route.guard === "infra") return 200;
  try {
    authorize(p.actor, route.guard, route.accountParam ? accountId : undefined);
    // Allowed by the matrix, refused by the service while acting (ADR-0023: no profile or photo changes, own included).
    if (route.refusedWhileActing && p.actor.kind === "user" && p.actor.actingAs) return 403;
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

async function signInResponse(email: string, password: string): Promise<Response> {
  return fetch(`${WEB}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB, "x-forwarded-for": HARNESS_IP },
    body: JSON.stringify({ email, password }),
  });
}

async function signIn(email: string, password: string): Promise<string> {
  // A documentation-range client address (TRUST_PROXY in dev/CI): the sign-in's platform audit entry carries it,
  // which the full-IP check below reads back.
  const res = await signInResponse(email, password);
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

  // A person staff suspended can't sign in at all (403 with the notice); every route then treats them as signed out.
  for (const p of personas) {
    if (!p.email) continue;
    if (p.actor.kind === "user" && p.actor.suspended) {
      const res = await signInResponse(p.email, password);
      results.push({ route: "sign-in refused while suspended", persona: p.label, expected: 403, got: res.status });
      p.actor = { kind: "anonymous" };
      continue;
    }
    p.cookie = await signIn(p.email, password);
  }

  // ---- 1a. an account staff suspended: its Owner signs in, account routes answer 403 `account_suspended` ----------
  {
    const [suspendedAccount] = await db
      .insert(schema.customerAccount)
      .values({
        name: `${run} account S`,
        plan: "plus",
        status: "suspended",
        suspensionReason: "spam",
        suspendedAt: new Date(),
      })
      .returning();
    if (!suspendedAccount) throw new Error("suspended account not created");
    const email = `${run}-s-owner@rbac.test`;
    const userId = await createUser(email, password);
    await db.insert(schema.accountMembership).values({ accountId: suspendedAccount.id, userId, role: "owner" });
    const cookie = await signIn(email, password);
    const get = (path: string) => fetch(`${WEB}${path}`, { headers: { cookie, origin: WEB } });
    const mailboxes = await get(`/api/accounts/${suspendedAccount.id}/mailboxes`);
    const code = ((await mailboxes.json()) as { error?: { code?: string } }).error?.code;
    results.push({
      route: "account routes while the account is suspended (account_suspended)",
      persona: "S owner",
      expected: 403,
      got: code === "account_suspended" ? mailboxes.status : 0,
    });
    results.push({
      route: "own profile while the account is suspended",
      persona: "S owner",
      expected: 200,
      got: (await get("/api/me")).status,
    });
  }

  // ---- 1b. (right after the sign-ins, so they are among the newest entries) full IPs in the platform audit: `platform.audit.full_ip` (Global Administrator) only ----------------
  for (const p of personas.filter((x) => x.actor.kind === "user" && x.actor.platformRoles.length > 0)) {
    const res = await fetch(`${WEB}/api/platform/audit?limit=200`, {
      headers: { cookie: p.cookie ?? "", origin: WEB },
    });
    if (res.status !== 200) continue; // no platform.audit.read: covered by the route matrix above
    const { data } = (await res.json()) as { data: { entries: { ip: string | null }[] } };
    const ips = data.entries.map((e) => e.ip).filter((ip): ip is string => ip !== null);
    const full = ips.includes(HARNESS_IP);
    const shouldBeFull = authorizes(p.actor, "platform.audit.full_ip");
    const anyFull = ips.some((ip) => !ip.endsWith(".x") && !ip.endsWith("/48") && ip !== "hidden");
    const okFull = shouldBeFull ? full : !anyFull;
    results.push({ route: "platform audit IPs (full_ip)", persona: p.label, expected: 1, got: okFull ? 1 : 0 });
  }

  // ---- 1c. an alias an administrator turned off: its own Member can't turn it on or delete it ---------------------
  // (403 `alias_admin_locked`, audited as denied); another account's Owner gets 404. Only refusals are probed here,
  // so nothing is queued for the mail server; lifting the lock is covered by the unit tests and the e2e journey.
  {
    const member = personas.find((p) => p.label === "A member");
    const outsider = personas.find((p) => p.label === "B owner");
    if (member?.actor.kind !== "user" || !outsider) throw new Error("personas missing");
    const domainName = `${run}.rbac.test`;
    await db
      .insert(schema.customerDomain)
      .values({ accountId: accountA.id, name: domainName, status: "active", verifyToken: run });
    const [box] = await db
      .insert(schema.mailbox)
      .values({ accountId: accountA.id, userId: member.actor.userId, address: `kid@${domainName}`, quotaBytes: 1 })
      .returning();
    if (!box) throw new Error("mailbox not created");
    const [alias] = await db
      .insert(schema.mailAlias)
      .values({
        accountId: accountA.id,
        mailboxId: box.id,
        address: `shop@${domainName}`,
        kind: "alias",
        enabled: false,
        adminLocked: true,
      })
      .returning();
    if (!alias) throw new Error("alias not created");
    const call = async (p: Persona, method: "PATCH" | "DELETE") => {
      const requestId = `${run}-${randomBytes(4).toString("hex")}`;
      const res = await fetch(`${WEB}/api/accounts/${accountA.id}/aliases/${alias.id}`, {
        method,
        headers: {
          "x-request-id": requestId,
          origin: WEB,
          cookie: p.cookie ?? "",
          "content-type": "application/json",
        },
        ...(method === "PATCH" ? { body: JSON.stringify({ enabled: true }) } : {}),
      });
      const code = res.status < 300 ? null : ((await res.json()) as { error?: { code?: string } }).error?.code;
      const [entry] = await db
        .select({ result: schema.auditLog.result, errorCode: schema.auditLog.errorCode })
        .from(schema.auditLog)
        .where(inArray(schema.auditLog.requestId, [requestId]));
      return { status: res.status, code, entry };
    };
    for (const method of ["PATCH", "DELETE"] as const) {
      const r = await call(member, method);
      const audited = r.entry?.result === "denied" && r.entry.errorCode === "alias_admin_locked";
      results.push({
        route: `${method} admin-locked alias (alias_admin_locked, audited denied)`,
        persona: member.label,
        expected: 403,
        got: r.code === "alias_admin_locked" && audited ? r.status : 0,
      });
      results.push({
        route: `${method} admin-locked alias from another account`,
        persona: outsider.label,
        expected: 404,
        got: (await call(outsider, method)).status,
      });
    }
    const [after] = await db
      .select({ enabled: schema.mailAlias.enabled, adminLocked: schema.mailAlias.adminLocked })
      .from(schema.mailAlias)
      .where(inArray(schema.mailAlias.id, [alias.id]));
    results.push({
      route: "admin-locked alias unchanged after refusals",
      persona: member.label,
      expected: 1,
      got: after?.enabled === false && after.adminLocked ? 1 : 0,
    });
  }

  // ---- 1c. staff support access (ADR-0023), started through the real flow --------------------------------------
  {
    const post = (cookie: string, path: string, body: unknown) =>
      fetch(`${WEB}${path}`, {
        method: "POST",
        headers: { cookie, origin: WEB, "content-type": "application/json", "x-forwarded-for": HARNESS_IP },
        body: JSON.stringify(body),
      });
    const reason = `${run}: RBAC harness checks support access`;
    const acting: [string, PlatformRole, { id: string; name: string }][] = [
      ["act-as support in A", "support_admin", accountA],
      ["act-as global in A", "global_admin", accountA],
      ["act-as support in B", "support_admin", accountB],
    ];
    for (const [label, role, account] of acting) {
      const email = `${run}-${label.replace(/[^a-z0-9]+/gi, "-")}@rbac.test`.toLowerCase();
      const userId = await createUser(email, password);
      await db.insert(schema.platformRoleAssignment).values({ userId, role, grantedBy: run });
      const cookie = await signIn(email, password); // every sign-in counts as a fresh step-up (ADR-0028)
      const res = await post(cookie, `/api/platform/accounts/${account.id}/act-as`, { reason });
      results.push({ route: "act-as start (fresh sign-in)", persona: label, expected: 200, got: res.status });
      const { data } = (await res.json()) as { data?: { expiresAt: string } };
      personas.push({
        label,
        email,
        cookie,
        actor: {
          kind: "user",
          userId,
          email,
          platformRoles: [],
          memberships: [{ accountId: account.id, role: ACT_AS_ACCOUNT_ROLE }],
          suspended: false,
          actingAs: {
            sessionId: "harness",
            accountId: account.id,
            staffUserId: userId,
            staffEmail: email,
            staffRole: role,
            reason,
            expiresAt: new Date(data?.expiresAt ?? 0),
          },
        },
      });
    }
    // Rule 28: never into an account where someone holds a staff role. Unknown reason: 400. Already acting: 403.
    const [staffAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} account staff`, plan: "plus" })
      .returning();
    if (!staffAccount) throw new Error("staff account not created");
    const colleague = personas.find((p) => p.label === "staff reports_reader");
    if (colleague?.actor.kind === "user") {
      await db
        .insert(schema.accountMembership)
        .values({ accountId: staffAccount.id, userId: colleague.actor.userId, role: "owner" });
    }
    const support = personas.find((p) => p.label === "staff support_admin");
    const supportCookie = support?.cookie ?? "";
    const intoStaff = await post(supportCookie, `/api/platform/accounts/${staffAccount.id}/act-as`, { reason });
    results.push({
      route: "act-as into a staff account",
      persona: "staff support_admin",
      expected: 403,
      got: intoStaff.status,
    });
    const noReason = await post(supportCookie, `/api/platform/accounts/${accountA.id}/act-as`, { reason: "short" });
    results.push({
      route: "act-as with a too-short reason",
      persona: "staff support_admin",
      expected: 400,
      got: noReason.status,
    });
    const actingA = personas.find((p) => p.label === "act-as support in A");
    const again = await post(actingA?.cookie ?? "", `/api/platform/accounts/${accountB.id}/act-as`, { reason });
    results.push({
      route: "act-as while already acting",
      persona: "act-as support in A",
      expected: 403,
      got: again.status,
    });
    // Account A's Owner sees the session in their log as Anhourtec staff, with the reason (rule 49).
    const ownerA = personas.find((p) => p.label === "A owner");
    const log = await fetch(`${WEB}/api/accounts/${accountA.id}/audit?actor=staff&limit=200`, {
      headers: { cookie: ownerA?.cookie ?? "", origin: WEB },
    });
    const entries =
      log.status === 200
        ? (
            (await log.json()) as {
              data: { entries: { action: string; onBehalfOf: unknown; meta: { reason?: string } }[] };
            }
          ).data.entries
        : [];
    const seen = entries.filter((e) => e.action === "staff.act_as_started" && e.meta.reason === reason).length;
    results.push({ route: "owner sees act-as starts as staff", persona: "A owner", expected: 2, got: seen });
  }

  // ---- 2. every route × every persona -------------------------------------------------------------------
  // Ending support access runs last, so the acting personas keep it open for every other route.
  const ends = (r: RouteSpec) => r.guard === "act_as" && r.method === "DELETE";
  for (const route of [...ROUTES.filter((r) => !ends(r)), ...ROUTES.filter(ends)]) {
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
      // A refusal while acting is recorded as denied `act_as` (rule 46), with the staff member on behalf of.
      if (
        route.audits &&
        route.refusedWhileActing &&
        p.actor.kind === "user" &&
        p.actor.actingAs &&
        res.status === 403
      ) {
        const rows = await db
          .select({
            action: schema.auditLog.action,
            result: schema.auditLog.result,
            errorCode: schema.auditLog.errorCode,
            onBehalfOf: schema.auditLog.onBehalfOf,
          })
          .from(schema.auditLog)
          .where(inArray(schema.auditLog.requestId, [requestId]));
        if (
          !rows.some(
            (r) =>
              r.action === route.audits && r.result === "denied" && r.errorCode === "act_as" && r.onBehalfOf !== null,
          )
        ) {
          auditFailures.push(`${route.method} ${route.path} as ${p.label}: no denied act_as ${route.audits} entry`);
        }
      }
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
