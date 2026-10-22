// SPDX-License-Identifier: AGPL-3.0-only
import type { Address } from "@/server/webmail/view";

import type { Folder } from "./mail-client";

/** The subject to show; blank subjects read "(no subject)". */
export function subjectOf(subject: string | null | undefined): string {
  const s = subject?.trim() ?? "";
  return s === "" ? "(no subject)" : s;
}

/** Display name for an address: the name, else the local part. */
export function displayName(a: Address | undefined | null): string {
  if (!a) return "Unknown sender";
  const name = a.name?.trim();
  return name && name !== "" ? name : (a.email.split("@")[0] ?? a.email);
}

export function initials(a: Address | undefined | null): string {
  const words = displayName(a)
    .split(/[\s._-]+/)
    .filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** One of five token tones, stable per address (avatars without remote images). */
export function tone(email: string | undefined): number {
  let h = 0;
  for (const c of email ?? "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 5;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Compact list date: time today, weekday this week, "Oct 12" this year, else ISO date. */
export function listDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6 && days > 0) return d.toLocaleDateString("en-CA", { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  return d.toISOString().slice(0, 10);
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString("en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const ROLE_ORDER = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
const ROLE_LABEL: Record<string, string> = {
  inbox: "Inbox",
  drafts: "Drafts",
  sent: "Sent",
  archive: "Archive",
  junk: "Junk",
  trash: "Trash",
};

export function folderLabel(f: Folder): string {
  return (f.role && ROLE_LABEL[f.role]) ?? f.name;
}

export type FolderNode = { folder: Folder; depth: number };

/** System folders in a fixed order, then custom folders (nested, by sort order then name), depth-first. */
export function folderTree(folders: Folder[]): FolderNode[] {
  const system = ROLE_ORDER.map((r) => folders.find((f) => f.role === r && f.parentId === null)).filter(
    (f): f is Folder => f !== undefined,
  );
  const systemIds = new Set(system.map((f) => f.id));
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    if (systemIds.has(f.id)) continue;
    const list = byParent.get(f.parentId) ?? [];
    list.push(f);
    byParent.set(f.parentId, list);
  }
  const sort = (list: Folder[]) =>
    [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "en-CA"));
  const out: FolderNode[] = system.map((folder) => ({ folder, depth: 0 }));
  const walk = (parent: string | null, depth: number) => {
    for (const f of sort(byParent.get(parent) ?? [])) {
      out.push({ folder: f, depth });
      if (depth < 8) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  // Children of system folders follow their parent.
  for (const s of system) {
    const idx = out.findIndex((n) => n.folder.id === s.id);
    const kids: FolderNode[] = [];
    const collect = (parent: string, depth: number) => {
      for (const f of sort(byParent.get(parent) ?? [])) {
        kids.push({ folder: f, depth });
        if (depth < 8) collect(f.id, depth + 1);
      }
    };
    collect(s.id, 1);
    out.splice(idx + 1, 0, ...kids);
  }
  return out;
}
