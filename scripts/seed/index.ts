// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dev seed (CLAUDE.md rule 50). Idempotent — safe to re-run; every run sets fresh random passwords and
 * rewrites credentials.md.
 *
 *   npm run db:seed              minimum: Global Administrator + dev mail stack (dev.test, alice, bob)
 *   npm run db:seed -- --demo    full demo world: every platform and account role, special states, mailboxes,
 *                                aliases, masked aliases, sample mail, sample audit entries, an unverified domain
 *
 * Plans are not seeded: they live in packages/shared/src/plans.ts (single source of truth, rule 32).
 * Passwords are generated here, never hard-coded, and only ever written to credentials.md.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { hashPassword } from "@anhourmail/adapters/auth";
import { createDb, type Db, PgUnitOfWork, schema } from "@anhourmail/adapters/postgres";
import { type Deps, systemClock } from "@anhourmail/core";
import type { AuditAction, AuditEntryInput } from "@anhourmail/core/audit";
import { enqueueProvisioning } from "@anhourmail/core/provisioning";
import { JmapClient } from "@anhourmail/jmap-client";
import { customerDomainRecords, PLANS } from "@anhourmail/shared";
import { createAppPassword, type StalwartManagement, stalwart } from "@anhourmail/stalwart-client";

import { applyDevMailPlan, DEV_DOMAIN, DEV_MAILBOXES } from "../../infra/stalwart/dev-plan";
import { type CredentialRow, writeCredentials } from "./credentials";
import {
  type AccountKey,
  ACCOUNTS,
  demoPeople,
  FREE_DOMAIN,
  INVITED,
  type SeedPerson,
  STAFF_DOMAIN,
  UNVERIFIED_DOMAIN,
} from "./people";

