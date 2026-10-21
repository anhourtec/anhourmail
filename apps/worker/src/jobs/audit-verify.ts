// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Verifies every audit hash chain (docs/internal/audit.md "Integrity"). A break is logged at fatal and the job
 * exits 1, which the scheduler reports; the alert channel is wired in phase 6.
 */
import { selectDistinct } from "./scopes";

import { createDb, PgUnitOfWork } from "@anhourmail/adapters/postgres";
import { systemClock } from "@anhourmail/core";
import { verifyAuditScope } from "@anhourmail/core/audit";
import { log } from "@anhourmail/server/log";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, pool } = createDb(url);
const deps = { uow: new PgUnitOfWork(db), clock: systemClock };
const l = log.child({ component: "audit-verify" });

let broken = 0;
const scopes = await selectDistinct(db);
for (const scope of scopes) {
  const brk = await verifyAuditScope(deps, scope);
  if (brk) {
    broken += 1;
    l.fatal("audit chain broken", { scope, seq: brk.seq, reason: brk.reason });
  }
}
l.info("audit chains verified", { scopes: scopes.length, broken });
await pool.end();
process.exit(broken === 0 ? 0 : 1);
