// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { cache } from "react";

import { can, ForbiddenError, NotFoundError, type UserActor } from "@anhourmail/core";
import { mailboxOptions } from "@anhourmail/core/mailboxes";
import {
  addUserAvailability,
  type Availability,
  grantableRoles,
  inviteAvailability,
  listPeople,
  type MailboxRoom,
} from "@anhourmail/core/people";

import { container } from "./container";

/** A refusal (e.g. a suspended account) just means "not offered"; anything else is a real error. */
const refusedAsNull = (err: unknown): null => {
  if (err instanceof ForbiddenError || err instanceof NotFoundError) return null;
  throw err;
};

/** The parts of `mailboxOptions` that decide whether a user can be added. */
export function mailboxRoom(options: Awaited<ReturnType<typeof mailboxOptions>>): MailboxRoom {
  return {
    remaining: options.remaining,
    maxQuotaGb: options.maxQuotaGb,
    domains: options.domains.length,
    platform: { allowed: options.platform.allowed, emailVerified: options.platform.emailVerified },
  };
}

/**
 * Whether "Add a user" and "Invite someone" can be offered in this account (core `addUserAvailability`), read through
 * the services with the person's own permissions. Once per request (the sidebar and Home both ask).
 */
export const peopleActions = cache(
  async (actor: UserActor, accountId: string): Promise<{ addUser: Availability; invite: Availability }> => {
    const deps = container().deps;
    const mayAdd = can(actor, "mailbox.manage", accountId) && grantableRoles(actor, accountId).length > 0;
    const [options, people] = await Promise.all([
      mayAdd ? mailboxOptions(deps, actor, accountId).catch(refusedAsNull) : null,
      can(actor, "member.read", accountId) ? listPeople(deps, actor, accountId).catch(refusedAsNull) : null,
    ]);
    return {
      addUser: addUserAvailability({
        permitted: mayAdd,
        people: people?.limits ?? null,
        mailboxes: options ? mailboxRoom(options) : null,
      }),
      invite: inviteAvailability({ permitted: can(actor, "member.manage", accountId), people: people?.limits ?? null }),
    };
  },
);
