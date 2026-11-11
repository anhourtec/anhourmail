// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The database checks on trust tiers (migration 0043) must list exactly the shared facts, so a new tier, source or
 * reason category can't be added in one place only.
 */
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SUSPENSION_REASONS } from "@anhourmail/shared/platform";
import { TRUST_TIER_ORDER, TRUST_TIER_SOURCES } from "@anhourmail/shared/sending";

import { customerAccount, mailbox } from "./schema";

const dialect = new PgDialect();

/** The quoted values in a check's `in (...)` list, sorted. */
function checkValues(table: typeof customerAccount | typeof mailbox, name: string): string[] {
  const check = getTableConfig(table).checks.find((c) => c.name === name);
  if (!check) throw new Error(`no check ${name}`);
  const text = dialect.sqlToQuery(check.value).sql;
  const list = /in \(([^)]*)\)/.exec(text)?.[1] ?? "";
  return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "").sort();
}

describe("trust tier checks match the shared facts", () => {
  it("lists every tier and source", () => {
    expect(checkValues(customerAccount, "customer_account_trust_tier")).toEqual([...TRUST_TIER_ORDER].sort());
    expect(checkValues(customerAccount, "customer_account_trust_tier_source")).toEqual([...TRUST_TIER_SOURCES].sort());
  });

  it("lists every reason category on the account and the mailbox", () => {
    const reasons = Object.keys(SUSPENSION_REASONS).sort();
    expect(checkValues(customerAccount, "customer_account_trust_reason")).toEqual(reasons);
    expect(checkValues(mailbox, "mailbox_sending_restricted_reason")).toEqual(reasons);
  });
});
