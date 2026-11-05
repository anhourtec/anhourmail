// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The mail importer (ADR-0030 §1, §6): its own process and container (from the worker image), separate from the
 * provisioning worker. It claims mail imports from Postgres, runs one slice of each (at most `IMPORT_SLICE_MINUTES`)
 * and gives it back, `IMPORT_PROCESS_CONCURRENCY` at once. It holds **no Stalwart management key**: it signs in to
 * the destination over IMAPS with each import's own sealed, IMAP-only credential, and to the source with the
 * person's sealed app password, opening both with the key ring for one slice only. Mail passes through memory one
 * message at a time; the log carries import ids, outcomes and counts only (never hosts, names or folder names).
 *
 * Heartbeat for the container healthcheck: `find /tmp/importer-heartbeat -mmin -2`. SIGTERM stops claiming; a slice
 * that is cut off resumes from its last checkpoint on any importer once its two-minute lease runs out.
 */
import { writeFileSync } from "node:fs";

import { imapMailDestination, type ImapTarget, imapMailSource } from "@anhourmail/adapters/imap";
import { createDb, PgUnitOfWork } from "@anhourmail/adapters/postgres";
import { systemClock } from "@anhourmail/core";
import {
  DEFAULT_RUNNER_CONFIG,
  ImportConnectError,
  type MailSource,
  type RunnerConfig,
  runNextImportSlice,
} from "@anhourmail/core/imports";
import { keyRingFromEnv } from "@anhourmail/server/keyring";
import { log } from "@anhourmail/server/log";

import { importerConfig } from "./importer-config";
import { workerPlatform } from "./platform";

const l = log.child({ component: "importer" });
const config = importerConfig();
const state = { stopping: false };
const stopping = (): boolean => state.stopping;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    state.stopping = true;
  });
}

const { db, pool } = createDb(config.databaseUrl);
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: workerPlatform() };
const sealer = keyRingFromEnv({
  spec: process.env.SECRETS_KEYRING,
  production: process.env.NODE_ENV === "production",
  devFallbackSecret: process.env.BETTER_AUTH_SECRET,
});
// Development only (refused in production by the config check): an allow-listed source's 993/143 may listen elsewhere.
const connectTo = (t: ImapTarget) => ({
  address: t.address,
  port: t.verifyCertificate ? t.port : (config.devSourcePorts.get(t.port) ?? t.port),
});
const imapSource = imapMailSource({
  maxMessageBytes: config.maxMessageBytes,
  allow: config.devSources,
  ...(config.devSourcePorts.size > 0 ? { connectTo } : {}),
});
// Outside production only the dev mail server is ever connected to (never a real provider; rule 19's spirit).
const devOnly = process.env.NODE_ENV !== "production";
const source: MailSource = {
  connect: async (endpoint, auth, signal) => {
    const pair = `${endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host}:${String(endpoint.port)}`;
    if (devOnly && !config.devSources.has(pair)) throw new ImportConnectError("blocked_address");
    return imapSource.connect(endpoint, auth, signal);
  },
};
const ports = {
  source,
  destination: imapMailDestination({
    endpoint: config.destination,
    servername: config.destinationTlsName,
    insecureDevCertificate: config.destinationInsecure,
    maxMessageBytes: config.maxMessageBytes,
  }),
  sealer,
};
const runner: RunnerConfig = {
  ...DEFAULT_RUNNER_CONFIG,
  sliceMs: config.sliceMs,
  leaseMs: config.leaseMs,
  renewEveryMs: Math.max(1000, Math.floor(config.leaseMs / 4)),
  maxMessagesPerSecond: config.maxMessagesPerSecond,
  maxBytesPerSecond: config.maxBytesPerSecond,
  maxMessageBytes: config.maxMessageBytes,
  global: config.globalConcurrency,
  messageCap: (tier) => config.messageCaps.get(tier) ?? null,
};

const beat = () => {
  writeFileSync(config.heartbeat, new Date().toISOString());
};
beat();
const heartbeat = setInterval(beat, 30_000);
l.info("importer started", { concurrency: config.processConcurrency, sliceMinutes: config.sliceMs / 60_000 });

async function lane(n: number): Promise<void> {
  while (!stopping()) {
    try {
      const out = await runNextImportSlice(deps, ports, runner);
      if (out) l.info("import slice finished", { lane: n, ...out });
      else await new Promise((r) => setTimeout(r, config.idleMs));
    } catch (err) {
      // Postgres trouble: the import itself is untouched (its lease runs out); back off, then exit if it persists.
      l.error("importer loop error", { lane: n, errorName: err instanceof Error ? err.name : "unknown" });
      await new Promise((r) => setTimeout(r, config.idleMs * 5));
    }
  }
}

await Promise.all(Array.from({ length: config.processConcurrency }, (_, i) => lane(i + 1)));
clearInterval(heartbeat);
await pool.end();
l.info("importer stopped");
