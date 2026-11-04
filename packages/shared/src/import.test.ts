// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  detectCsvColumns,
  IMPORT,
  IMPORT_DESTINATION_SPECIAL_USE,
  IMPORT_FOLDER_ROLES,
  IMPORT_SPECIAL_USE,
  IMPORT_STATUSES,
  IMPORT_TERMINAL_STATUSES,
  isImportSourcePort,
  isTerminalImportStatus,
  normalizeCsvHeader,
} from "./import";
import { ACCOUNT_POLICY } from "./plans";

describe("import facts", () => {
  it("keeps messages under the mail server's 50 MiB request limit, at the receive limit", () => {
    expect(IMPORT.maxMessageBytes).toBe(ACCOUNT_POLICY.receiveMessageMb * 1_000_000);
    // Room for the APPEND command and our marker header under 52,428,800 bytes.
    expect(IMPORT.maxMessageBytes + 4096).toBeLessThan(52_428_800);
  });

  it("allows only IMAP over TLS (993) or STARTTLS (143) as a source", () => {
    expect(IMPORT.sourcePorts).toEqual([993, 143]);
    for (const p of [993, 143]) expect(isImportSourcePort(p)).toBe(true);
    for (const p of [25, 110, 443, 465, 587, 995, "993", null]) expect(isImportSourcePort(p)).toBe(false);
  });

  it("ties the sync window to the credential and stays within the mail server's folder limits", () => {
    expect(IMPORT.syncWindowDays).toBeGreaterThanOrEqual(IMPORT.credentialDays);
    expect(IMPORT.syncWindowDays).toBe(14);
    expect(IMPORT.maxFolderDepth).toBe(10);
    expect(IMPORT.maxFolders).toBe(250);
    expect(IMPORT.contactsMaxCards).toBe(5000);
  });

  it("knows which statuses are terminal", () => {
    expect(IMPORT_TERMINAL_STATUSES).toEqual(["completed", "cancelled", "failed"]);
    expect(IMPORT_STATUSES.filter(isTerminalImportStatus)).toEqual([...IMPORT_TERMINAL_STATUSES]);
  });

  it("maps every special-use attribute to a role with a destination folder", () => {
    for (const role of Object.values(IMPORT_SPECIAL_USE)) expect(IMPORT_FOLDER_ROLES).toContain(role);
    for (const role of IMPORT_FOLDER_ROLES) expect(IMPORT_DESTINATION_SPECIAL_USE).toHaveProperty(role);
    expect(IMPORT_DESTINATION_SPECIAL_USE.all).toBe("\\Archive");
    expect(IMPORT_DESTINATION_SPECIAL_USE.inbox).toBeNull();
  });
});

describe("contacts CSV columns", () => {
  it("normalises headers to letters and digits", () => {
    expect(normalizeCsvHeader(" E-mail 2 Address ")).toBe("email2address");
    expect(normalizeCsvHeader("Prénom")).toBe("prenom");
  });

  it("detects the columns common exports use", () => {
    expect(
      detectCsvColumns([
        "First Name",
        "Middle Name",
        "Last Name",
        "Display Name",
        "E-mail Address",
        "E-mail 2 Address",
        "Mobile Phone",
        "Business Phone",
        "Company",
        "Notes",
        "Birthday",
        "Categories",
      ]),
    ).toEqual([
      "given",
      null,
      "surname",
      "fullName",
      "emails",
      "emails",
      "phones",
      "phones",
      "organization",
      "notes",
      "birthday",
      "labels",
    ]);
    expect(
      detectCsvColumns([
        "Name",
        "Given Name",
        "Family Name",
        "E-mail 1 - Type",
        "E-mail 1 - Value",
        "Phone 1 - Type",
        "Phone 1 - Value",
        "Organization 1 - Name",
        "Group Membership",
      ]),
    ).toEqual(["fullName", "given", "surname", null, "emails", null, "phones", "organization", "labels"]);
    expect(detectCsvColumns(["email", "tel", "Labels", "", "Website"])).toEqual([
      "emails",
      "phones",
      "labels",
      null,
      null,
    ]);
  });

  it("gives a single-valued field to its first column only", () => {
    expect(detectCsvColumns(["First Name", "Given Name", "Notes", "Comments"])).toEqual(["given", null, "notes", null]);
  });
});
