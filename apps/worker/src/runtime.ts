// SPDX-License-Identifier: AGPL-3.0-only
import { createDb, PgUnitOfWork } from "@anhourmail/adapters/postgres";
import { stalwartMailServer } from "@anhourmail/adapters/stalwart";
import { type Deps, systemClock } from "@anhourmail/core";
import type { MailServer } from "@anhourmail/core/provisioning";
import { stalwart } from "@anhourmail/stalwart-client";

/** Composition root for worker processes (ADR-0008): Postgres unit of work + Stalwart mail server. */
export function runtime(): { deps: Deps; mail: MailServer; close: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  return {
    deps: { uow: new PgUnitOfWork(db), clock: systemClock },
    mail: stalwartMailServer(stalwart()),
    close: () => pool.end(),
  };
}
