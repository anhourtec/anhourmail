// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { IMPORT } from "@anhourmail/shared/import";

import { DEFAULT_IMPORT_OPTIONS } from "./entity";
import { IMPORTED_JUNK_FOLDER, isJunkDestination, planFolders } from "./folders";
import type { DestinationFolder, SourceFolder } from "./ports";

const src = (path: string, extra: Partial<SourceFolder> = {}): SourceFolder => ({
  path,
  delimiter: "/",
  specialUse: null,
  specialUseSource: null,
  selectable: true,
  uidValidity: 1n,
  uidNext: 1,
  messages: 0,
  sizeBytes: null,
  ...extra,
});

const DEST: DestinationFolder[] = [
  { path: "INBOX", specialUse: null },
  { path: "Sent Items", specialUse: "\\Sent" },
  { path: "Drafts", specialUse: "\\Drafts" },
  { path: "Junk Mail", specialUse: "\\Junk" },
  { path: "Deleted Items", specialUse: "\\Trash" },
  { path: "Archive", specialUse: "\\Archive" },
];

const map = (source: SourceFolder[], options = DEFAULT_IMPORT_OPTIONS, dest = DEST) =>
  planFolders(source, dest, options).map((p) => [p.sourcePath, p.role, p.destination] as const);

describe("planFolders", () => {
  it("maps INBOX and special-use folders to our role folders, \\All last into Archive", () => {
    expect(
      map([
        src("[Gmail]/All Mail", { specialUse: "\\All" }),
        src("inbox"),
        src("Sent", { specialUse: "\\Sent" }),
        src("Brouillons", { specialUse: "\\Drafts", specialUseSource: "name" }),
        src("Old", { specialUse: "\\Archive" }),
        src("Starred", { specialUse: "\\Flagged" }),
        src("[Gmail]", { selectable: false }),
      ]),
    ).toEqual([
      ["inbox", "inbox", "INBOX"],
      ["Sent", "sent", "Sent Items"],
      ["Brouillons", "drafts", "Drafts"],
      ["Old", "archive", "Archive"],
      ["[Gmail]/All Mail", "all", "Archive"],
    ]);
  });

  it("never plans an APPEND into the destination's Junk", () => {
    const source = [src("Spam", { specialUse: "\\Junk" }), src("Trash", { specialUse: "\\Trash" })];
    // Default: Junk and Trash left out.
    expect(planFolders(source, DEST, DEFAULT_IMPORT_OPTIONS).map((p) => [p.destination, p.skipped])).toEqual([
      [null, "junk_trash"],
      [null, "junk_trash"],
    ]);
    // Kept: Junk becomes an ordinary folder, Trash goes to Deleted Items.
    expect(map(source, { ...DEFAULT_IMPORT_OPTIONS, excludeJunkTrash: false })).toEqual([
      ["Spam", "junk", IMPORTED_JUNK_FOLDER],
      ["Trash", "trash", "Deleted Items"],
    ]);
    // A custom folder named like our Junk folder (or under it) goes under Imported/.
    expect(map([src("Junk Mail"), src("junk mail/old")])).toEqual([
      ["Junk Mail", null, "Imported/Junk Mail"],
      ["junk mail/old", null, "Imported/junk mail/old"],
    ]);
    for (const p of planFolders([src("Junk Mail"), src("Spam", { specialUse: "\\Junk" })], DEST, {
      ...DEFAULT_IMPORT_OPTIONS,
      excludeJunkTrash: false,
    })) {
      expect(p.destination !== null && isJunkDestination(p.destination, DEST)).toBe(false);
    }
  });

  it("keeps custom hierarchy with our delimiter, and a slash inside a name becomes a dash", () => {
    expect(
      map([src("Projects.2015.Q1", { delimiter: "." }), src("A/B", { delimiter: "." }), src("Übersicht")]),
    ).toEqual([
      ["Projects.2015.Q1", null, "Projects/2015/Q1"],
      ["A/B", null, "A-B"],
      ["Übersicht", null, "Übersicht"],
    ]);
    expect(map([src("Work/Clients")], { ...DEFAULT_IMPORT_OPTIONS, intoSubfolder: true })).toEqual([
      ["Work/Clients", null, "Imported/Work/Clients"],
    ]);
  });

  it("flattens levels past the depth limit and sends folders past the count into Imported", () => {
    const deep = Array.from({ length: IMPORT.maxFolderDepth + 2 }, (_, i) => `L${String(i)}`).join("/");
    const [p] = planFolders([src(deep)], DEST, DEFAULT_IMPORT_OPTIONS);
    const parts = p?.destination?.split("/") ?? [];
    expect(parts).toHaveLength(IMPORT.maxFolderDepth);
    expect(parts.at(-1)).toBe("L9 - L10 - L11");
    const many = Array.from({ length: IMPORT.maxFolders }, (_, i) => src(`F${String(i)}`));
    const plan = planFolders(many, DEST, DEFAULT_IMPORT_OPTIONS);
    const overflow = plan.filter((x) => x.destination === "Imported");
    // The destination's six folders and Imported itself count toward the limit.
    expect(plan.length - overflow.length).toBe(IMPORT.maxFolders - DEST.length - 1);
    expect(overflow.length).toBeGreaterThan(0);
  });

  it("falls back to our default role names when the destination's LIST has no special use", () => {
    expect(map([src("Sent", { specialUse: "\\Sent" })], DEFAULT_IMPORT_OPTIONS, [])).toEqual([
      ["Sent", "sent", "Sent Items"],
    ]);
    expect(isJunkDestination("Junk Mail", [])).toBe(true);
  });
});
