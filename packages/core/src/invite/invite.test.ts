// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { anonymous, deps, fixedClock, req, user } from "../__tests__/helpers";
import { ConflictError, ForbiddenError, InvalidTokenError, NotFoundError, UnauthenticatedError } from "../errors";
import { confirmWaitlist, joinWaitlist } from "../waitlist/service";
import { INVITE_TTL_MS, inviteFromWaitlist, inviteMatches, lookupInvite, redeemInvite } from "./service";

const NOW = new Date("2026-10-21T12:00:00Z");
const staff = user({ id: "staff-1", platform: ["support_admin"] });

async function confirmedEntry(clock = fixedClock(NOW.toISOString())) {
  const d = deps(clock);
  const { confirmation } = await joinWaitlist(
    d,
    anonymous,
    { email: "Pat@Example.com", startedAt: NOW.getTime() - 5000 },
    req,
  );
  if (!confirmation) throw new Error("no confirmation");
  await confirmWaitlist(d, anonymous, confirmation.token, req);
  const id = d.uow.state.waitlist[0]?.id ?? "";
  return { d, id, clock };
}

describe("inviteFromWaitlist", () => {
  it("invites a confirmed sign-up once, with a 7-day token, and marks the entry invited", async () => {
    const { d, id } = await confirmedEntry();
    const out = await inviteFromWaitlist(d, staff, id, req);
    expect(out.email).toBe("pat@example.com");
    expect(out.expiresAt.getTime()).toBe(NOW.getTime() + INVITE_TTL_MS);
    expect(d.uow.state.waitlist[0]?.status).toBe("invited");
    expect(d.uow.state.invites[0]).toMatchObject({ email: "pat@example.com", source: "waitlist" });
    expect(d.uow.state.invites[0]?.tokenHash).not.toBe(out.token);
    await expect(inviteFromWaitlist(d, staff, id, req)).rejects.toThrow(ConflictError);
  });

  it("refuses unconfirmed entries (409), unknown ids (404) and people without waitlist.manage", async () => {
    const d = deps(fixedClock(NOW.toISOString()));
    await joinWaitlist(d, anonymous, { email: "raw@example.com", startedAt: NOW.getTime() - 5000 }, req);
    const id = d.uow.state.waitlist[0]?.id ?? "";
    await expect(inviteFromWaitlist(d, staff, id, req)).rejects.toThrow(ConflictError);
    await expect(inviteFromWaitlist(d, staff, "11111111-1111-4111-8111-111111111111", req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(inviteFromWaitlist(d, staff, "not-a-uuid", req)).rejects.toThrow(NotFoundError);
    await expect(inviteFromWaitlist(d, user({ platform: ["reports_reader"] }), id, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(inviteFromWaitlist(d, anonymous, id, req)).rejects.toThrow(UnauthenticatedError);
  });

  it("audits a refused invite attempt (rule 46)", async () => {
    const { d, id } = await confirmedEntry();
    const before = d.uow.state.audit.length;
    await expect(inviteFromWaitlist(d, user({ platform: ["reports_reader"] }), id, req)).rejects.toThrow(
      ForbiddenError,
    );
    expect(d.uow.state.audit.slice(before)).toEqual([
      expect.objectContaining({ action: "waitlist.invited", result: "denied" }),
    ]);
    expect(d.uow.state.waitlist[0]?.status).toBe("confirmed");
  });
});

describe("invite lookup and redemption", () => {
  it("looks up, matches the email, redeems once, then the link is dead", async () => {
    const { d, id } = await confirmedEntry();
    const { token } = await inviteFromWaitlist(d, staff, id, req);
    expect((await lookupInvite(d, token))?.email).toBe("pat@example.com");
    expect(await inviteMatches(d, token, "PAT@example.com ")).toBe(true);
    expect(await inviteMatches(d, token, "someone@example.com")).toBe(false);
    await expect(redeemInvite(d, { token, userId: "u9", email: "someone@example.com" }, req)).rejects.toThrow(
      InvalidTokenError,
    );
    await redeemInvite(d, { token, userId: "u9", email: "pat@example.com" }, req);
    expect(d.uow.state.invites[0]).toMatchObject({ status: "accepted", acceptedUserId: "u9" });
    expect(await lookupInvite(d, token)).toBeNull();
    expect(d.uow.state.audit.map((e) => e.action)).toContain("invite.redeemed");
  });

  it("expires after 7 days and ignores malformed tokens", async () => {
    const { d, id, clock } = await confirmedEntry();
    const { token } = await inviteFromWaitlist(d, staff, id, req);
    clock.set(new Date(NOW.getTime() + INVITE_TTL_MS + 1));
    expect(await lookupInvite(d, token)).toBeNull();
    expect(await lookupInvite(d, "bad")).toBeNull();
    await expect(redeemInvite(d, { token: 42, userId: "u", email: "x@y.z" }, req)).rejects.toThrow(InvalidTokenError);
  });
});
