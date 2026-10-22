// SPDX-License-Identifier: AGPL-3.0-only
import type { Address } from "@/server/webmail/view";

import type { Folder, SearchQuery } from "./mail-client";

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

/**
 * How dates and times are written (Settings → Region and shortcuts): the region's conventions, a time zone (unset =
 * the device's) and 12- or 24-hour time (unset = the region's). Set once by the app when preferences load or change.
 */
export type DateStyle = { locale: string; timeZone?: string; hourCycle?: "h12" | "h23" };
let style: DateStyle = { locale: "en-CA" };

export function setDateStyle(next: DateStyle): void {
  style = { ...next };
}

const zoned = (opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions => ({
  ...opts,
  ...(style.timeZone ? { timeZone: style.timeZone } : {}),
  ...(style.hourCycle && opts.hour ? { hourCycle: style.hourCycle } : {}),
});

/** One formatter per time zone (building one is slow; date headers ask for every loaded row). */
const ymdFormats = new Map<string, Intl.DateTimeFormat>();

/** Year, month and day of `d` in the chosen time zone (for "same day" checks and date headers). */
function ymd(d: Date): [number, number, number] {
  const key = style.timeZone ?? "";
  let fmt = ymdFormats.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", zoned({ year: "numeric", month: "2-digit", day: "2-digit" }));
    ymdFormats.set(key, fmt);
  }
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return [get("year"), get("month"), get("day")];
}

