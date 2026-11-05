// SPDX-License-Identifier: AGPL-3.0-only
import {
  credentialEnvProblems,
  type StalwartCredentialRole,
  stalwartAudit,
  stalwartProvisioning,
  stalwartTraining,
  verifyStalwartCredential,
} from "@anhourmail/stalwart-client";

/**
 * Which Stalwart credentials each worker-image process uses (ADR-0020 "Credential split"). The queue worker holds the
 * provisioning key (no owner access to any mailbox) and the training key, which only finds and destroys the
 * spam-training samples a mail import created (ADR-0030); one-off jobs hold the provisioning key; the scheduler also
 * holds the read-only audit key for the hourly managed-script check, which one-off jobs may be given too. The mail
 * importer holds none at all (it reaches the mail server's IMAPS port only). Nothing here ever holds the web app's
 * operations key.
 */
export const WORKER_CREDENTIALS = {
  worker: { required: ["provisioning", "training"], optional: [] },
  scheduler: { required: ["provisioning", "audit"], optional: [] },
  // One-off jobs run in the worker or scheduler container and may inherit either's extra key (they use neither).
  job: { required: ["provisioning"], optional: ["audit", "training"] },
  importer: { required: [], optional: [] },
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
  // The mailbox password grant key belongs to the web app and the management proxy only: with it, the provisioning key
  // could replace any customer's password (ADR-0020 "Mailbox passwords"). Refused everywhere, dev included.
  if ((env.MAILBOX_PASSWORD_GRANT_KEY ?? "") !== "") {
    problems.push("MAILBOX_PASSWORD_GRANT_KEY must not be given to this process (web app and management proxy only)");
  }
  // The send-on-behalf key makes tags that let a mailbox's mail name someone else as Sender (ADR-0026 §6): web app and
  // the mail server's script only. Refused everywhere, dev included (dev derives it; nothing to set).
  if ((env.SENDER_DELEGATION_KEY ?? "") !== "") {
    problems.push("SENDER_DELEGATION_KEY must not be given to this process (web app and mail server only)");
  }
  if (problems.length > 0) throw new Error(`Worker configuration refused: ${problems.join("; ")}`);
}

/**
 * Asks Stalwart what each of the process's keys can do and refuses to start unless it is exactly the documented set
 * (a provisioning key that can impersonate stops the worker). Skipped for the dev admin.
 */
export async function verifyStalwartCredentials(kind: WorkerProcess): Promise<void> {
  const clients = { provisioning: stalwartProvisioning, audit: stalwartAudit, training: stalwartTraining };
  for (const role of WORKER_CREDENTIALS[kind].required) {
    await verifyStalwartCredential(role, clients[role]());
  }
}
