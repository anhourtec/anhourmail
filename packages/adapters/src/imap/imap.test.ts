// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The IMAP adapter's security-relevant settings without a network (the integration test runs it against the dev
 * server): what every client is configured with, the guard in front of every source connect, and that errors carry
 * our codes only. A stand-in client class records the options instead of connecting.
 */
import { describe, expect, it } from "vitest";

import { ImportConnectError, ImportSessionError } from "@anhourmail/core/imports";
import { parseDevAllowList, type Resolver } from "@anhourmail/server/net-guard";
import { IMPORT } from "@anhourmail/shared/import";

import { baseOptions, CLIENT_INFO, connectFailure, openImapClient, sessionFailure, sourceTarget } from "./connect";
import { destinationPath, foreignNamespaces, imapMailDestination, imapMailSource, toSourceFolder } from ".";

type Recorded = Record<string, unknown> & { tls?: Record<string, unknown> };

/** Records constructor options; `connect` succeeds or throws `fail`. */
function recorder(fail?: Error) {
  const seen: Recorded[] = [];
  let closed = 0;
  class FakeClient {
    usable = false;
    capabilities = new Map<string, unknown>();
    constructor(opts: Recorded) {
      seen.push(opts);
    }
    on() {
      return this;
    }
    once() {
      return this;
    }
    async connect() {
      if (fail !== undefined) throw fail;
    }
    async logout() {
      this.usable = false;
    }
    close() {
      closed += 1;
    }
  }
  return { seen, closedCount: () => closed, clientClass: FakeClient as never };
}