const ROOT = path.join(import.meta.dirname, "../..");
const demo = process.argv.includes("--demo");
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set (copy .env.example to .env)`);
  return v;
};

const DATABASE_URL = need("DATABASE_URL");
const STALWART_URL = need("STALWART_URL");
const ADMIN_EMAIL = need("SEED_PLATFORM_ADMIN_EMAIL").toLowerCase();
const APP_URL = need("APP_URL");
const WEBMAIL_URL = need("WEBMAIL_URL");
const SITE_URL = need("SITE_URL");

/** 20 random url-safe chars + a fixed tail so Stalwart's zxcvbn strength check always passes. */
const newPassword = () => `${randomBytes(15).toString("base64url")}-Am7`;
const log = (msg: string) => process.stdout.write(`${msg}\n`);

// ---- console identity -------------------------------------------------------------------------------------

async function upsertConsoleUser(db: Db, p: SeedPerson, password: string): Promise<string> {
  const hash = await hashPassword(password);
  const [existing] = await db.select().from(schema.authUser).where(eq(schema.authUser.email, p.email));
  const userId = existing?.id ?? randomUUID();
  if (!existing) {
    await db.insert(schema.authUser).values({ id: userId, name: p.name, email: p.email, emailVerified: true });
    await db.insert(schema.authAccount).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: hash,
    });
  } else {
    await db
      .update(schema.authAccount)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(schema.authAccount.userId, userId), eq(schema.authAccount.providerId, "credential")));
  }
  await db
    .insert(schema.userProfile)
    .values({ userId, state: p.state, suspended: p.suspended ?? false })
    .onConflictDoUpdate({
      target: schema.userProfile.userId,
      set: { state: p.state, suspended: p.suspended ?? false, updatedAt: new Date() },
    });
  if (p.platformRole) {
    await db
      .insert(schema.platformRoleAssignment)
      .values({ userId, role: p.platformRole, grantedBy: "seed" })
      .onConflictDoNothing();
  }
  return userId;
}

async function upsertAccount(db: Db, key: AccountKey): Promise<{ id: string; created: boolean }> {
  const a = ACCOUNTS[key];
  const [existing] = await db.select().from(schema.customerAccount).where(eq(schema.customerAccount.name, a.name));
  if (existing) return { id: existing.id, created: false };
  const [row] = await db.insert(schema.customerAccount).values({ name: a.name, plan: a.plan }).returning();
  if (!row) throw new Error(`account ${a.name} not created`);
  return { id: row.id, created: true };
}

// ---- mail ---------------------------------------------------------------------------------------------------

const local = (address: string) => address.split("@")[0] ?? address;
const domainOf = (address: string) => address.split("@")[1] ?? "";

async function upsertMailbox(
  db: Db,
  mgmt: StalwartManagement,
  m: { address: string; password: string; accountId: string; userId: string | null; quotaBytes: number },
  aliases: { address: string; kind: "alias" | "masked"; description: string }[] = [],
): Promise<string> {
  const stalwartId = await mgmt.upsertUser({
    name: local(m.address),
    domain: domainOf(m.address),
    password: await hashPassword(m.password),
    resetPassword: true,
    quotaBytes: m.quotaBytes,
    aliases: aliases.map((a) => ({
      name: local(a.address),
      domain: domainOf(a.address),
      enabled: true,
      description: a.description,
    })),
  });
  const [row] = await db
    .insert(schema.mailbox)
    .values({ accountId: m.accountId, userId: m.userId, address: m.address, stalwartId, quotaBytes: m.quotaBytes })
    .onConflictDoUpdate({ target: schema.mailbox.address, set: { stalwartId, accountId: m.accountId } })
    .returning();
  if (!row) throw new Error(`mailbox ${m.address} not stored`);
  for (const a of aliases) {
    await db
      .insert(schema.mailAlias)
      .values({
        accountId: m.accountId,
        mailboxId: row.id,
        address: a.address,
        kind: a.kind,
        description: a.description,
      })
      .onConflictDoNothing();
  }
  return row.id;
}

/** Masked aliases are random, per-site addresses (ADR-0009); deterministic per run key so re-runs don't pile up. */
const masked = (seed: string, domain: string) =>
  `${createHash("sha256").update(seed).digest("hex").slice(0, 10)}@${domain}`;

function jmapFor(address: string, password: string) {
  return new JmapClient({
    sessionUrl: `${STALWART_URL}/jmap/session`,
    authorization: `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`,
  });
}

// ---- audit samples (system writes through the repository, same hash chain) ---------------------------------

function sample(
  scope: AuditEntryInput["scope"],
  action: AuditAction,
  target: AuditEntryInput["target"],
  actor: Partial<AuditEntryInput["actor"]> = {},
  onBehalfOf: AuditEntryInput["onBehalfOf"] = null,
  meta: Record<string, unknown> = {},
): AuditEntryInput {
  return {
    scope,
    action,
    actor: { type: "system", userId: null, email: "seed", role: null, accountId: null, ...actor },
    onBehalfOf,
    target,
    result: "success",
    errorCode: null,
    requestId: `seed-${randomUUID().slice(0, 8)}`,
    ip: null,
    userAgent: "anhourmail-seed",
    meta,
  };
}

// ---- main ---------------------------------------------------------------------------------------------------

const { db, pool } = createDb(DATABASE_URL);
const deps: Deps = { uow: new PgUnitOfWork(db), clock: systemClock };
const mgmt = stalwart();

log("migrations…");
execFileSync("npx", ["tsx", "packages/adapters/src/db-postgres/migrate.ts", DATABASE_URL], {
  cwd: ROOT,
  stdio: "inherit",
});

log("stalwart dev mail plan…");
await mgmt.ready();
// dev.test mailboxes use DEV_MAILBOX_PASSWORD when set (stack:verify signs in with it), else a random one.
const devPassword = process.env.DEV_MAILBOX_PASSWORD ?? newPassword();
const plan = await applyDevMailPlan(mgmt, { mailboxPassword: devPassword });
if (plan.restartNeeded) {
  log("restarting stalwart (admin UI bundle or new listeners)…");
  execFileSync("docker", ["compose", "restart", "stalwart"], { cwd: ROOT, stdio: "inherit" });
  for (let i = 0; i < 30; i++) {
    try {
      await mgmt.ready();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const rows: CredentialRow[] = [];
const special: { label: string; detail: string }[] = [];
let mailClient: { address: string; appPassword: string; host: string; imapPort: number; smtpPort: number } | null =
  null;
const quota = (plan: keyof typeof PLANS) => PLANS[plan].storageGb * 1024 ** 3;

const people = demo ? demoPeople(ADMIN_EMAIL) : demoPeople(ADMIN_EMAIL).filter((p) => p.email === ADMIN_EMAIL);

// Mail domains in Stalwart
const mailDomains = new Set(people.filter((p) => p.mailbox).map((p) => domainOf(p.email)));
for (const d of mailDomains) await mgmt.upsertDomain({ name: d });

const accountIds = new Map<AccountKey, string>();
const newAccounts = new Set<AccountKey>();
if (demo) {
  for (const key of Object.keys(ACCOUNTS) as AccountKey[]) {
    const { id, created } = await upsertAccount(db, key);
    accountIds.set(key, id);
    if (created) newAccounts.add(key);
  }
}

const passwords = new Map<string, string>();
for (const p of people) {
  const password = newPassword();
  passwords.set(p.email, password);
  const userId = await upsertConsoleUser(db, p, password);
  let accountId: string | undefined;
  if (p.account) {
    accountId = accountIds.get(p.account.key);
    if (!accountId) throw new Error(`no account for ${p.account.key}`);
    await db
      .insert(schema.accountMembership)
      .values({ accountId, userId, role: p.account.role })
      .onConflictDoUpdate({
        target: [schema.accountMembership.accountId, schema.accountMembership.userId],
        set: { role: p.account.role },
      });
  }
  if (p.mailbox && demo) {
    // Staff mailboxes belong to an internal "Anhourtec staff" account so every mailbox row has an owner.
    const owningAccount = accountId ?? (await upsertStaffAccount(db));
    const aliases =
      p.account?.role === "owner"
        ? [
            { address: `hello@${domainOf(p.email)}`, kind: "alias" as const, description: "Shared hello address" },
            {
              address: masked(`${p.email}:shop`, domainOf(p.email)),
              kind: "masked" as const,
              description: "shop.example",
            },
            {
              address: masked(`${p.email}:news`, domainOf(p.email)),
              kind: "masked" as const,
              description: "news.example",
            },
          ].filter((a) => (p.account?.key !== "free" && p.account?.key !== "supporter") || a.kind === "masked")
        : [];
    await upsertMailbox(
      db,
      mgmt,
      {
        address: p.email,
        password,
        accountId: owningAccount,
        userId,
        quotaBytes: quota(p.account ? ACCOUNTS[p.account.key].plan : "plus"),
      },
      aliases,
    );
  } else if (p.mailbox) {
    await mgmt.upsertUser({
      name: local(p.email),
      domain: domainOf(p.email),
      password: await hashPassword(password),
      resetPassword: true,
      quotaBytes: quota("plus"),
    });
  }
  const group = p.platformRole ? "Platform staff" : p.account ? `Customer: ${ACCOUNTS[p.account.key].name}` : "Other";
  const role = p.platformRole ?? p.account?.role ?? p.state;
  rows.push({ group, role, email: p.email, password, tryThis: p.tryThis });
}

async function upsertStaffAccount(database: Db): Promise<string> {
  const name = "Anhourtec staff";
  const [existing] = await database.select().from(schema.customerAccount).where(eq(schema.customerAccount.name, name));
  if (existing) return existing.id;
  const [row] = await database.insert(schema.customerAccount).values({ name, plan: "plus" }).returning();
  if (!row) throw new Error("staff account not created");
  return row.id;
}

if (demo) {
  log("demo: domains, invite, audit, sample mail…");
  // Verified customer domains + one unverified domain (DNS states in the console)
  for (const key of ["family", "group"] as const) {
    const a = ACCOUNTS[key];
    const accountId = accountIds.get(key) ?? "";
    await db
      .insert(schema.customerDomain)
      .values({ accountId, name: a.domain, status: "active", verifyToken: randomBytes(12).toString("hex") })
      .onConflictDoNothing();
    // The dev plan already created the domain on Stalwart; the worker's ensure job records its id (→ "Active").
    const [row] = await db.select().from(schema.customerDomain).where(eq(schema.customerDomain.name, a.domain));
    if (row?.stalwartId === null) await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: row.id });
  }
  const unverifiedToken = randomBytes(12).toString("hex");
  await db
    .insert(schema.customerDomain)
    .values({
      accountId: accountIds.get(UNVERIFIED_DOMAIN.account) ?? "",
      name: UNVERIFIED_DOMAIN.name,
      status: "pending_dns",
      verifyToken: unverifiedToken,
    })
    .onConflictDoNothing();

  // Invited, not yet accepted (the accept flow lands in phase 3)
  const inviteToken = randomBytes(24).toString("base64url");
  await db
    .delete(schema.invite)
    .where(and(eq(schema.invite.email, INVITED.email), eq(schema.invite.status, "pending")));
  await db.insert(schema.invite).values({
    email: INVITED.email,
    accountId: accountIds.get(INVITED.account) ?? null,
    role: INVITED.role,
    tokenHash: createHash("sha256").update(inviteToken).digest("hex"),
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    createdBy: "seed",
  });

  // Sample audit entries, only when the account is new (append-only: re-runs don't pile up)
  await deps.uow.run(async (r) => {
    for (const key of ["family", "group"] as const) {
      if (!newAccounts.has(key)) continue;
      const accountId = accountIds.get(key) ?? "";
      const scope = `account:${accountId}` as const;
      const owner = `owner@${ACCOUNTS[key].domain}`;
      const now = new Date();
      await r.audit.append(
        sample(scope, "account.created", { type: "account", id: accountId, label: ACCOUNTS[key].name }),
        now,
      );
      await r.audit.append(
        sample(
          scope,
          "domain.added",
          { type: "domain", id: null, label: ACCOUNTS[key].domain },
          { type: "user", email: owner, role: "owner", accountId },
        ),
        now,
      );
      await r.audit.append(
        sample(scope, "domain.verified", { type: "domain", id: null, label: ACCOUNTS[key].domain }),
        now,
      );
      await r.audit.append(
        sample(
          scope,
          "mailbox.created",
          { type: "mailbox", id: null, label: `member@${ACCOUNTS[key].domain}` },
          { type: "user", email: owner, role: "owner", accountId },
        ),
        now,
      );
      await r.audit.append(
        sample(
          scope,
          "masked_alias.created",
          { type: "alias", id: null, label: "shop.example" },
          { type: "user", email: owner, role: "owner", accountId },
        ),
        now,
      );
      if (key === "family") {
        await r.audit.append(
          sample(
            scope,
            "account.invite_sent",
            { type: "invite", id: null, label: INVITED.email },
            { type: "user", email: owner, role: "owner", accountId },
          ),
          now,
        );
        // Staff actions on an account are always visible to that account (rule 49)
        await r.audit.append(
          sample(
            scope,
            "staff.act_as_started",
            { type: "account", id: accountId, label: ACCOUNTS[key].name },
            { type: "staff", email: `support@${STAFF_DOMAIN}`, role: "support_admin" },
            null,
            { reason: "Customer asked for help with DNS (ticket #1042)", minutes: 30 },
          ),
          now,
        );
      }
    }
  });

  // Sample mail between demo mailboxes (visible in webmail once phase 4 lands; IMAP today)
  const fam = ACCOUNTS.family.domain;
  const grp = ACCOUNTS.group.domain;
  const sends: [string, string[], string, string][] = [
    [`owner@${fam}`, [`member@${fam}`], "Welcome to the family account", "Your mailbox is ready. Say hi!"],
    [`member@${fam}`, [`owner@${fam}`], "Re: Welcome to the family account", "Thanks, it works."],
    [`owner@${grp}`, [`owner@${fam}`, `member@${grp}`], "Group plans for the weekend", "Who's in for Saturday?"],
    [
      `free@${FREE_DOMAIN}`,
      [`supporter@${FREE_DOMAIN}`, "someone@example.com"],
      "Hello from the free tier",
      "This copy to example.com lands in Mailpit.",
    ],
  ];
  for (const [from, to, subject, text] of sends) {
    const pw = passwords.get(from);
    if (pw) await jmapFor(from, pw).sendText({ from, to, subject, text });
  }

  // App password for IMAP client testing
  const appUser = `member@${fam}`;
  const appUserPassword = passwords.get(appUser) ?? "";
  mailClient = {
    address: appUser,
    appPassword: await createAppPassword({
      baseUrl: STALWART_URL,
      address: appUser,
      password: appUserPassword,
      description: "Local IMAP client (seed)",
    }),
    host: "127.0.0.1",
    imapPort: Number(process.env.STALWART_IMAPS_PORT ?? "993"),
    smtpPort: Number(process.env.STALWART_SUBMISSIONS_PORT ?? "465"),
  };

  const records = customerDomainRecords(UNVERIFIED_DOMAIN.name, unverifiedToken);
  special.push(
    { label: "Free user", detail: `\`free@${FREE_DOMAIN}\` (see the Customer: Free user table)` },
    { label: "Supporter", detail: `\`supporter@${FREE_DOMAIN}\` (see the Customer: Supporter table)` },
    {
      label: "Invited, not accepted",
      detail: `\`${INVITED.email}\` invited to Demo Family as member — link (accept flow lands in phase 3): ${APP_URL}/invite/${inviteToken}`,
    },
    { label: "Suspended", detail: `\`suspended@${ACCOUNTS.group.domain}\` (see the Demo Group table)` },
    {
      label: "Unverified domain",
      detail: `\`${UNVERIFIED_DOMAIN.name}\` on Demo Family, status pending_dns, ${records.filter((r) => r.required).length} required records`,
    },
  );
}

