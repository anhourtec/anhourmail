// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { WaitlistSignupSchema } from "@anhourmail/shared/schemas";

import { type Actor, authorize, can } from "../actor";
import { maskEmail } from "../audit/record";
import { clampLimit } from "../audit/service";
import { ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import { hashEmail, looksAutomated, normaliseEmail, type WaitlistEntry } from "./entity";

/** The same answer whether the address is new, already listed, or dropped as a bot: no enumeration. */
export const WAITLIST_ACCEPTED = { status: "accepted" as const };

export async function joinWaitlist(deps: Deps, actor: Actor, input: unknown, req: RequestMeta) {
  const parsed = WaitlistSignupSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Enter a valid email address.");
  const data = parsed.data;
  const email = normaliseEmail(data.email);
  const emailHash = hashEmail(email);

  return mutation(
    deps,
    actor,
    req,
    { action: "waitlist.joined", permission: "waitlist.join", accountId: null, target: { type: "waitlist_entry" } },
    async (repos) => {
      if (looksAutomated(data, deps.clock.now())) {
        return { result: WAITLIST_ACCEPTED, denied: { code: "bot_check" }, meta: { emailHash } };
      }
      const existing = await repos.waitlist.findByEmailHash(emailHash);
      if (existing) {
        return {
          result: WAITLIST_ACCEPTED,
          target: { id: existing.id, label: maskEmail(email) },
          meta: { duplicate: true },
        };
      }
      const entry: WaitlistEntry = {
        id: randomUUID(),
        email,
        emailHash,
        community: data.community ?? null,
        ref: data.ref ?? null,
        utm: data.utm ?? null,
        status: "pending",
        createdAt: deps.clock.now(),
      };
      await repos.waitlist.insert(entry);
      return {
        result: WAITLIST_ACCEPTED,
        target: { id: entry.id, label: maskEmail(email) },
        meta: { community: entry.community, ref: entry.ref, utmSource: entry.utm?.source ?? null },
      };
    },
  );
}

export type WaitlistView = Omit<WaitlistEntry, "emailHash">;

/**
 * Staff view. `waitlist.manage` holders (who send invites) see addresses; read-only holders see them masked.
 */
export async function listWaitlist(
  deps: Deps,
  actor: Actor,
  opts: { limit?: number } = {},
): Promise<{ total: number; entries: WaitlistView[] }> {
  authorize(actor, "waitlist.read");
  const limit = clampLimit(opts.limit);
  const showEmail = can(actor, "waitlist.manage");
  const [total, rows] = await deps.uow.run((r) => Promise.all([r.waitlist.count(), r.waitlist.list({ limit })]));
  return {
    total,
    entries: rows.map(({ emailHash: _h, ...e }) => ({ ...e, email: showEmail ? e.email : maskEmail(e.email) })),
  };
}
