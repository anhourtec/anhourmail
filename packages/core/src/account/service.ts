// SPDX-License-Identifier: AGPL-3.0-only
import { nameProblem } from "@anhourmail/shared/names";

import type { Actor } from "../actor";
import { maskEmail } from "../audit/record";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

/**
 * Name shown for a new personal account: the person's name, else the local part of their email; "My account" when
 * that would break the shared name rules (`@anhourmail/shared/names`) — account names appear in invite emails and in
 * other people's consoles.
 */
export function personalAccountName(name: string, email: string): string {
  const trimmed = name.trim().slice(0, 80);
  const candidate = trimmed !== "" ? trimmed : (email.split("@")[0] ?? "");
  return candidate === "" || nameProblem(candidate) ? "My account" : candidate;
}

/**
 * After a self-service sign-up: a personal account on the Free plan with the person as Owner, and their state
 * set to `free`. Idempotent — a retry for a user who already has an account changes nothing. Mailbox
 * provisioning in Stalwart is a separate worker job (phase 3, CLAUDE.md rule 26).
 */
export async function provisionSignUp(
  deps: Deps,
  actor: Actor,
  user: { userId: string; email: string; name: string },
  req: RequestMeta,
): Promise<{ accountId: string | null }> {
  return mutation<{ accountId: string | null }>(
    deps,
    actor,
    req,
    { action: "account.created", permission: "self.profile.read", accountId: null, target: { type: "account" } },
    async (repos) => {
      if ((await repos.accounts.membershipCount(user.userId)) > 0) {
        return { result: { accountId: null }, meta: { signUp: true, alreadyProvisioned: true } };
      }
      const name = personalAccountName(user.name, user.email);
      const { id } = await repos.accounts.create({ name, plan: "free" });
      await repos.accounts.addMember({ accountId: id, userId: user.userId, role: "owner" });
      await repos.accounts.setUserState({ userId: user.userId, state: "free" });
      return {
        result: { accountId: id },
        target: { id, label: name },
        meta: { signUp: true, plan: "free", owner: maskEmail(user.email) },
      };
    },
  );
}
