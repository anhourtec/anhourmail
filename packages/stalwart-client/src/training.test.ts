// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartError, StalwartTransport } from "./client";
import { StalwartManagement } from "./management";
import {
  accountTrainingSamples,
  destroyTrainingSamples,
  holdMismatch,
  importSamples,
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
        ? { ids: ["s1", "s2", "s3"] }
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
    expect(seen[0]?.[1]).toEqual({ filter: { accountId: "a1" }, position: 0, limit: 500 });
    expect(seen[1]?.[1].properties).toEqual(["accountId", "isSpam", "expiresAt"]);
    expect(JSON.stringify(seen)).not.toMatch(/subject|"from"|blobId/);
  });

  it("pages through large lists and skips the get when there is nothing", async () => {
    let queries = 0;
    const { mgmt } = fake((name, args) => {
      if (name.endsWith("/query")) {
        queries += 1;
        return { ids: args.position === 0 ? Array.from({ length: 500 }, (_, i) => `p${String(i)}`) : ["last"] };
      }
      const ids = args.ids as string[];
      return { list: ids.map((id) => ({ id, accountId: "a1", isSpam: false, expiresAt: null })) };
    });
    expect(await accountTrainingSamples(mgmt, "a1")).toHaveLength(501);
    expect(queries).toBe(2);
    const empty = fake(() => ({ ids: [] }));
    expect(await accountTrainingSamples(empty.mgmt, "a1")).toEqual([]);
    expect(empty.seen).toHaveLength(1);
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
