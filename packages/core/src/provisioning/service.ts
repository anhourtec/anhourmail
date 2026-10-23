// SPDX-License-Identifier: AGPL-3.0-only
import { isSystemLocalPart } from "@anhourmail/shared/addresses";

import { turnOffCatchAllFor } from "../domains/catch-all";
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
  if (job.kind === "app_password.revoke") {
    // Subject: a mailbox. Each `revoking` app password comes off the mail server, then its row goes.
    const pending = await deps.uow.run((r) => r.appPasswords.revoking(job.subjectId));
    if (pending.length === 0) return;
    const mailbox = await deps.uow.run((r) => r.directory.getMailbox(job.subjectId));
    for (const p of pending) {
      if (mailbox?.stalwartId) {
        await mail.revokeAppPassword({
          externalId: mailbox.stalwartId,
          credentialId: p.credentialId,
          createdAt: p.credentialCreatedAt,
        });
      }
      await deps.uow.run((r) => r.appPasswords.deleteRevoked(p.id));
    }
    return;
  }
  if (job.kind === "mailbox.password") {
    // Subject: a mailbox. Sets the password waiting for it (an argon2id hash; the worker never sees a password).
    const m = await deps.uow.run((r) => r.directory.getMailbox(job.subjectId));
    if (!m?.pendingPasswordHash) return; // gone, or already applied by an earlier run
    if (m.status === "deleting") {
      // Going away: nobody can sign in to it, so the waiting hash is simply dropped.
      await deps.uow.run((r) => r.directory.clearPendingPassword(m.id));
      return;
    }
    if (m.stalwartId === null) throw new Error("mailbox is not on the mail server yet");
    const { credentialId } = await mail.setMailboxPassword({
      externalId: m.stalwartId,
      address: m.address,
      passwordHash: m.pendingPasswordHash,
      grant: m.pendingPasswordGrant,
    });
    await deps.uow.run((r) => r.directory.passwordApplied(m.id, m.pendingPasswordHash, credentialId));
    return;
  }
  if (job.kind === "domain.remove") {
    const domain = await deps.uow.run((r) => r.directory.getDomain(job.subjectId));
    if (!domain) return; // already gone
    if (domain.status !== "removing") throw new Error(`domain not marked for removal (status ${domain.status})`);
    await mail.removeDomain(domain.name);
    await deps.uow.run((r) => r.directory.deleteDomain(domain.id));
    return;
  }
  if (job.kind === "domain.ensure") {
    const domain = await deps.uow.run((r) => r.directory.getDomain(job.subjectId));
    if (!domain) throw new Error("domain not found");
    // Removed before the worker got to it: nothing to add.
    if (domain.status === "removing") return;
    // Only verified domains reach the mail server (DNS ownership proven first).
    if (domain.status !== "active") throw new Error(`domain not verified (status ${domain.status})`);
    // The catch-all as it is now (only while its mailbox is active; turned off otherwise).
    const catchAll = await deps.uow.run((r) => r.catchAll.targetAddress(domain.id));
    const { externalId } = await mail.ensureDomain(domain.name, catchAll);
    // Marked for removal while we were adding it: take it off again so the mail server keeps no orphan. If the row
    // is already gone, do nothing by name — another account may hold the name by now; the reconciler reports drift.
    const now = await deps.uow.run((r) => r.directory.getDomain(domain.id));
    if (now?.status !== "active") {
      if (now?.status === "removing") await mail.removeDomain(domain.name);
      return;
    }
    await deps.uow.run((r) => r.directory.markDomain(domain.id, { stalwartId: externalId, lastError: null }));
    return;
  }
  const first = await deps.uow.run((r) => r.directory.getMailbox(job.subjectId));
  if (!first) throw new Error("mailbox not found");
  // Never create or update an address on a domain another account has verified (e.g. after a removal raced).
  const owner = await deps.uow.run((r) =>
    r.directory.claimedDomainOwner(first.address.slice(first.address.lastIndexOf("@") + 1)),
  );
  if (owner !== null && owner !== first.accountId) throw new Error("domain belongs to another account");
  // Read again right before talking to the mail server, so what we apply is the latest intent.
  const mailbox = await deps.uow.run((r) => r.directory.getMailbox(job.subjectId));
  if (!mailbox) throw new Error("mailbox not found");
  const deleting = mailbox.status === "deleting";
  // A deleted mailbox that never reached the mail server has nothing to take off it; one whose grace period has
  // ended belongs to the purge, which may be removing it right now.
  if (deleting && (mailbox.stalwartId === null || isDue(mailbox.purgeAfter, deps.clock.now()))) return;
  const creating = mailbox.stalwartId === null;
  const ensured = await mail.ensureMailbox({
    externalId: mailbox.stalwartId,
    // A new account gets the password chosen at creation; an existing one keeps its own (a reset has its own job).
    initialPasswordHash: creating ? mailbox.pendingPasswordHash : null,
    address: mailbox.address,
    quotaBytes: mailbox.quotaBytes,
    // Suspended and deleting mailboxes keep their mail but nobody can sign in, and their mail is refused.
    suspended: mailbox.status === "suspended" || deleting,
    // A deleting mailbox's aliases go with it: off the mail server, still reserved in the control plane.
    aliases: deleting
      ? []
      : mailbox.aliases.map((a) => ({ address: a.address, enabled: a.enabled, description: a.description })),
  });
  await deps.uow.run(async (r) => {
    const current = await r.directory.getMailbox(mailbox.id);
    if (!current) return;
    // Changed while we worked (suspended, resumed, deleted, restored): that change queued its own job, which applies
    // it, so the status is left alone. Otherwise a new or resumed mailbox is now active; a suspension or deletion
    // stays in force (provisioning syncs configuration, it never reinstates).
    const status =
      current.status !== mailbox.status || current.status === "suspended" || current.status === "deleting"
        ? current.status
        : "active";
    await r.directory.markMailbox(mailbox.id, { status, stalwartId: ensured.externalId, lastError: null });
    // The Password credential the reconciler compares with: the one this call created, or, for a mailbox from before
    // it was tracked, the one it has now (recorded once; a recorded id is never overwritten here, so drift stays
    // visible). A password still waiting after a create was the one it was created with.
    if (ensured.passwordCredentialId !== null && (ensured.created || current.passwordCredentialId === null)) {
      const applied = ensured.created ? mailbox.pendingPasswordHash : null;
      await r.directory.passwordApplied(mailbox.id, applied, ensured.passwordCredentialId);
    }
  });
}

