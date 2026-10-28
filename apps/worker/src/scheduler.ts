// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scheduler (CLAUDE.md rule 17): periodic jobs run here, never in a host crontab. One job at a time, each
 * spawned as its own process with a timeout; a heartbeat file backs the container healthcheck
 * (`find /tmp/scheduler-heartbeat -mmin -2`). Event-driven provisioning runs in the queue worker (src/worker.ts).
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { log } from "@anhourmail/server/log";

import { checkStalwartSettings, verifyStalwartCredentials } from "./stalwart";

type Job = {
  name: string;
  script: string;
  everyMs: number;
  timeoutMs: number;
  enabled: boolean;
  /**
   * Stalwart keys this job's process needs beyond the base (provisioning). Only `job:reconcile` reads managed Sieve
   * scripts, so only it gets the audit key (ADR-0020 "Credential split"): the scheduler strips `STALWART_AUDIT_KEY`
   * from the environment every other job inherits.
   */
  stalwartKeys?: readonly "audit"[];
};

export const JOBS: readonly Job[] = [
  // Section 11: verify every audit hash chain and alert on breaks.
  { name: "audit-verify", script: "job:audit-verify", everyMs: 6 * 3600_000, timeoutMs: 10 * 60_000, enabled: true },
  // Rule 26: desired state vs Stalwart; reports drift, never deletes. The only job that reads managed scripts.
  {
    name: "reconcile",
    script: "job:reconcile",
    everyMs: 3600_000,
    timeoutMs: 10 * 60_000,
    enabled: true,
    stalwartKeys: ["audit"],
  },
  // ADR-0020: the service accounts hold API keys only — a cheap check, every minute.
  { name: "service-accounts", script: "job:service-accounts", everyMs: 60_000, timeoutMs: 60_000, enabled: true },
  // Pending customer domains: activate them once their DNS checks out (docs: "re-checks automatically").
  { name: "domain-recheck", script: "job:domain-recheck", everyMs: 5 * 60_000, timeoutMs: 4 * 60_000, enabled: true },
  // Pending customer domains that were abandoned: expire them, or take them off the mail server (PENDING_DOMAIN).
  { name: "domain-expiry", script: "job:domain-expiry", everyMs: 24 * 3600_000, timeoutMs: 15 * 60_000, enabled: true },
  // Deleted mailboxes past their grace period: remove the Stalwart account, then the rows (audited).
  { name: "mailbox-purge", script: "job:mailbox-purge", everyMs: 3600_000, timeoutMs: 10 * 60_000, enabled: true },
  // Storage used per mailbox for the console (sizes only, read with the provisioning key; keeps the last good value).
  { name: "storage-usage", script: "job:storage-usage", everyMs: 10 * 60_000, timeoutMs: 5 * 60_000, enabled: true },
];

/** The environment a job's process gets: the audit key only for jobs that declare it (`stalwartKeys`). */
function jobEnv(job: Job): NodeJS.ProcessEnv {
  if (job.stalwartKeys?.includes("audit")) return process.env;
  const { STALWART_AUDIT_KEY: _audit, ...rest } = process.env;
  return rest;
}

const HEARTBEAT = process.env.SCHEDULER_HEARTBEAT ?? "/tmp/scheduler-heartbeat";
const l = log.child({ component: "scheduler" });
const state = { stopping: false };
/** Read through a function so the checks after each await aren't narrowed away. */
const stopping = (): boolean => state.stopping;

const beat = () => {
  writeFileSync(HEARTBEAT, new Date().toISOString());
};

function runJob(job: Job): Promise<number> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("npm", ["run", "--silent", job.script], {
      stdio: ["ignore", "inherit", "inherit"],
      env: jobEnv(job),
    });
    const timer = setTimeout(() => {
      l.error("job timed out", { job: job.name, timeoutMs: job.timeoutMs });
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, job.timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const status = code ?? 1;
      l.at(status === 0 ? "info" : "error", "job finished", {
        job: job.name,
        code: status,
        durationMs: Date.now() - started,
      });
      resolve(status);
    });
  });
}

async function loop(): Promise<void> {
  const next = new Map(JOBS.map((j) => [j.name, Date.now() + 30_000] as const));
  beat();
  setInterval(beat, 30_000).unref();
  l.info("scheduler started", { jobs: JOBS.filter((j) => j.enabled).map((j) => j.name) });
  while (!stopping()) {
    for (const job of JOBS) {
      if (!job.enabled || stopping()) continue;
      if ((next.get(job.name) ?? 0) <= Date.now()) {
        next.set(job.name, Date.now() + job.everyMs);
        await runJob(job);
      }
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

process.on("SIGTERM", () => {
  state.stopping = true;
});
if (process.env.SCHEDULER_DRY_RUN !== "true") {
  // The jobs it spawns inherit this environment: the provisioning key and the read-only audit key, nothing else, each
  // exactly its documented set (ADR-0020 "Credential split").
  checkStalwartSettings("scheduler");
  await verifyStalwartCredentials("scheduler");
  await loop();
}