/** Days between the calendar dates of `a` and `b` in the chosen zone (b − a). */
function dayDiff(a: Date, b: Date): number {
  const [ay, am, ad] = ymd(a);
  const [by, bm, bd] = ymd(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

const sameDay = (a: Date, b: Date) => dayDiff(a, b) === 0;

/** Compact list date: time today, weekday this week, "Oct 12" this year, else ISO date. */
export function listDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return d.toLocaleTimeString(style.locale, zoned({ hour: "numeric", minute: "2-digit" }));
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6 && days > 0) return d.toLocaleDateString(style.locale, zoned({ weekday: "short" }));
  if (ymd(d)[0] === ymd(now)[0]) return d.toLocaleDateString(style.locale, zoned({ month: "short", day: "numeric" }));
  return d.toISOString().slice(0, 10);
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(
    style.locale,
    zoned({ weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
  );
}

/**
 * The date-header group of a message in the list: "Today", "Yesterday", "Earlier this week", "Last week",
 * "Earlier this month", then the month ("September 2026").
 */
export function dateGroup(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  // Weeks start on Monday.
  const [ny, nm, nd] = ymd(now);
  const weekday = (new Date(Date.UTC(ny, nm - 1, nd)).getUTCDay() + 6) % 7;
  if (diff <= weekday) return "Earlier this week";
  if (diff <= weekday + 7) return "Last week";
  const [dy, dm] = ymd(d);
  if (ny === dy && nm === dm) return "Earlier this month";
  return d.toLocaleDateString(style.locale, zoned({ month: "long", year: "numeric" }));
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

/** Relative list time: "just now", "24 minutes ago", "1 day ago" (up to 3 days), then "22 Oct 2026". */
export function relativeTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sec = Math.round((now.getTime() - d.getTime()) / 1000);
  if (sec < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat(style.locale, { numeric: "always" });
  if (sec < 3600) return rtf.format(-Math.max(1, Math.round(sec / 60)), "minute");
  if (sec < 86_400) return rtf.format(-Math.round(sec / 3600), "hour");
  if (sec < 4 * 86_400) return rtf.format(-Math.round(sec / 86_400), "day");
  return d.toLocaleDateString(style.locale, zoned({ day: "numeric", month: "short", year: "numeric" }));
}

/** Parses the search box: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:flagged`, plus free text. */
export function parseSearch(input: string): SearchQuery | null {
  const q: SearchQuery = {};
  const free: string[] = [];
  for (const m of input.matchAll(/(\w+):("[^"]*"|\S+)|("[^"]*"|\S+)/g)) {
    const key = m[1]?.toLowerCase();
    const value = (m[2] ?? m[3] ?? "").replace(/^"|"$/g, "").trim();
    if (value === "") continue;
    if (key === "from") q.from = value;
    else if (key === "to") q.to = value;
    else if (key === "subject") q.subject = value;
    else if (key === "has" && value.toLowerCase().startsWith("attach")) q.hasAttachment = true;
    else if (key === "is" && value.toLowerCase() === "unread") q.unread = true;
    else if (key === "is" && ["flagged", "starred", "priority"].includes(value.toLowerCase())) q.flagged = true;
    else free.push(m[0]);
  }
  if (free.length > 0) q.text = free.join(" ").slice(0, 200);
  return Object.keys(q).length > 0 ? q : null;
}

const RE = /^(?:(?:re|aw|sv|antw)\s*:\s*)+/i;
const FWD = /^(?:(?:fwd?|wg|tr)\s*:\s*)+/i;

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/** Subject for a reply or forward, without stacking prefixes. */
export function replySubject(subject: string | null, mode: ComposeMode): string {
  const s = (subject ?? "").trim();
  if (mode === "forward") return `Fwd: ${s.replace(FWD, "")}`;
  if (mode === "reply" || mode === "replyAll") return `Re: ${s.replace(RE, "")}`;
  return s;
}

/** Recipients for a reply: the sender (or Reply-To); reply all adds the other To/Cc, never yourself. */
export function replyRecipients(
  msg: { from: Address[]; to: Address[]; cc: Address[]; replyTo: Address[] },
  mode: ComposeMode,
  self: string[],
): { to: Address[]; cc: Address[] } {
  if (mode === "new" || mode === "forward") return { to: [], cc: [] };
  const mine = new Set(self.map((s) => s.toLowerCase()));
  const uniq = (list: Address[], skip = new Set<string>()) => {
    const out: Address[] = [];
    for (const a of list) {
      const k = a.email.toLowerCase();
      if (mine.has(k) || skip.has(k) || out.some((o) => o.email.toLowerCase() === k)) continue;
      out.push(a);
    }
    return out;
  };
  const sentByMe = msg.from.some((a) => mine.has(a.email.toLowerCase()));
  // Replying to your own message goes to its original recipients.
  const primary = sentByMe ? msg.to : msg.replyTo.length > 0 ? msg.replyTo : msg.from;
  const to = uniq(primary);
  if (mode === "reply") return { to, cc: [] };
  const taken = new Set(to.map((a) => a.email.toLowerCase()));
  return { to: [...to, ...uniq(sentByMe ? [] : msg.to, taken)], cc: uniq(msg.cc, taken) };
}

/** The quoted body for a reply ("On …, Sam wrote:" + "> " lines) or a forward (header block + the text). */
export function quoteBody(
  msg: { from: Address[]; to: Address[]; cc: Address[]; subject: string; receivedAt: string; quote: string },
  mode: ComposeMode,
): string {
  if (mode === "new") return "";
  const who = (list: Address[]) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
  if (mode === "forward") {
    return [
      "",
      "",
      "---------- Forwarded message ----------",
      `From: ${who(msg.from)}`,
      `Date: ${fullDate(msg.receivedAt)}`,
      `Subject: ${msg.subject}`,
      `To: ${who(msg.to)}`,
      ...(msg.cc.length > 0 ? [`Cc: ${who(msg.cc)}`] : []),
      "",
      msg.quote,
    ].join("\n");
  }
  const lines = msg.quote.split("\n").map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`));
  return `\n\nOn ${fullDate(msg.receivedAt)}, ${who(msg.from)} wrote:\n${lines.join("\n")}`;
}

/** A coarse kind for an attachment, to pick an icon. */
export function fileKind(type: string, name: string): "image" | "pdf" | "sheet" | "archive" | "text" | "file" {
  const t = type.toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf" || ext === "pdf") return "pdf";
  if (t.includes("spreadsheet") || t === "text/csv" || ["csv", "xls", "xlsx", "ods"].includes(ext)) return "sheet";
  if (t.includes("zip") || ["zip", "gz", "tar", "7z"].includes(ext)) return "archive";
  if (t.startsWith("text/") || ["txt", "md", "doc", "docx", "odt"].includes(ext)) return "text";
  return "file";
}
