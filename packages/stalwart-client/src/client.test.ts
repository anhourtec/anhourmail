// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { isOverQuotaError, StalwartError, StalwartTransport } from "./client";
import { CUSTOMER_PERMISSIONS, StalwartManagement, SUSPENDED_PERMISSIONS } from "./management";

type Call = { url: string; body: unknown; auth: string | null };

/** A fake Stalwart: answers JMAP method calls from a handler map, records requests. */
function fakeServer(handlers: Record<string, (args: Record<string, unknown>) => unknown>, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as { methodCalls: [string, Record<string, unknown>, string][] })
        : null;
    calls.push({ url, body, auth: headers.get("authorization") });
    if (status !== 200) return new Response("", { status });
    if (url.endsWith("/healthz/ready")) return new Response("ok");
    const methodResponses = (body?.methodCalls ?? []).map(([name, args, id]) => {
      const h = handlers[name];
      return h ? [name, h(args), id] : ["error", { type: "unknownMethod" }, id];
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const transport = (fetchImpl: typeof fetch) =>
  new StalwartTransport({
    baseUrl: "http://stalwart:8080/",
    auth: { type: "basic", username: "admin", password: "pw" },
    fetch: fetchImpl,
  });

describe("StalwartTransport", () => {
  it("posts JMAP with the management capability and basic auth", async () => {
    const s = fakeServer({ "x:Domain/get": () => ({ list: [{ id: "a", name: "x.test" }] }) });
    const t = transport(s.fetchImpl);
    expect(await t.getAll("x:Domain", ["name"])).toEqual([{ id: "a", name: "x.test" }]);
    expect(s.calls[0]?.url).toBe("http://stalwart:8080/jmap");
    expect(s.calls[0]?.auth).toBe(`Basic ${Buffer.from("admin:pw").toString("base64")}`);
    expect((s.calls[0]?.body as { using: string[] }).using).toContain("urn:stalwart:jmap");
  });

  it("lists past the server's 500-object get limit with /query, then gets in pages of 500", async () => {
    const all = Array.from({ length: 1234 }, (_, i) => ({ id: `a${String(i)}`, name: `n${String(i)}` }));
    const s = fakeServer({
      // Like the real server: `ids: null` answers only the first 500.
      "x:Account/get": (args) => ({
        list: args.ids === null ? all.slice(0, 500) : all.filter((a) => (args.ids as string[]).includes(a.id)),
      }),
      "x:Account/query": (args) => {
        const position = Number(args.position);
        return { ids: all.slice(position, position + Number(args.limit)).map((a) => a.id) };
      },
    });
    const got = await transport(s.fetchImpl).getAll("x:Account", ["name"]);
    expect(got).toHaveLength(1234);
    const gets = s.calls.map((c) => (c.body as { methodCalls: [string, { ids: unknown }][] }).methodCalls[0]);
    expect(gets.filter((m) => m?.[0] === "x:Account/query")).toHaveLength(3);
    expect(
      gets
        .filter((m) => m?.[0] === "x:Account/get" && Array.isArray(m[1].ids))
        .map((m) => (m?.[1].ids as unknown[]).length),
    ).toEqual([500, 500, 234]);
    // Fewer than a full page: one call, as before.
    const small = fakeServer({ "x:Domain/get": () => ({ list: [{ id: "d", name: "x.test" }] }) });
    expect(await transport(small.fetchImpl).getAll("x:Domain", ["name"])).toHaveLength(1);
    expect(small.calls).toHaveLength(1);
  });

  it("uses bearer auth for API keys", async () => {
    const s = fakeServer({});
    const t = new StalwartTransport({ baseUrl: "http://s", auth: { type: "bearer", token: "k" }, fetch: s.fetchImpl });
    await t.ready();
    expect(s.calls[0]?.url).toBe("http://s/healthz/ready");
  });

  it("throws on HTTP errors, method errors and failed sets", async () => {
    await expect(transport(fakeServer({}, 500).fetchImpl).call([])).rejects.toMatchObject({ kind: "http" });
    await expect(transport(fakeServer({}, 503).fetchImpl).ready()).rejects.toBeInstanceOf(StalwartError);
    await expect(transport(fakeServer({}).fetchImpl).call([["x:Nope/get", {}, "a"]])).rejects.toMatchObject({
      kind: "method",
    });
    const s = fakeServer({ "x:Domain/set": () => ({ notCreated: { d: { type: "invalidProperties" } } }) });
    await expect(transport(s.fetchImpl).set("x:Domain", { create: { d: {} } })).rejects.toMatchObject({ kind: "set" });
  });
});

describe("StalwartManagement", () => {
  it("upserts domains and users idempotently and maps aliases to domain ids", async () => {
    const domains = [{ id: "d1", name: "a.test" }];
    const accounts: { id: string; name: string; domainId: string }[] = [];
    const sets: Record<string, unknown>[] = [];
    const s = fakeServer({
      "x:Domain/get": () => ({ list: domains }),
      "x:Domain/set": (args) => {
        sets.push(args);
        return args.create ? { created: { d: { id: "d2" } } } : { updated: {} };
      },
      "x:Account/get": () => ({ list: accounts }),
      "x:Account/set": (args) => {
        sets.push(args);
        if (args.create) accounts.push({ id: "u1", name: "alice", domainId: "d1" });
        return args.create ? { created: { u: { id: "u1" } } } : { updated: {} };
      },
    });
    const m = new StalwartManagement(transport(s.fetchImpl));
    expect(await m.upsertDomain({ name: "a.test" })).toBe("d1");
    expect(await m.upsertDomain({ name: "b.test", catchAllAddress: "x@b.test", subAddressing: false })).toBe("d2");
    const created = await m.upsertUser({
      name: "alice",
      domain: "a.test",
      password: "pw",
      quotaBytes: 10,
      aliases: [{ name: "hi", domain: "a.test", enabled: true }],
    });
    expect(created).toBe("u1");
    expect(
      await m.upsertUser({ name: "alice", domain: "a.test", password: "pw2", quotaBytes: 20, resetPassword: true }),
    ).toBe("u1");
    const lastUpdate = sets.at(-1) as { update: Record<string, { credentials?: unknown; quotas: unknown }> };
    expect(lastUpdate.update.u1?.credentials).toEqual({ "0": { "@type": "Password", secret: "pw2" } });
    expect(lastUpdate.update.u1).not.toHaveProperty("description");
    await m.upsertUser({
      name: "alice",
      domain: "a.test",
      password: "pw",
      quotaBytes: 20,
      description: "Alice Example",
    });
    expect((sets.at(-1) as { update: Record<string, { description?: unknown }> }).update.u1?.description).toBe(
      "Alice Example",
    );
    await expect(m.upsertUser({ name: "x", domain: "missing.test", password: "p", quotaBytes: 1 })).rejects.toThrow(
      /Unknown domain/,
    );
    expect(await m.ensureTenant("acct")).toBeNull();
  });

  it("suspends and resumes through permissions, and leaves them alone when not asked", async () => {
    const updates: Record<string, Record<string, unknown>>[] = [];
    const s = fakeServer({
      "x:Domain/get": () => ({ list: [{ id: "d1", name: "a.test" }] }),
      "x:Account/get": (args) =>
        args.ids
          ? {
              list: (args.ids as string[]).includes("u1")
                ? [
                    {
                      id: "u1",
                      "@type": "User",
                      name: "alice",
                      domainId: "d1",
                      permissions: SUSPENDED_PERMISSIONS,
                    },
                  ]
                : [],
            }
          : { list: [{ id: "u1", name: "alice", domainId: "d1" }] },
      "x:Account/set": (args) => {
        updates.push(args.update as Record<string, Record<string, unknown>>);
        return { updated: {} };
      },
    });
    const m = new StalwartManagement(transport(s.fetchImpl));
    const base = { name: "alice", domain: "a.test", password: "pw", quotaBytes: 1 };
    await m.upsertUser({ ...base, suspended: true });
    await m.upsertUser({ ...base, suspended: false });
    await m.upsertUser(base);
    expect(updates.map((u) => u.u1?.permissions)).toEqual([SUSPENDED_PERMISSIONS, CUSTOMER_PERMISSIONS, undefined]);
    // Credentials are never touched by a suspension (app passwords and the password survive it).
    expect(updates.every((u) => u.u1?.credentials === undefined)).toBe(true);
    expect(SUSPENDED_PERMISSIONS.disabledPermissions).toMatchObject({ authenticate: true, emailReceive: true });
    // A normal customer mailbox keeps sign-in and delivery, but can't write its own Sieve (closes the relay vector).
    expect(CUSTOMER_PERMISSIONS.disabledPermissions).toMatchObject({
      sieveAuthenticate: true,
      jmapSieveScriptCreate: true,
      jmapSieveScriptUpdate: true,
    });
    expect("authenticate" in CUSTOMER_PERMISSIONS.disabledPermissions).toBe(false);
    // …nor VacationResponse (it would activate the server's own script and switch ours off).
    expect(CUSTOMER_PERMISSIONS.disabledPermissions).toMatchObject({ jmapVacationResponseUpdate: true });
    // Suspension is a superset: resuming never briefly unlocks Sieve.
    expect(SUSPENDED_PERMISSIONS.disabledPermissions).toMatchObject(CUSTOMER_PERMISSIONS.disabledPermissions);
    expect(await m.getUser("u1")).toEqual({ id: "u1", address: "alice@a.test", suspended: true });
    expect(await m.getUser("gone")).toBeUndefined();
    expect(await m.listUsers()).toEqual([
      { id: "u1", address: "alice@a.test", quotaBytes: null, aliases: [], suspended: false, sieveLocked: false },
    ]);
  });

  it("reads storage used for the given accounts only, name and usedDiskQuota only", async () => {
    const asked: Record<string, unknown>[] = [];
    const s = fakeServer({
      "x:Account/get": (args) => {
        asked.push(args);
        return {
          list: [
            { id: "u1", name: "alice", usedDiskQuota: 1234 },
            { id: "u2", name: "bob" },
          ],
          notFound: ["gone"],
        };
      },
    });
    const m = new StalwartManagement(transport(s.fetchImpl));
    expect(await m.accountUsage([])).toEqual([]);
    expect(asked).toHaveLength(0);
    expect(await m.accountUsage(["u1", "u2", "gone"])).toEqual([
      { id: "u1", name: "alice", usedBytes: 1234 },
      { id: "u2", name: "bob", usedBytes: 0 },
    ]);
    expect(asked).toEqual([{ ids: ["u1", "u2", "gone"], properties: ["name", "usedDiskQuota"] }]);
  });

  it("routes, listeners, singletons, web UI and reload", async () => {
    const sets: [string, Record<string, unknown>][] = [];
    const s = fakeServer({
      "x:MtaRoute/get": () => ({ list: [{ id: "r1", name: "mailpit" }] }),
      "x:MtaRoute/set": (a) => (sets.push(["route", a]), { updated: {} }),
      "x:MtaOutboundStrategy/set": (a) => (sets.push(["strategy", a]), { updated: {} }),
      "x:MtaOutboundStrategy/get": () => ({ list: [{ id: "singleton", route: { else: "'mailpit'" } }] }),
      "x:NetworkListener/get": () => ({ list: [{ id: "l1", name: "smtp" }] }),
      "x:NetworkListener/set": (a) => (sets.push(["listener", a]), { created: { l: { id: "l2" } } }),
      "x:SpamPyzor/set": (a) => (sets.push(["pyzor", a]), { updated: {} }),
      "x:Application/get": () => ({ list: [{ id: "app1", resourceUrl: "https://old" }] }),
      "x:Application/set": (a) => (sets.push(["app", a]), { updated: {} }),
      "x:Action/set": (a) => (sets.push(["action", a]), { created: { a: { id: "x" } } }),
      "x:Domain/get": () => ({ list: [{ id: "d1", dnsZoneFile: "zone" }] }),
    });
    const m = new StalwartManagement(transport(s.fetchImpl));
    expect(await m.upsertRelayRoute({ name: "mailpit", description: "d", host: "mailpit", port: 1025 })).toBe("r1");
    await m.setRemoteRoute("mailpit");
    expect(await m.remoteRoute()).toBe("mailpit");
    await m.ensureListener({ name: "smtp", port: 25, protocol: "smtp", implicitTls: false });
    await m.ensureListener({ name: "submission", port: 587, protocol: "smtp", implicitTls: false });
    await m.updateSingleton("x:SpamPyzor", { enable: false });
    expect(await m.setWebUiResource("file:///x.zip")).toBe(true);
    await m.reloadSettings();
    expect(await m.domainZoneFile("d1")).toBe("zone");
    expect(sets.map(([k]) => k)).toEqual(["route", "strategy", "listener", "pyzor", "app", "action"]);
  });
});

describe("managed Sieve script (management credentials)", () => {
  /** A mail server with Sieve scripts, blobs and accounts, enough for the managed-script calls. */
  function sieveServer() {
    const scripts: { id: string; name: string; blobId: string; isActive: boolean }[] = [];
    const blobs = new Map<string, string>();
    const usings: string[][] = [];
    let seq = 0;
    let state = 0;
    let created: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/jmap/upload/")) {
        const blobId = `blob${String(++seq)}`;
        blobs.set(blobId, typeof init?.body === "string" ? init.body : "");
        return Response.json({ blobId });
      }
      if (url.includes("/jmap/download/")) {
        const blobId = decodeURIComponent(url.split("/")[6] ?? "");
        const text = blobs.get(blobId);
        return text === undefined ? new Response(null, { status: 404 }) : new Response(text);
      }
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        using: string[];
        methodCalls: [string, Record<string, unknown>, string][];
      };
      usings.push(body.using);
      const methodResponses = body.methodCalls.map(([name, a, id]) => {
        if (name === "SieveScript/get")
          return [name, { state: String(state), list: scripts.map((s) => ({ ...s })) }, id];
        if (name === "x:Domain/get") return [name, { list: [{ id: "d1", name: "a.test" }] }, id];
        if (name === "x:Account/get") return [name, { list: [] }, id];
        if (name === "x:Account/set") {
          created = (a.create as Record<string, Record<string, unknown>>).u ?? null;
          return [name, { created: { u: { id: "u9" } } }, id];
        }
        // SieveScript/set: a stale ifInState is a method error, as on the pinned server.
        if (typeof a.ifInState === "string" && a.ifInState !== String(state))
          return ["error", { type: "stateMismatch" }, id];
        state += 1;
        const c = (a.create ?? {}) as Record<string, { name: string; blobId: string }>;
        const made: Record<string, { id: string }> = {};
        for (const [k, v] of Object.entries(c)) {
          const sid = `s${String(++seq)}`;
          scripts.push({ id: sid, name: v.name, blobId: v.blobId, isActive: false });
          made[k] = { id: sid };
        }
        for (const [sid, p] of Object.entries((a.update ?? {}) as Record<string, { blobId: string }>)) {
          const s = scripts.find((x) => x.id === sid);
          if (s) s.blobId = p.blobId;
        }
        const act = typeof a.onSuccessActivateScript === "string" ? a.onSuccessActivateScript : null;
        if (act) {
          const target = act.startsWith("#") ? made[act.slice(1)]?.id : act;
          for (const s of scripts) s.isActive = s.id === target;
        }
        return [name, { created: made }, id];
      });
      return Response.json({ methodResponses });
    }) as typeof fetch;
    return { scripts, blobs, usings, fetchImpl, created: () => created };
  }

  it("writes, reads back with its active flag, and re-activates the script after a user switched it off", async () => {
    const s = sieveServer();
    const m = new StalwartManagement(transport(s.fetchImpl));
    expect(await m.getSieveScript("acc1", "anhourmail")).toBeNull();
    expect(await m.activateSieveScript("acc1", "anhourmail")).toBe(false);
    await m.putSieveScript("acc1", "anhourmail", "keep;\n");
    expect(await m.getSieveScript("acc1", "anhourmail")).toMatchObject({ content: "keep;\n", active: true });
    await m.putSieveScript("acc1", "anhourmail", "discard;\n");
    expect(s.scripts).toHaveLength(1);
    expect(await m.getSieveScript("acc1", "anhourmail")).toMatchObject({ content: "discard;\n", active: true });
    // A user's bare deactivate: reported, then turned back on (nothing else is deleted).
    for (const x of s.scripts) x.isActive = false;
    expect((await m.getSieveScript("acc1", "anhourmail"))?.active).toBe(false);
    expect(await m.activateSieveScript("acc1", "anhourmail")).toBe(true);
    expect(s.scripts[0]?.isActive).toBe(true);
    // Standard JMAP Sieve calls, not only the management capability.
    expect(s.usings.some((u) => u.includes("urn:ietf:params:jmap:sieve"))).toBe(true);
  });

  it("writes only when the Sieve state is unchanged since the read (compare-and-swap), keeping the active flag", async () => {
    const s = sieveServer();
    const m = new StalwartManagement(transport(s.fetchImpl));
    expect(await m.putSieveScriptIfUnchanged("acc1", "anhourmail", "keep;\n", "0")).toBe(false); // no script yet
    await m.putSieveScript("acc1", "anhourmail", "keep;\n");
    const read = await m.getSieveScript("acc1", "anhourmail");
    expect(read?.state).toMatch(/^\d+$/);
    // A save in between moves the state on: the stale write is refused and the save stays.
    await m.putSieveScript("acc1", "anhourmail", "discard;\n");
    expect(await m.putSieveScriptIfUnchanged("acc1", "anhourmail", "upgraded;\n", read?.state ?? "")).toBe(false);
    expect((await m.getSieveScript("acc1", "anhourmail"))?.content).toBe("discard;\n");
    const now = await m.getSieveScript("acc1", "anhourmail");
    expect(await m.putSieveScriptIfUnchanged("acc1", "anhourmail", "upgraded;\n", now?.state ?? "")).toBe(true);
    expect(await m.getSieveScript("acc1", "anhourmail")).toMatchObject({ content: "upgraded;\n", active: true });
    expect(await m.putSieveScriptIfUnchanged("acc1", "anhourmail", "x;\n", "")).toBe(false); // never blind
  });

  it("saves a person's change only on the Sieve state it was read at, and still makes the script active", async () => {
    const s = sieveServer();
    const m = new StalwartManagement(transport(s.fetchImpl));
    // No script at the read: a create, unless one appeared meanwhile.
    expect(await m.putSieveScript("acc1", "anhourmail", "keep;\n", null)).toBe(true);
    expect(await m.putSieveScript("acc1", "anhourmail", "other;\n", null)).toBe(false);
    const read = await m.getSieveScript("acc1", "anhourmail");
    for (const x of s.scripts) x.isActive = false;
    expect(await m.putSieveScript("acc1", "anhourmail", "discard;\n", read?.state ?? "")).toBe(true);
    expect(await m.getSieveScript("acc1", "anhourmail")).toMatchObject({ content: "discard;\n", active: true });
    // The read is stale now: refused, and the saved text stays.
    expect(await m.putSieveScript("acc1", "anhourmail", "lost;\n", read?.state ?? "")).toBe(false);
    expect((await m.getSieveScript("acc1", "anhourmail"))?.content).toBe("discard;\n");
    expect(await m.putSieveScript("acc1", "anhourmail", "x;\n", "")).toBe(false);
    // Unconditional writes are unchanged.
    expect(await m.putSieveScript("acc1", "anhourmail", "keep;\n")).toBe(true);
  });

  it("creates new accounts locked even when the caller doesn't say", async () => {
    const s = sieveServer();
    const m = new StalwartManagement(transport(s.fetchImpl));
    await m.upsertUser({ name: "bob", domain: "a.test", password: "pw", quotaBytes: 1 });
    expect(s.created()?.permissions).toEqual(CUSTOMER_PERMISSIONS);
  });
});

