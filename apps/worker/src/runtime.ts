// SPDX-License-Identifier: AGPL-3.0-only
import { createBillingProvider } from "@anhourmail/adapters/billing";
import { devResolver, systemResolver } from "@anhourmail/adapters/dns";
import { createDb, devDomainClaims, PgUnitOfWork } from "@anhourmail/adapters/postgres";
import { stalwartMailServer } from "@anhourmail/adapters/stalwart";
import { type Deps, systemClock } from "@anhourmail/core";
import type { BillingProvider } from "@anhourmail/core/billing";
import type { DnsResolver } from "@anhourmail/core/domains";
import type { MailServer } from "@anhourmail/core/provisioning";
import { redis } from "@anhourmail/server/redis";
import { stalwartProvisioning } from "@anhourmail/stalwart-client";

import { checkBillingSettings } from "./billing";
import { workerPlatform } from "./platform";
import { checkStalwartSettings, type WorkerProcess } from "./stalwart";

/**
 * Composition root for worker processes (ADR-0008): Postgres unit of work, Stalwart mail server (the provisioning key
 * only — ADR-0020 "Credential split"), DNS, and the billing provider (ADR-0029; null when billing is off, built on
 * first use). `kind` says which process this is, for the Stalwart settings check.
 */
export function runtime(kind: WorkerProcess = "job"): {
  deps: Deps;
  mail: MailServer;
  dns: DnsResolver;
  billing: () => BillingProvider | null;
  close: () => Promise<void>;
} {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const platform = workerPlatform();
  checkStalwartSettings(kind);
  checkBillingSettings();
  const { db, pool } = createDb(url);
  let billing: BillingProvider | null | undefined;
  return {
    deps: { uow: new PgUnitOfWork(db), clock: systemClock, platform },
    mail: stalwartMailServer(stalwartProvisioning()),
    // Development answers for `.test` names (devResolver); production always asks real DNS.
    dns:
      process.env.NODE_ENV === "production"
        ? systemResolver()
        : devResolver(systemResolver(), (name) => devDomainClaims(db, name), platform),
    // The fake (dev and tests) shares its state with the web app through Redis; the worker only reads from it.
    billing: () =>
      (billing ??= createBillingProvider({
        env: process.env,
        appUrl: process.env.APP_URL ?? "",
        fakeSeed: process.env.BETTER_AUTH_SECRET ?? "",
        redis,
      })),
    close: async () => {
      await pool.end();
      if (billing?.kind === "fake") await redis().quit();
    },
  };
}
