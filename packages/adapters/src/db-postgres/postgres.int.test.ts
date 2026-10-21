// SPDX-License-Identifier: AGPL-3.0-only
import { describeAdapterContract } from "../contract";
import { randomUUID } from "node:crypto";

import { createDb, schema } from "./client";
import { PgUnitOfWork } from "./repositories";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (integration tests need the compose stack)");

// Rows are scoped by random ids/emails per test, so runs never collide and nothing needs deleting
// (audit rows can't be deleted by design).
describeAdapterContract("postgres", async () => {
  const { db, pool } = createDb(url);
  return {
    uow: new PgUnitOfWork(db),
    cleanup: () => pool.end(),
    createUser: async (email) => {
      const id = randomUUID();
      await db.insert(schema.authUser).values({ id, name: email, email, emailVerified: true });
      return id;
    },
    seedMail: async ({ domain, address, alias, quotaBytes }) => {
      const [account] = await db
        .insert(schema.customerAccount)
        .values({ name: `contract ${domain}` })
        .returning();
      if (!account) throw new Error("account not created");
      const [d] = await db
        .insert(schema.customerDomain)
        .values({ accountId: account.id, name: domain, status: "active", verifyToken: "t" })
        .returning();
      const [m] = await db
        .insert(schema.mailbox)
        .values({ accountId: account.id, address, quotaBytes, status: "active" })
        .returning();
      if (!d || !m) throw new Error("mail rows not created");
      await db
        .insert(schema.mailAlias)
        .values({ accountId: account.id, mailboxId: m.id, address: alias, kind: "alias" });
      return { domainId: d.id, mailboxId: m.id };
    },
  };
});