const resolver =
  (answers: Record<string, string[]>): Resolver =>
  async (host) =>
    (answers[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

const auth = { kind: "password" as const, username: "someone@example.org", secret: "app-password-123" };
const signal = () => AbortSignal.timeout(5000);

describe("IMAP client options", () => {
  it("never logs, never compresses or idles, sends only our name, and caps literals above one message", () => {
    const o = baseOptions({ maxMessageBytes: IMPORT.maxMessageBytes });
    expect(o).toMatchObject({
      logger: false,
      emitLogs: false,
      clientInfo: { name: "AnhourMail import" },
      disableAutoIdle: true,
      disableCompression: true,
      qresync: false,
    });
    expect(CLIENT_INFO).toEqual({ name: "AnhourMail import" });
    expect(o.maxLiteralSize).toBeGreaterThan(IMPORT.maxMessageBytes);
    expect(o.maxLiteralSize).toBeLessThan(IMPORT.maxMessageBytes * 2);
    expect(o.maxResponseSize).toBeGreaterThan(o.maxLiteralSize ?? 0);
    // No proxy or custom transport is ever configured.
    expect(o).not.toHaveProperty("proxy");
    expect(o).not.toHaveProperty("transport");
  });

  it("connects a source to the pinned public address with TLS verified against the typed name", async () => {
    const r = recorder();
    const source = imapMailSource({
      clientClass: r.clientClass,
      resolve: resolver({ "imap.example.org": ["93.184.215.14"] }),
    });
    const s = await source.connect({ host: "IMAP.example.org", port: 993 }, auth, signal());
    await s.close();
    expect(r.seen[0]).toMatchObject({
      host: "93.184.215.14",
      port: 993,
      secure: true,
      doSTARTTLS: false,
      servername: "imap.example.org",
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      auth: { user: "someone@example.org", pass: "app-password-123" },
      logger: false,
    });
    expect(r.closedCount()).toBe(1);
  });

  it("requires STARTTLS on 143 and leaves SNI out for an IP literal", async () => {
    const r = recorder();
    const source = imapMailSource({ clientClass: r.clientClass, resolve: resolver({}) });
    await (await source.connect({ host: "93.184.215.14", port: 143 }, auth, signal())).close();
    expect(r.seen[0]).toMatchObject({ host: "93.184.215.14", port: 143, secure: false, doSTARTTLS: true });
    expect(r.seen[0]).not.toHaveProperty("servername");
    expect(r.seen[0]?.tls?.rejectUnauthorized).toBe(true);
  });

  it("refuses private, internal and rebinding sources, and other ports, before any connection", async () => {
    const r = recorder();
    const source = imapMailSource({
      clientClass: r.clientClass,
      resolve: resolver({ "inside.example.org": ["10.0.0.5"], "mixed.example.org": ["93.184.215.14", "127.0.0.1"] }),
    });
    const cases: [string, number, string][] = [
      ["127.0.0.1", 993, "blocked_address"],
      ["169.254.169.254", 993, "blocked_address"],
      ["localhost", 993, "blocked_address"],
      ["stalwart", 993, "blocked_address"],
      ["inside.example.org", 993, "blocked_address"],
      ["mixed.example.org", 993, "blocked_address"],
      ["imap.example.org", 25, "bad_port"],
      ["imap.example.org", 995, "bad_port"],
      ["user@imap.example.org", 993, "bad_host"],
    ];
    const got: [string, number, string][] = [];
    for (const [host, port] of cases) {
      const err = await source.connect({ host, port: port as 993 }, auth, signal()).catch((e: unknown) => e);
      got.push([host, port, err instanceof ImportConnectError ? err.code : "not refused"]);
    }
    expect(got).toEqual(cases);
    expect(r.seen).toHaveLength(0);
  });

  it("skips certificate checks only for an exact dev allow-list entry", async () => {
    const allow = parseDevAllowList("127.0.0.1:993", { NODE_ENV: "test" }, "IMPORT_DEV_ALLOW_SOURCES");
    const target = await sourceTarget({ host: "127.0.0.1", port: 993 }, { allow }, signal());
    expect(target).toEqual({
      address: "127.0.0.1",
      port: 993,
      servername: "",
      verifyCertificate: false,
      implicitTls: true,
    });
    const other = await sourceTarget({ host: "127.0.0.1", port: 143 }, { allow }, signal()).catch((e: unknown) => e);
    expect((other as ImportConnectError).code).toBe("blocked_address");
  });

  it("checks our destination's certificate against the public name; the dev override is refused in production", async () => {
    const r = recorder();
    const dest = imapMailDestination({
      endpoint: { host: "stalwart", port: 993 },
      servername: "imap.example.org",
      clientClass: r.clientClass,
    });
    await (await dest.connect("dest@example.org", "app_secret", signal())).close();
    expect(r.seen[0]).toMatchObject({
      host: "stalwart",
      port: 993,
      secure: true,
      servername: "imap.example.org",
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
    expect(() =>
      imapMailDestination({
        endpoint: { host: "stalwart", port: 993 },
        servername: "imap.example.org",
        insecureDevCertificate: true,
        env: { NODE_ENV: "production" },
      }),
    ).toThrow(/development only/);
  });

  it("turns connect failures into codes and drops the server's text", async () => {
    const authFail = Object.assign(new Error("NO [AUTHENTICATIONFAILED] someone@example.org: bad password"), {
      authenticationFailed: true,
    });
    const r = recorder(authFail);
    const err = await openImapClient(
      {
        address: "93.184.215.14",
        port: 993,
        servername: "imap.example.org",
        verifyCertificate: true,
        implicitTls: true,
      },
      { user: "someone@example.org", pass: "x" },
      { maxMessageBytes: 1000, clientClass: r.clientClass },
      signal(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportConnectError);
    expect((err as Error).message).toBe("IMAP connect failed: auth");
    expect(r.closedCount()).toBe(1);

    expect(connectFailure(Object.assign(new Error("x"), { tlsFailed: true }))).toBe("tls_required");
    for (const code of [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_HAS_EXPIRED",
      "ERR_SSL_X",
    ]) {
      expect(connectFailure(Object.assign(new Error("x"), { code }))).toBe("certificate");
    }
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", undefined]) {
      expect(connectFailure(Object.assign(new Error("x"), { code }))).toBe("unreachable");
    }
    expect(connectFailure(null)).toBe("unreachable");
  });

  it("gives up at once when the caller already stopped", async () => {
    const r = recorder();
    const err = await openImapClient(
      { address: "93.184.215.14", port: 993, servername: "", verifyCertificate: true, implicitTls: true },
      { user: "u", pass: "p" },
      { maxMessageBytes: 1000, clientClass: r.clientClass },
      AbortSignal.abort(),
    ).catch((e: unknown) => e);
    expect((err as ImportConnectError).code).toBe("unreachable");
    expect(r.seen).toHaveLength(0);
  });

  it("turns session failures into codes", () => {
    expect(sessionFailure(Object.assign(new Error("NO x"), { responseStatus: "NO" }))).toEqual(
      new ImportSessionError("refused"),
    );
    expect(sessionFailure(Object.assign(new Error("BAD"), { responseStatus: "BAD" })).code).toBe("refused");
    expect(sessionFailure(Object.assign(new Error("t"), { code: "ETIMEOUT" })).code).toBe("timeout");
    expect(sessionFailure(new Error("closed")).code).toBe("dropped");
  });
});

describe("source folders", () => {
  const list = (over: Record<string, unknown>) =>
    ({ path: "X", delimiter: "/", flags: new Set<string>(), listed: true, subscribed: true, ...over }) as never;

  it("keeps the server's special use, a localized-name match, and nothing from our own hints", () => {
    expect(toSourceFolder(list({ specialUse: "\\Sent", specialUseSource: "extension" }))).toMatchObject({
      specialUse: "\\Sent",
      specialUseSource: "server",
    });
    expect(toSourceFolder(list({ specialUse: "\\Trash", specialUseSource: "name" }))).toMatchObject({
      specialUse: "\\Trash",
      specialUseSource: "name",
    });
    expect(toSourceFolder(list({ specialUse: "\\Junk", specialUseSource: "user" }))).toMatchObject({
      specialUse: null,
      specialUseSource: null,
    });
  });

  it("marks hierarchy-only folders and reads status values", () => {
    expect(toSourceFolder(list({ flags: new Set(["\\Noselect"]) })).selectable).toBe(false);
    expect(toSourceFolder(list({ flags: new Set(["\\NonExistent"]) })).selectable).toBe(false);
    expect(
      toSourceFolder(list({ delimiter: ".", status: { messages: 3, uidValidity: 7n, uidNext: 9, size: 1200 } })),
    ).toMatchObject({ delimiter: ".", messages: 3, uidValidity: 7n, uidNext: 9, sizeBytes: 1200, selectable: true });
    expect(toSourceFolder(list({ delimiter: "" }))).toMatchObject({ delimiter: "/", messages: null, sizeBytes: null });
  });
});

describe("destination paths", () => {
  it("splits on / and refuses empty levels, control characters and absurd depth before any command", () => {
    expect(destinationPath("Imported/Projects/2015")).toEqual(["Imported", "Projects", "2015"]);
    expect(destinationPath("Übersicht")).toEqual(["Übersicht"]);
    for (const bad of ["", "a//b", "/a", "a/", "a\r\nb", "a\u0000b", "x".repeat(256), Array(33).fill("a").join("/")]) {
      expect(() => destinationPath(bad)).toThrow(ImportSessionError);
    }
  });

  it("never writes under another namespace: Shared Folders (any case) or one the server announces", () => {
    for (const bad of ["Shared Folders", "shared folders/Team/Inbox", "SHARED FOLDERS/x"]) {
      expect(() => destinationPath(bad)).toThrow(ImportSessionError);
    }
    // A personal folder that merely starts with the same words is fine.
    expect(destinationPath("Shared Folders Archive")).toEqual(["Shared Folders Archive"]);
    const announced = foreignNamespaces({
      namespaces: {
        personal: [{ prefix: "", delimiter: "/" }],
        other: [{ prefix: "Other Users/", delimiter: "/" }],
        shared: [{ prefix: "Public/", delimiter: "/" }],
      },
    });
    expect(announced).toEqual(["Shared Folders", "Other Users/", "Public/"]);
    for (const bad of ["Other Users/kim/Inbox", "public/News"]) {
      expect(() => destinationPath(bad, announced)).toThrow(ImportSessionError);
    }
    expect(destinationPath("Publications", announced)).toEqual(["Publications"]);
    expect(foreignNamespaces({ namespaces: undefined })).toEqual(["Shared Folders"]);
    expect(foreignNamespaces({ namespaces: { personal: [], other: false, shared: false } })).toEqual([
      "Shared Folders",
    ]);
  });
});
