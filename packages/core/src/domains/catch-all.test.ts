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
import { deleteMailbox, suspendMailbox } from "../mailboxes/service";
import type { Mailbox } from "../mailboxes/entity";
import { getCatchAll, setCatchAll } from "./catch-all";
import type { CustomerDomain } from "./entity";

const DOMAIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PENDING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOMAIN_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MBX = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MBX_PAUSED = "abababab-abab-4bab-8bab-abababababab";
const MBX_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

function setup(plan: "free" | "plus" = "plus") {
  const d = makeDeps(fixedClock("2026-10-22T12:00:00Z"));
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT_A, "owner"],
    ["dadmin", ACCOUNT_A, "domain_admin"],
    ["uadmin", ACCOUNT_A, "user_admin"],
    ["member", ACCOUNT_A, "member"],
    ["owner-b", ACCOUNT_B, "owner"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@example.ca`;
  }
  const domain = (id: string, accountId: string, name: string, status: CustomerDomain["status"]): CustomerDomain => ({
    id,
    accountId,
    name,
    status,
    verifyToken: "t",
    stalwartId: status === "active" ? `s-${name}` : null,
    lastError: null,
    createdAt: new Date(0),
  });
  s.domains.push(
    domain(DOMAIN, ACCOUNT_A, "family.ca", "active"),
    domain(PENDING, ACCOUNT_A, "new.ca", "pending_dns"),
    domain(DOMAIN_B, ACCOUNT_B, "other.ca", "active"),
  );
  const mailbox = (id: string, accountId: string, address: string, status: Mailbox["status"]): Mailbox => ({
    id,
    accountId,
    userId: "member",
    address,
    status,
    quotaBytes: 1,
    stalwartId: `s-${id.slice(0, 4)}`,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(
    mailbox(MBX, ACCOUNT_A, "kid@family.ca", "active"),
    mailbox(MBX_PAUSED, ACCOUNT_A, "paused@family.ca", "suspended"),
    mailbox(MBX_B, ACCOUNT_B, "b@other.ca", "active"),
  );
  return d;
}

const jobs = (d: ReturnType<typeof setup>) => d.uow.state.jobs.map((j) => `${j.kind}:${j.subjectId}`);

describe("catch-all", () => {
  it("is off by default; owners and domain admins see the active mailboxes it can point at", async () => {
    const d = setup();
    const v = await getCatchAll(d, owner, ACCOUNT_A, DOMAIN);
    expect(v).toMatchObject({ mailbox: null, planAllowed: true, domainActive: true });
    expect(v.options?.mailboxes).toEqual([{ id: MBX, address: "kid@family.ca" }]);
    expect((await getCatchAll(d, userAdmin, ACCOUNT_A, DOMAIN)).options).toBeNull(); // reads domains, can't change
    await expect(getCatchAll(d, member, ACCOUNT_A, DOMAIN)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCatchAll(d, owner, ACCOUNT_A, DOMAIN_B)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCatchAll(d, ownerB, ACCOUNT_A, DOMAIN)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("turns on for an active mailbox of the account, queues the domain and audits", async () => {
    const d = setup();
    const v = await setCatchAll(d, domainAdmin, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req);
    expect(v.mailbox).toEqual({ id: MBX, address: "kid@family.ca" });
    expect(d.uow.state.catchAll).toEqual([{ domainId: DOMAIN, mailboxId: MBX }]);
    expect(jobs(d)).toEqual([`domain.ensure:${DOMAIN}`]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "catch_all.changed",
      result: "success",
      target: { type: "domain", id: DOMAIN, label: "family.ca" },
      meta: { enabled: true, mailbox: "k***@family.ca", changed: true }, // addresses are masked in audit meta
    });
    // Off again.
    const off = await setCatchAll(d, owner, ACCOUNT_A, DOMAIN, { mailboxId: null }, req);
    expect(off.mailbox).toBeNull();
    expect(d.uow.state.catchAll).toEqual([]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ meta: { enabled: false, changed: true } });
    // Off when already off: nothing queued.
    const before = d.uow.state.jobs.length;
    await setCatchAll(d, owner, ACCOUNT_A, DOMAIN, { mailboxId: "" }, req);
    expect(d.uow.state.jobs.length).toBe(before);
  });

  it("needs a paid plan, a verified domain and an active mailbox of this account", async () => {
    const free = setup("free");
    await expect(setCatchAll(free, owner, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req)).rejects.toBeInstanceOf(
      PlanLimitError,
    );
    expect((await getCatchAll(free, owner, ACCOUNT_A, DOMAIN)).planAllowed).toBe(false);
    const d = setup();
    await expect(setCatchAll(d, owner, ACCOUNT_A, PENDING, { mailboxId: MBX }, req)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(setCatchAll(d, owner, ACCOUNT_A, DOMAIN, { mailboxId: MBX_PAUSED }, req)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(setCatchAll(d, owner, ACCOUNT_A, DOMAIN, { mailboxId: MBX_B }, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(setCatchAll(d, owner, ACCOUNT_A, DOMAIN, { mailboxId: 7 }, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(d.uow.state.catchAll).toEqual([]);
  });

  it("is never set on a platform domain", async () => {
    const d = setup();
    d.uow.state.domains[0]!.name = "anhourmail.com";
    await expect(setCatchAll(d, owner, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req)).rejects.toThrow(/isn't available/);
  });

  it("is never set on the deployment's configured platform domain either", async () => {
    const d = setup();
    d.uow.state.domains[0]!.name = `free.${d.platform.domain}`;
    await expect(setCatchAll(d, owner, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req)).rejects.toThrow(/isn't available/);
  });

  it("is refused to people who can't manage domains, and other accounts' ids are not found", async () => {
    const d = setup();
    await expect(setCatchAll(d, userAdmin, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(setCatchAll(d, member, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(setCatchAll(d, ownerB, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(setCatchAll(d, owner, ACCOUNT_A, DOMAIN_B, { mailboxId: MBX }, req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(setCatchAll(d, anonymous, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(d.uow.state.audit.filter((e) => e.scope === `account:${ACCOUNT_A}`).map((e) => e.result)).toEqual([
      "denied",
      "denied",
      "failed",
    ]);
  });

  it("turns off by itself when its mailbox is suspended or deleted (same audit entry)", async () => {
    const d = setup();
    await setCatchAll(d, owner, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req);
    d.uow.state.jobs = [];
    await suspendMailbox(d, owner, ACCOUNT_A, MBX, req);
    expect(d.uow.state.catchAll).toEqual([]);
    expect(jobs(d)).toEqual([`mailbox.ensure:${MBX}`, `domain.ensure:${DOMAIN}`]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "mailbox.suspended",
      meta: { catchAllOff: ["family.ca"] },
    });

    const d2 = setup();
    await setCatchAll(d2, owner, ACCOUNT_A, DOMAIN, { mailboxId: MBX }, req);
    await deleteMailbox(d2, owner, ACCOUNT_A, MBX, req);
    expect(d2.uow.state.catchAll).toEqual([]);
    expect(d2.uow.state.audit.at(-1)).toMatchObject({ meta: { catchAllOff: ["family.ca"] } });
    // A mailbox that isn't a catch-all leaves nothing about it in the entry.
    const d3 = setup();
    await suspendMailbox(d3, owner, ACCOUNT_A, MBX, req);
    expect(d3.uow.state.audit.at(-1)?.meta).toEqual({ from: "active" });
  });
});
