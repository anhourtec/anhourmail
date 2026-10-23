// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Provisioning worker (CLAUDE.md rule 26): claims jobs from the Postgres queue and applies them to Stalwart.
 * Polls every 2 s when idle; several workers can run (claims use SKIP LOCKED). Heartbeat file for the container
 * healthcheck: `find /tmp/worker-heartbeat -mmin -2`. SIGTERM finishes the current job, then exits.
 */
import { writeFileSync } from "node:fs";

import { runNextJob } from "@anhourmail/core/provisioning";
import { log } from "@anhourmail/server/log";

import { runtime } from "./runtime";
import { verifyStalwartCredentials } from "./stalwart";

const HEARTBEAT = process.env.WORKER_HEARTBEAT ?? "/tmp/worker-heartbeat";
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? "2000");
const l = log.child({ component: "worker" });
const state = { stopping: false };
const stopping = (): boolean => state.stopping;

process.on("SIGTERM", () => {
  state.stopping = true;
});
process.on("SIGINT", () => {
  state.stopping = true;
});

const { deps, mail, close } = runtime("worker");
// The provisioning key must be exactly its documented set (no `impersonate`): refuse to start otherwise.
await verifyStalwartCredentials("worker");
const beat = () => {
  writeFileSync(HEARTBEAT, new Date().toISOString());
};
beat();
const heartbeat = setInterval(beat, 30_000);
l.info("worker started");

while (!stopping()) {
  try {
    const job = await runNextJob(deps, mail);
    if (job) l.info("job processed", { jobId: job.id, kind: job.kind, attempt: job.attempts });
    else await new Promise((r) => setTimeout(r, IDLE_MS));
  } catch (err) {
    // Queue or database trouble: back off and keep going (the job itself is retried by the queue).
    l.error("worker loop error", { err });
    await new Promise((r) => setTimeout(r, IDLE_MS * 5));
  }
}

clearInterval(heartbeat);
await close();
l.info("worker stopped");
