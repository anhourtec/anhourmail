// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createMailer, type Mailer } from "@anhourmail/adapters/mail";
import { devResolver, systemResolver } from "@anhourmail/adapters/dns";
import { db, devDomainClaims, PgUnitOfWork } from "@anhourmail/adapters/postgres";
import { type Deps, systemClock } from "@anhourmail/core";
import type { DnsResolver } from "@anhourmail/core/domains";
import type { PasswordHasher } from "@anhourmail/core/mailboxes";
import type { BreachedPasswords } from "@anhourmail/core/security";
import { type Counter, redisCounter } from "@anhourmail/server/rate-limit";
import { redis } from "@anhourmail/server/redis";

import { breachedPasswords } from "./adapters/breached-passwords";
import { mailboxPasswords } from "./adapters/mailbox-passwords";
import { breachedPasswordMode, env } from "./env";
import { platform } from "./platform";

/**
 * Composition root: the only place the app picks adapters (ADR-0008). Tests swap in memory adapters with
 * `setContainerForTests`.
 */
export type Container = {
  deps: Deps;
  counter: Counter;
  mailer: Mailer;
  dns: DnsResolver;
  /** Mailbox passwords → argon2id PHC strings (the only form they are kept or queued in; rule 23). */
  passwords: PasswordHasher;
  /** New console passwords (sign-up, reset, invite logins) are checked with the same breached-password check. */
  breaches: BreachedPasswords;
};

let override: Container | null = null;
let real: Container | null = null;

export function container(): Container {
  if (override) return override;
  if (real) return real;
  const breaches = breachedPasswords(breachedPasswordMode(env()));
  real = {
    deps: { uow: new PgUnitOfWork(db()), clock: systemClock, platform: platform() },
    counter: redisCounter(redis()),
    mailer: createMailer({ url: env().MAIL_TRANSPORT_URL, from: env().MAIL_FROM }),
    // Development answers for `.test` names (devResolver); production always asks real DNS.
    dns:
      env().NODE_ENV === "production"
        ? systemResolver()
        : devResolver(systemResolver(), (name) => devDomainClaims(db(), name), platform()),
    passwords: mailboxPasswords(env().MAILBOX_PASSWORD_GRANT_KEY, breaches),
    breaches,
  };
  return real;
}

export function setContainerForTests(c: Container | null): void {
  override = c;
}
