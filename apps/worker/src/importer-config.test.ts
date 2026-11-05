// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { importerConfig, parseMessageCaps } from "./importer-config";

const prod = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://x",
  IMPORT_DESTINATION_IMAP: "stalwart:993",
  PLATFORM_DOMAIN: "mail.example",
  IMPORT_MESSAGE_CAPS: "new=11,standard=22,restricted=0",
};

describe("importerConfig", () => {
  it("runs in production with Postgres, the IMAPS endpoint and caps, and no key at all", () => {
    const c = importerConfig(prod);
    expect(c).toMatchObject({
      destination: { host: "stalwart", port: 993 },
      destinationTlsName: "imap.mail.example",
      destinationInsecure: false,
      processConcurrency: 2,
      globalConcurrency: 4,
      sliceMs: 15 * 60_000,
    });
    expect(c.devSources.size).toBe(0);
    expect(c.messageCaps.get("new")).toBe(11);
  });

  it("refuses every Stalwart key, the dev admin, Redis and Stalwart HTTP in production", () => {
    for (const k of [
      "STALWART_PROVISIONING_KEY",
      "STALWART_OPERATIONS_KEY",
      "STALWART_AUDIT_KEY",
      "STALWART_TRAINING_KEY",
      "STALWART_DEV_ADMIN_USER",
      "STALWART_URL",
      "REDIS_URL",
      "MAILBOX_PASSWORD_GRANT_KEY",
    ]) {
      expect(() => importerConfig({ ...prod, [k]: "x" })).toThrow(new RegExp(k));
    }
  });

  it("refuses the development switches in production and needs the endpoint and caps", () => {
    for (const [k, v] of [
      ["IMPORT_DEV_ALLOW_SOURCES", "127.0.0.1:993"],
      ["IMPORT_DEV_DESTINATION_INSECURE", "true"],
      ["IMPORT_DEV_SOURCE_PORTS", "993=43993"],
      ["IMPORT_MAX_MESSAGE_BYTES", "1000"],
    ] as const) {
      expect(() => importerConfig({ ...prod, [k]: v })).toThrow(/development only|tests only/);
    }
    expect(() => importerConfig({ ...prod, IMPORT_DESTINATION_IMAP: undefined })).toThrow(/IMPORT_DESTINATION_IMAP/);
    expect(() => importerConfig({ ...prod, IMPORT_MESSAGE_CAPS: "new=1" })).toThrow(/standard, restricted/);
    expect(() => importerConfig({ ...prod, IMPORT_SLICE_MINUTES: "0" })).toThrow(/IMPORT_SLICE_MINUTES/);
    expect(() => importerConfig({ ...prod, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("defaults to the dev mail server outside production", () => {
    const c = importerConfig({
      DATABASE_URL: "postgres://x",
      STALWART_IMAPS_PORT: "43993",
      IMPORT_DEV_SOURCE_PORTS: "993=43993,143=43143",
    });
    expect(c).toMatchObject({ destination: { host: "127.0.0.1", port: 43993 }, destinationInsecure: true });
    expect(c.devSources.has("127.0.0.1:993")).toBe(true);
    expect([...c.devSourcePorts]).toEqual([
      [993, 43993],
      [143, 43143],
    ]);
    expect(() => importerConfig({ DATABASE_URL: "x", IMPORT_DEV_SOURCE_PORTS: "25=2525" })).toThrow(/993=43993/);
  });
});

describe("parseMessageCaps", () => {
  it("reads tier=cap pairs and refuses anything else", () => {
    expect([...(parseMessageCaps("new=10, trusted=0") ?? [])]).toEqual([
      ["new", 10],
      ["trusted", 0],
    ]);
    expect(parseMessageCaps(undefined)?.size).toBe(0);
    expect(parseMessageCaps("new:10")).toBeNull();
  });
});
