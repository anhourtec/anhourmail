// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartError, StalwartTransport } from "./client";
import { StalwartManagement } from "./management";
import {
  accountsThatExist,
  accountTrainingSamples,
  allTrainingSamples,
  destroyTrainingSamples,
  holdMismatch,
  importSamples,
  orphanCleanup,
  orphanedSamples,
  samplesMadeBefore,
  SPAM_SAMPLE_HOLD_DEFAULT_MS,
  type TrainingSample,
} from "./training";

type Call = [string, Record<string, unknown>, string];

function fake(handler: (name: string, args: Record<string, unknown>) => unknown) {
  const seen: Call[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { methodCalls: Call[] };
    return Response.json({
      methodResponses: body.methodCalls.map(([name, args, id]) => {
        seen.push([name, args, id]);
        return [name, handler(name, args), id];
      }),
    });
  }) as typeof fetch;
  const mgmt = new StalwartManagement(
    new StalwartTransport({ baseUrl: "http://s", auth: { type: "bearer", token: "k" }, fetch: fetchImpl }),
  );
  return { mgmt, seen };
}

const HOLD = SPAM_SAMPLE_HOLD_DEFAULT_MS;
const at = (iso: string) => new Date(iso);
const sample = (id: string, created: string, isSpam = false): TrainingSample => ({
  id,
  accountId: "a1",
  isSpam,
  // Whole seconds, as the server writes it.
  expiresAt: new Date(Math.floor((Date.parse(created) + HOLD) / 1000) * 1000),
});

describe("accountTrainingSamples", () => {
  it("queries by account, reads only id, account, kind and expiry, and drops any other account's sample", async () => {
    const { mgmt, seen } = fake((name) =>
      name.endsWith("/query")
        ? { ids: ["s1", "s2", "s3"], total: 3 }
        : {
            list: [
              { id: "s1", accountId: "a1", isSpam: false, expiresAt: "2027-05-03T22:54:18Z" },
              { id: "s2", accountId: "a1", isSpam: true, expiresAt: "bad" },
              { id: "s3", accountId: "other", isSpam: false, expiresAt: "2027-05-03T22:54:18Z" },
            ],
          },
    );
    const got = await accountTrainingSamples(mgmt, "a1");
    expect(got).toEqual([
      { id: "s1", accountId: "a1", isSpam: false, expiresAt: at("2027-05-03T22:54:18Z") },
      { id: "s2", accountId: "a1", isSpam: true, expiresAt: null },
    ]);
    expect(seen[0]?.[1]).toEqual({ filter: { accountId: "a1" }, limit: 100_000, calculateTotal: true });
    expect(seen[1]?.[1].properties).toEqual(["accountId", "isSpam", "expiresAt"]);
    expect(JSON.stringify(seen)).not.toMatch(/subject|"from"|blobId/);
  });

  it("lists in one query (position paging repeats pages on v0.16.27), de-duplicated, gets in pages of 500", async () => {
    let queries = 0;
    let gets = 0;
    const many = Array.from({ length: 700 }, (_, i) => `p${String(i)}`);
    const { mgmt, seen } = fake((name, args) => {
      if (name.endsWith("/query")) {
        queries += 1;
        return { ids: [...many, "p0"], total: 700 };
      }
      gets += 1;
      const ids = args.ids as string[];
      return { list: ids.map((id) => ({ id, accountId: "a1", isSpam: false, expiresAt: null })) };
    });
    expect(await accountTrainingSamples(mgmt, "a1")).toHaveLength(700);
    expect(queries).toBe(1);
    expect(gets).toBe(2);
    expect(seen[0]?.[1]).not.toHaveProperty("position");
    const empty = fake(() => ({ ids: [], total: 0 }));
    expect(await accountTrainingSamples(empty.mgmt, "a1")).toEqual([]);
    expect(empty.seen).toHaveLength(1);
  });

  it("refuses a list short of the server's total (there are samples it didn't list)", async () => {
    const { mgmt } = fake((name) => (name.endsWith("/query") ? { ids: ["s1"], total: 2 } : { list: [] }));
    await expect(allTrainingSamples(mgmt)).rejects.toThrow(/listed 1 of 2/);
  });
});

describe("importSamples", () => {
  const window = { from: at("2026-11-05T10:00:00.400Z"), to: at("2026-11-05T10:15:00Z") };
  const opts = { holdMs: HOLD, slackMs: 60_000 };

  it("matches ham samples made inside the window (with slack) and never spam samples", () => {
    const samples = [
      sample("before", "2026-11-05T09:58:00Z"),
      sample("edge-start", "2026-11-05T09:59:01Z"),
      sample("inside", "2026-11-05T10:07:00.900Z"),
      sample("spam-inside", "2026-11-05T10:07:00Z", true),
      sample("edge-end", "2026-11-05T10:16:00Z"),
      sample("after", "2026-11-05T10:16:02Z"),
      { id: "no-expiry", accountId: "a1", isSpam: false, expiresAt: null },
    ];
    expect(importSamples(samples, window, opts)).toEqual(["edge-start", "inside", "edge-end"]);
  });

  it("counts a sample made in the window's first second, whose expiry was rounded down", () => {
    expect(importSamples([sample("s", "2026-11-05T09:59:00.900Z")], window, opts)).toEqual(["s"]);
  });
});

