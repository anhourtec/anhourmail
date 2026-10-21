// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { anonymous, deps, fixedClock, req, user } from "../__tests__/helpers";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "../errors";
import { hashEmail, looksAutomated, MIN_FILL_MS, normaliseEmail } from "./entity";
import { joinWaitlist, listWaitlist, WAITLIST_ACCEPTED } from "./service";

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
    expect(out).toEqual(WAITLIST_ACCEPTED);
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
    expect(await joinWaitlist(d, anonymous, form("DUP@example.com"), req)).toEqual(WAITLIST_ACCEPTED);
    expect(d.uow.state.waitlist).toHaveLength(1);
    expect(d.uow.state.audit.at(-1)?.meta).toEqual({ duplicate: true });
  });

  it("drops bots silently but audits them as denied", async () => {
    const d = deps(fixedClock(NOW.toISOString()));
    expect(await joinWaitlist(d, anonymous, form("bot@example.com", { website: "http://spam" }), req)).toEqual(
      WAITLIST_ACCEPTED,
    );
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
