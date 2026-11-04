// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createKeyRing } from "@anhourmail/server/keyring";

import {
  DEFAULT_IMPORT_OPTIONS,
  IMPORT_SECRET_PURPOSES,
  finishedSourceHost,
  importDestinationAad,
  importFolderAad,
  importOptions,
  importSourceAad,
  openDestinationSecret,
  openFolderPath,
  openSourceSecret,
  sealDestinationSecret,
  sealFolderPath,
  sealSourceSecret,
} from ".";

const ring = createKeyRing([{ id: "k1", key: randomBytes(32) }]);
const A = "2b0c1c55-1111-4a4a-8b8b-000000000001";
const B = "2b0c1c55-1111-4a4a-8b8b-000000000002";
const F1 = "2b0c1c55-1111-4a4a-8b8b-0000000000f1";
const F2 = "2b0c1c55-1111-4a4a-8b8b-0000000000f2";

describe("import options", () => {
  it("keeps booleans and defaults the rest (exclude Junk and Trash on, the others off)", () => {
    expect(DEFAULT_IMPORT_OPTIONS).toEqual({ excludeJunkTrash: true, intoSubfolder: false, sync: false });
    expect(importOptions(null)).toEqual(DEFAULT_IMPORT_OPTIONS);
    expect(importOptions("x")).toEqual(DEFAULT_IMPORT_OPTIONS);
    expect(importOptions({ sync: true, excludeJunkTrash: false, intoSubfolder: "yes", extra: 1 })).toEqual({
      excludeJunkTrash: false,
      intoSubfolder: false,
      sync: true,
    });
  });
});

describe("import secrets", () => {
  it("uses its own purpose and an AAD bound to the import for each kind", () => {
    expect(IMPORT_SECRET_PURPOSES).toEqual({
      source: "mail-import-source",
      destination: "mail-import-destination",
      folder: "mail-import-folder",
    });
    expect(importSourceAad(A)).toBe(`mail_import:${A}:source`);
    expect(importDestinationAad(A)).toBe(`mail_import:${A}:destination`);
    expect(importFolderAad(A, F1)).toBe(`mail_import_folder:${A}:${F1}`);
  });

  it("round-trips, and never opens on another import, as another kind, or with another ring", () => {
    const source = sealSourceSecret(ring, A, "old-provider-app-password");
    const destination = sealDestinationSecret(ring, A, "app_destination");
    const path = sealFolderPath(ring, A, F1, "Archive/2015/Trips");
    for (const sealed of [source, destination, path]) {
      expect(sealed).toMatch(/^v1\.k1\./);
      expect(sealed).not.toContain("password");
    }
    expect(openSourceSecret(ring, A, source)).toBe("old-provider-app-password");
    expect(openDestinationSecret(ring, A, destination)).toBe("app_destination");
    expect(openFolderPath(ring, A, F1, path)).toBe("Archive/2015/Trips");

    expect(() => openSourceSecret(ring, B, source)).toThrow();
    expect(() => openDestinationSecret(ring, A, source)).toThrow();
    expect(() => openSourceSecret(ring, A, destination)).toThrow();
    expect(() => openFolderPath(ring, B, F1, path)).toThrow();
    // Moved to another folder row of the same import: refused too.
    expect(() => openFolderPath(ring, A, F2, path)).toThrow();
    const other = createKeyRing([{ id: "k1", key: randomBytes(32) }]);
    expect(() => openSourceSecret(other, A, source)).toThrow();
  });
});

describe("finished source host", () => {
  it("keeps only the registrable domain, or says IP address", () => {
    expect(finishedSourceHost("imap.mail.example.org")).toBe("example.org");
    expect(finishedSourceHost("example.org")).toBe("example.org");
    expect(finishedSourceHost("mail.someone.co.uk")).toBe("someone.co.uk");
    expect(finishedSourceHost("imap.provider.com.au")).toBe("provider.com.au");
    expect(finishedSourceHost("mail.xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
    expect(finishedSourceHost("93.184.215.14")).toBe("IP address");
    expect(finishedSourceHost("2606:4700::1111")).toBe("IP address");
  });
});