for (const name of DEV_MAILBOXES) {
  rows.push({
    group: "Dev mailboxes (dev.test, mail only)",
    role: "mailbox",
    email: `${name}@${DEV_DOMAIN}`,
    password: devPassword,
    tryThis: "IMAP/JMAP only; no console login. Used by `npm run stack:verify`",
  });
}

const port = (k: string, d: string) => process.env[k] ?? d;
writeCredentials(path.join(ROOT, "credentials.md"), {
  urls: [
    { label: "Marketing site", url: SITE_URL },
    { label: "Docs", url: `${SITE_URL}/docs` },
    { label: "Changelog / credits", url: `${SITE_URL}/changelog` },
    { label: "Console", url: APP_URL },
    { label: "Webmail", url: WEBMAIL_URL },
    {
      label: "Console from another device (LAN)",
      url: `http://<this-machine-ip>:${port("WEB_DEV_PORT", "43200")} (webmail: port ${port("WEBMAIL_DEV_PORT", "43300")})`,
    },
    { label: "Mailpit UI", url: `http://localhost:${port("MAILPIT_UI_PORT", "43026")}` },
    { label: "Stalwart admin UI", url: `${STALWART_URL.replace("127.0.0.1", "localhost")}/admin` },
  ],
  rows,
  special,
  mailClient,
  infra: [
    { label: "Postgres", value: DATABASE_URL },
    { label: "Redis", value: need("REDIS_URL") },
    {
      label: "Stalwart admin (dev recovery admin)",
      value: `${need("STALWART_DEV_ADMIN_USER")} / ${need("STALWART_DEV_ADMIN_PASSWORD")}`,
    },
  ],
});

await pool.end();
log(`seed done${demo ? " (demo)" : ""} — credentials.md written (gitignored; never commit or paste it).`);
