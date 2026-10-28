// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartTransport } from "./client";
import { StalwartManagement } from "./management";
import {
  applySenderIdentityPolicy,
  SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION,
  SENDER_IDENTITY_SCRIPT,
  SENDER_IDENTITY_SIEVE,
} from "./sender";

type Call = [string, Record<string, unknown>, string];

function fake(scripts: { id: string; name: string; contents?: string; isActive?: boolean }[]) {
  const sets: Call[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { methodCalls: Call[] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "x:SieveSystemScript/get") return [name, { list: scripts }, id];
      sets.push([name, args, id]);
      if (name === "x:SieveSystemScript/set" && args.create) return [name, { created: { s: { id: "new1" } } }, id];
      return [name, { updated: {} }, id];
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  const mgmt = new StalwartManagement(
    new StalwartTransport({ baseUrl: "http://s", auth: { type: "bearer", token: "k" }, fetch: fetchImpl }),
  );
  return { mgmt, sets };
}

describe("sender identity policy", () => {
  it("creates the script, wires it to authenticated DATA and keeps mustMatchSender on", async () => {
    const { mgmt, sets } = fake([]);
    expect(await applySenderIdentityPolicy(mgmt)).toEqual({ scriptId: "new1" });
    const created = sets.find(([n]) => n === "x:SieveSystemScript/set")?.[1].create as Record<string, { name: string }>;
    expect(created.s?.name).toBe(SENDER_IDENTITY_SCRIPT);
    const data = sets.find(([n]) => n === "x:MtaStageData/set")?.[1].update as Record<string, { script: unknown }>;
    expect(data.singleton?.script).toEqual(SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION);
    expect(sets.some(([n]) => n === "x:MtaStageAuth/set")).toBe(true);
  });

  it("is idempotent when the script is already current, and repairs a drifted one", async () => {
    const current = fake([{ id: "s1", name: SENDER_IDENTITY_SCRIPT, contents: SENDER_IDENTITY_SIEVE, isActive: true }]);
    await applySenderIdentityPolicy(current.mgmt);
    expect(current.sets.some(([n]) => n === "x:SieveSystemScript/set")).toBe(false);
    const drifted = fake([{ id: "s1", name: SENDER_IDENTITY_SCRIPT, contents: "old", isActive: false }]);
    await applySenderIdentityPolicy(drifted.mgmt);
    const upd = drifted.sets.find(([n]) => n === "x:SieveSystemScript/set")?.[1].update as Record<string, unknown>;
    expect(upd.s1).toEqual({ contents: SENDER_IDENTITY_SIEVE, isActive: true });
  });

  it("script compares header From and Sender to the envelope sender and needs exactly one From", () => {
    expect(SENDER_IDENTITY_SIEVE).toContain('"from" "${envelope.from}"');
    expect(SENDER_IDENTITY_SIEVE).toContain('"sender" "${envelope.from}"');
    expect(SENDER_IDENTITY_SIEVE).toContain(':count "ne"');
  });

  it("script strips every Authentication-Results header from submitted mail", () => {
    expect(SENDER_IDENTITY_SIEVE).toMatch(/^require \[[^\]]*"editheader"/);
    expect(SENDER_IDENTITY_SIEVE).toContain('deleteheader "Authentication-Results";');
  });
});
