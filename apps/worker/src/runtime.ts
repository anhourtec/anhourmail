// SPDX-License-Identifier: AGPL-3.0-only
import { devResolver, systemResolver } from "@anhourmail/adapters/dns";
import { createDb, devDomainClaims, PgUnitOfWork } from "@anhourmail/adapters/postgres";
import { stalwartMailServer } from "@anhourmail/adapters/stalwart";
import { type Deps, systemClock } from "@anhourmail/core";
import type { DnsResolver } from "@anhourmail/core/domains";
import type { MailServer } from "@anhourmail/core/provisioning";
import { stalwartProvisioning } from "@anhourmail/stalwart-client";

import { workerPlatform } from "./platform";
import { checkStalwartSettings, type WorkerProcess } from "./stalwart";

/**
 * Composition root for worker processes (ADR-0008): Postgres unit of work, Stalwart mail server (the provisioning key
 * only — ADR-0020 "Credential split"), DNS. `kind` says which process this is, for the Stalwart settings check.
 */
export function runtime(kind: WorkerProcess = "job"): {
  deps: Deps;
  mail: MailServer;
  dns: DnsResolver;
  close: () => Promise<void>;
} {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const platform = workerPlatform();
  checkStalwartSettings(kind);
  const { db, pool } = createDb(url);
  return {
    deps: { uow: new PgUnitOfWork(db), clock: systemClock, platform },
    mail: stalwartMailServer(stalwartProvisioning()),
    // Development answers for `.test` names (devResolver); production always asks real DNS.
    dns:
      process.env.NODE_ENV === "production"
        ? systemResolver()
        : devResolver(systemResolver(), (name) => devDomainClaims(db, name), platform),
    close: () => pool.end(),
  };
}
