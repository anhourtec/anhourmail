// SPDX-License-Identifier: AGPL-3.0-only
/**
 * After the paid plan ends (ADR-0029 §5, §6; slice 10): "Choose what stays on" (the Owner's swap of the plan holds)
 * and `billing.timers`, the hourly scheduler job that runs our own deadlines.
 *
 * - A `restricted` account whose payment never came within `BILLING.restrictedDays` has its subscription ended now
 *   (disputes excluded: staff handle them); the sync then lapses it with holds.
 * - A comp whose free period ended is synced (it lapses unless the account subscribed meanwhile).
 * - A lapsed account whose held mailboxes, domains or aliases were since deleted drops those holds; with none left it
 *   becomes `free` on the sync.
 * - Held mailboxes past their receive window: counted only. Receiving stays on (send-blocked) until held recipients
 *   can be refused during the SMTP conversation instead of bounced (backscatter; ADR-0029 update 2026-11-04, the
 *   maintainer's call).
 *
 * Nothing here deletes mail, mailboxes, aliases, domains or data (rule 26).
 */
import { BILLING } from "@anhourmail/shared/plans";

import type { Actor } from "../actor";
import { NotFoundError, ValidationError } from "../errors";
import { authorizeAudited, mutation, recordSystemChanges, type MutationSpec } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";

import { billingOf } from "./checkout";
import type { PlanHold, PlanHoldInput } from "./entity";
import { BillingError } from "./entitlements";
import { billingTarget, refuse, refuseActAs } from "./guards";
import { carryReceiveWindows, computeHolds, type HoldChoice } from "./holds";
import { compEnded, restrictedTimedOut } from "./lifecycle";
import { type BillingProvider, BillingProviderError } from "./ports";
import { holdResources } from "./sync";

const DAY_MS = 86_400_000;
const TIMERS = { kind: "system", name: "billing-timers" } as const;
const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export type HoldsChoiceInput = { mailboxId?: unknown; aliasIds?: unknown };

/** Validates the shape of "Choose what stays on" (400); whether it fits Free is `computeHolds`'s call. */
export function parseHoldsChoice(input: HoldsChoiceInput): HoldChoice {
  const out: { mailboxId?: string; aliasIds?: string[] } = {};
  if (input.mailboxId !== undefined && input.mailboxId !== null) {
    if (typeof input.mailboxId !== "string" || !isId(input.mailboxId)) {
      throw new ValidationError("Choose a mailbox in this account to keep.");
    }
    out.mailboxId = input.mailboxId;
  }
  if (input.aliasIds !== undefined && input.aliasIds !== null) {
    if (
      !Array.isArray(input.aliasIds) ||
      input.aliasIds.length > 1000 ||
      !input.aliasIds.every((a): a is string => typeof a === "string" && isId(a))
    ) {
      throw new ValidationError("Choose aliases of the mailbox you keep.");
    }
    out.aliasIds = input.aliasIds;
  }
  return out;
}

/**
 * A swap never restarts a receive window (ADR-0029 §6): a mailbox held before keeps its date, and one newly held by the
 * swap gets the window that started when the account lapsed — so swapping back and forth can't keep two mailboxes
 * receiving past the lapse's window.
 */
export function swapReceiveWindows(
  next: readonly PlanHoldInput[],
  current: readonly Pick<PlanHold, "subjectType" | "subjectId" | "receiveUntil">[],
  lapsedAt: Date | null,
): PlanHoldInput[] {
  const cap = lapsedAt === null ? null : new Date(lapsedAt.getTime() + BILLING.heldReceiveDays * DAY_MS);
  return carryReceiveWindows(next, current).map((h) =>
    h.subjectType === "mailbox" && h.receiveUntil !== null && cap !== null && h.receiveUntil > cap
      ? { ...h, receiveUntil: cap }
      : h,
  );
}

const counts = (holds: readonly { subjectType: string }[]) => ({
  mailboxes: holds.filter((h) => h.subjectType === "mailbox").length,
  domains: holds.filter((h) => h.subjectType === "domain").length,
  aliases: holds.filter((h) => h.subjectType === "alias").length,
});

