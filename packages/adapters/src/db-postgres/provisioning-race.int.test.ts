// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The worker's read-then-write of a mailbox racing a person's lifecycle change (Postgres only: the in-memory adapter
 * runs one unit of work at a time). The provisioning service's closing unit of work reads the mailbox's status and
 * writes it back (keeping a suspension in force, or leaving a status that changed while it worked alone). If a resume
 * is still uncommitted when it reads, a plain read sees "suspended" and the write, queued behind the resume's row lock,
 * then puts "suspended" back over the committed resume: the mailbox stays suspended although its owner resumed it.
 * `getMailbox` locks the row, so the read waits for the resume and sees it.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";

import { createDb, schema } from "./client";
import { PgUnitOfWork } from "./repositories";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (integration tests need the compose stack)");

const { db, pool } = createDb(url);
const uow = new PgUnitOfWork(db);
const accountIds: string[] = [];

afterAll(async () => {
  for (const id of accountIds) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, id));
  await pool.end();
});

async function suspendedMailbox(): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const [account] = await db
    .insert(schema.customerAccount)
    .values({ name: `race ${tag}` })
    .returning();
  if (!account) throw new Error("account not created");
  accountIds.push(account.id);
  const [m] = await db
    .insert(schema.mailbox)
    .values({ accountId: account.id, address: `jane@race-${tag}.test`, quotaBytes: 1024, status: "suspended" })
    .returning();
  if (!m) throw new Error("mailbox not created");
  return m.id;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("a resume committed while the worker closes its job is never overwritten by the suspension", async () => {
  const id = await suspendedMailbox();
  const didTransition = deferred();
  const gate = deferred();

  // The person resumes the mailbox; their unit of work holds the change uncommitted for a moment.
  const resume = uow.run(async (r) => {
    expect(await r.mailboxes.transition(id, ["suspended"], "provisioning", null)).toBe(true);
    didTransition.resolve();
    await gate.promise;
  });
  await didTransition.promise;

  // Meanwhile the worker closes the suspension's job: read the status, keep a suspension, leave anything else.
  const worker = uow.run(async (r) => {
    const current = await r.directory.getMailbox(id);
    if (!current) throw new Error("mailbox not found");
    await r.directory.markMailbox(id, { status: current.status, lastError: null });
    return current.status;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  gate.resolve();
  await resume;

  expect(await worker).toBe("provisioning");
  const [row] = await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, id));
  expect(row?.status).toBe("provisioning");
});
