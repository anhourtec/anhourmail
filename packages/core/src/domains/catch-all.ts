// SPDX-License-Identifier: AGPL-3.0-only
import { PLANS } from "@anhourmail/shared/plans";
import { COMPANY_DOMAIN, PRODUCT_DOMAIN } from "@anhourmail/shared/platform";

import { type Actor, authorize, can } from "../actor";
import { maskEmail } from "../audit/record";
import { ConflictError, NotFoundError, PlanLimitError, ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { CustomerDomain } from "./entity";

/**
 * Catch-all on a customer domain (paid plans): mail for addresses that don't exist at the domain goes to one chosen
 * mailbox of the account instead of being refused. Off by default. The worker applies it to the mail server with
 * the domain (`domain.ensure`), and only while that mailbox is active; suspending or deleting the mailbox turns the
 * catch-all off (`turnOffCatchAllFor`). Never on the platform domains.
 */
export type CatchAllView = {
  domainId: string;
  /** The catch-all mailbox, or null when it is off. */
  mailbox: { id: string; address: string } | null;
  /** The account's plan includes catch-all. */
  planAllowed: boolean;
  /** Only a verified (active) domain can have one. */
  domainActive: boolean;
};

/** For people who can change it: the account's active mailboxes it can point at. */
export type CatchAllOptions = { mailboxes: { id: string; address: string }[] };

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function scopedDomain(repos: Repositories, accountId: string, id: string): Promise<CustomerDomain> {
  const d = isId(id) ? await repos.domains.get(accountId, id) : null;
  if (!d) throw new NotFoundError();
  return d;
}

const platformDomain = (name: string, configured: string): boolean =>
  [PRODUCT_DOMAIN, COMPANY_DOMAIN, configured].some((p) => name === p || name.endsWith(`.${p}`));

async function viewOf(repos: Repositories, accountId: string, d: CustomerDomain): Promise<CatchAllView> {
  const account = await repos.accounts.get(accountId);
  const mailboxId = await repos.catchAll.get(d.id);
  const m = mailboxId ? await repos.mailboxes.get(accountId, mailboxId) : null;
  return {
    domainId: d.id,
    mailbox: m ? { id: m.id, address: m.address } : null,
    planAllowed: account !== null && PLANS[account.plan].catchAll,
    domainActive: d.status === "active",
  };
}

/** A domain's catch-all (`domain.read`), plus the mailboxes it can point at for people who manage domains. */
export async function getCatchAll(
  deps: Deps,
  actor: Actor,
  accountId: string,
  domainId: string,
): Promise<CatchAllView & { options: CatchAllOptions | null }> {
  authorize(actor, "domain.read", accountId);
  return deps.uow.run(async (r) => {
    const d = await scopedDomain(r, accountId, domainId);
    const v = await viewOf(r, accountId, d);
    const options = can(actor, "domain.manage", accountId)
      ? {
          mailboxes: (await r.mailboxes.listByAccount(accountId))
            .filter((m) => m.status === "active")
            .map((m) => ({ id: m.id, address: m.address })),
        }
      : null;
    return { ...v, options };
  });
}

/**
 * Turns a domain's catch-all on (`{ mailboxId }`, an active mailbox of this account) or off (`{ mailboxId: null }`)
 * (`domain.manage`). Needs a plan with catch-all and a verified domain. Audited as `catch_all.changed`.
 */
export async function setCatchAll(
  deps: Deps,
  actor: Actor,
  accountId: string,
  domainId: string,
  input: { mailboxId?: unknown },
  req: RequestMeta,
): Promise<CatchAllView> {
  return mutation(
    deps,
    actor,
    req,
    { action: "catch_all.changed", permission: "domain.manage", accountId, target: { type: "domain", id: domainId } },
    async (repos) => {
      const d = await scopedDomain(repos, accountId, domainId);
      const raw = input.mailboxId;
      if (raw !== null && typeof raw !== "string") throw new ValidationError("Choose a mailbox, or turn it off.");
      const turnOn = typeof raw === "string" && raw !== "";
      const before = await repos.catchAll.get(d.id);
      if (!turnOn) {
        if (before !== null) {
          await repos.catchAll.set(d.id, null);
          await repos.provisioning.enqueue({ kind: "domain.ensure", subjectId: d.id, runAfter: deps.clock.now() });
        }
        return {
          result: await viewOf(repos, accountId, d),
          target: { label: d.name },
          meta: { enabled: false, changed: before !== null },
        };
      }
      if (platformDomain(d.name, deps.platform.domain))
        throw new ConflictError("Catch-all isn't available on this domain.");
      const account = await repos.accounts.get(accountId);
      if (!account) throw new NotFoundError();
      if (!PLANS[account.plan].catchAll) {
        throw new PlanLimitError("Catch-all is part of the Plus and Supporter plans.");
      }
      if (d.status !== "active") throw new ConflictError("Verify this domain first.");
      const m = isId(raw) ? await repos.mailboxes.get(accountId, raw) : null;
      if (!m) throw new ValidationError("Choose one of this account's mailboxes.");
      if (m.status !== "active")
        throw new ConflictError("Choose an active mailbox: this one is suspended or not ready.");
      await repos.catchAll.set(d.id, m.id);
      await repos.provisioning.enqueue({ kind: "domain.ensure", subjectId: d.id, runAfter: deps.clock.now() });
      return {
        result: await viewOf(repos, accountId, d),
        target: { label: d.name },
        meta: { enabled: true, mailbox: maskEmail(m.address), changed: before !== m.id },
      };
    },
  );
}

/**
 * Inside a mailbox suspension or deletion (same unit of work, same audit entry): turns off every catch-all that
 * points at the mailbox and queues the domains, so the mail server stops accepting unknown recipients there instead
 * of bouncing them at a mailbox that can't receive. Returns the domain names for the audit entry.
 */
export async function turnOffCatchAllFor(deps: Deps, repos: Repositories, mailboxId: string): Promise<string[]> {
  const off = await repos.catchAll.clearForMailbox(mailboxId);
  for (const d of off) {
    await repos.provisioning.enqueue({ kind: "domain.ensure", subjectId: d.id, runAfter: deps.clock.now() });
  }
  return off.map((d) => d.name);
}