const isDue = (purgeAfter: Date | null, now: Date): boolean => purgeAfter !== null && purgeAfter <= now;

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
          let catchAllOff: string[] = [];
          if (job.kind === "mailbox.password") {
            // The new password never reached the mail server: drop its hash (the old password still works).
            await repos.directory.clearPendingPassword(job.subjectId);
          } else if (job.kind === "mailbox.ensure") {
            // A suspension or a scheduled deletion stays in force; only the error is recorded. A password waiting
            // for a create that never happened isn't kept either (a reset sets a new one once it exists).
            const current = await repos.directory.getMailbox(job.subjectId);
            if (current?.stalwartId === null) await repos.directory.clearPendingPassword(job.subjectId);
            await repos.directory.markMailbox(job.subjectId, {
              status: current?.status === "suspended" || current?.status === "deleting" ? current.status : "failed",
              lastError: error,
            });
            // A mailbox that can't be applied can't receive: any catch-all pointing at it goes off.
            catchAllOff = await turnOffCatchAllFor(deps, repos, job.subjectId);
          } else if (job.kind === "domain.ensure" || job.kind === "domain.remove") {
            await repos.directory.markDomain(job.subjectId, { lastError: error });
          }
          return {
            result: undefined,
            meta: { jobId: job.id, attempts: job.attempts, error, ...(catchAllOff.length > 0 ? { catchAllOff } : {}) },
          };
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
  /**
   * Suspension on the mail server differs from the control plane (e.g. a suspend whose job gave up, or an account
   * changed by hand). Each one is re-queued for the worker; nothing is deleted.
   */
  suspensionMismatch: { address: string; desired: boolean; actual: boolean }[];
  /**
   * Active mailboxes whose customer lock is missing on the mail server (the user could write their own Sieve or
   * VacationResponse). Re-queued like suspension drift; `mailbox.ensure` re-applies the lock.
   */
  sieveLockMismatch: string[];
  clean: boolean;
};

