// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartTransport } from "./client";
import {
  ARCHIVE_DEFAULT_FOLDER,
  applyDefaultFolders,
  backfillArchiveFolders,
  ensureArchiveFolder,
  type FolderSummary,
  planArchiveFolder,
} from "./folders";
import { StalwartManagement } from "./management";

type Folder = { id: string; name: string; role: string | null; parentId: string | null };
type Sent = { name: string; args: Record<string, unknown>; using: string[] };

/**
 * A fake Stalwart holding each account's folders; `Mailbox/set` create/update change them like the real server
 * (a top-level name already taken in any case is `alreadyExists`).
 */
function fakeStalwart(
  accounts: Record<string, Folder[]>,
  extra: {
    domains?: { id: string; name: string }[];
    types?: Record<string, { "@type": string; domainId: string }>;
    failOn?: string;
  } = {},
) {
  const sent: Sent[] = [];
  let next = 0;
  const handle = (name: string, args: Record<string, unknown>): unknown => {
    const accountId = args.accountId as string;
    if (name === "Mailbox/get") {
      if (accountId === extra.failOn) return { error: true };
      return { list: accounts[accountId] ?? [] };
    }
    if (name === "Mailbox/set") {
      const list = (accounts[accountId] ??= []);
      const created: Record<string, { id: string }> = {};
      const notCreated: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((args.create ?? {}) as Record<string, Folder>)) {
        if (list.some((f) => f.parentId === null && f.name.toLowerCase() === v.name.toLowerCase())) {
          notCreated[k] = { type: "alreadyExists" };
          continue;
        }
        const id = `n${String(next++)}`;
        list.push({ id, name: v.name, role: v.role, parentId: v.parentId });
        created[k] = { id };
      }
      const updated: Record<string, null> = {};
      for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, { role: string }>)) {
        const f = list.find((x) => x.id === id);
        if (f) {
          f.role = patch.role;
          updated[id] = null;
        }
      }
      return { created, notCreated, updated };
    }
    if (name === "x:Domain/get") return { list: extra.domains ?? [{ id: "d", name: "customer.test" }] };
    if (name === "x:Account/get") {
      return {
        list: Object.keys(accounts).map((id) => ({ id, ...(extra.types?.[id] ?? { "@type": "User", domainId: "d" }) })),
      };
    }
    if (name === "x:Email/set") return { updated: { singleton: null } };
    return null;
  };
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      using: string[];
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      sent.push({ name, args, using: body.using });
      const out = handle(name, args);
      if (out === null || (typeof out === "object" && "error" in out)) return ["error", { type: "forbidden" }, id];
      return [name, out, id];
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  const mgmt = new StalwartManagement(
    new StalwartTransport({ baseUrl: "http://s", auth: { type: "bearer", token: "k" }, fetch: fetchImpl }),
  );
  return { mgmt, sent, accounts };
}

const standard = (): Folder[] => [
  { id: "a", name: "Inbox", role: "inbox", parentId: null },
  { id: "b", name: "Deleted Items", role: "trash", parentId: null },
  { id: "c", name: "Junk Mail", role: "junk", parentId: null },
  { id: "d", name: "Drafts", role: "drafts", parentId: null },
  { id: "e", name: "Sent Items", role: "sent", parentId: null },
];

describe("planArchiveFolder", () => {
  const f = (over: Partial<FolderSummary>): FolderSummary => ({
    id: "x",
    name: "X",
    role: null,
    parentId: null,
    ...over,
  });

  it("does nothing when a folder already has the archive role, whatever its name", () => {
    expect(planArchiveFolder([f({ id: "k", name: "Kept", role: "archive" })])).toEqual({ action: "none", id: "k" });
    // Even when another top-level folder is called Archive: never two archive folders.
    expect(
      planArchiveFolder([f({ id: "o", name: "Archive" }), f({ id: "k", name: "Old mail", role: "archive" })]),
    ).toEqual({ action: "none", id: "k" });
  });

  it("gives the role to a top-level folder already named Archive, in any case", () => {
    expect(planArchiveFolder([f({ id: "m", name: "archive" })])).toEqual({ action: "setRole", id: "m" });
    expect(planArchiveFolder([f({ id: "m", name: "ARCHIVE" })])).toEqual({ action: "setRole", id: "m" });
  });

  it("creates one otherwise, ignoring a nested folder called Archive", () => {
    expect(planArchiveFolder([])).toEqual({ action: "create" });
    expect(planArchiveFolder([f({ id: "n", name: "Archive", parentId: "p" })])).toEqual({ action: "create" });
  });
});

