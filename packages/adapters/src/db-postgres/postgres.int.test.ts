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
  };
});
