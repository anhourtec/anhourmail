// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ValidationError } from "../errors";

import { carryReceiveWindows, computeHolds, type HoldAlias, type HoldMailbox, type HoldResources } from "./holds";

const NOW = new Date("2026-11-04T00:00:00Z");
const DAY = 86_400_000;
const WINDOW_END = new Date(NOW.getTime() + 30 * DAY);
const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * DAY);

const mbx = (id: string, over: Partial<HoldMailbox> = {}): HoldMailbox => ({
  id,
  userId: null,
  platform: true,
  status: "active",
  createdAt: at(0),
  ...over,
});

const aliases = (mailboxId: string, kind: HoldAlias["kind"], n: number, prefix: string): HoldAlias[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${String(i).padStart(2, "0")}`,
    mailboxId,
    kind,
    enabled: true,
    platform: true,
    createdAt: at(i),
  }));

const ids = (holds: { subjectType: string; subjectId: string }[], type: string) =>
  holds.filter((h) => h.subjectType === type).map((h) => h.subjectId);

describe("computeHolds (ADR-0029 §6)", () => {
  const base: HoldResources = {
    ownerUserIds: ["owner"],
    mailboxes: [
      mbx("old-platform", { createdAt: at(0), userId: "member" }),
      mbx("owner-platform", { createdAt: at(5), userId: "owner" }),
      mbx("custom", { platform: false, userId: "owner", createdAt: at(1) }),
      mbx("shared", { createdAt: at(2) }),
      mbx("going", { status: "deleting", createdAt: at(3) }),
    ],
    domainIds: ["dom-b", "dom-a"],
    aliases: [],
  };

  it("keeps the Owner's own platform mailbox and holds every other one, with a receive window", () => {
    const plan = computeHolds(base, NOW);
    expect(plan.keptMailboxId).toBe("owner-platform");
    expect(ids(plan.holds, "mailbox")).toEqual(["old-platform", "custom", "shared"]);
    expect(plan.holds.find((h) => h.subjectType === "mailbox")?.receiveUntil).toEqual(WINDOW_END);
    expect(ids(plan.holds, "domain")).toEqual(["dom-a", "dom-b"]);
    expect(plan.holds.find((h) => h.subjectType === "domain")?.receiveUntil).toBeNull();
  });

  it("keeps the oldest platform mailbox when no Owner has one; none when there is no platform mailbox", () => {
    const noOwner = computeHolds({ ...base, ownerUserIds: ["someone-else"] }, NOW);
    expect(noOwner.keptMailboxId).toBe("old-platform");
    const none = computeHolds({ ...base, mailboxes: [mbx("custom", { platform: false })] }, NOW);
    expect(none.keptMailboxId).toBeNull();
    expect(ids(none.holds, "mailbox")).toEqual(["custom"]);
  });

  it("a mailbox being deleted is neither kept nor held, and its aliases aren't held", () => {
    const r: HoldResources = {
      ...base,
      mailboxes: [mbx("going", { status: "deleting", userId: "owner" }), mbx("kept")],
      aliases: aliases("going", "alias", 1, "g"),
    };
    const plan = computeHolds(r, NOW);
    expect(plan.keptMailboxId).toBe("kept");
    expect(plan.holds.filter((h) => h.subjectType !== "domain")).toEqual([]);
  });

  it("keeps the 10 oldest enabled aliases and, separately, the 10 oldest masked ones on the kept mailbox", () => {
    const r: HoldResources = {
      ownerUserIds: ["owner"],
      mailboxes: [mbx("m", { userId: "owner" })],
      domainIds: [],
      aliases: [
        ...aliases("m", "alias", 12, "a"),
        ...aliases("m", "masked", 11, "k"),
        { id: "off", mailboxId: "m", kind: "alias", enabled: false, platform: true, createdAt: at(-1) },
        { id: "on-custom", mailboxId: "m", kind: "alias", enabled: true, platform: false, createdAt: at(-2) },
      ],
    };
    const plan = computeHolds(r, NOW);
    expect(plan.keptAliasIds).toHaveLength(20);
    expect(plan.keptAliasIds).not.toContain("off");
    expect(ids(plan.holds, "alias")).toEqual(["on-custom", "a10", "k10", "a11"]);
  });

  it("every alias on a held mailbox is held with it", () => {
    const r: HoldResources = { ...base, aliases: aliases("shared", "masked", 2, "s") };
    expect(ids(computeHolds(r, NOW).holds, "alias")).toEqual(["s00", "s01"]);
  });

  describe("the Owner's swap must fit Free", () => {
    const r: HoldResources = {
      ownerUserIds: ["owner"],
      mailboxes: [mbx("m1", { userId: "owner" }), mbx("m2", { createdAt: at(1) }), mbx("c", { platform: false })],
      domainIds: [],
      aliases: [...aliases("m2", "alias", 11, "b"), ...aliases("m1", "masked", 1, "x")],
    };

    it("swapping the kept mailbox moves the hold to the other one", () => {
      const plan = computeHolds(r, NOW, { mailboxId: "m2" });
      expect(plan.keptMailboxId).toBe("m2");
      expect(ids(plan.holds, "mailbox")).toEqual(["c", "m1"]);
      expect(ids(plan.holds, "alias")).toEqual(["x00", "b10"]);
    });

    it("choosing which aliases stay on", () => {
      const plan = computeHolds(r, NOW, { mailboxId: "m2", aliasIds: ["b10", "b10"] });
      expect(plan.keptAliasIds).toEqual(["b10"]);
      expect(ids(plan.holds, "alias")).toHaveLength(11);
    });

    it.each([
      [{ mailboxId: "c" }, /platform domain/],
      [{ mailboxId: "nope" }, /Choose a mailbox/],
      [{ mailboxId: "m1", aliasIds: ["b00"] }, /Only enabled aliases/],
      [{ mailboxId: "m2", aliasIds: aliases("m2", "alias", 11, "b").map((a) => a.id) }, /up to 10 aliases/],
    ])("refuses %j", (choice, message) => {
      expect(() => computeHolds(r, NOW, choice)).toThrow(ValidationError);
      expect(() => computeHolds(r, NOW, choice)).toThrow(message);
    });

    it("refuses more than 10 masked aliases", () => {
      const many: HoldResources = { ...r, aliases: aliases("m1", "masked", 11, "z") };
      expect(() => computeHolds(many, NOW, { aliasIds: many.aliases.map((a) => a.id) })).toThrow(
        /up to 10 masked aliases/,
      );
    });
  });

  it("a swap keeps the receive windows already running; new holds start fresh", () => {
    const earlier = new Date(NOW.getTime() + 5 * DAY);
    const next = carryReceiveWindows(
      [
        { subjectType: "mailbox", subjectId: "a", receiveUntil: WINDOW_END },
        { subjectType: "mailbox", subjectId: "b", receiveUntil: WINDOW_END },
        { subjectType: "alias", subjectId: "c", receiveUntil: null },
      ],
      [
        { subjectType: "mailbox", subjectId: "a", receiveUntil: earlier },
        { subjectType: "alias", subjectId: "c", receiveUntil: null },
      ],
    );
    expect(next.map((h) => h.receiveUntil)).toEqual([earlier, WINDOW_END, null]);
  });
});
