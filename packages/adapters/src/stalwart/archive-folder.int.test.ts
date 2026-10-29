// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Archive folder against the dev Stalwart (ADR-0014; `@anhourmail/stalwart-client` `folders.ts`): with the
 * server-wide default folder on, a mailbox provisioned by the `mailbox.ensure` job with the real provisioning key gets
 * exactly one Archive (role `archive`) when it is first opened; accounts opened before (simulated here by taking the
 * folder or its role away in throwaway accounts) get it from the backfill once, and a re-run changes nothing. None of
 * the three management keys can do the backfill (no owner access to mailboxes), which is why it runs with the
 * administrator credential. Cleans up everything it creates.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { systemClock } from "@anhourmail/core";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import {
  applyDefaultFolders,
  backfillArchiveFolders,
  ensureArchiveFolder,
  StalwartManagement,
  StalwartTransport,
} from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartMailServer } from ".";
import { issueTestKeys } from "./int-keys";

const dbUrl = process.env.TEST_DATABASE_URL;
const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!dbUrl || !stalwartUrl || !admin || !adminPassword) {
  throw new Error("integration tests need TEST_DATABASE_URL, STALWART_URL and the dev Stalwart admin");
}

const { db, pool } = createDb(dbUrl);
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const adminMgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const domain = `archive-${tag}.test`;
const keys = await issueTestKeys(adminMgmt, stalwartUrl, `svc-ar-${tag}.test`);
let accountId = "";

afterAll(async () => {
  for (const u of (await adminMgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await adminMgmt.destroy("x:Account", u.id);
  }
  const d = (await adminMgmt.listDomains()).find((x) => x.name === domain);
  if (d) await adminMgmt.destroyDomain(d.id);
  await keys.cleanup();
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  await pool.end();
});

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
type Box = { id: string; name: string; role: string | null };

const folders = async (stalwartId: string): Promise<Box[]> =>
  ((
    await adminMgmt.transport.rawCall(USING, [
      ["Mailbox/get", { accountId: stalwartId, ids: null, properties: ["name", "role"] }, "m"],
    ])
  ).get("m")?.list ?? []) as Box[];

const archives = async (stalwartId: string) => (await folders(stalwartId)).filter((b) => b.role === "archive");

/** A throwaway account on `domain` whose mail store is opened, then Archive's role (or the folder) taken away. */
async function openedBefore(name: string, change: "noRole" | "noFolder"): Promise<string> {
  const id = await adminMgmt.upsertUser({ name, domain, password: await hashPassword(randomUUID()), quotaBytes: 1e8 });
  const [archive] = await archives(id);
  if (!archive) throw new Error("expected the default Archive");
  const args =
    change === "noRole"
      ? { accountId: id, update: { [archive.id]: { role: null } } }
      : { accountId: id, destroy: [archive.id] };
  await adminMgmt.transport.rawCall(USING, [["Mailbox/set", args, "s"]]);
  expect(await archives(id)).toEqual([]);
  return id;
}

describe("Archive folder against Stalwart", () => {
  it("is created for a newly provisioned mailbox, and backfilled once for older ones", async () => {
    // What the dev plan and the deploy's bootstrap apply (idempotent).
    await applyDefaultFolders(adminMgmt);
    await adminMgmt.reloadSettings();

    // A new mailbox through the provisioning job, with the production provisioning key.
    await adminMgmt.upsertDomain({ name: domain });
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `archive ${tag}` })
      .returning();
    if (!account) throw new Error("account not created");
    accountId = account.id;
    const [m] = await db
      .insert(schema.mailbox)
      .values({ accountId, address: `new@${domain}`, quotaBytes: 50 * 1024 * 1024, status: "provisioning" })
      .returning();
    if (!m) throw new Error("mailbox not created");
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    const mail = stalwartMailServer(keys.provisioning);
    for (let i = 0; i < 20; i++) {
      const [r] = await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id));
      if (r?.status === "active") break;
      if (!(await runNextJob(deps, mail))) await new Promise((res) => setTimeout(res, 100));
    }
    const [row] = await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id));
    expect(row?.status).toBe("active");
    const fresh = row?.stalwartId ?? "";
    expect(await archives(fresh)).toEqual([expect.objectContaining({ name: "Archive", role: "archive" })]);

    // No management key can act inside a mailbox: the backfill needs the administrator credential.
    for (const k of [keys.provisioning, keys.operations, keys.audit]) {
      await expect(ensureArchiveFolder(k, fresh)).rejects.toThrow();
    }
    expect(await archives(fresh)).toHaveLength(1);

    // Older accounts: one with an Archive folder but no role, one with none at all.
    const noRole = await openedBefore("norole", "noRole");
    const noFolder = await openedBefore("nofolder", "noFolder");

    const first = await backfillArchiveFolders(adminMgmt, { domains: [domain] });
    expect(first).toEqual({ checked: 3, created: 1, roleSet: 1, failed: [] });
    for (const id of [fresh, noRole, noFolder]) {
      expect(await archives(id)).toEqual([expect.objectContaining({ name: "Archive", role: "archive" })]);
    }
    // The role went onto the existing folder: no duplicate.
    expect((await folders(noRole)).filter((b) => b.name.toLowerCase() === "archive")).toHaveLength(1);

    const snapshot = await Promise.all([fresh, noRole, noFolder].map(folders));
    expect(await backfillArchiveFolders(adminMgmt, { domains: [domain] })).toEqual({
      checked: 3,
      created: 0,
      roleSet: 0,
      failed: [],
    });
    const byId = (list: Box[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    expect((await Promise.all([fresh, noRole, noFolder].map(folders))).map(byId)).toEqual(snapshot.map(byId));
  });
});
