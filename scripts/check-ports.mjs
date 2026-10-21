#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rule 18: dev ports are uncommon (43xxx) and must not clash — except mail protocols, which use the
 * real standard ports so clients are tested as in production.
 *
 *   npm run ports:check            # before `npm run stack:up`
 *
 * Reads every `*_PORT` key from .env.example, applies overrides from .env, then fails (exit 1) when
 *   - two keys resolve to the same port,
 *   - a port is outside 40000–49151 (common or ephemeral ranges), or
 *   - a port is already taken on 127.0.0.1 by something other than this project's containers
 *     (pass --running when the stack is up to skip the "in use" check).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

function readEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+_PORT)\s*=\s*(\d+)\s*$/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

const ports = { ...readEnv(".env.example"), ...readEnv(".env") };
/** Our own stack holds these ports while it runs; detect that instead of reporting them as clashes. */
function stackRunning() {
  try {
    return (
      execFileSync("docker", ["compose", "ps", "-q", "mail-edge"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() !== ""
    );
  } catch {
    return false;
  }
}
const running = process.argv.includes("--running") || stackRunning();
const problems = [];

/** Mail protocol ports: standard on purpose (SMTP, IMAP, POP3, submission, ManageSieve). */
const MAIL_PORTS = new Set([25, 110, 143, 465, 587, 993, 995, 4190]);
const byPort = new Map();
for (const [key, port] of Object.entries(ports)) {
  const mailKey = /^STALWART_(SMTP|IMAP|IMAPS|POP3|POP3S|SUBMISSION|SUBMISSIONS|SIEVE)_PORT$/.test(key);
  if (mailKey && !MAIL_PORTS.has(port)) problems.push(`${key}=${port} should be the standard mail port`);
  if (!mailKey && (port < 40000 || port > 49151)) problems.push(`${key}=${port} is outside 40000–49151`);
  byPort.set(port, [...(byPort.get(port) ?? []), key]);
}
for (const [port, keys] of byPort) if (keys.length > 1) problems.push(`${port} is used by ${keys.join(", ")}`);

/** Something accepts connections on the port (used when we may not bind it ourselves). */
const answers = (port) =>
  new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.setTimeout(1000);
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => (sock.destroy(), resolve(false)));
  });

/**
 * Busy only if the bind fails with EADDRINUSE. Ports below 1024 can refuse a non-root bind (EACCES) while Docker
 * can still publish them, so for those we check whether anything is listening instead.
 */
const inUse = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err) => {
      if (err.code === "EADDRINUSE") resolve(true);
      else answers(port).then(resolve, () => resolve(false));
    });
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });

if (!running) {
  for (const [key, port] of Object.entries(ports)) {
    if (await inUse(port)) problems.push(`${key}=${port} is already in use on 127.0.0.1 (lsof -nP -iTCP:${port})`);
  }
}

if (problems.length > 0) {
  console.error("Port problems (CLAUDE.md rule 18):");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`ports:check — ${Object.keys(ports).length} ports, no clashes${running ? "" : ", all free"}.`);
