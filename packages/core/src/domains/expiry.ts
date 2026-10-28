// SPDX-License-Identifier: AGPL-3.0-only
import { PENDING_DOMAIN } from "@anhourmail/shared/plans";

import { ConflictError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import { claimStillHeld, type DnsResolver } from "./dns";
import type { CustomerDomain } from "./entity";

/**
 * Pending-domain lifecycle (docs/internal/02-mail-infrastructure.md "Pending domains"). A pending domain whose
 * ownership and MX records were found is put on the mail server for its DKIM keys; from then on the mail server treats
 * the name as local. An abandoned claim must not keep it there for good: it would block the real owner and keep our
 * other customers' mail for that name inside the mail server. So a claim is released (marked `removing`, and the
 * worker's `domain.remove` takes it off the mail server, then deletes the row) when its records are gone or it was not
 * verified in time; an unverified domain never put on the mail server is simply deleted after a while. Every such
 * change is the system's, audited in the domain's own account so its admins see why it went.
 */

const DAY_MS = 86_400_000;

/** Why a pending domain was released or expired (audit meta `reason`). */
export type ReleaseReason =
  /** Another account proved the name (ownership and MX found) and this claim's ownership record is gone. */
  | "ownership_proven_elsewhere"
  /** The daily check found its ownership or MX record gone. */
  | "records_not_found"
  /** Not verified within `PENDING_DOMAIN.onMailServerDays` (on the mail server) or `unverifiedDays` (not). */
  | "not_verified_in_time";

const requestFor = (prefix: string, d: CustomerDomain): RequestMeta => ({
  requestId: `${prefix}-${d.id.slice(0, 8)}`,
  ip: null,
  userAgent: null,
});

/**
 * Releases a pending domain that is on the mail server: `removing`, plus a `domain.remove` job, under the per-name lock
 * and only while it is still pending there (a domain verified meanwhile is refused: 409, audited as failed). Written by
 * the system in the domain's account as `domain.released` (its records are gone) or `domain.expired` (not verified in
 * time), with the reason; never another account's details.
 */
export async function releasePendingDomain(
  deps: Deps,
  d: CustomerDomain,
  why: { action: "domain.released" | "domain.expired"; reason: ReleaseReason; by: string },
): Promise<void> {
  await mutation(
    deps,
    { kind: "system", name: why.by },
    requestFor(why.by, d),
    { action: why.action, permission: "domain.manage", accountId: d.accountId, target: { type: "domain", id: d.id } },
    async (repos) => {
      await repos.directory.lockDomainName(d.name);
      const now = await repos.domains.get(d.accountId, d.id);
      if (now?.status !== "pending_dns" || now.stalwartId === null) {
        throw new ConflictError("This domain changed meanwhile.");
      }
      if (!(await repos.domains.transition(d.id, "pending_dns", "removing"))) {
        throw new ConflictError("This domain changed meanwhile.");
      }
      await repos.provisioning.enqueue({ kind: "domain.remove", subjectId: d.id, runAfter: deps.clock.now() });
      return { result: undefined, target: { label: d.name }, meta: { reason: why.reason, onMailServer: true } };
    },
  );
}

const EXPIRY = "domain-expiry";

/** Per scheduler run: at most this many domains of each kind, within this time. */
export const EXPIRY_LIMITS = { batch: 200, budgetMs: 10 * 60_000 } as const;

export type ExpiryOutcome = { expired: number; released: number; failed: number };

/**
 * Scheduler (daily): pending domains not on the mail server and older than `PENDING_DOMAIN.unverifiedDays` are deleted
 * (`domain.expired`); pending domains on the mail server older than `PENDING_DOMAIN.onMailServerDays` are released
 * (`domain.expired`), and younger ones whose ownership or MX record is gone are released (`domain.released`). A failed
 * DNS lookup never releases anything. One domain failing doesn't stop the run; it is tried again the next day.
 */
export async function expirePendingDomains(
  deps: Deps,
  dns: DnsResolver,
  limits: { batch: number; budgetMs: number } = EXPIRY_LIMITS,
): Promise<ExpiryOutcome> {
  const started = Date.now();
  const now = deps.clock.now().getTime();
  const unverifiedCutoff = new Date(now - PENDING_DOMAIN.unverifiedDays * DAY_MS);
  const setupCutoff = new Date(now - PENDING_DOMAIN.onMailServerDays * DAY_MS);
  const stale = await deps.uow.run((r) => r.domains.unverifiedBefore(unverifiedCutoff, limits.batch));
  const onServer = await deps.uow.run((r) => r.domains.pendingOnMailServer(limits.batch));
  const out: ExpiryOutcome = { expired: 0, released: 0, failed: 0 };
  const attempt = async (kind: "expired" | "released", fn: () => Promise<void>) => {
    try {
      await fn();
      out[kind] += 1;
    } catch {
      out.failed += 1; // audited as failed by `mutation`; tried again on the next run
    }
  };

  for (const d of stale) {
    if (Date.now() - started > limits.budgetMs) break;
    await attempt("expired", () =>
      mutation(
        deps,
        { kind: "system", name: EXPIRY },
        requestFor(EXPIRY, d),
        {
          action: "domain.expired",
          permission: "domain.manage",
          accountId: d.accountId,
          target: { type: "domain", id: d.id },
        },
        async (repos) => {
          // Only while still pending and off the mail server (a check may have moved it on meanwhile).
          if (!(await repos.domains.deletePending(d.id))) throw new ConflictError("This domain changed meanwhile.");
          return {
            result: undefined,
            target: { label: d.name },
            meta: { reason: "not_verified_in_time" satisfies ReleaseReason, onMailServer: false },
          };
        },
      ),
    );
  }

  for (const d of onServer) {
    if (Date.now() - started > limits.budgetMs) break;
    if (d.createdAt < setupCutoff) {
      await attempt("expired", () =>
        releasePendingDomain(deps, d, { action: "domain.expired", reason: "not_verified_in_time", by: EXPIRY }),
      );
      continue;
    }
    const state = await claimStillHeld(dns, d.name, d.verifyToken, deps.platform).catch(() => "unknown" as const);
    if (state !== "gone") continue;
    await attempt("released", () =>
      releasePendingDomain(deps, d, { action: "domain.released", reason: "records_not_found", by: EXPIRY }),
    );
  }
  return out;
}
