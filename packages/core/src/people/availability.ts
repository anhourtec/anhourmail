// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Whether "Add a user" and "Invite someone" can be offered right now, from what the pages already read through the
 * services (`mailboxOptions`, `listPeople`, `grantableRoles`). One answer for the sidebar, Home, the Mailboxes list
 * and the Add a user page, so an action is never shown and then refused. The services still check everything again.
 *
 * - `ready`: offer it.
 * - `full`: the account has run out of room (people, mailboxes or storage): show it disabled, with `reason`.
 * - `unavailable`: not something this person can do here (their role, the plan, no domain to put the address on):
 *   don't offer it; the Add a user page still explains why with `reason`.
 */
export type Availability =
  | { state: "ready" }
  | { state: "full"; code: "people_full" | "mailboxes_full" | "storage_full"; reason: string }
  | {
      state: "unavailable";
      code: "not_permitted" | "single_person_plan" | "no_domain" | "email_unverified";
      reason: string;
    };

/** The account's people ceiling (`listPeople().limits`). */
export type PeopleRoom = { addPeople: boolean; used: number; max: number; planName: string };

/** What "Add a user" needs from `mailboxOptions` (the mailbox ceiling, unassigned storage and usable domains). */
export type MailboxRoom = {
  remaining: number;
  maxQuotaGb: number;
  /** Active custom domains. */
  domains: number;
  /** The free platform domain: room in its allowance, and whether this person's email is confirmed. */
  platform: { allowed: boolean; emailVerified: boolean };
};

const NOT_PERMITTED = "Your role in this account doesn't include adding users. Ask an owner if you need access.";

function peopleFull(people: PeopleRoom): Availability | null {
  if (!people.addPeople) {
    return {
      state: "unavailable",
      code: "single_person_plan",
      reason: `The ${people.planName} plan is for one person.`,
    };
  }
  if (people.used >= people.max) {
    return {
      state: "full",
      code: "people_full",
      reason: `This account already has ${String(people.max)} people, counting pending invites.`,
    };
  }
  return null;
}

/**
 * "Add a user": `permitted` is `mailbox.manage` plus a role this person may grant; `people` and `mailboxes` are null
 * when their role can't read them (then it isn't offered).
 */
export function addUserAvailability(input: {
  permitted: boolean;
  people: PeopleRoom | null;
  mailboxes: MailboxRoom | null;
}): Availability {
  const { permitted, people, mailboxes } = input;
  if (!permitted || !people || !mailboxes)
    return { state: "unavailable", code: "not_permitted", reason: NOT_PERMITTED };
  const room = peopleFull(people);
  if (room) return room;
  if (mailboxes.remaining <= 0) {
    return { state: "full", code: "mailboxes_full", reason: "This account has all the mailboxes its plan includes." };
  }
  if (mailboxes.maxQuotaGb < 1) {
    return {
      state: "full",
      code: "storage_full",
      reason: "All of the account's storage is assigned. Lower another mailbox's storage first.",
    };
  }
  if (mailboxes.domains === 0) {
    if (mailboxes.platform.allowed && !mailboxes.platform.emailVerified) {
      return {
        state: "unavailable",
        code: "email_unverified",
        reason: "Confirm your email address first: users on the free domain need it.",
      };
    }
    if (!mailboxes.platform.allowed) {
      return { state: "unavailable", code: "no_domain", reason: "New users need an address on your own domain." };
    }
  }
  return { state: "ready" };
}

/** "Invite someone": `permitted` is `member.manage`; `people` is null when their role can't read the account's people. */
export function inviteAvailability(input: { permitted: boolean; people: PeopleRoom | null }): Availability {
  if (!input.permitted || !input.people) {
    return {
      state: "unavailable",
      code: "not_permitted",
      reason: "Your role in this account doesn't include inviting people.",
    };
  }
  return peopleFull(input.people) ?? { state: "ready" };
}
