// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  appPasswordPermissions,
  HANDOFF_CREDENTIAL_DESCRIPTION,
  HANDOFF_CREDENTIAL_MAX_LIFETIME_MS,
  handoffCredentialPermissions,
  isAppPasswordSecret,
  isHandoffCredential,
  KNOWN_PERMISSIONS,
  PRINCIPAL_READ_PERMISSIONS,
  SCOPE_ALLOW,
  scopesOf,
  SELF_SERVICE_PERMISSIONS,
} from "./app-passwords";
import { StalwartError, StalwartTransport } from "./client";
import {
  CUSTOMER_PERMISSIONS,
  FILE_STORAGE_PERMISSIONS,
  StalwartManagement,
  SUSPENDED_PERMISSIONS,
} from "./management";

type Seen = { name: string; args: Record<string, unknown> };

function management(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
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
  return { mgmt, seen };
}

const offOf = (scopes: Parameters<typeof appPasswordPermissions>[0]) =>
  Object.keys(appPasswordPermissions(scopes).permissions);
/** What stays on for a credential: every known permission minus the ones turned off. */
const onOf = (scopes: Parameters<typeof appPasswordPermissions>[0]) => {
  const off = new Set(offOf(scopes));
  return KNOWN_PERMISSIONS.filter((p) => !off.has(p));
};

