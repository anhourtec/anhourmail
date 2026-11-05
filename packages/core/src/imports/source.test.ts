// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ValidationError } from "../errors";
import { DEV_IMPORT_SOURCES, devImportSources, importSource, importSourceSecret } from "./source";

const ok = { host: "imap.example.com", port: 993, username: " me@example.com ", password: " pw " };

describe("importSource", () => {
  it("normalises a public host, defaults the port and trims the sign-in", () => {
    expect(importSource({ ...ok, host: "IMAP.Exämple.com", port: undefined })).toEqual({
      host: "imap.xn--exmple-cua.com",
      port: 993,
      username: "me@example.com",
      secret: "pw",
    });
    expect(importSource({ ...ok, host: "9.9.9.9", port: 143 }).host).toBe("9.9.9.9");
  });

  it("refuses internal names, private literals, other ports and bad sign-ins", () => {
    for (const bad of [
      { host: "mail" },
      { host: "mail.local" },
      { host: "box.internal" },
      { host: "192.168.1.2" },
      { host: "[::1]" },
      { host: "a@b.example" },
      { host: 42 },
      { port: 25 },
      { port: "993" },
      { username: "a\tb" },
      { username: "x".repeat(321) },
      { password: "x".repeat(1025) },
    ]) {
      expect(() => importSource({ ...ok, ...bad })).toThrow(ValidationError);
    }
    expect(() => importSourceSecret(undefined)).toThrow(ValidationError);
  });

  it("lets an exact development pair through", () => {
    const allow = devImportSources({ NODE_ENV: "development" });
    expect(importSource({ ...ok, host: "127.0.0.1" }, allow).host).toBe("127.0.0.1");
    expect(() => importSource({ ...ok, host: "127.0.0.1", port: 143 }, new Set(["127.0.0.1:993"]))).toThrow();
  });
});

describe("devImportSources", () => {
  it("defaults outside production, is empty in production and refuses being set there", () => {
    expect(devImportSources({ NODE_ENV: "development" }).size).toBe(DEV_IMPORT_SOURCES.split(",").length);
    expect(devImportSources({ NODE_ENV: "test", IMPORT_DEV_ALLOW_SOURCES: "" }).size).toBe(0);
    expect(devImportSources({ NODE_ENV: "production" }).size).toBe(0);
    expect(() => devImportSources({ NODE_ENV: "production", IMPORT_DEV_ALLOW_SOURCES: "127.0.0.1:993" })).toThrow(
      /development only/,
    );
  });
});