/**
 * Compares desired state with the mail server. Reports drift and audits it; NEVER deletes anything — unknown
 * mailboxes may hold mail (CLAUDE.md rule 26). `ignoreDomains` excludes infrastructure domains (e.g. dev.test); the
 * platform domain is never excluded wholesale: only its system accounts are expected there (customers' free addresses
 * live on it).
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
  const haveSuspended = new Map(mailboxes.map((m) => [m.address, m.suspended] as const));
  const haveLocked = new Map(mailboxes.map((m) => [m.address, m.sieveLocked] as const));
  // Must exist with this quota: active and suspended mailboxes (suspension keeps the account and its mail).
  const required = desired.mailboxes.filter((m) => m.status === "active" || m.status === "suspended");
  // Ours if present: those, plus deleting mailboxes (kept until the purge, or never created if they never got that
  // far) and any mailbox the worker has created before (e.g. one being resumed). A deleting mailbox is neither
  // missing nor unknown: either state is expected during its grace period.
  const known = desired.mailboxes.filter(
    (m) => m.status === "active" || m.status === "suspended" || m.status === "deleting" || m.provisioned,
  );
  // Platform domains (free-tier and staff) have mailboxes but no customer-domain row: they are desired too, and the
  // deployment's platform domain always is (ADR-0021: it belongs to no account).
  const wantDomains = new Set([...desired.domains, ...known.map((m) => domainOf(m.address)), deps.platform.domain]);
  const knownAddresses = new Set(known.map((m) => m.address));
  // An account we don't know about is drift, except: anything on an infrastructure domain (`ignoreDomains`, e.g. the
  // dev mail domain) — but on the platform domain, which holds customers' free addresses, only the system accounts
  // (svc-*, no-reply, postmaster, …) are expected; any other unknown account there is reported like anywhere else.
  const expectedUnknown = (address: string) => {
    const domain = domainOf(address);
    if (domain === deps.platform.domain) return isSystemLocalPart(address.slice(0, address.lastIndexOf("@")));
    return ignore.has(domain);
  };

  const report: DriftReport = {
    missingOnMailServer: {
      domains: desired.domains.filter((d) => !haveDomains.has(d)),
      mailboxes: required.map((m) => m.address).filter((a) => !haveMailboxes.has(a)),
    },
    unknownOnMailServer: {
      domains: domains.filter((d) => !wantDomains.has(d) && !ignore.has(d)),
      mailboxes: mailboxes.map((m) => m.address).filter((a) => !knownAddresses.has(a) && !expectedUnknown(a)),
    },
    quotaMismatch: required.flatMap((m) => {
      const actual = haveMailboxes.get(m.address);
      return actual !== undefined && actual !== m.quotaBytes
        ? [{ address: m.address, desired: m.quotaBytes, actual }]
        : [];
    }),
    suspensionMismatch: [],
    sieveLockMismatch: [],
    clean: true,
  };
  // Settled states only: a provisioning or failed mailbox has a job (or an error) of its own.
  const settled = desired.mailboxes.filter(
    (m) => m.status === "active" || m.status === "suspended" || m.status === "deleting",
  );
  const requeue: string[] = [];
  for (const m of settled) {
    const actual = haveSuspended.get(m.address);
    const want = m.status !== "active";
    if (actual !== undefined && actual !== want) {
      report.suspensionMismatch.push({ address: m.address, desired: want, actual });
      requeue.push(m.id);
    } else if (m.status === "active" && haveLocked.get(m.address) === false) {
      // Suspended/deleting accounts are locked by their superset permissions; only active ones can drift open.
      report.sieveLockMismatch.push(m.address);
      requeue.push(m.id);
    }
  }
  report.clean =
    report.missingOnMailServer.domains.length +
      report.missingOnMailServer.mailboxes.length +
      report.unknownOnMailServer.domains.length +
      report.unknownOnMailServer.mailboxes.length +
      report.quotaMismatch.length +
      report.suspensionMismatch.length +
      report.sieveLockMismatch.length ===
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
      async (repos) => {
        // Brings suspension back in line through the normal job (in the same unit of work as the audit entry).
        for (const id of requeue) {
          await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: id, runAfter: deps.clock.now() });
        }
        return {
          result: undefined,
          meta: {
            missingDomains: report.missingOnMailServer.domains.length,
            missingMailboxes: report.missingOnMailServer.mailboxes.length,
            unknownDomains: report.unknownOnMailServer.domains.length,
            unknownMailboxes: report.unknownOnMailServer.mailboxes.length,
            quotaMismatches: report.quotaMismatch.length,
            suspensionMismatches: report.suspensionMismatch.length,
            sieveLockMismatches: report.sieveLockMismatch.length,
            requeued: requeue.length,
          },
        };
      },
    );
  }
  return report;
}

/**
 * One-off backfill (deploy step, 05-webmail.md "Settings"): queue `mailbox.ensure` for every active mailbox, so each
 * one gets the current mail-server permissions (the customer Sieve lock) and its managed Sieve script re-activated.
 * Idempotent (ensure is); suspended and deleting mailboxes are left to their own jobs. Returns how many were queued.
 */
export async function requeueActiveMailboxes(deps: Deps): Promise<number> {
  return mutation(
    deps,
    SYSTEM,
    req(`backfill-${String(deps.clock.now().getTime())}`),
    {
      action: "platform.mailboxes_requeued",
      permission: "self.profile.read",
      accountId: null,
      target: { type: "mail_server" },
    },
    async (repos) => {
      const { mailboxes } = await repos.directory.desired();
      const active = mailboxes.filter((m) => m.status === "active");
      for (const m of active) {
        await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: deps.clock.now() });
      }
      return { result: active.length, meta: { requeued: active.length } };
    },
  );
}