describe("app password permissions", () => {
  it("works as an allow-list: only authenticate plus the scopes' permissions stay on", () => {
    expect(onOf([])).toEqual(["authenticate"]);
    expect(onOf(["smtp"]).sort()).toEqual(["authenticate", "emailSend"]);
    expect(onOf(["imap"])).toContain("imapFetch");
    expect(onOf(["imap"])).not.toContain("imapAclSet");
    for (const p of SELF_SERVICE_PERMISSIONS) expect(offOf(["imap", "pop3", "smtp", "jmap", "dav"])).toContain(p);
  });

  it("never allows Sieve, principal look-ups, sharing, alias sign-in, invitations by mail or admin work", () => {
    const on = onOf(["imap", "pop3", "smtp", "jmap", "dav"]);
    for (const p of [
      "sieveAuthenticate",
      "jmapSieveScriptCreate",
      "jmapSieveScriptUpdate",
      "jmapVacationResponseUpdate",
      "jmapIdentityUpdate",
      "imapAclSet",
      "davCardAcl",
      "davPrincipalSearch",
      "authenticateWithAlias",
      "calendarSchedulingSend",
      "impersonate",
      "fetchAnyBlob",
      ...PRINCIPAL_READ_PERMISSIONS,
    ]) {
      expect(on).not.toContain(p);
    }
  });

  it("keeps contacts and calendars apart from mail over HTTPS", () => {
    const dav = onOf(["dav"]);
    expect(dav).toEqual(
      expect.arrayContaining(["davCardPropFind", "davCalPut", "jmapContactCardGet", "jmapCalendarGet"]),
    );
    for (const p of dav) expect(p).not.toMatch(/^jmap(Email|Mailbox|Thread|SearchSnippet|Blob|FileNode)|^davFile/);
    const jmap = onOf(["jmap"]);
    expect(jmap).toEqual(expect.arrayContaining(["jmapEmailQuery", "jmapEmailSubmissionCreate", "emailSend"]));
    for (const p of jmap) expect(p).not.toMatch(/^dav|^jmap(ContactCard|AddressBook|Calendar)|^jmapBlobLookup$/);
    // Nothing that can carry `shareWith`.
    for (const p of [...dav, ...jmap]) expect(p).not.toMatch(/^jmap(Mailbox|AddressBook|Calendar)(Create|Update)$/);
    expect(SCOPE_ALLOW.dav.every((p) => KNOWN_PERMISSIONS.includes(p))).toBe(true);
  });

  it("reads a credential's permissions back into its scopes, and nothing else", () => {
    expect(scopesOf(appPasswordPermissions(["imap", "dav"]))).toEqual(["imap", "dav"]);
    expect(scopesOf(appPasswordPermissions(["smtp"]))).toEqual(["smtp"]);
    expect(scopesOf({ "@type": "Inherit" })).toBeNull();
    // The server may list the names in another order.
    const reordered = appPasswordPermissions(["pop3"]);
    const reversed = {
      "@type": reordered["@type"],
      permissions: Object.fromEntries(Object.entries(reordered.permissions).reverse()),
    };
    expect(scopesOf(reversed)).toEqual(["pop3"]);
    expect(scopesOf(null)).toBeNull();
    expect(scopesOf(appPasswordPermissions([]))).toBeNull();
  });

  it("turns off self-service and principal look-ups on every customer account", () => {
    const customer: Record<string, boolean> = CUSTOMER_PERMISSIONS.disabledPermissions;
    const suspended: Record<string, boolean> = SUSPENDED_PERMISSIONS.disabledPermissions;
    for (const p of [...SELF_SERVICE_PERMISSIONS, ...PRINCIPAL_READ_PERMISSIONS]) {
      expect(customer[p]).toBe(true);
      expect(suspended[p]).toBe(true);
    }
  });

  it("turns off file storage (JMAP FileNode and WebDAV files) on every account, and leaves attachments alone", () => {
    const customer: Record<string, boolean> = CUSTOMER_PERMISSIONS.disabledPermissions;
    const suspended: Record<string, boolean> = SUSPENDED_PERMISSIONS.disabledPermissions;
    // Every file permission the server knows, not a hand-picked few (an upgrade adding one fails here).
    const known = KNOWN_PERMISSIONS.filter((p) => /^jmapFileNode|^davFile/.test(p));
    expect([...FILE_STORAGE_PERMISSIONS].sort()).toEqual(known.sort());
    expect(known).toHaveLength(18);
    for (const p of known) {
      expect(customer[p]).toBe(true);
      expect(suspended[p]).toBe(true);
    }
    // Share notifications (who shared what) are off too.
    for (const p of KNOWN_PERMISSIONS.filter((n) => n.startsWith("jmapShareNotification")))
      expect(customer[p]).toBe(true);
    // Email blobs (attachments), mail import and sending are separate permissions and stay on.
    for (const p of [
      "jmapBlobUpload",
      "jmapBlobGet",
      "jmapBlobCopy",
      "jmapEmailImport",
      "jmapEmailCreate",
      "emailSend",
    ]) {
      expect(p in customer).toBe(false);
    }
    // No app password scope allows them either.
    for (const scope of ["imap", "pop3", "smtp", "jmap", "dav"] as const) {
      expect(SCOPE_ALLOW[scope].filter((p) => known.includes(p))).toEqual([]);
    }
  });

  it("reports drift (sieveLocked false) for an account locked down before file storage was denied", async () => {
    const before = Object.fromEntries(
      Object.keys(CUSTOMER_PERMISSIONS.disabledPermissions)
        .filter((p) => !/^jmapFileNode|^davFile(?!Acl)/.test(p))
        .map((p) => [p, true] as const),
    );
    const { mgmt } = management({
      "x:Domain/get": () => ({ list: [{ id: "d", name: "x.test" }] }),
      "x:Account/get": () => ({
        list: [
          { id: "a", name: "now", domainId: "d", permissions: CUSTOMER_PERMISSIONS },
          { id: "b", name: "before", domainId: "d", permissions: { "@type": "Merge", disabledPermissions: before } },
        ],
      }),
    });
    expect((await mgmt.listUsers()).map((u) => [u.address, u.sieveLocked])).toEqual([
      ["now@x.test", true],
      ["before@x.test", false],
    ]);
  });

  it("reports drift (sieveLocked false) when any of the whole denial list is missing, these included", async () => {
    const onlySieve = {
      sieveAuthenticate: true,
      jmapSieveScriptCreate: true,
      jmapSieveScriptUpdate: true,
      jmapVacationResponseUpdate: true,
    };
    const { mgmt } = management({
      "x:Domain/get": () => ({ list: [{ id: "d", name: "x.test" }] }),
      "x:Account/get": () => ({
        list: [
          { id: "a", name: "full", domainId: "d", permissions: CUSTOMER_PERMISSIONS },
          { id: "b", name: "old", domainId: "d", permissions: { "@type": "Merge", disabledPermissions: onlySieve } },
          { id: "c", name: "paused", domainId: "d", permissions: SUSPENDED_PERMISSIONS },
        ],
      }),
    });
    const users = await mgmt.listUsers();
    expect(users.map((u) => [u.address, u.sieveLocked])).toEqual([
      ["full@x.test", true],
      ["old@x.test", false],
      ["paused@x.test", true],
    ]);
  });

  it("refuses anything starting like an app password, whatever follows", () => {
    expect(isAppPasswordSecret(`app_${"abc123def4".repeat(3)}xyz789`)).toBe(true);
    expect(isAppPasswordSecret(`app_${"a".repeat(36)}$123456`)).toBe(true);
    expect(isAppPasswordSecret(" APP_short")).toBe(true);
    expect(isAppPasswordSecret("correct horse battery staple")).toBe(false);
    expect(isAppPasswordSecret(`apps_${"a".repeat(36)}`)).toBe(false);
  });
});