describe("ensureArchiveFolder", () => {
  it("creates Archive with the archive role inside the account, then is a no-op", async () => {
    const s = fakeStalwart({ acc1: standard() });
    const first = await ensureArchiveFolder(s.mgmt, "acc1");
    expect(first.action).toBe("create");
    const set = s.sent.find((x) => x.name === "Mailbox/set");
    expect(set?.args).toMatchObject({
      accountId: "acc1",
      create: { a: { name: "Archive", role: "archive", parentId: null } },
    });
    expect(set?.using).toContain("urn:ietf:params:jmap:mail");
    expect(s.accounts.acc1?.filter((x) => x.role === "archive")).toHaveLength(1);

    const before = s.sent.length;
    expect(await ensureArchiveFolder(s.mgmt, "acc1")).toEqual({ action: "none", id: first.id });
    expect(s.sent.slice(before).map((x) => x.name)).toEqual(["Mailbox/get"]);
  });

  it("sets the role on an existing Archive folder instead of making a duplicate", async () => {
    const s = fakeStalwart({ acc1: [...standard(), { id: "z", name: "Archive", role: null, parentId: null }] });
    expect(await ensureArchiveFolder(s.mgmt, "acc1")).toEqual({ action: "setRole", id: "z" });
    expect(s.sent.find((x) => x.name === "Mailbox/set")?.args).toEqual({
      accountId: "acc1",
      update: { z: { role: "archive" } },
    });
    expect(s.accounts.acc1).toHaveLength(6);
  });

  it("never destroys anything", async () => {
    const s = fakeStalwart({ acc1: standard(), acc2: [{ id: "z", name: "archive", role: null, parentId: null }] });
    await backfillArchiveFolders(s.mgmt);
    expect(s.sent.filter((x) => x.name === "Mailbox/set").every((x) => !("destroy" in x.args))).toBe(true);
  });

  it("throws when the server refuses the create", async () => {
    const s = fakeStalwart({ acc1: standard() });
    s.mgmt.transport.rawCall = async () =>
      Promise.resolve(
        new Map([
          ["g", { list: [] }],
          ["s", { notCreated: {} }],
        ]),
      );
    await expect(ensureArchiveFolder(s.mgmt, "acc1")).rejects.toThrow("Archive folder was not created");
  });

  it("throws when the server refuses the role", async () => {
    const s = fakeStalwart({ acc1: standard() });
    s.mgmt.transport.rawCall = async () =>
      Promise.resolve(
        new Map([
          ["g", { list: [{ id: "z", name: "Archive", parentId: null }] }],
          ["s", { notUpdated: { z: { type: "forbidden" } } }],
        ]),
      );
    await expect(ensureArchiveFolder(s.mgmt, "acc1")).rejects.toThrow("Archive role was not set");
  });
});

describe("backfillArchiveFolders", () => {
  it("adds Archive once per user account, skips groups and service domains, and a re-run changes nothing", async () => {
    const s = fakeStalwart(
      {
        u1: standard(),
        u2: [...standard(), { id: "z", name: "Archive", role: null, parentId: null }],
        u3: [...standard(), { id: "k", name: "Archive", role: "archive", parentId: null }],
        g1: standard(),
        svc: standard(),
      },
      {
        domains: [
          { id: "d", name: "customer.test" },
          { id: "sys", name: "System.Test" },
        ],
        types: { g1: { "@type": "Group", domainId: "d" }, svc: { "@type": "User", domainId: "sys" } },
      },
    );
    expect(await backfillArchiveFolders(s.mgmt, { skipDomains: ["system.test"] })).toEqual({
      checked: 3,
      created: 1,
      roleSet: 1,
      failed: [],
    });
    expect(s.accounts.g1?.some((f) => f.role === "archive")).toBe(false);
    expect(s.accounts.svc?.some((f) => f.role === "archive")).toBe(false);
    expect(s.sent.filter((x) => x.name === "Mailbox/get").map((x) => x.args.accountId)).toEqual(["u1", "u2", "u3"]);

    expect(await backfillArchiveFolders(s.mgmt, { skipDomains: ["system.test"] })).toEqual({
      checked: 3,
      created: 0,
      roleSet: 0,
      failed: [],
    });
  });

  it("limits the run to the named domains", async () => {
    const s = fakeStalwart(
      { u1: standard(), u2: standard() },
      {
        domains: [
          { id: "d1", name: "one.test" },
          { id: "d2", name: "two.test" },
        ],
        types: { u1: { "@type": "User", domainId: "d1" }, u2: { "@type": "User", domainId: "d2" } },
      },
    );
    expect(await backfillArchiveFolders(s.mgmt, { domains: ["ONE.test"] })).toMatchObject({ checked: 1, created: 1 });
    expect(s.accounts.u2?.some((f) => f.role === "archive")).toBe(false);
  });

  it("keeps going past an account that fails and reports its id only", async () => {
    const s = fakeStalwart({ bad: standard(), good: standard() }, { failOn: "bad" });
    expect(await backfillArchiveFolders(s.mgmt)).toEqual({ checked: 2, created: 1, roleSet: 0, failed: ["bad"] });
  });
});

describe("applyDefaultFolders", () => {
  it("patches only the archive entry of x:Email.defaultFolders", async () => {
    const s = fakeStalwart({});
    await applyDefaultFolders(s.mgmt);
    expect(s.sent).toEqual([
      {
        name: "x:Email/set",
        args: { update: { singleton: { "defaultFolders/archive": ARCHIVE_DEFAULT_FOLDER } } },
        using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      },
    ]);
    expect(ARCHIVE_DEFAULT_FOLDER).toMatchObject({ name: "Archive", create: true, subscribe: true });
  });
});