/** Every mailbox's access and aliases follow the holds (`mailbox.ensure`; aliases ride with their mailbox). */
async function ensureMailboxes(r: Repositories, accountId: string, at: Date): Promise<void> {
  for (const m of await r.mailboxes.listByAccount(accountId)) {
    if (m.status !== "deleting")
      await r.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: at });
  }
}

/**
 * `PUT /api/accounts/:id/billing/holds` (`billing.manage` ★): "Choose what stays on" after a lapse — the platform-domain
 * mailbox Free keeps, and which of its aliases and masked aliases stay on within Free's limits (400 with what doesn't
 * fit). Only while the account is `lapsed` (409 `invalid_change` otherwise). Nothing is deleted: what isn't kept is
 * held. Receive windows already running are kept. Audited `billing.holds_changed` with the counts.
 */
export async function chooseHolds(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: HoldsChoiceInput,
  req: RequestMeta,
): Promise<{ keptMailboxId: string | null; keptAliasIds: string[]; held: ReturnType<typeof counts> }> {
  const spec: MutationSpec = {
    action: "billing.holds_changed",
    permission: "billing.manage",
    accountId,
    target: billingTarget(accountId),
  };
  await authorizeAudited(deps, actor, req, spec);
  await refuseActAs(deps, actor, req, spec);
  const choice = parseHoldsChoice(input);
  const now = deps.clock.now();
  // Checked before the unit of work, so a choice that doesn't fit is a plain 400 (nothing to audit as changed).
  const pre = await deps.uow.run(async (r) => ({
    billing: await billingOf(r, accountId, now),
    resources: await holdResources(deps, r, accountId),
  }));
  if (!pre.billing) throw new NotFoundError();
  if (pre.billing.state !== "lapsed") {
    return refuse(
      deps,
      actor,
      req,
      spec,
      "invalid_change",
      new BillingError("invalid_change", "Only an account whose paid plan ended chooses what stays on."),
    );
  }
  computeHolds(pre.resources, now, choice);
  return mutation(deps, actor, req, spec, async (r) => {
    await r.accounts.lock(accountId);
    const b = await billingOf(r, accountId, now);
    if (b?.state !== "lapsed") throw new BillingError("invalid_change", "The account's plan changed meanwhile.");
    const planned = computeHolds(await holdResources(deps, r, accountId), now, choice);
    const holds = swapReceiveWindows(planned.holds, await r.billing.holds(accountId), b.lapsedAt);
    await r.billing.replaceHolds(accountId, holds, now);
    await ensureMailboxes(r, accountId, now);
    const held = counts(holds);
    return {
      result: { keptMailboxId: planned.keptMailboxId, keptAliasIds: planned.keptAliasIds, held },
      meta: { ...held, keptMailboxId: planned.keptMailboxId, keptAliases: planned.keptAliasIds.length },
    };
  });
}

export type BillingTimersRun = {
  /** Restricted past `restrictedDays`: subscription ended now. */
  restrictedEnded: number;
  /** The provider couldn't end one (retried next hour). */
  restrictedFailed: number;
  compsEnded: number;
  /** Lapsed accounts whose holds on deleted subjects were dropped. */
  holdsPruned: number;
  /** Held mailboxes past their receive window (receiving stays on for now; see the module comment). */
  receiveWindowsPassed: number;
  syncsQueued: number;
};

const reqOf = (at: Date): RequestMeta => ({
  requestId: `billing-timers-${String(at.getTime())}`,
  ip: null,
  userAgent: null,
});

/**
 * `billing.timers` (hourly, scheduler; rule 17). Each account is handled on its own: a provider failure for one is
 * counted and retried next hour, never stopping the rest. Billing off (`provider` null): the restricted timeout waits
 * (nothing is ended without the provider), the rest still runs.
 */
