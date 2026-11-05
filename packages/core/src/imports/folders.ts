// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where each source folder goes (ADR-0030 §5 "Folder mapping"), as a pure plan the runner records: INBOX → INBOX;
 * special-use folders (from the server, or matched by a localized name) → the destination's role folders; everything
 * else kept as a custom folder with its hierarchy (delimiter → `/`, a `/` inside a name → `-`), within the mail
 * server's depth and count limits. Virtual folders (`\Flagged`, `\Important`) are skipped; `\All` goes last, into
 * Archive, de-duplicated against the whole destination.
 *
 * **Never into Junk** (ADR-0030 update 2026-11-05): on the pinned server every APPEND into the Junk folder becomes a
 * spam-training sample, and the classifier is shared server-wide. The source's Junk is skipped (`excludeJunkTrash`, on
 * by default) or copied as the ordinary folder `Imported Junk`; a custom folder whose path would land on the
 * destination's Junk folder goes under `Imported/` instead. `isJunkDestination` is the runner's last check before each
 * APPEND.
 */
import {
  IMPORT,
  IMPORT_DELIMITER,
  IMPORT_DESTINATION_SPECIAL_USE,
  IMPORT_FLATTEN_SEPARATOR,
  IMPORT_NAME_SLASH_REPLACEMENT,
  IMPORT_SKIPPED_SPECIAL_USE,
  IMPORT_SPECIAL_USE,
  IMPORT_SUBFOLDER,
  type ImportFolderRole,
} from "@anhourmail/shared/import";

import type { MailImportOptions } from "./entity";
import type { DestinationFolder, SourceFolder } from "./ports";

/** The ordinary folder a source's Junk is copied into when Junk isn't left out. */
export const IMPORTED_JUNK_FOLDER = "Imported Junk";

/** Destination folder names the pinned server uses for its role folders (a fallback when LIST has no special use). */
const DEFAULT_ROLE_PATHS: Readonly<Record<"sent" | "drafts" | "trash" | "archive", string>> = {
  sent: "Sent Items",
  drafts: "Drafts",
  trash: "Deleted Items",
  archive: "Archive",
};

export type FolderPlan = {
  sourcePath: string;
  role: ImportFolderRole | null;
  /** Where it goes; null: skipped (recorded as `skipped`, never copied). */
  destination: string | null;
  /** Why it is skipped (for counts), when it is. */
  skipped: "junk_trash" | null;
};

const lower = (s: string) => s.toLowerCase();

/** The destination path of a role folder: by its special use there, else the server's default name. */
function rolePath(dest: readonly DestinationFolder[], role: "sent" | "drafts" | "trash" | "archive"): string {
  const want = IMPORT_DESTINATION_SPECIAL_USE[role];
  return dest.find((f) => f.specialUse === want)?.path ?? DEFAULT_ROLE_PATHS[role];
}

/** True for the destination's Junk folder (by special use, or the server's default name), ignoring case. */
export function isJunkDestination(path: string, dest: readonly DestinationFolder[]): boolean {
  const junk = new Set(["junk mail", ...dest.filter((f) => f.specialUse === "\\Junk").map((f) => lower(f.path))]);
  return junk.has(lower(path)) || [...junk].some((j) => lower(path).startsWith(`${j}${IMPORT_DELIMITER}`));
}

/** A source path's levels with our delimiter: split on the source's, each `/` inside a name made `-`, blanks dropped. */
function levels(f: SourceFolder): string[] {
  const parts = f.delimiter === "" ? [f.path] : f.path.split(f.delimiter);
  return parts.map((p) => p.split(IMPORT_DELIMITER).join(IMPORT_NAME_SLASH_REPLACEMENT).trim()).filter((p) => p !== "");
}

/** Deeper than the limit: the extra levels joined into the deepest allowed one ("Parent - Child"). */
function withinDepth(parts: string[], max: number): string[] {
  if (parts.length <= max) return parts;
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join(IMPORT_FLATTEN_SEPARATOR)];
}

function roleOf(f: SourceFolder): ImportFolderRole | null {
  if (lower(f.path) === "inbox") return "inbox";
  if (f.specialUse === null) return null;
  return IMPORT_SPECIAL_USE[f.specialUse] ?? null;
}

/**
 * The plan for every selectable source folder, `\All` last. `existing` is the destination's folders now (their count
 * counts toward `IMPORT.maxFolders`; a folder already there is reused, not counted again).
 */
export function planFolders(
  source: readonly SourceFolder[],
  existing: readonly DestinationFolder[],
  options: MailImportOptions,
): FolderPlan[] {
  const known = new Set(existing.map((f) => lower(f.path)));
  let count = existing.length;
  const out: FolderPlan[] = [];
  const all: FolderPlan[] = [];
  const add = (path: string): string => {
    // Every level counts: CREATE makes missing parents too.
    const parts = path.split(IMPORT_DELIMITER);
    for (let i = 1; i <= parts.length; i++) {
      const p = lower(parts.slice(0, i).join(IMPORT_DELIMITER));
      if (!known.has(p)) {
        known.add(p);
        count += 1;
      }
    }
    return path;
  };
  for (const f of source) {
    if (!f.selectable) continue;
    if (f.specialUse !== null && IMPORT_SKIPPED_SPECIAL_USE.includes(f.specialUse)) continue;
    const role = roleOf(f);
    const plan = (destination: string | null, skipped: FolderPlan["skipped"] = null): FolderPlan => ({
      sourcePath: f.path,
      role,
      destination,
      skipped,
    });
    if (role === "inbox") out.push(plan("INBOX"));
    else if (role === "all") all.push(plan(rolePath(existing, "archive")));
    else if (role === "junk") {
      out.push(options.excludeJunkTrash ? plan(null, "junk_trash") : plan(add(IMPORTED_JUNK_FOLDER)));
    } else if (role === "trash") {
      out.push(options.excludeJunkTrash ? plan(null, "junk_trash") : plan(rolePath(existing, "trash")));
    } else if (role !== null) out.push(plan(rolePath(existing, role)));
    else {
      let parts = levels(f);
      if (parts.length === 0) continue;
      if (options.intoSubfolder) parts = [IMPORT_SUBFOLDER, ...parts];
      let path = withinDepth(parts, IMPORT.maxFolderDepth).join(IMPORT_DELIMITER);
      // A custom folder that would land on (or under) the destination's Junk goes under Imported/ instead.
      if (isJunkDestination(path, existing)) {
        path = withinDepth([IMPORT_SUBFOLDER, ...parts], IMPORT.maxFolderDepth).join(IMPORT_DELIMITER);
      }
      const newLevels = path
        .split(IMPORT_DELIMITER)
        .map((_, i, a) => lower(a.slice(0, i + 1).join(IMPORT_DELIMITER)))
        .filter((p) => !known.has(p)).length;
      // Past the count limit, everything else shares one folder (whose own slot is kept free for it).
      const reserve = known.has(lower(IMPORT_SUBFOLDER)) ? 0 : 1;
      out.push(plan(count + newLevels + reserve > IMPORT.maxFolders ? add(IMPORT_SUBFOLDER) : add(path)));
    }
  }
  return [...out, ...all];
}
