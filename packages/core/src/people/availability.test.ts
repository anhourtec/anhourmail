// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { addUserAvailability, inviteAvailability, type MailboxRoom, type PeopleRoom } from "./availability";

const people = (over: Partial<PeopleRoom> = {}): PeopleRoom => ({
  addPeople: true,
  used: 2,
  max: 6,
  planName: "Plus",
  ...over,
});
const mailboxes = (over: Partial<MailboxRoom> = {}): MailboxRoom => ({
  remaining: 3,
  maxQuotaGb: 10,
  domains: 1,
  platform: { allowed: false, emailVerified: true },
  ...over,
});
const add = (p: Partial<PeopleRoom> = {}, m: Partial<MailboxRoom> = {}) =>
  addUserAvailability({ permitted: true, people: people(p), mailboxes: mailboxes(m) });

describe("addUserAvailability", () => {
  it("is ready with room and a custom domain", () => {
    expect(add()).toEqual({ state: "ready" });
  });

  it("is ready on the free platform domain alone (no custom domain) once the email is confirmed", () => {
    expect(add({}, { domains: 0, platform: { allowed: true, emailVerified: true } })).toEqual({ state: "ready" });
    expect(add({}, { domains: 0, platform: { allowed: true, emailVerified: false } })).toMatchObject({
      state: "unavailable",
      code: "email_unverified",
    });
  });

  it("isn't offered without the permission, a role to grant, or the data to decide", () => {
    expect(addUserAvailability({ permitted: false, people: people(), mailboxes: mailboxes() })).toMatchObject({
      state: "unavailable",
      code: "not_permitted",
    });
    expect(addUserAvailability({ permitted: true, people: null, mailboxes: mailboxes() }).state).toBe("unavailable");
    expect(addUserAvailability({ permitted: true, people: people(), mailboxes: null }).state).toBe("unavailable");
  });

  it("isn't offered on a one-person plan or without any domain", () => {
    expect(add({ addPeople: false, planName: "Free" })).toEqual({
      state: "unavailable",
      code: "single_person_plan",
      reason: "The Free plan is for one person.",
    });
    expect(add({}, { domains: 0 })).toMatchObject({ state: "unavailable", code: "no_domain" });
  });

  it("is full (shown disabled, with the reason) when people, mailboxes or storage run out", () => {
    expect(add({ used: 6 })).toEqual({
      state: "full",
      code: "people_full",
      reason: "This account already has 6 people, counting pending invites.",
    });
    expect(add({}, { remaining: 0 })).toMatchObject({ state: "full", code: "mailboxes_full" });
    expect(add({}, { maxQuotaGb: 0 })).toMatchObject({ state: "full", code: "storage_full" });
    // A full account is reported as full even before a domain exists.
    expect(add({ used: 7 }, { domains: 0 })).toMatchObject({ state: "full", code: "people_full" });
  });
});

describe("inviteAvailability", () => {
  it("follows the people ceiling and the plan", () => {
    expect(inviteAvailability({ permitted: true, people: people() })).toEqual({ state: "ready" });
    expect(inviteAvailability({ permitted: true, people: people({ used: 6 }) })).toMatchObject({
      state: "full",
      code: "people_full",
    });
    expect(inviteAvailability({ permitted: true, people: people({ addPeople: false }) })).toMatchObject({
      state: "unavailable",
      code: "single_person_plan",
    });
    expect(inviteAvailability({ permitted: false, people: people() })).toMatchObject({ code: "not_permitted" });
    expect(inviteAvailability({ permitted: true, people: null })).toMatchObject({ code: "not_permitted" });
  });
});