export async function runBillingTimers(
  deps: Deps,
  provider: BillingProvider | null,
  opts: { batch?: number } = {},
): Promise<BillingTimersRun> {
  const batch = opts.batch ?? 500;
  const now = deps.clock.now();
  const req = reqOf(now);
  const run: BillingTimersRun = {
    restrictedEnded: 0,
    restrictedFailed: 0,
    compsEnded: 0,
    holdsPruned: 0,
    receiveWindowsPassed: 0,
    syncsQueued: 0,
  };
  const queueSync = (r: Repositories, accountId: string) => {
    run.syncsQueued++;
    return r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: now });
  };

  // 1. Restricted too long without payment: end the subscription now (provider first, then our record).
  if (provider) {
    const due = (await deps.uow.run((r) => r.billing.listByState("restricted", batch))).filter((b) =>
      restrictedTimedOut(b, now),
    );
    for (const b of due) {
      const subscriptionId = b.providerSubscriptionId;
      if (b.planSource !== "stripe" || subscriptionId === null || b.restrictedAt === null) continue;
      try {
        await provider.cancel({
          subscriptionId,
          when: "now",
          intentId: `restricted-timeout:${String(b.restrictedAt.getTime())}`,
        });
      } catch (err) {
        if (!(err instanceof BillingProviderError)) throw err;
        run.restrictedFailed++;
        continue;
      }
      await deps.uow.run(async (r) => {
        await queueSync(r, b.accountId);
        await recordSystemChanges(deps, r, TIMERS, req, [
          {
            action: "billing.subscription_ended",
            accountId: b.accountId,
            target: billingTarget(b.accountId),
            meta: { reason: "restricted_timeout", restrictedDays: BILLING.restrictedDays, subscriptionId },
          },
        ]);
      });
      run.restrictedEnded++;
    }
  }

  // 2. Comps that ended: the sync lapses them (or keeps the subscription that replaced the comp).
  await deps.uow.run(async (r) => {
    for (const accountId of await r.billing.compsEnded(now, batch)) {
      const b = await r.billing.get(accountId);
      if (b && compEnded(b, now)) {
        await queueSync(r, accountId);
        run.compsEnded++;
      }
    }
  });

  // 3. Lapsed accounts: holds on what the Owner since deleted are dropped; none left → `free` on the sync.
  for (const lapsed of await deps.uow.run((r) => r.billing.listByState("lapsed", batch))) {
    await deps.uow.run(async (r) => {
      await r.accounts.lock(lapsed.accountId);
      const holds = await r.billing.holds(lapsed.accountId);
      const [mailboxes, domains, aliases] = await Promise.all([
        r.mailboxes.listByAccount(lapsed.accountId),
        r.domains.listByAccount(lapsed.accountId),
        r.aliases.listByAccount(lapsed.accountId),
      ]);
      const exists = new Set([
        ...mailboxes.filter((m) => m.status !== "deleting").map((m) => `mailbox:${m.id}`),
        ...domains.filter((d) => d.status !== "removing").map((d) => `domain:${d.id}`),
        ...aliases.map((a) => `alias:${a.id}`),
      ]);
      const kept = holds.filter((h) => exists.has(`${h.subjectType}:${h.subjectId}`));
      run.receiveWindowsPassed += kept.filter(
        (h) => h.subjectType === "mailbox" && h.receiveUntil !== null && h.receiveUntil <= now,
      ).length;
      if (kept.length === holds.length) return;
      await r.billing.replaceHolds(
        lapsed.accountId,
        kept.map((h) => ({ subjectType: h.subjectType, subjectId: h.subjectId, receiveUntil: h.receiveUntil })),
        now,
      );
      await recordSystemChanges(deps, r, TIMERS, req, [
        {
          action: "billing.holds_changed",
          accountId: lapsed.accountId,
          target: billingTarget(lapsed.accountId),
          meta: { reason: "removed", ...counts(kept) },
        },
      ]);
      run.holdsPruned++;
      if (kept.length === 0) await queueSync(r, lapsed.accountId);
    });
  }
  return run;
}
