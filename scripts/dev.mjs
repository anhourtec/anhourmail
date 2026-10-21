#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `npm run dev`: starts the Docker services if they're down, syncs brand assets, then runs the console/webmail
 * (apps/web, with the webmail port forwarder), the site + docs (apps/site) and the provisioning worker together with labelled, coloured output. Ctrl-C stops the apps;
 * `npm run stack:down` stops the containers (CLAUDE.md rule 51: do that at the end of every session).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
else {
  console.error("No .env — run `cp .env.example .env` first.");
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
run("docker", ["compose", "--profile", "dev", "up", "-d", "--wait"]);
run("node", ["scripts/sync-brand.mjs"]);

const host = process.env.DEV_HOST ?? "0.0.0.0";
console.log(`
  Site + docs   ${process.env.SITE_URL ?? "http://localhost:43100"}  (/docs, /changelog, /credits)
  Console       ${process.env.APP_URL ?? "http://localhost:43200"}
  Webmail       ${process.env.WEBMAIL_URL ?? "http://localhost:43300"}
  Mailpit       http://localhost:${process.env.MAILPIT_UI_PORT ?? "43026"}
  Stalwart      http://localhost:${process.env.STALWART_HTTP_PORT ?? "43080"}/admin
  Listening on ${host} (LAN: http://<this-machine-ip>:<port>). Logins: credentials.md
`);

const child = spawn(
  "npx",
  [
    "concurrently",
    "--kill-others-on-fail",
    "--names",
    "web,mail,site,worker",
    "--prefix-colors",
    "blue,cyan,magenta,yellow",
    "npm run dev --workspace @anhourmail/web",
    "node scripts/dev-mail-proxy.mjs",
    "npm run dev --workspace @anhourmail/site",
    "npm run dev --workspace @anhourmail/worker",
  ],
  { stdio: "inherit", env: process.env },
);
child.on("exit", (code) => process.exit(code ?? 0));
