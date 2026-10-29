// SPDX-License-Identifier: AGPL-3.0-only
import { isSystemLocalPart } from "@anhourmail/shared/addresses";

import { turnOffCatchAllFor } from "../domains/catch-all";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { MailServer } from "./ports";
import { backoffMs, type ClaimedJob, type JobKind, MAX_ATTEMPTS } from "./types";

const SYSTEM = { kind: "system", name: "provisioning" } as const;
const req = (id: string): RequestMeta => ({ requestId: `job-${id}`, ip: null, userAgent: null });

/** Queue work for the worker. Called inside the user-facing mutation that changed the desired state. */
export function enqueueProvisioning(deps: Deps, input: { kind: JobKind; subjectId: string }) {
  return deps.uow.run((r) => r.provisioning.enqueue({ ...input, runAfter: deps.clock.now() }));
}

/** Short, single-line error text for storage (never secrets: the client error messages carry none). */
const describe = (err: unknown): string =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/\s+/g, " ").slice(0, 300);

/** This run's claim on the job was taken over by another worker: stop, touching nothing more. */
class LockLostError extends Error {
  constructor() {
    super("provisioning job claim lost");
    this.name = "LockLostError";
  }
}

/**
 * Applies a claimed job. Every call to the mail server is preceded by `held`: one unit of work that re-confirms this
 * claim (renewing its lease) and re-reads the subject's current desired state, so a worker that stalled past
 * `STALE_RUNNING_MS` and was taken over stops instead of pushing what it read before (an old password hash, a lifted
 * suspension, an old alias set or catch-all). Every directory write after a call renews the claim in its own
 * transaction too. A takeover can then only land between `held` and the call itself, which the mail-server client's
 * request timeout (seconds) keeps far below the stale limit (minutes).
 */
