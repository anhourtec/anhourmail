// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm";

import type { Db } from "./client";
import { customerDomain } from "./schema";

/** Development DNS only (adapters/dns `devResolver`): the ownership tokens issued for a domain name. */
export async function domainVerifyTokens(database: Db, name: string): Promise<string[]> {
  const rows = await database
    .select({ token: customerDomain.verifyToken })
    .from(customerDomain)
    .where(eq(customerDomain.name, name));
  return rows.map((r) => r.token);
}
