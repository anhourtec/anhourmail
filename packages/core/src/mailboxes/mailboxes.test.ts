// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, anonymous, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import { GB, normaliseLocalPart } from "./entity";
import { createMailbox, getMailbox, listMailboxes, mailboxOptions, setMailboxQuota } from "./service";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

const DOMAIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PENDING_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOMAIN_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function setup() {
  const d = makeDeps(fixedClock("2026-10-21T12:00:00Z"));
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT_A, "owner"],
    ["member", ACCOUNT_A, "member"],
    ["owner-b", ACCOUNT_B, "owner"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@example.ca`;
  }
  const domain = (id: string, accountId: string, name: string, status: "active" | "pending_dns") => ({
    id,
    accountId,
    name,
    status,
    verifyToken: "t",
    stalwartId: null,
    lastError: null,
    createdAt: new Date(0),
  });
  s.domains.push(
    domain(DOMAIN_A, ACCOUNT_A, "family.ca", "active"),
    domain(PENDING_A, ACCOUNT_A, "later.ca", "pending_dns"),
    domain(DOMAIN_B, ACCOUNT_B, "other.ca", "active"),
  );
  return d;
}

describe("normaliseLocalPart", () => {
  it("lowercases and trims, and refuses plus signs, doubled or edge dots and junk", () => {
    expect(normaliseLocalPart("  Jane.Doe ")).toBe("jane.doe");
    for (const bad of [undefined, "", "a+b", ".a", "a.", "a..b", "a b", "ä", "x".repeat(65)]) {
      expect(() => normaliseLocalPart(bad)).toThrow(ValidationError);
    }
  });
});

describe("mailboxes service", () => {
  it("creates a mailbox for a member on an active domain, queues provisioning and audits it", async () => {
    const d = setup();
    const m = await createMailbox(
      d,
      userAdmin,
      ACCOUNT_A,
      { localPart: "Jane", domainId: DOMAIN_A, ownerUserId: "member", quotaGb: 5 },
      req,
    );
    expect(m).toMatchObject({
      address: "jane@family.ca",
      status: "provisioning",
      quotaBytes: 5 * GB,
      owner: { userId: "member", email: "member@example.ca" },
    });
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ kind: "mailbox.ensure", subjectId: m.id })]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "mailbox.created", result: "success" });
    expect((await listMailboxes(d, domainAdmin, ACCOUNT_A)).map((x) => x.address)).toEqual(["jane@family.ca"]);
  });

  it("defaults the quota to the plan's storage and keeps it within 1 GB … plan storage", async () => {
    const d = setup();
    const m = await createMailbox(d, owner, ACCOUNT_A, { localPart: "a", domainId: DOMAIN_A }, req);
    expect(m.quotaBytes).toBe(30 * GB);
    for (const quotaGb of [0, 31, 2.5, "x"]) {
      await expect(
        createMailbox(d, owner, ACCOUNT_A, { localPart: "b", domainId: DOMAIN_A, quotaGb }, req),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("refuses pending or other accounts' domains, non-members, taken addresses and the 11th mailbox", async () => {
    const d = setup();
    const base = { localPart: "x", domainId: DOMAIN_A };
    await expect(createMailbox(d, owner, ACCOUNT_A, { ...base, domainId: PENDING_A }, req)).rejects.toThrow(
      ValidationError,
    );
    await expect(createMailbox(d, owner, ACCOUNT_A, { ...base, domainId: DOMAIN_B }, req)).rejects.toThrow(
      ValidationError,
    );
    await expect(createMailbox(d, owner, ACCOUNT_A, { ...base, ownerUserId: "owner-b" }, req)).rejects.toThrow(
      ValidationError,
    );
    await createMailbox(d, owner, ACCOUNT_A, base, req);
    await expect(createMailbox(d, owner, ACCOUNT_A, { ...base, localPart: "X" }, req)).rejects.toThrow(ConflictError);
    for (let i = 0; i < 9; i++) await createMailbox(d, owner, ACCOUNT_A, { ...base, localPart: `n${String(i)}` }, req);
    await expect(createMailbox(d, owner, ACCOUNT_A, { ...base, localPart: "eleven" }, req)).rejects.toThrow(
      PlanLimitError,
    );
  });

  it("enforces permission and scope, and audits refusals", async () => {
    const d = setup();
    const m = await createMailbox(d, owner, ACCOUNT_A, { localPart: "a", domainId: DOMAIN_A }, req);
    await expect(createMailbox(d, domainAdmin, ACCOUNT_A, { localPart: "b", domainId: DOMAIN_A }, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(listMailboxes(d, member, ACCOUNT_A)).rejects.toThrow(ForbiddenError);
    await expect(listMailboxes(d, ownerB, ACCOUNT_A)).rejects.toThrow(NotFoundError);
    await expect(getMailbox(d, ownerB, ACCOUNT_B, m.id)).rejects.toThrow(NotFoundError);
    await expect(getMailbox(d, owner, ACCOUNT_A, "nope")).rejects.toThrow(NotFoundError);
    await expect(mailboxOptions(d, domainAdmin, ACCOUNT_A)).rejects.toThrow(ForbiddenError);
    await expect(setMailboxQuota(d, anonymous, ACCOUNT_A, m.id, { quotaGb: 2 }, req)).rejects.toThrow(
      UnauthenticatedError,
    );
    await expect(setMailboxQuota(d, ownerB, ACCOUNT_B, m.id, { quotaGb: 2 }, req)).rejects.toThrow(NotFoundError);
    expect(d.uow.state.audit.filter((e) => e.result === "denied").map((e) => e.action)).toEqual(
      expect.arrayContaining(["mailbox.created", "mailbox.quota_changed"]),
    );
  });

  it("changes the quota (audited, re-provisioned) and shows the bound", async () => {
    const d = setup();
    const m = await createMailbox(d, owner, ACCOUNT_A, { localPart: "a", domainId: DOMAIN_A }, req);
    const out = await setMailboxQuota(d, userAdmin, ACCOUNT_A, m.id, { quotaGb: "12" }, req);
    expect(out.quotaBytes).toBe(12 * GB);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "mailbox.quota_changed", meta: { fromGb: 30, toGb: 12 } });
    expect(d.uow.state.jobs.filter((j) => j.subjectId === m.id)).toHaveLength(1); // queued job reused
    expect((await getMailbox(d, domainAdmin, ACCOUNT_A, m.id)).maxQuotaBytes).toBe(30 * GB);
    await expect(setMailboxQuota(d, owner, ACCOUNT_A, m.id, {}, req)).rejects.toThrow(ValidationError);
  });

  it("lists the form options: active domains, members and room left", async () => {
    const d = setup();
    expect(await mailboxOptions(d, userAdmin, ACCOUNT_A)).toEqual({
      domains: [{ id: DOMAIN_A, name: "family.ca" }],
      members: [
        { userId: "member", email: "member@example.ca" },
        { userId: "owner", email: "owner@example.ca" },
      ],
      maxQuotaGb: 30,
      remaining: 10,
    });
  });

  it("refuses quota changes once the mailbox's domain is no longer active in the account", async () => {
    const d = setup();
    const m = await createMailbox(d, owner, ACCOUNT_A, { localPart: "a", domainId: DOMAIN_A }, req);
    d.uow.state.domains.find((x) => x.id === DOMAIN_A)!.status = "removing";
    await expect(setMailboxQuota(d, owner, ACCOUNT_A, m.id, { quotaGb: 2 }, req)).rejects.toThrow(ConflictError);
  });
});
