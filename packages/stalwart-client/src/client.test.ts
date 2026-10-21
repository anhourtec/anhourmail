// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartError, StalwartTransport } from "./client";
import { StalwartManagement } from "./management";

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
    await expect(m.upsertUser({ name: "x", domain: "missing.test", password: "p", quotaBytes: 1 })).rejects.toThrow(
      /Unknown domain/,
    );
    expect(await m.ensureTenant("acct")).toBeNull();
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