async function apply(deps: Deps, mail: MailServer, job: ClaimedJob): Promise<void> {
  const held = <T>(fn: (r: Repositories) => Promise<T>): Promise<T> =>
    deps.uow.run(async (r) => {
      if (!(await r.provisioning.renew(job, deps.clock.now()))) throw new LockLostError();
      return fn(r);
    });
  if (job.kind === "app_password.revoke") {
    // Subject: a mailbox. Each `revoking` app password comes off the mail server, then its row goes.
    const pending = await held((r) => r.appPasswords.revoking(job.subjectId));
    for (const p of pending) {
      const mailbox = await held((r) => r.directory.getMailbox(job.subjectId));
      if (mailbox?.stalwartId) {
        await mail.revokeAppPassword({
          externalId: mailbox.stalwartId,
          credentialId: p.credentialId,
          createdAt: p.credentialCreatedAt,
        });
      }
      await held((r) => r.appPasswords.deleteRevoked(p.id));
    }
    return;
  }
  if (job.kind === "mailbox.password") {
    // Subject: a mailbox. Sets the password waiting for it (an argon2id hash; the worker never sees a password).
    // Read right before the call, under a confirmed claim: the hash sent is the one waiting now.
    const m = await held((r) => r.directory.getMailbox(job.subjectId));
    if (!m?.pendingPasswordHash) return; // gone, or already applied by an earlier run
    if (m.status === "deleting") {
      // Going away: nobody can sign in to it, so the waiting hash is simply dropped.
      await held((r) => r.directory.clearPendingPassword(m.id));
      return;
    }
    if (m.stalwartId === null) throw new Error("mailbox is not on the mail server yet");
    const { credentialId } = await mail.setMailboxPassword({
      externalId: m.stalwartId,
      address: m.address,
      passwordHash: m.pendingPasswordHash,
      grant: m.pendingPasswordGrant,
    });
    await held(async (r) => {
      await r.directory.passwordApplied(m.id, m.pendingPasswordHash, credentialId);
      // The person's own password is on the mail server now: their first-sign-in password change is done. (An
      // admin's reset never clears it; a failed job leaves it set, and the old password keeps working.)
      if (m.pendingPasswordByOwner) await r.mailboxes.setPasswordChangeRequired(m.id, false);
    });
    return;
  }
  if (job.kind === "domain.remove") {
    const domain = await held((r) => r.directory.getDomain(job.subjectId));
    if (!domain) return; // already gone
    if (domain.status !== "removing") throw new Error(`domain not marked for removal (status ${domain.status})`);
    // Another row recorded on the mail server for this name (a claim from before the per-name lock) keeps it there:
    // only this row goes. While this row is on the mail server no other pending claim can be recorded there.
    if (!(await held((r) => r.directory.domainOnMailServerElsewhere(domain.name, domain.id)))) {
      await mail.removeDomain(domain.name);
    }
    await held((r) => r.directory.deleteDomain(domain.id));
    return;
  }
  if (job.kind === "domain.ensure") {
    const domain = await deps.uow.run((r) => r.directory.getDomain(job.subjectId));
    if (!domain) return; // removed while still pending: nothing to add
    // Removed before the worker got to it: nothing to add.
    if (domain.status === "removing") return;
    // Active (verified), or pending with its ownership and MX records found, which is when this job is queued for a
    // pending domain (`checkDomain`): the mail server creates its DKIM keys, which the customer then publishes.
    if (domain.status !== "active" && domain.status !== "pending_dns") {
      throw new Error(`domain not verified (status ${domain.status})`);
    }
    const pending = domain.status === "pending_dns";
    // Never touch a name another account has verified, and never share one mail-server domain between two pending
    // claims (removing one would take it from the other).
    const owner = await deps.uow.run((r) => r.directory.claimedDomainOwner(domain.name));
    if (owner !== null && owner !== domain.accountId) throw new Error("domain belongs to another account");
    if (pending && (await deps.uow.run((r) => r.directory.domainOnMailServerElsewhere(domain.name, domain.id)))) {
      throw new Error("domain is being set up by another account");
    }
    // The catch-all as it is now (only while its mailbox is active; turned off otherwise; never while pending), read
    // under a confirmed claim right before the call.
    const catchAll = await held(async (r) => (pending ? null : r.catchAll.targetAddress(domain.id)));
    const { externalId } = await mail.ensureDomain(domain.name, catchAll);
    // Deleted (still pending) while we were adding it: take it off again unless someone else holds the name now.
    const offAgainUnlessHeld = async () => {
      const kept = await held(
        async (r) =>
          (await r.directory.claimedDomainOwner(domain.name)) !== null ||
          (await r.directory.domainOnMailServerElsewhere(domain.name, domain.id)),
      );
      if (!kept) await mail.removeDomain(domain.name);
    };
    const now = await deps.uow.run((r) => r.directory.getDomain(domain.id));
    if (!now) return offAgainUnlessHeld();
    // Marked for removal while we were adding it: take it off again so the mail server keeps no orphan (unless another
    // row is recorded there for this name).
    if (now.status === "removing") {
      if (!(await held((r) => r.directory.domainOnMailServerElsewhere(domain.name, domain.id)))) {
        await mail.removeDomain(domain.name);
      }
      return;
    }
    // From now on a removal goes through a job that takes the domain off the mail server; a pending row deleted in
    // the moment before this (it had no mail-server id yet) is caught by the second read. Recorded under the per-name
    // lock, re-checking that no other claim was recorded meanwhile: two pending claims that both passed the check
    // above can't both own the mail server's domain (the loser leaves it in place: it is the winner's now).
    const recorded = await held(async (r) => {
      await r.directory.lockDomainName(domain.name);
      const holder = await r.directory.claimedDomainOwner(domain.name);
      if (holder !== null && holder !== domain.accountId) return false;
      if (pending && (await r.directory.domainOnMailServerElsewhere(domain.name, domain.id))) return false;
      await r.directory.markDomain(domain.id, { stalwartId: externalId, lastError: null });
      return true;
    });
    if (!recorded) throw new Error("domain is being set up by another account");
    if (!(await deps.uow.run((r) => r.directory.getDomain(domain.id)))) return offAgainUnlessHeld();
    const keys = await mail.domainDkimKeys(externalId);
    // The RSA key (the one every receiver checks) is created a moment after the domain: retry until it is there, so
    // the customer is never shown a partial set.
    if (!keys.some((k) => /(^|;)\s*k=rsa\s*(;|$)/i.test(k.value))) throw new Error("DKIM keys not ready yet");
    await held((r) => r.directory.markDomain(domain.id, { lastError: null, dkimKeys: keys }));
    return;
  }
  const first = await deps.uow.run((r) => r.directory.getMailbox(job.subjectId));
  if (!first) throw new Error("mailbox not found");
  // Never create or update an address on a domain another account has verified (e.g. after a removal raced).
  const owner = await deps.uow.run((r) =>
    r.directory.claimedDomainOwner(first.address.slice(first.address.lastIndexOf("@") + 1)),
  );
  if (owner !== null && owner !== first.accountId) throw new Error("domain belongs to another account");
  // Read again right before talking to the mail server, under a confirmed claim, so what we apply is the latest intent
  // (status and suspension, quota, aliases, sender name, a waiting password).
  const mailbox = await held((r) => r.directory.getMailbox(job.subjectId));
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
    description: mailbox.displayName,
    // A deleting mailbox's aliases go with it: off the mail server, still reserved in the control plane.
    aliases: deleting
      ? []
      : mailbox.aliases.map((a) => ({ address: a.address, enabled: a.enabled, description: a.description })),
  });
  await held(async (r) => {
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
 * A job this worker ran. `lockLost`: its claim went stale while it ran and another worker took the job over, so this
 * run's outcome (done, retry or give up) was discarded and the newer claim decides (the caller logs it).
 */
export type ProcessedJob = ClaimedJob & { lockLost: boolean };

/**
 * Claims and runs one job. Returns the job (or null when the queue is empty). Failures retry with backoff; the
 * last failure gives up, marks the subject failed and writes `platform.provisioning_failed` to the audit log.
 * Every outcome is recorded only while this run's claim still holds the job (its lock token); otherwise nothing of it
 * is written and `lockLost` is set.
 */
export async function runNextJob(deps: Deps, mail: MailServer): Promise<ProcessedJob | null> {
  const job = await deps.uow.run((r) => r.provisioning.claimNext(deps.clock.now()));
  if (!job) return null;
  return runClaimedJob(deps, mail, job);
}

/**
 * Runs a job this worker has already claimed (`runNextJob` = claim + this). Exported for tests that hold a claim while
 * another worker takes the job over.
 */
export async function runClaimedJob(deps: Deps, mail: MailServer, job: ClaimedJob): Promise<ProcessedJob> {
  let owned = true;
  try {
    await apply(deps, mail, job);
    owned = await deps.uow.run((r) => r.provisioning.complete(job, deps.clock.now()));
  } catch (err) {
    // Taken over before a side effect: nothing of this run is recorded (the newer claim applies the latest state).
    if (err instanceof LockLostError) return { ...job, lockLost: true };
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
          // Taken over by another worker: its claim decides; the subject is left as it is (audited as denied).
          if (!(await repos.provisioning.giveUp(job, error, now))) {
            owned = false;
            return {
              result: undefined,
              denied: { code: "lock_lost" },
              meta: { jobId: job.id, attempts: job.attempts },
            };
          }
          let catchAllOff: string[] = [];
          let adminPasswordKept = false;
          if (job.kind === "mailbox.password") {
            // The new password never reached the mail server, so the old one still works. The person's own change is
            // dropped (they keep the password they had). An administrator's password is kept, marked by this failed
            // job: the console asks them to set it again, and until a new one is applied the mailbox can't change its
            // own password and its login gets no console reset email (mustChangePassword stays as it is), so
            // whoever knew the old password can't take it over (docs/internal/07-security.md "Mailbox passwords").
            const current = await repos.directory.getMailbox(job.subjectId);
            adminPasswordKept =
              current !== null &&
              current.status !== "deleting" &&
              current.pendingPasswordHash !== null &&
              !current.pendingPasswordByOwner;
            if (!adminPasswordKept) await repos.directory.clearPendingPassword(job.subjectId);
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
            meta: {
              jobId: job.id,
              attempts: job.attempts,
              error,
              ...(catchAllOff.length > 0 ? { catchAllOff } : {}),
              ...(adminPasswordKept ? { adminPasswordKept } : {}),
            },
          };
        },
      );
    } else {
      owned = await deps.uow.run((r) =>
        r.provisioning.retry(job, error, new Date(now.getTime() + backoffMs(job.attempts)), now),
      );
    }
  }
  return { ...job, lockLost: !owned };
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
