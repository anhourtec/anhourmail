// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createMailer, type Mailer } from "@anhourmail/adapters/mail";
import { devResolver, systemResolver } from "@anhourmail/adapters/dns";
import { db, domainVerifyTokens, PgUnitOfWork } from "@anhourmail/adapters/postgres";
import { type Deps, systemClock } from "@anhourmail/core";
import type { DnsResolver } from "@anhourmail/core/domains";
import { type Counter, redisCounter } from "@anhourmail/server/rate-limit";
import { redis } from "@anhourmail/server/redis";

import { env } from "./env";

/**
 * Composition root: the only place the app picks adapters (ADR-0008). Tests swap in memory adapters with
 * `setContainerForTests`.
 */
export type Container = { deps: Deps; counter: Counter; mailer: Mailer; dns: DnsResolver };

let override: Container | null = null;
let real: Container | null = null;

export function container(): Container {
  if (override) return override;
  real ??= {
    deps: { uow: new PgUnitOfWork(db()), clock: systemClock },
    counter: redisCounter(redis()),
    mailer: createMailer({ url: env().MAIL_TRANSPORT_URL, from: env().MAIL_FROM }),
    // Development answers for `.test` names (devResolver); production always asks real DNS.
    dns:
      env().NODE_ENV === "production"
        ? systemResolver()
        : devResolver(systemResolver(), (name) => domainVerifyTokens(db(), name)),
  };
  return real;
}

export function setContainerForTests(c: Container | null): void {
  override = c;
}
