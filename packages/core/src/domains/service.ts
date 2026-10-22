// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from "node:crypto";

import { customerDomainRecords, type DnsRecordTemplate } from "@anhourmail/shared/dns";
import { MAX_CUSTOM_DOMAINS, PLANS } from "@anhourmail/shared/plans";

import { type Actor, authorize } from "../actor";
import { ConflictError, NotFoundError, PlanLimitError } from "../errors";
import { authorizeAudited, mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { type CheckedRecord, checkRecords, type DnsResolver, requiredPass } from "./dns";
import { type CustomerDomain, type DomainStatus, normaliseDomain } from "./entity";

/** What the console and API show. Internal provisioning details (mail-server ids, errors) stay server-side. */
export type DomainView = {
  id: string;
  name: string;
  status: DomainStatus;
  /** On the mail server (the worker has applied it). */
  provisioned: boolean;
  createdAt: Date;
};

export type DomainDetail = DomainView & { records: DnsRecordTemplate[] };

/** Pending domains are re-checked automatically for this long, then left for the customer to check by hand. */
export const AUTO_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

const view = (d: CustomerDomain): DomainView => ({
  id: d.id,
  name: d.name,
  status: d.status,
  provisioned: d.stalwartId !== null,
  createdAt: d.createdAt,
});

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function scoped(repos: Repositories, accountId: string, id: string): Promise<CustomerDomain> {
  const domain = isId(id) ? await repos.domains.get(accountId, id) : null;
  if (!domain) throw new NotFoundError();
  return domain;
}

export async function listDomains(deps: Deps, actor: Actor, accountId: string): Promise<DomainView[]> {
  authorize(actor, "domain.read", accountId);
  return (await deps.uow.run((r) => r.domains.listByAccount(accountId))).map(view);
}

/** One domain with the records to publish (the live state comes from `checkDomain`). */
export async function getDomain(deps: Deps, actor: Actor, accountId: string, id: string): Promise<DomainDetail> {
  authorize(actor, "domain.read", accountId);
  const d = await deps.uow.run((r) => scoped(r, accountId, id));
  return { ...view(d), records: customerDomainRecords(d.name, d.verifyToken) };
}

/**
 * Adds a domain on a plan with custom domains. Names are unique per account; across accounts only a verified
 * (active) claim blocks others, so nobody can squat a domain by adding it without proving ownership.
 */
export async function addDomain(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { name?: unknown },
  req: RequestMeta,
): Promise<DomainDetail> {
  return mutation(
    deps,
    actor,
    req,
    { action: "domain.added", permission: "domain.manage", accountId, target: { type: "domain" } },
    async (repos) => {
      const name = normaliseDomain(input.name);
      await repos.accounts.lock(accountId); // the domain ceiling holds under concurrent adds
      const account = await repos.accounts.get(accountId);
      if (!account) throw new NotFoundError();
      if (!PLANS[account.plan].customDomains) {
        throw new PlanLimitError("Custom domains are part of the Plus and Supporter plans.");
      }
      const mine = await repos.domains.listByAccount(accountId);
      if (mine.some((d) => d.name === name)) throw new ConflictError("This domain is already in your account.");
      if (mine.length >= MAX_CUSTOM_DOMAINS) {
        throw new PlanLimitError(`An account can have up to ${String(MAX_CUSTOM_DOMAINS)} domains.`);
      }
      if (await repos.domains.nameTaken(name)) {
        throw new ConflictError("This domain is already connected to another account. Contact support if it's yours.");
      }
      const domain: CustomerDomain = {
        id: randomUUID(),
        accountId,
        name,
        status: "pending_dns",
        verifyToken: randomBytes(16).toString("hex"),
        stalwartId: null,
        lastError: null,
        createdAt: deps.clock.now(),
      };
      await repos.domains.insert(domain);
      return {
        result: { ...view(domain), records: customerDomainRecords(domain.name, domain.verifyToken) },
        target: { id: domain.id, label: name },
      };
    },
  );
}

export type CheckResult = { domain: DomainView; records: CheckedRecord[]; activated: boolean };

/**
 * Checks every record live. When all required records pass on a pending domain, it becomes active and the
 * worker adds it to the mail server. Lookups run before the unit of work (no transaction held over DNS).
 */
export async function checkDomain(
  deps: Deps,
  dns: DnsResolver,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<CheckResult> {
  const spec = { permission: "domain.manage", accountId, target: { type: "domain", id } } as const;
  await authorizeAudited(deps, actor, req, { ...spec, action: "domain.verified" });
  const before = await deps.uow.run((r) => scoped(r, accountId, id));
  const records = await checkRecords(dns, before.name, before.verifyToken);
  const pass = requiredPass(records);
  const failing = records.filter((r) => r.required && r.state !== "ok").map((r) => r.purpose);

  if (before.status !== "pending_dns" || !pass) {
    // Audit the manual check that didn't activate anything (scheduler re-checks are not audited).
    if (before.status === "pending_dns" && actor.kind === "user") {
      await mutation(deps, actor, req, { ...spec, action: "domain.verify_failed" }, async () => ({
        result: null,
        target: { id: before.id, label: before.name },
        meta: { failing },
      }));
    }
    return { domain: view(before), records, activated: false };
  }

  const activated = await mutation(deps, actor, req, { ...spec, action: "domain.verified" }, async (repos) => {
    if (await repos.domains.nameTaken(before.name)) {
      throw new ConflictError("This domain is already connected to another account. Contact support if it's yours.");
    }
    const changed = await repos.domains.transition(before.id, "pending_dns", "active");
    if (changed)
      await repos.provisioning.enqueue({ kind: "domain.ensure", subjectId: before.id, runAfter: deps.clock.now() });
    return { result: changed, target: { id: before.id, label: before.name } };
  });
  const after = await deps.uow.run((r) => scoped(r, accountId, id));
  return { domain: view(after), records, activated };
}

/**
 * Removes a domain that no mailbox or alias uses. A pending domain goes at once; an active one is marked
 * `removing` and the worker takes it off the mail server, then deletes the row. Mail is never deleted here.
 */
export async function removeDomain(deps: Deps, actor: Actor, accountId: string, id: string, req: RequestMeta) {
  return mutation(
    deps,
    actor,
    req,
    { action: "domain.removed", permission: "domain.manage", accountId, target: { type: "domain", id } },
    async (repos) => {
      await repos.accounts.lock(accountId); // serialised with mailbox creation, so no mailbox lands mid-removal
      const d = await scoped(repos, accountId, id);
      if (d.status === "removing") throw new ConflictError("This domain is already being removed.");
      // Only an active (claimed) domain can carry addresses; another account's addresses never block a pending row.
      if (d.status !== "pending_dns" && (await repos.domains.addressCount(d.name)) > 0) {
        throw new ConflictError(
          "Remove or move the mailboxes and aliases on this domain first. A deleted mailbox keeps its address until it's permanently removed.",
        );
      }
      if (d.status === "pending_dns") {
        if (!(await repos.domains.deletePending(d.id))) {
          throw new ConflictError("This domain changed while you were removing it. Try again.");
        }
      } else {
        if (!(await repos.domains.transition(d.id, "active", "removing"))) {
          throw new ConflictError("This domain changed while you were removing it. Try again.");
        }
        await repos.provisioning.enqueue({ kind: "domain.remove", subjectId: d.id, runAfter: deps.clock.now() });
      }
      return { result: { status: d.status === "pending_dns" ? "removed" : "removing" }, target: { label: d.name } };
    },
  );
}

const SCHEDULER = { kind: "system", name: "domain-recheck" } as const;

/** Per scheduler run: at most this many domains, this many per account, within this time. */
export const RECHECK_LIMITS = { total: 50, perAccount: 5, budgetMs: 3 * 60_000 } as const;

/**
 * Scheduler: re-checks pending domains added in the last week and activates those whose records now pass, so a
 * customer who fixed their DNS doesn't have to come back and press a button. The candidates come in no fixed
 * order and each account gets a small share, so one account's abandoned or slow domains can't starve the rest.
 */
export async function recheckPendingDomains(deps: Deps, dns: DnsResolver, limits = RECHECK_LIMITS): Promise<number> {
  const started = Date.now();
  const since = new Date(deps.clock.now().getTime() - AUTO_RECHECK_MS);
  const candidates = await deps.uow.run((r) => r.domains.pending(since, limits.total * 10));
  const perAccount = new Map<string, number>();
  const pending = candidates
    .filter((d) => {
      const n = perAccount.get(d.accountId) ?? 0;
      perAccount.set(d.accountId, n + 1);
      return n < limits.perAccount;
    })
    .slice(0, limits.total);
  let activated = 0;
  for (const d of pending) {
    if (Date.now() - started > limits.budgetMs) break;
    const req = { requestId: `recheck-${d.id.slice(0, 8)}`, ip: null, userAgent: null };
    const out = await checkDomain(deps, dns, SCHEDULER, d.accountId, d.id, req).catch(() => null);
    if (out?.activated) activated += 1;
  }
  return activated;
}

/** Read-only live view of the records (`domain.read`): no state change, no audit — for rendering the page. */
export async function inspectDomain(
  deps: Deps,
  dns: DnsResolver,
  actor: Actor,
  accountId: string,
  id: string,
): Promise<{ domain: DomainView; records: CheckedRecord[] }> {
  authorize(actor, "domain.read", accountId);
  const d = await deps.uow.run((r) => scoped(r, accountId, id));
  return { domain: view(d), records: await checkRecords(dns, d.name, d.verifyToken) };
}

/** Whether the account's plan includes custom domains, and the per-account ceiling (`domain.read`). */
export async function domainAllowance(
  deps: Deps,
  actor: Actor,
  accountId: string,
): Promise<{ allowed: boolean; max: number }> {
  authorize(actor, "domain.read", accountId);
  const account = await deps.uow.run((r) => r.accounts.get(accountId));
  return { allowed: account !== null && PLANS[account.plan].customDomains, max: MAX_CUSTOM_DOMAINS };
}