describe("StalwartManagement app passwords", () => {
  it("creates one on another account with its limits, then reads its creation time", async () => {
    const { mgmt, seen } = management({
      "x:AppPassword/set": () => ({ created: { a: { id: "b", secret: "app_secret" } } }),
      "x:AppPassword/get": () => ({ list: [{ id: "b", description: "Phone", createdAt: "2026-10-22T11:40:37Z" }] }),
    });
    const out = await mgmt.createAppPassword("km", { description: "Phone", scopes: ["imap", "smtp"] });
    expect(out).toEqual({
      id: "b",
      description: "Phone",
      createdAt: new Date("2026-10-22T11:40:37Z"),
      secret: "app_secret",
    });
    const set = seen[0]?.args as { accountId: string; create: { a: { permissions: unknown } } };
    expect(set.accountId).toBe("km");
    expect(set.create.a.permissions).toEqual(appPasswordPermissions(["imap", "smtp"]));
    expect(seen[1]).toEqual({
      name: "x:AppPassword/get",
      args: { ids: ["b"], properties: ["description", "createdAt"], accountId: "km" },
    });
  });

  it("fails loudly when the server returns no secret or loses the new credential", async () => {
    const noSecret = management({ "x:AppPassword/set": () => ({ created: { a: { id: "b" } } }) });
    await expect(noSecret.mgmt.createAppPassword("km", { description: "x", scopes: [] })).rejects.toBeInstanceOf(
      StalwartError,
    );
    const gone = management({
      "x:AppPassword/set": () => ({ created: { a: { id: "b", secret: "s" } } }),
      "x:AppPassword/get": () => ({ list: [] }),
    });
    await expect(gone.mgmt.createAppPassword("km", { description: "x", scopes: [] })).rejects.toThrow(/vanished/);
  });

  it("lists and destroys on the given account", async () => {
    const { mgmt, seen } = management({
      "x:AppPassword/get": () => ({ list: [{ id: "c" }] }),
      "x:AppPassword/set": () => ({ destroyed: ["c"] }),
    });
    expect(await mgmt.listAppPasswords("km")).toEqual([{ id: "c", description: "", createdAt: new Date(0) }]);
    expect(await mgmt.appPassword("km", "c")).toMatchObject({ id: "c" });
    await mgmt.destroyAppPassword("km", "c");
    expect(seen.at(-1)).toEqual({ name: "x:AppPassword/set", args: { accountId: "km", destroy: ["c"] } });
  });
});