describe("reporting the customer lock", () => {
  it("is locked with the customer or suspended permissions, open otherwise", async () => {
    const s = fakeServer({
      "x:Domain/get": () => ({ list: [{ id: "d1", name: "a.test" }] }),
      "x:Account/get": () => ({
        list: [
          { id: "1", name: "locked", domainId: "d1", permissions: CUSTOMER_PERMISSIONS },
          { id: "2", name: "suspended", domainId: "d1", permissions: SUSPENDED_PERMISSIONS },
          { id: "3", name: "open", domainId: "d1", permissions: { "@type": "Inherit" } },
          {
            id: "4",
            name: "partial",
            domainId: "d1",
            permissions: { "@type": "Merge", disabledPermissions: { sieveAuthenticate: true } },
          },
        ],
      }),
    });
    const users = await new StalwartManagement(transport(s.fetchImpl)).listUsers();
    expect(users.map((u) => [u.address.split("@")[0], u.sieveLocked])).toEqual([
      ["locked", true],
      ["suspended", true],
      ["open", false],
      ["partial", false],
    ]);
  });
});

describe("isOverQuotaError", () => {
  it("is true only for a /set refusal of type overQuota", () => {
    const refusal = (type: string) => new StalwartError("x:AppPassword/set notCreated", "set", { h: { type } });
    expect(isOverQuotaError(refusal("overQuota"))).toBe(true);
    expect(isOverQuotaError(refusal("invalidProperties"))).toBe(false);
    expect(isOverQuotaError(new StalwartError("x", "set"))).toBe(false);
    expect(isOverQuotaError(new StalwartError("x", "http", { h: { type: "overQuota" } }))).toBe(false);
    expect(isOverQuotaError(new Error("overQuota"))).toBe(false);
  });
});
