// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HANDOFF_CREDENTIAL_DESCRIPTION,
  handoffCredentialPermissions,
  SELF_SERVICE_PERMISSIONS,
} from "./app-passwords";
import { StalwartError, StalwartTransport } from "./client";
import {
  hasStalwartCredential,
  stalwartAudit,
  stalwartDevAdmin,
  stalwartOperations,
  stalwartProvisioning,
  verifyStalwartCredential,
} from "./index";
import {
  AUDIT_KEY_PERMISSIONS,
  credentialEnvProblems,
  credentialScopeProblems,
  CUSTOMER_EFFECTIVE_PERMISSIONS,
  OPERATIONS_KEY_PERMISSIONS,
  PROVISIONING_KEY_PERMISSIONS,
  SERVICE_CREDENTIALS,
  USER_ROLE_PERMISSIONS,
} from "./keys";
import { CUSTOMER_PERMISSIONS, StalwartManagement } from "./management";
import {
  ensureServiceAccount,
  ensureServiceRole,
  issueServiceKey,
  listServiceKeys,
  serviceAccountProblems,
  serviceRoleDescription,
} from "./service-accounts";

type Handler = (args: Record<string, unknown>) => unknown;
type Seen = { name: string; args: Record<string, unknown> };

/** A fake Stalwart: JMAP from handlers, `/api/account` answering `permissions`; records the calls. */
function fake(handlers: Record<string, Handler>, permissions: string[] | number = []) {
  const seen: Seen[] = [];
  const auth: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    if (url.endsWith("/api/account")) {
      return typeof permissions === "number"
        ? new Response("", { status: permissions })
        : Response.json({ permissions });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      seen.push({ name, args });
      const h = handlers[name];
      return h ? [name, h(args), id] : ["error", { type: "unknownMethod" }, id];
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  const mgmt = new StalwartManagement(
    new StalwartTransport({ baseUrl: "http://s", auth: { type: "bearer", token: "k" }, fetch: fetchImpl }),
  );
  return { mgmt, seen, auth };
}

describe("key permission sets", () => {
  it("gives the provisioning key the directory and what a customer keeps, and never impersonate", () => {
    expect(USER_ROLE_PERMISSIONS).toHaveLength(239);
    expect(CUSTOMER_EFFECTIVE_PERMISSIONS).toHaveLength(186);
    const p = new Set(PROVISIONING_KEY_PERMISSIONS);
    for (const n of ["authenticate", "sysAccountCreate", "sysDomainDestroy", "sysDkimSignatureUpdate", "emailSend"]) {
      expect(p.has(n)).toBe(true);
    }
    for (const n of [
      "impersonate",
      "sysAppPasswordCreate",
      "sysApiKeyGet",
      "jmapSieveScriptCreate",
      "sieveAuthenticate",
    ]) {
      expect(p.has(n)).toBe(false);
    }
    // Every denial on a customer account is left out (disabling needs nothing), self-service included.
    for (const n of [...Object.keys(CUSTOMER_PERMISSIONS.disabledPermissions), ...SELF_SERVICE_PERMISSIONS]) {
      expect(p.has(n)).toBe(false);
    }
    expect(PROVISIONING_KEY_PERMISSIONS).toHaveLength(1 + 15 + 186 - 1); // `authenticate` is also a customer one
  });

  it("keeps account and domain writes off the operations key and everything but reads off the audit key", () => {
    expect(OPERATIONS_KEY_PERMISSIONS).toHaveLength(15);
    expect(OPERATIONS_KEY_PERMISSIONS.filter((n) => /^sys(Account|Domain|Dkim)/.test(n))).toEqual([]);
    expect(OPERATIONS_KEY_PERMISSIONS.filter((n) => /^jmap(Email|Mailbox)|BlobLookup/.test(n))).toEqual([]);
    expect([...AUDIT_KEY_PERMISSIONS]).toEqual([
      "authenticate",
      "impersonate",
      "jmapBlobGet",
      "jmapSieveScriptGet",
      "jmapSieveScriptQuery",
    ]);
    expect(Object.values(SERVICE_CREDENTIALS).map((c) => c.account)).toEqual(["svc-provision", "svc-ops", "svc-audit"]);
  });
});

describe("credentialEnvProblems", () => {
  const prod = { NODE_ENV: "production" };
  it("requires the process's own key in production and refuses the others", () => {
    expect(credentialEnvProblems(["operations"], { ...prod, STALWART_OPERATIONS_KEY: "k" })).toEqual([]);
    expect(credentialEnvProblems(["operations"], prod)).toEqual(["STALWART_OPERATIONS_KEY must be set in production"]);
    expect(
      credentialEnvProblems(["operations"], {
        ...prod,
        STALWART_OPERATIONS_KEY: "k",
        STALWART_PROVISIONING_KEY: "p",
        STALWART_AUDIT_KEY: "a",
        STALWART_DEV_ADMIN_USER: "admin",
        STALWART_DEV_ADMIN_PASSWORD: "pw",
      }),
    ).toEqual([
      "STALWART_PROVISIONING_KEY must not be given to this process (only to the worker and scheduler)",
      "STALWART_AUDIT_KEY must not be given to this process (only to the scheduler)",
      "STALWART_DEV_ADMIN_USER is for development only",
      "STALWART_DEV_ADMIN_PASSWORD is for development only",
    ]);
  });

  it("allows optional keys, ignores blanks, and refuses the legacy single key everywhere", () => {
    const env = { ...prod, STALWART_PROVISIONING_KEY: "p", STALWART_AUDIT_KEY: "a", STALWART_OPERATIONS_KEY: " " };
    expect(credentialEnvProblems(["provisioning"], env, ["audit"])).toEqual([]);
    expect(credentialEnvProblems(["provisioning"], { STALWART_API_KEY: "old" })).toEqual([
      "STALWART_API_KEY is no longer used: set STALWART_PROVISIONING_KEY instead",
    ]);
    // Development: one .env serves every process, so other keys and the dev admin are fine.
    expect(
      credentialEnvProblems(["operations"], { STALWART_PROVISIONING_KEY: "p", STALWART_DEV_ADMIN_USER: "a" }),
    ).toEqual([]);
  });
});

describe("credentialScopeProblems", () => {
  it("accepts exactly the set and names what is extra or missing", () => {
    expect(credentialScopeProblems("audit", [...AUDIT_KEY_PERMISSIONS].reverse())).toEqual([]);
    expect(credentialScopeProblems("provisioning", [...PROVISIONING_KEY_PERMISSIONS, "impersonate"])).toEqual([
      "STALWART_PROVISIONING_KEY holds permissions outside its set: impersonate",
    ]);
    const missing = credentialScopeProblems("operations", ["authenticate"]);
    expect(missing).toEqual([
      "STALWART_OPERATIONS_KEY lacks permissions of its set: impersonate, jmapBlobGet, jmapBlobUpload, jmapSieveScriptCreate, jmapSieveScriptGet, jmapSieveScriptQuery, jmapSieveScriptUpdate, jmapSieveScriptValidate and 6 more",
    ]);
  });
});

describe("credentials on x:Account", () => {
  const credentials = {
    "0": { "@type": "Password", credentialId: "a" },
    "1": {
      "@type": "AppPassword",
      credentialId: "b",
      createdAt: "2026-10-22T10:00:00Z",
      permissions: { "@type": "Disable" },
    },
    "2": { "@type": "ApiKey", credentialId: "c", createdAt: "2026-10-22T10:00:01Z" },
    "3": { "@type": "AppPassword", credentialId: "d", createdAt: "2026-10-22T10:00:02Z" },
    // A console → webmail handoff credential in flight (ADR-0024): not an app password anyone holds.
    "4": {
      "@type": "AppPassword",
      credentialId: "e",
      description: HANDOFF_CREDENTIAL_DESCRIPTION,
      createdAt: "2026-10-22T10:00:03Z",
      expiresAt: "2026-10-22T10:01:03Z",
      permissions: handoffCredentialPermissions(),
    },
  };

  it("lists app passwords and counts API keys without owner access", async () => {
    const { mgmt, seen } = fake({ "x:Account/get": () => ({ list: [{ id: "km", credentials }] }) });
    expect(await mgmt.credentialInventory("km")).toEqual({
      appPasswords: [
        { id: "b", createdAt: new Date("2026-10-22T10:00:00Z"), permissions: { "@type": "Disable" } },
        { id: "d", createdAt: new Date("2026-10-22T10:00:02Z"), permissions: undefined },
      ],
      handoffCredentials: 1,
      apiKeys: 1,
      passwords: [{ id: "a" }],
    });
    expect(seen[0]).toEqual({ name: "x:Account/get", args: { ids: ["km"], properties: ["credentials"] } });
    const none = fake({ "x:Account/get": () => ({ list: [] }) });
    await expect(none.mgmt.credentialInventory("gone")).rejects.toBeInstanceOf(StalwartError);
    const empty = fake({ "x:Account/get": () => ({ list: [{ id: "km" }] }) });
    expect(await empty.mgmt.credentialInventory("km")).toEqual({
      appPasswords: [],
      handoffCredentials: 0,
      apiKeys: 0,
      passwords: [],
    });
  });

  it("revokes one app password by id and creation time through a patch of its position", async () => {
    let current: Record<string, unknown> = { ...credentials };
    const { mgmt, seen } = fake({
      "x:Account/get": () => ({ list: [{ id: "km", credentials: current }] }),
      "x:Account/set": (args) => {
        const patch = (args.update as Record<string, Record<string, unknown>>).km ?? {};
        const removed = new Set(Object.keys(patch).map((k) => k.replace("credentials/", "")));
        current = Object.fromEntries(Object.entries(current).filter(([k]) => !removed.has(k)));
        return { updated: { km: null } };
      },
    });
    expect(await mgmt.revokeAppPasswordCredential("km", "d", new Date("2026-10-22T10:00:02.400Z"))).toBe(true);
    expect(seen.find((s) => s.name === "x:Account/set")?.args).toEqual({ update: { km: { "credentials/3": null } } });
    // Already gone, another creation time (an id reused), or not an app password: nothing is touched.
    expect(await mgmt.revokeAppPasswordCredential("km", "d", new Date("2026-10-22T10:00:02Z"))).toBe(false);
    expect(await mgmt.revokeAppPasswordCredential("km", "b", new Date("2026-10-22T11:00:00Z"))).toBe(false);
    expect(await mgmt.revokeAppPasswordCredential("km", "c", new Date("2026-10-22T10:00:01Z"))).toBe(false);
    expect(seen.filter((s) => s.name === "x:Account/set")).toHaveLength(1);
  });

  it("fails loudly when the revocation didn't take or took something else with it", async () => {
    const stuck = fake({
      "x:Account/get": () => ({ list: [{ id: "km", credentials }] }),
      "x:Account/set": () => ({ updated: { km: null } }),
    });
    await expect(stuck.mgmt.revokeAppPasswordCredential("km", "b", new Date("2026-10-22T10:00:00Z"))).rejects.toThrow(
      /still there/,
    );
    let calls = 0;
    const shifted = fake({
      // A credential was removed in between: the patch hit the wrong position.
      "x:Account/get": () => ({
        list: [
          { id: "km", credentials: calls++ === 0 ? credentials : { "0": credentials["0"], "1": credentials["1"] } },
        ],
      }),
      "x:Account/set": () => ({ updated: { km: null } }),
    });
    await expect(shifted.mgmt.revokeAppPasswordCredential("km", "b", new Date("2026-10-22T10:00:00Z"))).rejects.toThrow(
      /still there/,
    );
    calls = 0;
    const lost = fake({
      "x:Account/get": () => ({
        list: [
          { id: "km", credentials: calls++ === 0 ? credentials : { "0": credentials["0"], "2": credentials["2"] } },
        ],
      }),
      "x:Account/set": () => ({ updated: { km: null } }),
    });
    await expect(lost.mgmt.revokeAppPasswordCredential("km", "b", new Date("2026-10-22T10:00:00Z"))).rejects.toThrow(
      /Another credential/,
    );
    // A handoff credential that comes and goes meanwhile (ADR-0024) is not "another credential".
    calls = 0;
    const handoff = fake({
      "x:Account/get": () => ({
        list: [
          {
            id: "km",
            credentials:
              calls++ === 0 ? credentials : { "0": credentials["0"], "2": credentials["2"], "3": credentials["3"] },
          },
        ],
      }),
      "x:Account/set": () => ({ updated: { km: null } }),
    });
    expect(await handoff.mgmt.revokeAppPasswordCredential("km", "b", new Date("2026-10-22T10:00:00Z"))).toBe(true);
  });

  it("asks Stalwart what the credential can do", async () => {
    expect(await fake({}, ["authenticate", "sysDomainGet"]).mgmt.credentialPermissions()).toEqual([
      "authenticate",
      "sysDomainGet",
    ]);
    await expect(fake({}, 401).mgmt.credentialPermissions()).rejects.toMatchObject({ kind: "http" });
    const odd = fake({});
    const t = new StalwartTransport({
      baseUrl: "http://s",
      auth: { type: "bearer", token: "k" },
      fetch: async () => Response.json({ edition: "community" }),
    });
    await expect(t.credentialPermissions()).rejects.toThrow(/no permissions/);
    expect(odd.mgmt.transport.authType).toBe("bearer");
  });
});

describe("service accounts", () => {
  type State = {
    roles: {
      id: string;
      description: string;
      enabledPermissions: Record<string, boolean>;
      disabledPermissions?: Record<string, boolean>;
      roleIds?: Record<string, boolean>;
    }[];
    accounts: {
      id: string;
      name: string;
      domainId: string;
      roles?: unknown;
      permissions?: unknown;
      credentials?: Record<string, { "@type": string }>;
    }[];
    keys: {
      id: string;
      description: string;
      createdAt: string;
      permissions?: unknown;
      allowedIps?: Record<string, boolean>;
    }[];
  };
  function server(state: State) {
    let n = 0;
    return fake({
      "x:Role/get": () => ({ list: state.roles }),
      "x:Role/set": (args) => {
        const create = args.create as Record<string, State["roles"][number]> | undefined;
        if (create?.r) {
          state.roles.push({ ...create.r, id: `r${String(++n)}` });
          return { created: { r: { id: `r${String(n)}` } } };
        }
        const update = args.update as Record<string, Partial<State["roles"][number]>>;
        for (const [id, f] of Object.entries(update)) Object.assign(state.roles.find((r) => r.id === id) ?? {}, f);
        return { updated: update };
      },
      "x:Account/get": () => ({ list: state.accounts }),
      "x:Account/set": (args) => {
        const create = args.create as Record<string, State["accounts"][number]> | undefined;
        if (create?.s) {
          state.accounts.push({ ...create.s, id: `a${String(++n)}` });
          return { created: { s: { id: `a${String(n)}` } } };
        }
        const update = args.update as Record<string, Partial<State["accounts"][number]>>;
        for (const [id, f] of Object.entries(update)) Object.assign(state.accounts.find((a) => a.id === id) ?? {}, f);
        return { updated: update };
      },
      "x:ApiKey/get": () => ({ list: state.keys }),
      "x:ApiKey/set": (args) => {
        const k = (args.create as { k: State["keys"][number] }).k;
        state.keys.push({ ...k, id: `k${String(++n)}`, createdAt: `2026-10-2${String(n)}T00:00:00Z` });
        return { created: { k: { id: `k${String(n)}`, secret: "the-secret" } } };
      },
    });
  }
  const flags = (names: readonly string[]) => Object.fromEntries(names.map((x) => [x, true]));

  it("creates the custom role, the password-less account and a key carrying exactly the set", async () => {
    const state: State = { roles: [], accounts: [], keys: [] };
    const { mgmt, seen } = server(state);
    const { id, created } = await ensureServiceAccount(mgmt, "operations", "d1");
    expect(created).toBe(true);
    const roleId = state.roles[0]?.id ?? "";
    expect(state.roles[0]).toMatchObject({ description: "anhourmail svc-ops", disabledPermissions: {}, roleIds: {} });
    expect(Object.keys(state.roles[0]?.enabledPermissions ?? {}).sort()).toEqual([...OPERATIONS_KEY_PERMISSIONS]);
    expect(state.accounts[0]).toMatchObject({
      name: "svc-ops",
      domainId: "d1",
      credentials: {},
      roles: { "@type": "Custom", roleIds: { [roleId]: true } },
    });
    const secret = await issueServiceKey(mgmt, "operations", id, {
      description: "web",
      allowedIps: ["172.30.42.0/24"],
      expiresAt: new Date("2027-01-01T00:00:00.123Z"),
    });
    expect(secret).toBe("the-secret");
    expect(seen.at(-1)?.args).toEqual({
      accountId: id,
      create: {
        k: {
          description: "web",
          permissions: { "@type": "Replace", permissions: flags(OPERATIONS_KEY_PERMISSIONS) },
          allowedIps: { "172.30.42.0/24": true },
          expiresAt: "2027-01-01T00:00:00Z",
        },
      },
    });
    // Second run: same role and account, role corrected if someone changed it, credentials never written.
    state.roles[0] = {
      ...(state.roles[0] ?? { id: roleId, description: "" }),
      enabledPermissions: { impersonate: true },
    };
    state.accounts[0] = {
      ...(state.accounts[0] ?? { id, name: "svc-ops", domainId: "d1" }),
      credentials: { "0": { "@type": "ApiKey" } },
    };
    expect(await ensureServiceAccount(mgmt, "operations", "d1")).toEqual({ id, created: false });
    expect(Object.keys(state.roles[0].enabledPermissions)).toHaveLength(15);
    const lastAccountSet = seen.filter((s) => s.name === "x:Account/set").at(-1)?.args as {
      update: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(lastAccountSet.update[id] ?? {})).toEqual(["roles", "description"]);
    expect(await ensureServiceRole(mgmt, "operations")).toBe(roleId);
    expect(await listServiceKeys(mgmt, id)).toEqual([
      { id: "k3", description: "web", createdAt: new Date("2026-10-23T00:00:00Z") },
    ]);
    expect(serviceRoleDescription("audit")).toBe("anhourmail svc-audit");
  });

  it("reports everything that makes a service account unsafe", async () => {
    const want = flags(AUDIT_KEY_PERMISSIONS);
    const state: State = {
      roles: [{ id: "r1", description: "anhourmail svc-audit", enabledPermissions: want, disabledPermissions: {} }],
      accounts: [
        {
          id: "a1",
          name: "svc-audit",
          domainId: "d1",
          roles: { "@type": "Custom", roleIds: { r1: true } },
          credentials: { "0": { "@type": "ApiKey" } },
        },
      ],
      keys: [
        {
          id: "k1",
          description: "",
          createdAt: "",
          permissions: { "@type": "Replace", permissions: want },
          allowedIps: { "10.0.0.0/8": true },
        },
      ],
    };
    const { mgmt } = server(state);
    expect(await serviceAccountProblems(mgmt, "audit", "d1", { allowedIps: ["10.0.0.0/8"], maxKeys: 1 })).toEqual([]);
    expect(await serviceAccountProblems(mgmt, "operations", "d1")).toEqual(["svc-ops: missing"]);

    const account = state.accounts[0];
    if (!account) throw new Error("fixture");
    account.roles = { "@type": "Admin" };
    account.permissions = { "@type": "Merge" };
    account.credentials = { "0": { "@type": "Password" }, "1": { "@type": "AppPassword" }, "2": { "@type": "ApiKey" } };
    state.keys.push({ id: "k2", description: "", createdAt: "", permissions: { "@type": "Inherit" } });
    expect(await serviceAccountProblems(mgmt, "audit", "d1", { allowedIps: ["10.0.0.0/8"], maxKeys: 1 })).toEqual([
      'svc-audit: role is {"@type":"Admin"}, expected its custom role only',
      "svc-audit: account-level permissions",
      "svc-audit: has a password",
      "svc-audit: has an app password",
      "svc-audit: 2 API keys (prune)",
      "svc-audit: API key list mismatch",
      "svc-audit: key k2 doesn't carry exactly its set",
      "svc-audit: key k2 allowedIps differ",
    ]);
    account.roles = { "@type": "Custom", roleIds: { r1: true } };
    const role = state.roles[0];
    if (role) role.enabledPermissions = { ...want, jmapEmailGet: true };
    state.keys = [];
    account.permissions = undefined;
    account.credentials = {};
    expect(await serviceAccountProblems(mgmt, "audit", "d1")).toEqual([
      "svc-audit: its role doesn't hold exactly the key's permissions",
      "svc-audit: no API key",
    ]);
  });
});

describe("credential factories", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { amStalwart?: unknown }).amStalwart;
  });
  const stub = (env: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries({
      STALWART_URL: "http://stalwart:8080",
      NODE_ENV: "test",
      STALWART_PROVISIONING_KEY: undefined,
      STALWART_OPERATIONS_KEY: undefined,
      STALWART_AUDIT_KEY: undefined,
      STALWART_API_KEY: undefined,
      STALWART_DEV_ADMIN_USER: undefined,
      STALWART_DEV_ADMIN_PASSWORD: undefined,
      ...env,
    })) {
      vi.stubEnv(k, v);
    }
  };

  it("uses each process's own key, and the dev admin only outside production", () => {
    stub({ STALWART_PROVISIONING_KEY: "p", STALWART_DEV_ADMIN_USER: "admin", STALWART_DEV_ADMIN_PASSWORD: "pw" });
    expect(stalwartProvisioning().transport.authType).toBe("bearer");
    expect(stalwartProvisioning()).toBe(stalwartProvisioning());
    expect(stalwartOperations().transport.authType).toBe("basic");
    expect(stalwartAudit().transport.authType).toBe("basic");
    expect(stalwartDevAdmin()).toBe(stalwartDevAdmin());
    expect(hasStalwartCredential("audit")).toBe(true);
  });

  it("refuses production without the key, the dev admin in production, and the legacy key", () => {
    stub({ NODE_ENV: "production", STALWART_DEV_ADMIN_USER: "admin", STALWART_DEV_ADMIN_PASSWORD: "pw" });
    expect(() => stalwartOperations()).toThrow(/STALWART_OPERATIONS_KEY must be set in production/);
    expect(() => stalwartDevAdmin()).toThrow(/never used in production/);
    expect(hasStalwartCredential("audit")).toBe(false);
    stub({ NODE_ENV: "production", STALWART_AUDIT_KEY: "a" });
    expect(hasStalwartCredential("audit")).toBe(true);
    stub({ STALWART_API_KEY: "old", STALWART_DEV_ADMIN_USER: "admin", STALWART_DEV_ADMIN_PASSWORD: "pw" });
    expect(() => stalwartProvisioning()).toThrow(/STALWART_API_KEY is no longer used/);
    stub({});
    expect(() => stalwartAudit()).toThrow(/Set STALWART_AUDIT_KEY/);
    expect(() => stalwartDevAdmin()).toThrow(/STALWART_DEV_ADMIN_USER/);
    stub({ STALWART_URL: undefined, STALWART_PROVISIONING_KEY: "p" });
    expect(() => stalwartProvisioning()).toThrow(/STALWART_URL/);
  });

  it("verifies a key's scope against Stalwart and skips the dev admin", async () => {
    expect(await verifyStalwartCredential("audit", fake({}, [...AUDIT_KEY_PERMISSIONS]).mgmt)).toBe("key");
    await expect(
      verifyStalwartCredential("provisioning", fake({}, [...PROVISIONING_KEY_PERMISSIONS, "impersonate"]).mgmt),
    ).rejects.toThrow(/outside its set: impersonate/);
    const admin = new StalwartManagement(
      new StalwartTransport({ baseUrl: "http://s", auth: { type: "basic", username: "a", password: "b" } }),
    );
    expect(await verifyStalwartCredential("operations", admin)).toBe("dev-admin");
  });
});
