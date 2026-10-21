// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";

import type { Db } from "@anhourmail/adapters/postgres";
import type { AuditScope } from "@anhourmail/core/audit";

/** Every audit scope that has entries. */
export async function selectDistinct(db: Db): Promise<AuditScope[]> {
  const res = await db.execute<{ scope: string }>(sql`select distinct scope from audit_log order by scope`);
  return res.rows.map((r) => r.scope as AuditScope);
}
