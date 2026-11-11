// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Provisioning worker (CLAUDE.md rule 26): claims jobs from the Postgres queue and applies them to Stalwart.
 * Polls every 2 s when idle; several workers can run (claims use SKIP LOCKED). Heartbeat file for the container
 * healthcheck: `find /tmp/worker-heartbeat -mmin -2`. SIGTERM finishes the current job, then exits.
 */
import { writeFileSync } from "node:fs";

import { stalwartImportTrainingSamples } from "@anhourmail/adapters/stalwart";
import { runNextJob } from "@anhourmail/core/provisioning";
import { redisAccountSignals, SENDING_PAUSE_SIGNALS_KEY } from "@anhourmail/server/account-signals";
import { log } from "@anhourmail/server/log";
import { redis } from "@anhourmail/server/redis";
import { SPAM_SAMPLE_HOLD_DEFAULT_MS, stalwartTraining } from "@anhourmail/stalwart-client";

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

const { deps, mail, billing, close } = runtime("worker");
// The provisioning key must be exactly its documented set (no `impersonate`), and the training key exactly
// spam-training samples: refuse to start otherwise.
await verifyStalwartCredentials("worker");
// Removes the spam-training samples a mail import's APPENDs created (ADR-0030); `STALWART_SPAM_SAMPLE_HOLD_MS` is the
// mail server's `holdSamplesFor` (default 180 days), which a sample's expiry is measured from.
const hold = Number(process.env.STALWART_SPAM_SAMPLE_HOLD_MS ?? SPAM_SAMPLE_HOLD_DEFAULT_MS);
if (!Number.isInteger(hold) || hold <= 0) throw new Error("STALWART_SPAM_SAMPLE_HOLD_MS must be a whole number of ms");
const trainingSamples = stalwartImportTrainingSamples(stalwartTraining(), { holdMs: hold });
// A billing sync that moved an account's trust tier tells the web app, which alone may write the managed scripts'
// sending pause (ADR-0034; the provisioning key can't write Sieve).
// Without Redis the scripts follow at the web app's next start-up pass instead.
const sendingPause = process.env.REDIS_URL ? redisAccountSignals(redis(), SENDING_PAUSE_SIGNALS_KEY) : null;
if (!sendingPause) l.warn("no REDIS_URL: trust tier changes reach managed scripts at the web app's next start");
const tierChanged = async (accountId: string) => {
  await sendingPause?.signal(accountId);
};
const beat = () => {
  writeFileSync(HEARTBEAT, new Date().toISOString());
};
beat();
const heartbeat = setInterval(beat, 30_000);
l.info("worker started");

while (!stopping()) {
  try {
    const job = await runNextJob(deps, mail, { billing: billing(), trainingSamples, tierChanged });
    if (job?.lockLost) {
      // This run's claim went stale and another worker took the job over: its outcome was discarded.
      l.warn("job lock lost", { jobId: job.id, kind: job.kind, attempt: job.attempts });
    } else if (job) l.info("job processed", { jobId: job.id, kind: job.kind, attempt: job.attempts });
    else await new Promise((r) => setTimeout(r, IDLE_MS));
  } catch (err) {
    // Queue or database trouble: back off and keep going (the job itself is retried by the queue).
    l.error("worker loop error", { err });
    await new Promise((r) => setTimeout(r, IDLE_MS * 5));
  }
}

clearInterval(heartbeat);
await close();
if (sendingPause)
  await redis()
    .quit()
    .catch(() => undefined);
l.info("worker stopped");
