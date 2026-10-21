// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { anonymous, deps, fixedClock, req, user } from "../__tests__/helpers";
import { ForbiddenError, InvalidTokenError, UnauthenticatedError, ValidationError } from "../errors";
import { hashEmail, looksAutomated, MIN_FILL_MS, normaliseEmail } from "./entity";
import { confirmWaitlist, joinWaitlist, listWaitlist, WAITLIST_ACCEPTED } from "./service";

const NOW = new Date("2026-10-21T12:00:00Z");
const form = (email: string, extra: Record<string, unknown> = {}) => ({
  email,
  startedAt: NOW.getTime() - MIN_FILL_MS - 1,
  ...extra,
});

describe("waitlist entity", () => {
  it("normalises and hashes emails", () => {
    expect(normaliseEmail("  Walter@Example.COM ")).toBe("walter@example.com");
    expect(hashEmail("Walter@example.com")).toBe(hashEmail("walter@example.com "));
    expect(hashEmail("a@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags honeypots and implausible fill times", () => {
    expect(looksAutomated({ website: "spam", startedAt: 0 }, NOW)).toBe(true);
    expect(looksAutomated({ startedAt: NOW.getTime() - 500 }, NOW)).toBe(true);
    expect(looksAutomated({ startedAt: NOW.getTime() - 2 * 86_400_000 }, NOW)).toBe(true);
    expect(looksAutomated({ website: "", startedAt: NOW.getTime() - 10_000 }, NOW)).toBe(false);
  });
});

describe("joinWaitlist", () => {
  it("stores a new signup and audits it with a masked label", async () => {
    const d = deps(fixedClock(NOW.toISOString()));
    const out = await joinWaitlist(
      d,
      anonymous,
      form("New@Example.com", { community: "lemmy", ref: "abcd1234", utm: { source: "hn" } }),
      req,
    );
    expect(out.accepted).toEqual(WAITLIST_ACCEPTED);
    expect(out.confirmation?.email).toBe("new@example.com");
    expect(d.uow.state.waitlist).toHaveLength(1);
    expect(d.uow.state.waitlist[0]).toMatchObject({ email: "new@example.com", community: "lemmy", ref: "abcd1234" });
    const [entry] = d.uow.state.audit;
    expect(entry).toMatchObject({
      action: "waitlist.joined",
      result: "success",
      target: { label: "n***@example.com" },
    });
    expect(JSON.stringify(entry)).not.toContain("new@example.com");
  });

  it("answers the same for duplicates and stores nothing new", async () => {
    const d = deps(fixedClock(NOW.toISOString()));
    await joinWaitlist(d, anonymous, form("dup@example.com"), req);
    const again = await joinWaitlist(d, anonymous, form("DUP@example.com"), req);
    expect(again).toEqual({ accepted: WAITLIST_ACCEPTED, confirmation: null }); // within the resend window
    expect(d.uow.state.waitlist).toHaveLength(1);
    expect(d.uow.state.audit.at(-1)?.meta).toEqual({ duplicate: true, confirmationResent: false });
  });

  it("answers a join that loses a race to a concurrent join like a known address (no 500)", async () => {
    const d = deps(fixedClock(NOW.toISOString()));
    await joinWaitlist(d, anonymous, form("race@example.com"), req);
    // Simulate the race: the duplicate check misses, then the insert finds the row a concurrent join committed.
    const run = d.uow.run.bind(d.uow);
    let calls = 0;
    d.uow.run = (fn) =>
      run((r) =>
        fn({
          ...r,
          waitlist: {
            ...r.waitlist,
            findByEmailHash: async (h) => (calls++ === 0 ? null : r.waitlist.findByEmailHash(h)),
          },
        }),
      );
    expect(await joinWaitlist(d, anonymous, form("race@example.com"), req)).toEqual({
      accepted: WAITLIST_ACCEPTED,
      confirmation: null,
    });
    expect(d.uow.state.waitlist).toHaveLength(1);
  });

  it("drops bots silently but audits them as denied", async () => {
    const d = deps(fixedClock(NOW.toISOString()));
    expect(await joinWaitlist(d, anonymous, form("bot@example.com", { website: "http://spam" }), req)).toEqual({
      accepted: WAITLIST_ACCEPTED,
      confirmation: null,
    });
    expect(d.uow.state.waitlist).toHaveLength(0);
    expect(d.uow.state.audit[0]).toMatchObject({ result: "denied", errorCode: "bot_check" });
  });

  it("rejects malformed input before touching storage", async () => {
    const d = deps();
    await expect(joinWaitlist(d, anonymous, { email: "nope" }, req)).rejects.toThrow(ValidationError);
    await expect(joinWaitlist(d, anonymous, null, req)).rejects.toThrow(ValidationError);
    expect(d.uow.state.audit).toHaveLength(0);
  });
});

describe("double opt-in", () => {
  it("confirms with the emailed token once, then the link is dead", async () => {
    const clock = fixedClock(NOW.toISOString());
    const d = deps(clock);
    const { confirmation } = await joinWaitlist(d, anonymous, form("opt@example.com"), req);
    if (!confirmation) throw new Error("no confirmation");
    expect(await confirmWaitlist(d, anonymous, confirmation.token, req)).toEqual({ status: "confirmed" });
    expect(d.uow.state.waitlist[0]).toMatchObject({ status: "confirmed" });
    await expect(confirmWaitlist(d, anonymous, confirmation.token, req)).rejects.toThrow(InvalidTokenError);
    expect(d.uow.state.audit.map((e) => [e.action, e.result])).toEqual([
      ["waitlist.joined", "success"],
      ["waitlist.confirmed", "success"],
      ["waitlist.confirmed", "failed"],
    ]);
  });

  it("refuses malformed, unknown and expired tokens alike", async () => {
    const clock = fixedClock(NOW.toISOString());
    const d = deps(clock);
    const { confirmation } = await joinWaitlist(d, anonymous, form("late@example.com"), req);
    await expect(confirmWaitlist(d, anonymous, "nope", req)).rejects.toThrow(InvalidTokenError);
    await expect(confirmWaitlist(d, anonymous, "x".repeat(43), req)).rejects.toThrow(InvalidTokenError);
    clock.set(new Date(NOW.getTime() + 49 * 3600_000));
    await expect(confirmWaitlist(d, anonymous, confirmation?.token, req)).rejects.toThrow(InvalidTokenError);
  });

  it("re-sends the confirmation for a pending address after the resend window, not for confirmed ones", async () => {
    const clock = fixedClock(NOW.toISOString());
    const d = deps(clock);
    const first = await joinWaitlist(d, anonymous, form("again@example.com"), req);
    clock.set(new Date(NOW.getTime() + 11 * 60_000));
    const second = await joinWaitlist(
      d,
      anonymous,
      { email: "again@example.com", startedAt: clock.now().getTime() - 5000 },
      req,
    );
    expect(second.confirmation?.token).toBeTruthy();
    expect(second.confirmation?.token).not.toBe(first.confirmation?.token);
    if (!second.confirmation) throw new Error("no token");
    await confirmWaitlist(d, anonymous, second.confirmation.token, req);
    clock.set(new Date(NOW.getTime() + 30 * 60_000));
    const third = await joinWaitlist(
      d,
      anonymous,
      { email: "again@example.com", startedAt: clock.now().getTime() - 5000 },
      req,
    );
    expect(third.confirmation).toBeNull();
  });
});

describe("listWaitlist", () => {
  it("shows full emails to waitlist managers and masked ones to readers", async () => {
    const d = deps(fixedClock(NOW.toISOString()));
    await joinWaitlist(d, anonymous, form("person@example.com"), req);
    const managed = await listWaitlist(d, user({ platform: ["support_admin"] }));
    expect(managed.total).toBe(1);
    expect(managed.entries[0]?.email).toBe("person@example.com");
    expect(managed.entries[0]).not.toHaveProperty("emailHash");
    const read = await listWaitlist(d, user({ platform: ["reports_reader"] }), { limit: 9999 });
    expect(read.entries[0]?.email).toBe("p***@example.com");
  });

  it("refuses everyone else", async () => {
    const d = deps();
    await expect(listWaitlist(d, anonymous)).rejects.toThrow(UnauthenticatedError);
    await expect(listWaitlist(d, user({ platform: ["billing_admin"] }))).rejects.toThrow(ForbiddenError);
    await expect(listWaitlist(d, user({ account: [["x", "owner"]] }))).rejects.toThrow(ForbiddenError);
  });
});
