// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES } from "@anhourmail/shared/webmail";

import { ACCOUNT_A, ACCOUNT_B, deps, fixedClock, req } from "../__tests__/helpers";
import type { Mailbox } from "../mailboxes/entity";
import type { DisposableEmailCheck } from "../security/disposable-email";
import { FORWARDING_EMAILS_PER_DAY, forwardingAddress, WebmailSettingsService } from "./settings-service";

const MB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup() {
  const clock = fixedClock();
  const d = deps(clock);
  const mailbox = (id: string, accountId: string, address: string): Mailbox => ({
    id,
    accountId,
    userId: null,
    address,
    status: "active",
    quotaBytes: 1024,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: clock.now(),
  });
  d.uow.state.mailboxes.push(mailbox(MB_A, ACCOUNT_A, "sam@a.test"), mailbox(MB_B, ACCOUNT_B, "lee@b.test"));
  return { d, clock, svc: new WebmailSettingsService(d) };
}

describe("webmail preferences service", () => {
  it("returns defaults, applies a valid change and audits only the keys changed", async () => {
    const { d, svc } = setup();
    expect(await svc.preferences("Sam@A.test")).toEqual(DEFAULT_PREFERENCES);
    const next = await svc.updatePreferences("sam@a.test", { density: "compact", previewLines: 0 }, req);
    expect(next).toMatchObject({ density: "compact", previewLines: 0, readingPane: "right" });
    expect(await svc.preferences("sam@a.test")).toEqual(next);
    // The other mailbox is untouched.
    expect(await svc.preferences("lee@b.test")).toEqual(DEFAULT_PREFERENCES);
    const entry = d.uow.state.audit.at(-1);
    expect(entry).toMatchObject({
      action: "webmail.preferences_changed",
      scope: `account:${ACCOUNT_A}`,
      result: "success",
      target: { type: "mailbox", id: MB_A },
      actor: { type: "system", email: "sam@a.test" },
    });
    expect(entry?.meta).toEqual({ changed: ["density", "previewLines"] });
  });

  it("only ever forgets remembered image senders, never adds one (Safe senders load images now)", async () => {
    const { d, svc } = setup();
    const [k1, k2, k3] = ["a".repeat(22), "b".repeat(22), "c".repeat(22)];
    d.uow.state.webmailPreferences.push({ mailboxId: MB_A, prefs: { imageSenders: [k1, k2] }, updatedAt: new Date() });
    expect((await svc.updatePreferences("sam@a.test", { imageSenders: [k2, k3] }, req)).imageSenders).toEqual([k2]);
    expect((await svc.preferences("sam@a.test")).imageSenders).toEqual([k2]);
    expect((await svc.updatePreferences("sam@a.test", { imageSenders: [] }, req)).imageSenders).toEqual([]);
    expect((await svc.updatePreferences("sam@a.test", { imageSenders: [k1] }, req)).imageSenders).toEqual([]);
  });

  it("refuses unknown keys or values and unknown mailboxes", async () => {
    const { d, svc } = setup();
    await expect(svc.updatePreferences("sam@a.test", { density: "huge" }, req)).rejects.toThrow(/can't be changed/);
    await expect(svc.updatePreferences("sam@a.test", { admin: true }, req)).rejects.toThrow(/can't be changed/);
    await expect(svc.preferences("nobody@a.test")).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.updatePreferences("nobody@a.test", { density: "roomy" }, req)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(d.uow.state.audit).toHaveLength(0);
  });
});

describe("forwarding confirmation", () => {
  it("normalises the target address and refuses anything else", () => {
    expect(forwardingAddress("  Copy@Example.ORG ")).toBe("copy@example.org");
    for (const bad of ["", "no-at", "a@b", "a b@c.d", 'x"@y.z', "a@-b.c", 42, null, `${"x".repeat(250)}@a.bc`]) {
      expect(forwardingAddress(bad)).toBeNull();
    }
  });

  it("sends a link, confirms it once, and only then counts as confirmed", async () => {
    const { d, svc } = setup();
    const { token, target } = await svc.requestForwarding(
      "sam@a.test",
      { target: "Copy@Example.org", ownAddresses: ["hi@a.test"], tier: "standard" },
      req,
    );
    expect(target).toBe("copy@example.org");
    expect(await svc.forwarding("sam@a.test")).toMatchObject({ address: target, status: "pending" });
    expect(await svc.forwardingConfirmed("sam@a.test", target)).toBe(false);
    // Only the hash is stored.
    expect(JSON.stringify(d.uow.state.forwardingTargets)).not.toContain(token);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "forwarding.verification_sent",
      meta: { forwardTo: "c***@example.org" },
    });

    expect(await svc.confirmForwarding(token, req)).toEqual({ mailbox: "sam@a.test", target });
    expect(await svc.forwardingConfirmed("sam@a.test", target)).toBe(true);
    expect(await svc.forwardingConfirmed("sam@a.test", "other@example.org")).toBe(false);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "forwarding.confirmed", scope: `account:${ACCOUNT_A}` });
    // Used: a second click is not found.
    await expect(svc.confirmForwarding(token, req)).rejects.toMatchObject({ code: "not_found" });

    await svc.removeForwarding("sam@a.test", req);
    expect(await svc.forwarding("sam@a.test")).toBeNull();
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "forwarding.changed", meta: { enabled: false } });
  });

  it("refuses a temporary-inbox target (422) and writes nothing", async () => {
    const { d, svc } = setup();
    const disposable: DisposableEmailCheck = {
      check: (address) =>
        Promise.resolve(
          address.toLowerCase().endsWith("@burner.test") ? { disposable: true, via: "listed" } : { disposable: false },
        ),
    };
    const own = { ownAddresses: ["hi@a.test"], tier: "standard" as const, disposable };
    await expect(svc.requestForwarding("sam@a.test", { ...own, target: "Me@Burner.test" }, req)).rejects.toMatchObject({
      code: "disposable_email",
    });
    expect(d.uow.state.forwardingTargets).toEqual([]);
    const ok = await svc.requestForwarding("sam@a.test", { ...own, target: "me@example.org" }, req);
    expect(ok.target).toBe("me@example.org");
  });

  it("while the new tier holds the mailbox, refuses an outside target (sending_held, audited) and takes a hosted one", async () => {
    const { d, svc } = setup();
    d.uow.state.domains.push({
      id: "dom-b",
      accountId: ACCOUNT_B,
      name: "b.test",
      status: "active",
      verifyToken: "t",
      stalwartId: null,
      lastError: null,
      createdAt: d.clock.now(),
    });
    const own = { ownAddresses: ["hi@a.test"], tier: "new" as const };
    await expect(
      svc.requestForwarding("sam@a.test", { ...own, target: "Me@Outside.example" }, req),
    ).rejects.toMatchObject({ code: "sending_held" });
    expect(d.uow.state.forwardingTargets).toEqual([]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "forwarding.verification_sent",
      result: "denied",
      errorCode: "sending_held",
      scope: `account:${ACCOUNT_A}`,
    });
    // A verified customer domain and the platform's own domain are ours: set up as usual.
    expect((await svc.requestForwarding("sam@a.test", { ...own, target: "lee@b.test" }, req)).target).toBe(
      "lee@b.test",
    );
    const free = `x@${d.platform.freeAddressDomain}`;
    expect((await svc.requestForwarding("sam@a.test", { ...own, target: free }, req)).target).toBe(free);
    // Standard: the outside target is fine.
    const standard = await svc.requestForwarding(
      "sam@a.test",
      { ...own, tier: "standard", target: "me@outside.example" },
      req,
    );
    expect(standard.target).toBe("me@outside.example");
  });

  it("refuses loops, paused senders, junk tokens, expired links and too many emails", async () => {
    const { clock, svc } = setup();
    const own = { ownAddresses: ["hi@a.test"], tier: "standard" as const };
    await expect(svc.requestForwarding("sam@a.test", { ...own, target: "SAM@a.test" }, req)).rejects.toThrow(/own/);
    await expect(svc.requestForwarding("sam@a.test", { ...own, target: "hi@a.test" }, req)).rejects.toThrow(/own/);
    await expect(svc.requestForwarding("sam@a.test", { ...own, target: "nope" }, req)).rejects.toThrow(/Enter/);
    await expect(
      svc.requestForwarding("sam@a.test", { ...own, tier: "restricted", target: "x@example.org" }, req),
    ).rejects.toThrow(/paused/);
    await expect(svc.confirmForwarding("short", req)).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.confirmForwarding("A".repeat(43), req)).rejects.toMatchObject({ code: "not_found" });

    const first = await svc.requestForwarding("sam@a.test", { ...own, target: "x@example.org" }, req);
    clock.set(new Date(clock.now().getTime() + 73 * 3_600_000));
    await expect(svc.confirmForwarding(first.token, req)).rejects.toMatchObject({ code: "not_found" });
    expect((await svc.forwarding("sam@a.test"))?.expiresAt?.getTime()).toBe(0);

    // A newer request replaces the older link.
    const a = await svc.requestForwarding("sam@a.test", { ...own, target: "y@example.org" }, req);
    const b = await svc.requestForwarding("sam@a.test", { ...own, target: "z@example.org" }, req);
    await expect(svc.confirmForwarding(a.token, req)).rejects.toMatchObject({ code: "not_found" });
    expect((await svc.confirmForwarding(b.token, req)).target).toBe("z@example.org");

    for (let i = 2; i < FORWARDING_EMAILS_PER_DAY; i++) {
      await svc.requestForwarding("sam@a.test", { ...own, target: "y@example.org" }, req);
    }
    await expect(svc.requestForwarding("sam@a.test", { ...own, target: "y@example.org" }, req)).rejects.toThrow(
      /tomorrow/,
    );
    clock.set(new Date(clock.now().getTime() + 25 * 3_600_000));
    await expect(svc.requestForwarding("sam@a.test", { ...own, target: "y@example.org" }, req)).resolves.toMatchObject({
      target: "y@example.org",
    });
  });

  it("records mail-flow changes in the mailbox's own account", async () => {
    const { d, svc } = setup();
    await svc.recordMailFlow("lee@b.test", "vacation.changed", { enabled: true }, req);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "vacation.changed",
      scope: `account:${ACCOUNT_B}`,
      meta: { enabled: true },
    });
  });

  it("records a refused change in a shared mailbox as denied, by the person, in that mailbox's account", async () => {
    const { d, svc } = setup();
    await svc.recordMailFlowDenied(
      " Sam@A.test ",
      "lee@b.test",
      "junk_rules.changed",
      "own_mailbox_only",
      { via: "message" },
      req,
    );
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "junk_rules.changed",
      result: "denied",
      errorCode: "own_mailbox_only",
      scope: `account:${ACCOUNT_B}`,
      meta: { via: "message" },
    });
    expect(JSON.stringify(d.uow.state.audit.at(-1)?.actor)).toContain("sam@a.test");
    await expect(
      svc.recordMailFlowDenied("sam@a.test", "nobody@b.test", "junk_rules.changed", "x", {}, req),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
