// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm";

import type { DkimKey } from "@anhourmail/shared/dns";

import type { Db } from "./client";
import { customerDomain } from "./schema";

/**
 * Development DNS only (adapters/dns `devResolver`): every claim on a domain name — its ownership token and the DKIM
 * keys the mail server gave it (null until read) — so the dev resolver can answer as if each was published.
 */
export async function devDomainClaims(
  database: Db,
  name: string,
): Promise<{ verifyToken: string; dkimKeys: DkimKey[] | null }[]> {
  const rows = await database
    .select({ verifyToken: customerDomain.verifyToken, dkimKeys: customerDomain.dkimKeys })
    .from(customerDomain)
    .where(eq(customerDomain.name, name));
  return rows.map((r) => ({ verifyToken: r.verifyToken, dkimKeys: r.dkimKeys ?? null }));
}
