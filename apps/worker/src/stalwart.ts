// SPDX-License-Identifier: AGPL-3.0-only
import {
  credentialEnvProblems,
  type StalwartCredentialRole,
  stalwartAudit,
  stalwartProvisioning,
  verifyStalwartCredential,
} from "@anhourmail/stalwart-client";

/**
 * Which Stalwart credentials each worker-image process uses (ADR-0020 "Credential split"). The queue worker and
 * one-off jobs hold only the provisioning key (no owner access to any mailbox); the scheduler also holds the read-only
 * audit key for the hourly managed-script check, which one-off jobs may be given too. Nothing here ever holds the web
 * app's operations key.
 */
export const WORKER_CREDENTIALS = {
  worker: { required: ["provisioning"], optional: [] },
  scheduler: { required: ["provisioning", "audit"], optional: [] },
  job: { required: ["provisioning"], optional: ["audit"] },
} as const satisfies Record<
  string,
  { required: readonly StalwartCredentialRole[]; optional: readonly StalwartCredentialRole[] }
>;

export type WorkerProcess = keyof typeof WORKER_CREDENTIALS;

/** Refuses to start (throws, naming settings only) when the process's Stalwart settings are wrong for production. */
export function checkStalwartSettings(
  kind: WorkerProcess,
  env: Record<string, string | undefined> = process.env,
): void {
  const { required, optional } = WORKER_CREDENTIALS[kind];
  const problems = credentialEnvProblems(required, env, optional);
  if (problems.length > 0) throw new Error(`Worker configuration refused: ${problems.join("; ")}`);
}

/**
 * Asks Stalwart what each of the process's keys can do and refuses to start unless it is exactly the documented set
 * (a provisioning key that can impersonate stops the worker). Skipped for the dev admin.
 */
export async function verifyStalwartCredentials(kind: WorkerProcess): Promise<void> {
  for (const role of WORKER_CREDENTIALS[kind].required) {
    await verifyStalwartCredential(role, role === "audit" ? stalwartAudit() : stalwartProvisioning());
  }
}
