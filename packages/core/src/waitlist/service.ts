// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { WaitlistSignupSchema } from "@anhourmail/shared/schemas";

import { type Actor, authorize, can } from "../actor";
import { maskEmail } from "../audit/record";
import { clampLimit } from "../audit/service";
import { InvalidTokenError, ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import { hashToken, isTokenShaped, newToken } from "../tokens";
import {
  CONFIRM_RESEND_MS,
  CONFIRM_TTL_MS,
  hashEmail,
  looksAutomated,
  normaliseEmail,
  type WaitlistEntry,
} from "./entity";

/** The same answer whether the address is new, already listed, or dropped as a bot: no enumeration. */
export const WAITLIST_ACCEPTED = { status: "accepted" as const };

/** A confirmation email to send after the transaction commits (the caller owns delivery). */
export type ConfirmationToSend = { email: string; token: string };

/**
 * Join the waitlist (double opt-in). New addresses get a confirmation token; a repeat sign-up for a still-pending
 * address re-sends at most every 10 minutes. The HTTP answer is always WAITLIST_ACCEPTED.
 */
export async function joinWaitlist(
  deps: Deps,
  actor: Actor,
  input: unknown,
  req: RequestMeta,
): Promise<{ accepted: typeof WAITLIST_ACCEPTED; confirmation: ConfirmationToSend | null }> {
  const parsed = WaitlistSignupSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Enter a valid email address.");
  const data = parsed.data;
  const email = normaliseEmail(data.email);
  const emailHash = hashEmail(email);
  const none = { accepted: WAITLIST_ACCEPTED, confirmation: null };

  return mutation(
    deps,
    actor,
    req,
    { action: "waitlist.joined", permission: "waitlist.join", accountId: null, target: { type: "waitlist_entry" } },
    async (repos) => {
      const now = deps.clock.now();
      if (looksAutomated(data, now)) {
        return { result: none, denied: { code: "bot_check" }, meta: { emailHash } };
      }
      const issue = async (id: string) => {
        const token = newToken();
        await repos.waitlist.setConfirmation(id, {
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + CONFIRM_TTL_MS),
          sentAt: now,
        });
        return { accepted: WAITLIST_ACCEPTED, confirmation: { email, token } };
      };
      const known = async (existing: WaitlistEntry) => {
        const resend =
          existing.status === "pending" &&
          (existing.confirmSentAt === null || now.getTime() - existing.confirmSentAt.getTime() >= CONFIRM_RESEND_MS);
        return {
          result: resend ? await issue(existing.id) : none,
          target: { id: existing.id, label: maskEmail(email) },
          meta: { duplicate: true, confirmationResent: resend },
        };
      };
      const existing = await repos.waitlist.findByEmailHash(emailHash);
      if (existing) return known(existing);
      const entry: WaitlistEntry = {
        id: randomUUID(),
        email,
        emailHash,
        community: data.community ?? null,
        ref: data.ref ?? null,
        utm: data.utm ?? null,
        status: "pending",
        createdAt: now,
        confirmSentAt: null,
        confirmedAt: null,
      };
      if (!(await repos.waitlist.insert(entry))) {
        // A concurrent join for the same address committed first: answer exactly as for a known address.
        const winner = await repos.waitlist.findByEmailHash(emailHash);
        if (winner) return known(winner);
      }
      return {
        result: await issue(entry.id),
        target: { id: entry.id, label: maskEmail(email) },
        meta: { community: entry.community, ref: entry.ref, utmSource: entry.utm?.source ?? null },
      };
    },
  );
}

/** Confirms a waitlist address from the emailed link. Unknown, used and expired tokens get the same error. */
export async function confirmWaitlist(deps: Deps, actor: Actor, token: unknown, req: RequestMeta) {
  if (!isTokenShaped(token)) throw new InvalidTokenError();
  return mutation(
    deps,
    actor,
    req,
    { action: "waitlist.confirmed", permission: "waitlist.join", accountId: null, target: { type: "waitlist_entry" } },
    async (repos) => {
      const now = deps.clock.now();
      const entry = await repos.waitlist.findByConfirmToken(hashToken(token), now);
      if (!entry || !(await repos.waitlist.markConfirmed(entry.id, now))) throw new InvalidTokenError();
      return { result: { status: "confirmed" as const }, target: { id: entry.id, label: maskEmail(entry.email) } };
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
  // Sequential: a transaction holds one database connection, which runs one query at a time.
  const [total, rows] = await deps.uow.run(
    async (r) => [await r.waitlist.count(), await r.waitlist.list({ limit })] as const,
  );
  return {
    total,
    entries: rows.map(({ emailHash: _h, ...e }) => ({ ...e, email: showEmail ? e.email : maskEmail(e.email) })),
  };
}
