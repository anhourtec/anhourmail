// SPDX-License-Identifier: AGPL-3.0-only
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import type { MailServer } from "./ports";
import { backoffMs, type JobKind, MAX_ATTEMPTS, type ProvisioningJob } from "./types";

const SYSTEM = { kind: "system", name: "provisioning" } as const;
const req = (id: string): RequestMeta => ({ requestId: `job-${id}`, ip: null, userAgent: null });

/** Queue work for the worker. Called inside the user-facing mutation that changed the desired state. */
export function enqueueProvisioning(deps: Deps, input: { kind: JobKind; subjectId: string }) {
  return deps.uow.run((r) => r.provisioning.enqueue({ ...input, runAfter: deps.clock.now() }));
}

/** Short, single-line error text for storage (never secrets: the client error messages carry none). */
const describe = (err: unknown): string =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/\s+/g, " ").slice(0, 300);

async function apply(deps: Deps, mail: MailServer, job: ProvisioningJob): Promise<void> {
  if (job.kind === "domain.ensure") {
    const domain = await deps.uow.run((r) => r.directory.getDomain(job.subjectId));
    if (!domain) throw new Error("domain not found");
    // Only verified domains reach the mail server (DNS ownership proven first).
    if (domain.status !== "active") throw new Error(`domain not verified (status ${domain.status})`);
    const { externalId } = await mail.ensureDomain(domain.name);
    await deps.uow.run((r) => r.directory.markDomain(domain.id, { stalwartId: externalId, lastError: null }));
    return;
  }
  const mailbox = await deps.uow.run((r) => r.directory.getMailbox(job.subjectId));
  if (!mailbox) throw new Error("mailbox not found");
  const { externalId } = await mail.ensureMailbox({
    address: mailbox.address,
    quotaBytes: mailbox.quotaBytes,
    aliases: mailbox.aliases.map((a) => ({ address: a.address, enabled: a.enabled, description: a.description })),
  });
  await deps.uow.run((r) =>
    // A suspended mailbox stays suspended: provisioning syncs configuration, it never reinstates.
    r.directory.markMailbox(mailbox.id, {
      status: mailbox.status === "suspended" ? "suspended" : "active",
      stalwartId: externalId,
      lastError: null,
    }),
  );
}

/**
 * Claims and runs one job. Returns the job (or null when the queue is empty). Failures retry with backoff; the
 * last failure gives up, marks the subject failed and writes `platform.provisioning_failed` to the audit log.
 */
export async function runNextJob(deps: Deps, mail: MailServer): Promise<ProvisioningJob | null> {
  const job = await deps.uow.run((r) => r.provisioning.claimNext(deps.clock.now()));
  if (!job) return null;
  try {
    await apply(deps, mail, job);
    await deps.uow.run((r) => r.provisioning.complete(job.id, deps.clock.now()));
  } catch (err) {
    const error = describe(err);
    const now = deps.clock.now();
    if (job.attempts >= MAX_ATTEMPTS) {
      await mutation(
        deps,
        SYSTEM,
        req(job.id),
        {
          action: "platform.provisioning_failed",
          permission: "self.profile.read",
          accountId: null,
          target: { type: job.kind, id: job.subjectId },
        },
        async (repos) => {
          await repos.provisioning.giveUp(job.id, error, now);
          if (job.kind === "mailbox.ensure") {
            await repos.directory.markMailbox(job.subjectId, { status: "failed", lastError: error });
          } else {
            await repos.directory.markDomain(job.subjectId, { lastError: error });
          }
          return { result: undefined, meta: { jobId: job.id, attempts: job.attempts, error } };
        },
      );
    } else {
      await deps.uow.run((r) =>
        r.provisioning.retry(job.id, error, new Date(now.getTime() + backoffMs(job.attempts)), now),
      );
    }
  }
  return job;
}

export type DriftReport = {
  /** Desired in the control plane but absent on the mail server. */
  missingOnMailServer: { domains: string[]; mailboxes: string[] };
  /** Present on the mail server but unknown to the control plane (never deleted automatically). */
  unknownOnMailServer: { domains: string[]; mailboxes: string[] };
  quotaMismatch: { address: string; desired: number; actual: number }[];
  clean: boolean;
};

/**
 * Compares desired state with the mail server. Reports drift and audits it; NEVER deletes anything — unknown
 * mailboxes may hold mail (CLAUDE.md rule 26). `ignoreDomains` excludes infrastructure domains (e.g. dev.test).
 */
export async function reconcile(
  deps: Deps,
  mail: MailServer,
  opts: { ignoreDomains?: readonly string[] } = {},
): Promise<DriftReport> {
  const ignore = new Set(opts.ignoreDomains ?? []);
  const domainOf = (address: string) => address.split("@")[1] ?? "";
  const [desired, domains, mailboxes] = await Promise.all([
    deps.uow.run((r) => r.directory.desired()),
    mail.listDomains(),
    mail.listMailboxes(),
  ]);
  const haveDomains = new Set(domains);
  const haveMailboxes = new Map(mailboxes.map((m) => [m.address, m.quotaBytes] as const));
  // Platform domains (free-tier and staff) have mailboxes but no customer-domain row: they are desired too.
  const wantDomains = new Set([...desired.domains, ...desired.mailboxes.map((m) => domainOf(m.address))]);
  const wantMailboxes = new Map(desired.mailboxes.map((m) => [m.address, m.quotaBytes] as const));

  const report: DriftReport = {
    missingOnMailServer: {
      domains: desired.domains.filter((d) => !haveDomains.has(d)),
      mailboxes: desired.mailboxes.map((m) => m.address).filter((a) => !haveMailboxes.has(a)),
    },
    unknownOnMailServer: {
      domains: domains.filter((d) => !wantDomains.has(d) && !ignore.has(d)),
      mailboxes: mailboxes.map((m) => m.address).filter((a) => !wantMailboxes.has(a) && !ignore.has(domainOf(a))),
    },
    quotaMismatch: desired.mailboxes.flatMap((m) => {
      const actual = haveMailboxes.get(m.address);
      return actual !== undefined && actual !== m.quotaBytes
        ? [{ address: m.address, desired: m.quotaBytes, actual }]
        : [];
    }),
    clean: true,
  };
  report.clean =
    report.missingOnMailServer.domains.length +
      report.missingOnMailServer.mailboxes.length +
      report.unknownOnMailServer.domains.length +
      report.unknownOnMailServer.mailboxes.length +
      report.quotaMismatch.length ===
    0;

  if (!report.clean) {
    await mutation(
      deps,
      SYSTEM,
      req(`reconcile-${String(deps.clock.now().getTime())}`),
      {
        action: "platform.reconciler_drift",
        permission: "self.profile.read",
        accountId: null,
        target: { type: "mail_server" },
      },
      async () => ({
        result: undefined,
        meta: {
          missingDomains: report.missingOnMailServer.domains.length,
          missingMailboxes: report.missingOnMailServer.mailboxes.length,
          unknownDomains: report.unknownOnMailServer.domains.length,
          unknownMailboxes: report.unknownOnMailServer.mailboxes.length,
          quotaMismatches: report.quotaMismatch.length,
        },
      }),
    );
  }
  return report;
}
