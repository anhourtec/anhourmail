// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  appPasswordPermissions,
  isAppPasswordSecret,
  KNOWN_PERMISSIONS,
  PRINCIPAL_READ_PERMISSIONS,
  SCOPE_ALLOW,
  scopesOf,
  SELF_SERVICE_PERMISSIONS,
} from "./app-passwords";
import { StalwartError, StalwartTransport } from "./client";
import { CUSTOMER_PERMISSIONS, StalwartManagement, SUSPENDED_PERMISSIONS } from "./management";

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