describe("samplesMadeBefore", () => {
  it("takes spam and ham made before the destroy (with slack) and undatable ones; a later account's stay", () => {
    const samples = [
      sample("old-ham", "2026-11-01T10:00:00Z"),
      sample("old-spam", "2026-11-04T10:00:00Z", true),
      sample("edge", "2026-11-05T10:01:00Z"),
      sample("reused-id", "2026-11-05T10:01:02Z"),
      { id: "no-expiry", accountId: "a1", isSpam: true, expiresAt: null },
    ];
    expect(samplesMadeBefore(samples, at("2026-11-05T10:00:00Z"), { holdMs: HOLD, slackMs: 60_000 })).toEqual([
      "old-ham",
      "old-spam",
      "edge",
      "no-expiry",
    ]);
    expect(samplesMadeBefore([], at("2026-11-05T10:00:00Z"), { holdMs: HOLD, slackMs: 0 })).toEqual([]);
  });
});

describe("orphanedSamples", () => {
  it("finds samples of missing accounts and ones made before their account existed", () => {
    const accounts = new Map<string, Date | null>([
      ["a1", at("2026-11-01T00:00:00Z")],
      ["a2", null],
    ]);
    const samples = [
      sample("mine", "2026-11-02T00:00:00Z"),
      sample("inherited", "2026-10-31T23:58:00Z"),
      sample("edge", "2026-10-31T23:59:30Z"),
      { ...sample("gone-1", "2026-10-01T00:00:00Z"), accountId: "x9" },
      { ...sample("gone-2", "2026-10-02T00:00:00Z", true), accountId: "x9" },
      { ...sample("unknown-time", "2026-10-02T00:00:00Z"), accountId: "a2" },
      { id: "no-account", accountId: null, isSpam: false, expiresAt: null },
    ];
    expect(orphanedSamples(samples, accounts, HOLD)).toEqual({
      orphans: ["gone-1", "gone-2", "no-account"],
      inherited: ["inherited"],
      missingAccountIds: ["x9"],
    });
  });
});

describe("orphanCleanup", () => {
  const samples = [
    { ...sample("gone-1", "2026-10-01T00:00:00Z"), accountId: "x1" },
    { ...sample("back-1", "2026-10-01T00:00:00Z"), accountId: "x2" },
    { id: "no-account", accountId: null, isSpam: false, expiresAt: null },
    sample("inh", "2026-10-01T00:00:00Z"),
  ];
  const found = { orphans: ["gone-1", "back-1", "no-account"], inherited: ["inh"], missingAccountIds: ["x1", "x2"] };
  it("keeps the samples of an account that exists after all, and refuses --apply then", () => {
    const back = new Set(["x2"]);
    expect(orphanCleanup(samples, found, back, { apply: false, inherited: false })).toEqual({
      doomed: ["gone-1", "no-account"],
      orphans: 2,
      refused: false,
    });
    expect(orphanCleanup(samples, found, back, { apply: true, inherited: true })).toEqual({
      doomed: [],
      orphans: 2,
      refused: true,
    });
  });
  it("with nothing reappeared, --apply goes ahead (and takes inherited ones only when asked)", () => {
    expect(orphanCleanup(samples, found, new Set(), { apply: true, inherited: false }).doomed).toEqual([
      "gone-1",
      "back-1",
      "no-account",
    ]);
    expect(orphanCleanup(samples, found, new Set(), { apply: true, inherited: true }).doomed).toContain("inh");
  });
});

describe("accountsThatExist", () => {
  it("asks for the ids themselves and answers only the asked ones that came back", async () => {
    const { mgmt, seen } = fake((_name, args) => ({
      list: [{ id: "x2" }, { id: "not-asked" }].filter(
        (r) => (args.ids as string[]).includes(r.id) || r.id === "not-asked",
      ),
    }));
    expect(await accountsThatExist(mgmt, ["x1", "x2"])).toEqual(["x2"]);
    expect(seen[0]?.[0]).toBe("x:Account/get");
    expect(seen[0]?.[1]).toMatchObject({ ids: ["x1", "x2"], properties: ["id"] });
    const none = fake(() => ({ list: [] }));
    expect(await accountsThatExist(none.mgmt, [])).toEqual([]);
    expect(none.seen).toHaveLength(0);
  });
});

describe("holdMismatch", () => {
  it("notices a sample that expires later than the configured hold allows", () => {
    const now = at("2026-11-05T10:00:00Z");
    expect(holdMismatch([sample("ok", "2026-11-05T09:59:00Z")], now, HOLD)).toBe(false);
    expect(holdMismatch([sample("long", "2026-11-05T09:59:00Z")], now, HOLD - 86_400_000)).toBe(true);
  });
});

describe("destroyTrainingSamples", () => {
  it("destroys in chunks, counts what went and treats already-gone samples as done", async () => {
    const { mgmt, seen } = fake((_name, args) => {
      const ids = args.destroy as string[];
      return { destroyed: ids.filter((id) => id !== "gone"), notDestroyed: { gone: { type: "notFound" } } };
    });
    const ids = [...Array.from({ length: 500 }, (_, i) => `d${String(i)}`), "gone"];
    expect(await destroyTrainingSamples(mgmt, ids)).toBe(500);
    expect(seen).toHaveLength(2);
    expect(await destroyTrainingSamples(mgmt, [])).toBe(0);
  });

  it("throws when the server refuses one", async () => {
    const { mgmt } = fake(() => ({ notDestroyed: { s1: { type: "forbidden" } } }));
    await expect(destroyTrainingSamples(mgmt, ["s1"])).rejects.toBeInstanceOf(StalwartError);
  });
});
