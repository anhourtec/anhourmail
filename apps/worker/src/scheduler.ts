// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scheduler (CLAUDE.md rule 17): periodic jobs run here, never in a host crontab. One job at a time, each
 * spawned as its own process with a timeout; a heartbeat file backs the container healthcheck
 * (`find /tmp/scheduler-heartbeat -mmin -2`). Event-driven provisioning jobs arrive in phase 3 (queue worker).
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { log } from "@anhourmail/server/log";

type Job = { name: string; script: string; everyMs: number; timeoutMs: number; enabled: boolean };

export const JOBS: readonly Job[] = [
  // Section 11: verify every audit hash chain and alert on breaks.
  { name: "audit-verify", script: "job:audit-verify", everyMs: 6 * 3600_000, timeoutMs: 10 * 60_000, enabled: true },
];

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
      env: process.env,
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
if (process.env.SCHEDULER_DRY_RUN !== "true") await loop();