describe("handoff credential (ADR-0024)", () => {
  const at = new Date("2026-10-29T12:00:00Z");
  const handoff = (over: Record<string, unknown> = {}) => ({
    description: HANDOFF_CREDENTIAL_DESCRIPTION,
    permissions: handoffCredentialPermissions(),
    createdAt: at,
    expiresAt: new Date(at.getTime() + 60_000),
    ...over,
  });

  it("turns off every known and self-service permission but authenticate", () => {
    const off = Object.keys(handoffCredentialPermissions().permissions);
    expect(off).not.toContain("authenticate");
    for (const p of [...KNOWN_PERMISSIONS.filter((x) => x !== "authenticate"), ...SELF_SERVICE_PERMISSIONS]) {
      expect(off).toContain(p);
    }
    // Never mistaken for an app password with scopes (the reconciler would then accept it as one).
    expect(scopesOf(handoffCredentialPermissions())).toBeNull();
  });

  it("is recognised only with our description, exactly its permissions and a lifetime of two minutes or less", () => {
    expect(isHandoffCredential(handoff())).toBe(true);
    expect(
      isHandoffCredential(handoff({ expiresAt: new Date(at.getTime() + HANDOFF_CREDENTIAL_MAX_LIFETIME_MS) })),
    ).toBe(true);
    expect(isHandoffCredential(handoff({ description: "Phone" }))).toBe(false);
    expect(isHandoffCredential(handoff({ permissions: appPasswordPermissions(["imap"]) }))).toBe(false);
    expect(isHandoffCredential(handoff({ permissions: { "@type": "Inherit" } }))).toBe(false);
    expect(isHandoffCredential(handoff({ expiresAt: null }))).toBe(false);
    expect(isHandoffCredential(handoff({ createdAt: null }))).toBe(false);
    expect(isHandoffCredential(handoff({ expiresAt: new Date(at.getTime() + 3_600_000) }))).toBe(false);
    expect(isHandoffCredential(handoff({ expiresAt: at }))).toBe(false);
  });

  it("mints one expiring in whole seconds on the given account and returns its secret", async () => {
    const { mgmt, seen } = management({
      "x:AppPassword/set": () => ({ created: { h: { id: "f", secret: "app_secret" } } }),
    });
    expect(await mgmt.createHandoffCredential("km", 60_000, new Date("2026-10-29T12:00:00.250Z"))).toEqual({
      id: "f",
      secret: "app_secret",
    });
    expect(seen[0]).toEqual({
      name: "x:AppPassword/set",
      args: {
        accountId: "km",
        create: {
          h: {
            description: HANDOFF_CREDENTIAL_DESCRIPTION,
            expiresAt: "2026-10-29T12:01:01Z",
            permissions: handoffCredentialPermissions(),
          },
        },
      },
    });
    const none = management({ "x:AppPassword/set": () => ({ created: { h: { id: "f" } } }) });
    await expect(none.mgmt.createHandoffCredential("km", 60_000)).rejects.toBeInstanceOf(StalwartError);
  });

  it("clears only expired handoff credentials", async () => {
    const iso = (ms: number) => new Date(at.getTime() + ms).toISOString();
    const { mgmt, seen } = management({
      "x:AppPassword/get": () => ({
        list: [
          // expired handoff credential: goes
          {
            id: "a",
            description: HANDOFF_CREDENTIAL_DESCRIPTION,
            createdAt: iso(-120_000),
            expiresAt: iso(-60_000),
            permissions: handoffCredentialPermissions(),
          },
          // one still in flight: stays
          {
            id: "b",
            description: HANDOFF_CREDENTIAL_DESCRIPTION,
            createdAt: iso(-10_000),
            expiresAt: iso(50_000),
            permissions: handoffCredentialPermissions(),
          },
          // an app password someone holds, expired: not ours to remove here
          {
            id: "c",
            description: "Phone",
            createdAt: iso(-120_000),
            expiresAt: iso(-60_000),
            permissions: appPasswordPermissions(["imap"]),
          },
          // our description but other permissions: not a handoff credential
          {
            id: "d",
            description: HANDOFF_CREDENTIAL_DESCRIPTION,
            createdAt: iso(-120_000),
            expiresAt: iso(-60_000),
            permissions: { "@type": "Inherit" },
          },
        ],
      }),
      "x:AppPassword/set": () => ({ destroyed: ["a"] }),
    });
    expect(await mgmt.clearExpiredHandoffCredentials("km", at)).toBe(1);
    expect(seen[0]).toEqual({
      name: "x:AppPassword/get",
      args: { ids: null, properties: ["description", "createdAt", "expiresAt", "permissions"], accountId: "km" },
    });
    expect(seen[1]).toEqual({ name: "x:AppPassword/set", args: { accountId: "km", destroy: ["a"] } });
    const empty = management({ "x:AppPassword/get": () => ({ list: [] }) });
    expect(await empty.mgmt.clearExpiredHandoffCredentials("km", at)).toBe(0);
    expect(empty.seen).toHaveLength(1);
  });
});
