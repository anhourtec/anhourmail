// SPDX-License-Identifier: AGPL-3.0-only
import type { Actor } from "../actor";
import { maskEmail } from "../audit/record";
import { ConflictError, InvalidTokenError, NotFoundError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import { hashToken, isTokenShaped, newToken } from "../tokens";
import { normaliseEmail } from "../waitlist/entity";

/** Invite links work for 7 days. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Staff invite a confirmed waitlist sign-up (`waitlist.manage`). Returns the token for the invite email; only its
 * hash is stored. Unconfirmed or already-invited entries are refused (409); unknown ids are 404.
 */
export async function inviteFromWaitlist(deps: Deps, actor: Actor, entryId: string, req: RequestMeta) {
  return mutation(
    deps,
    actor,
    req,
    {
      action: "waitlist.invited",
      permission: "waitlist.manage",
      accountId: null,
      target: { type: "waitlist_entry", id: entryId },
    },
    async (repos) => {
      const entry = /^[0-9a-f-]{36}$/i.test(entryId) ? await repos.waitlist.get(entryId) : null;
      if (!entry) throw new NotFoundError();
      // Claim the entry first (conditional update), so two concurrent invites can't both succeed.
      if (entry.status !== "confirmed" || !(await repos.waitlist.markInvited(entry.id))) {
        throw new ConflictError("Only confirmed sign-ups can be invited.");
      }
      const token = newToken();
      const expiresAt = new Date(deps.clock.now().getTime() + INVITE_TTL_MS);
      const { id } = await repos.invites.create({
        email: entry.email,
        tokenHash: hashToken(token),
        expiresAt,
        source: "waitlist",
        createdBy: actor.kind === "user" ? actor.userId : null,
        waitlistEntryId: entry.id,
        accountId: null,
        role: null,
      });
      return {
        result: { email: entry.email, token, expiresAt },
        target: { id: entry.id, label: maskEmail(entry.email) },
        meta: { inviteId: id, source: "waitlist" },
      };
    },
  );
}

/** For the sign-up page: the invited email, or null when the token is unknown, used or expired. No audit. */
export async function lookupInvite(deps: Deps, token: unknown): Promise<{ email: string; expiresAt: Date } | null> {
  if (!isTokenShaped(token)) return null;
  const invite = await deps.uow.run((r) => r.invites.findValid(hashToken(token), deps.clock.now()));
  return invite ? { email: invite.email, expiresAt: invite.expiresAt } : null;
}

/** True when `token` is a valid invite for exactly this email (sign-up gate in invite-only mode). */
export async function inviteMatches(deps: Deps, token: unknown, email: string): Promise<boolean> {
  const invite = await lookupInvite(deps, token);
  return invite !== null && invite.email === normaliseEmail(email);
}

/** Marks the invite used by the new account (system actor, audited as invite.redeemed). */
export async function redeemInvite(
  deps: Deps,
  input: { token: unknown; userId: string; email: string },
  req: RequestMeta,
): Promise<void> {
  if (!isTokenShaped(input.token)) throw new InvalidTokenError();
  const tokenHash = hashToken(input.token);
  await mutation(
    deps,
    { kind: "system", name: "sign-up" },
    req,
    { action: "invite.redeemed", permission: "self.profile.read", accountId: null, target: { type: "invite" } },
    async (repos) => {
      const now = deps.clock.now();
      const invite = await repos.invites.findValid(tokenHash, now);
      if (invite?.email !== normaliseEmail(input.email)) throw new InvalidTokenError();
      await repos.invites.markAccepted(invite.id, input.userId, now);
      return {
        result: undefined,
        target: { id: invite.id, label: maskEmail(invite.email) },
        meta: { source: invite.source },
      };
    },
  );
}
