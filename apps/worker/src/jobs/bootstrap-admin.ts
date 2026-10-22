// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One-off: creates the first platform Global Administrator on a fresh server and emails them a one-time link to set
 * their password (deploy/README.md "First platform administrator"). Refuses, changing nothing, once anyone holds a
 * platform role or when the email already has a console login. Audited as `platform.admin_bootstrapped` (system
 * actor). Touches only the control-plane database and the system mailer: no mail-server plan, no demo data.
 *
 *   npx tsx --env-file=.env apps/worker/src/jobs/bootstrap-admin.ts --email admin@example.org --first-name Ada \
 *     [--last-name Lovelace]
 *
 * There is no password option on purpose: nothing secret goes on the command line, and the link is never printed or
 * logged. Exit codes: 0 created and emailed, 1 refused or bad input, 2 created but the email failed (fix mail, then
 * use "Forgot password" on the console).
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import { createMailer } from "@anhourmail/adapters/mail";
import { createDb, PgUnitOfWork } from "@anhourmail/adapters/postgres";
import { DomainError, systemClock } from "@anhourmail/core";
import { log } from "@anhourmail/server/log";
import type { Platform } from "@anhourmail/shared/platform";

import { runBootstrapAdmin } from "../bootstrap-admin";
import { workerPlatform } from "../platform";

const l = log.child({ component: "bootstrap-admin" });

function fail(msg: string): never {
  l.error(msg);
  process.exit(1);
}

const need = (k: string) => process.env[k] ?? fail(`${k} is not set`);

let args: { email?: string | undefined; "first-name"?: string | undefined; "last-name"?: string | undefined };
try {
  args = parseArgs({
    options: { email: { type: "string" }, "first-name": { type: "string" }, "last-name": { type: "string" } },
    strict: true,
    allowPositionals: false,
  }).values;
} catch {
  // The parser's message can echo what was typed; keep it out of the log.
  fail("usage: bootstrap-admin --email <address> --first-name <name> [--last-name <name>] (no other options)");
}
if (!args.email || !args["first-name"]) fail("--email and --first-name are required");

const appUrl = need("APP_URL");
if (process.env.NODE_ENV === "production" && !appUrl.startsWith("https://")) {
  fail("APP_URL must be https in production");
}

// Production refuses an unset PLATFORM_DOMAIN or an APP_URL outside it (messages name settings, never values).
let platform: Platform;
try {
  platform = workerPlatform();
} catch (err) {
  fail(err instanceof Error ? err.message : "PLATFORM_DOMAIN is not usable");
}

const { db, pool } = createDb(need("DATABASE_URL"));
let code = 1;
try {
  const result = await runBootstrapAdmin({
    deps: { uow: new PgUnitOfWork(db), clock: systemClock, platform },
    mailer: createMailer({ url: need("MAIL_TRANSPORT_URL"), from: need("MAIL_FROM") }),
    appUrl,
    input: {
      email: args.email,
      firstName: args["first-name"],
      ...(args["last-name"] ? { lastName: args["last-name"] } : {}),
    },
    log: l,
    requestId: `bootstrap-${randomUUID().slice(0, 8)}`,
  });
  code = result === "created" ? 0 : result === "refused" ? 1 : 2;
} catch (err) {
  if (err instanceof DomainError) l.error(`bootstrap refused: ${err.message}`, { code: err.code });
  else l.error("bootstrap failed", { errorName: err instanceof Error ? err.name : "unknown" });
} finally {
  await pool.end();
}
process.exit(code);
