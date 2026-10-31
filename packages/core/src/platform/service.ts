// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole } from "@anhourmail/shared/rbac";

import { type Actor, authorize } from "../actor";
import { NotFoundError } from "../errors";
import type { MailboxStatus } from "../mailboxes/entity";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import type { AccountSummary } from "./repository";

/**
 * Staff views of customer accounts (`platform.accounts.read`): Global, Support, Trust & Safety and Billing
 * Administrators. Metadata only — no mail content exists on any of these paths. Opening an account is audited as
 * `staff.account_viewed` in that account's own log, so its admins see it (CLAUDE.md rule 49).
 */

export const ACCOUNTS_PAGE_SIZE = 25;

export type AccountSearch = { rows: AccountSummary[]; total: number; page: number; pages: number; query: string };

/** Search text from untrusted input: trimmed, at most 100 characters; empty means "everything". */
export function normaliseQuery(input: unknown): string {
  return typeof input === "string" ? input.trim().slice(0, 100) : "";
}

/** Page number from untrusted input: an integer from 1 (NaN, fractions and negatives become 1). */
export function normalisePage(input: unknown): number {
  const n = typeof input === "number" ? input : Number(input);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), 100_000) : 1;
}

export async function searchAccounts(
  deps: Deps,
  actor: Actor,
  opts: { query?: unknown; page?: unknown } = {},
): Promise<AccountSearch> {
  authorize(actor, "platform.accounts.read");
  const query = normaliseQuery(opts.query);
  const page = normalisePage(opts.page);
  const { total, rows } = await deps.uow.run((r) =>
    r.platformAccounts.search({
      query: query === "" ? null : query,
      limit: ACCOUNTS_PAGE_SIZE,
      offset: (page - 1) * ACCOUNTS_PAGE_SIZE,
    }),
  );
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / ACCOUNTS_PAGE_SIZE)), query };
}

export type AccountDetail = {
  summary: AccountSummary;
  people: { userId: string; name: string; email: string; role: AccountRole; joinedAt: Date; suspended: boolean }[];
  domains: { id: string; name: string; status: string }[];
  mailboxes: {
    id: string;
    address: string;
    status: MailboxStatus;
    quotaBytes: number;
    /** When a deleted mailbox is purged (restorable until then); null otherwise. */
    purgeAfter: Date | null;
    /** The worker gave up applying its last change (`lastError` set; the message itself isn't shown to staff). */
    applyFailed: boolean;
  }[];
  pendingInvites: number;
};

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * One account's summary for staff. Unknown ids are 404. The view itself is recorded (`staff.account_viewed`, in the
 * account's log); a refused look-up is not, so probes can't write into arbitrary accounts' logs.
 */
export async function viewAccount(
  deps: Deps,
  actor: Actor,
  accountId: string,
  req: RequestMeta,
): Promise<AccountDetail> {
  authorize(actor, "platform.accounts.read");
  const exists = isId(accountId) ? await deps.uow.run((r) => r.platformAccounts.summary(accountId)) : null;
  if (!exists) throw new NotFoundError();
  return mutation(
    deps,
    actor,
    req,
    {
      action: "staff.account_viewed",
      permission: "platform.accounts.read",
      accountId,
      target: { type: "account", id: accountId, label: exists.name },
      staffPath: true,
    },
    async (repos) => {
      const summary = await repos.platformAccounts.summary(accountId);
      if (!summary) throw new NotFoundError();
      const now = deps.clock.now();
      return {
        result: {
          summary,
          people: await repos.people.list(accountId),
          domains: (await repos.domains.listByAccount(accountId)).map((d) => ({
            id: d.id,
            name: d.name,
            status: d.status,
          })),
          mailboxes: (await repos.mailboxes.listByAccount(accountId)).map((m) => ({
            id: m.id,
            address: m.address,
            status: m.status,
            quotaBytes: m.quotaBytes,
            purgeAfter: m.purgeAfter,
            applyFailed: m.lastError !== null,
          })),
          pendingInvites: (await repos.invites.listPending(accountId)).filter((i) => i.expiresAt > now).length,
        },
        meta: { view: "summary" },
      };
    },
  );
}
