// SPDX-License-Identifier: AGPL-3.0-only
import type { WebmailPreferences } from "@anhourmail/shared/webmail";

import type { Address } from "@/server/webmail/view";

import { FOLDER_ROLES } from "./tab-paths";

/**
 * What the message list asks the mail server, in one place for the browser (`mail-client.ts`) and the BFF's first
 * load (`server/webmail/bootstrap.ts`), so both build the same JMAP calls and read the answers the same way. Pure: no
 * browser or server APIs.
 */

export type Folder = {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
};

export type Summary = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[] | null;
  to: Address[] | null;
  cc?: Address[] | null;
  subject: string | null;
  receivedAt: string;
  preview: string;
  hasAttachment: boolean;
};

export type ListRow = Summary & {
  threadSize: number;
  /** Attachment names and types (only fetched when the list shows attachment chips). */
  attachments?: { name: string | null; type: string }[];
};

/** How the list groups mail: whole conversations (one row each) or every message on its own row. */
export type Grouping = WebmailPreferences["grouping"];

/** What the list shows: a folder, or "Priority" (flagged everywhere but Trash and Junk). */
export type View = { kind: "folder"; id: string } | { kind: "priority" };

export type SearchQuery = {
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  unread?: boolean;
  flagged?: boolean;
};

/** List narrowing from the filter menu and the search box. */
export type ListFilter = {
  unread?: boolean;
  flagged?: boolean;
  attachments?: boolean;
  /** Parsed search (see `parseSearch`); searching covers every folder but Trash and Junk. */
  search?: SearchQuery | null;
};

/** Where automatic refresh is: the mail server's `Email` and `Mailbox` states after the last check. */
export type SyncState = { email: string; mailbox: string };

export type Condition = Record<string, unknown>;
type Call = [string, Record<string, unknown>, string];

export const SUMMARY = [
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "cc",
  "subject",
  "receivedAt",
  "preview",
  "hasAttachment",
];
export const FOLDER_PROPERTIES = [
  "name",
  "role",
  "parentId",
  "sortOrder",
  "totalEmails",
  "unreadEmails",
  "totalThreads",
  "unreadThreads",
];
export const PAGE_SIZE = 50;
export const PINNED_LIMIT = 50;

/** The JMAP filter for a view, narrowing and search. `hidden` = Trash and Junk ids. */
export function listFilter(view: View, f: ListFilter, hidden: string[], opts: { pinned?: boolean } = {}): Condition {
  const all: Condition[] = [];
  const searching = f.search && Object.keys(f.search).length > 0;
  if (view.kind === "folder" && (!searching || hidden.includes(view.id))) all.push({ inMailbox: view.id });
  else if (hidden.length > 0) all.push({ inMailboxOtherThan: hidden });
  if (view.kind === "priority") all.push({ hasKeyword: "$flagged" });
  const s = f.search ?? {};
  if (s.text) all.push({ text: s.text });
  if (s.from) all.push({ from: s.from });
  if (s.to) all.push({ to: s.to });
  if (s.subject) all.push({ subject: s.subject });
  if (f.attachments || s.hasAttachment) all.push({ hasAttachment: true });
  if (f.unread || s.unread) all.push({ notKeyword: "$seen" });
  if (f.flagged || s.flagged) all.push({ hasKeyword: "$flagged" });
  if (opts.pinned === true) all.push({ hasKeyword: "$pinned" });
  if (opts.pinned === false) all.push({ notKeyword: "$pinned" });
  return all.length === 1 ? (all[0] ?? {}) : { operator: "AND", conditions: all };
}

/** What the list shows: a view, its narrowing and its search. */
export type Shown = { view: View; narrow: Omit<ListFilter, "search">; search: SearchQuery | null };

/** The list's identity: the same key means the same rows (what is shown, grouped and fetched the same way). */
export const listKey = (
  s: Shown,
  look: { grouping: string; attachmentChips: boolean } = { grouping: "", attachmentChips: false },
): string => JSON.stringify([s.view, s.narrow, s.search, look.grouping, look.attachmentChips]);

/** The main section's filter: pinned conversations have their own section in folder views. */
export const mainFilter = (s: Shown, hidden: string[]): Condition =>
  listFilter(
    s.view,
    { ...s.narrow, search: s.search },
    hidden,
    s.view.kind === "folder" && !s.search ? { pinned: false } : {},
  );

/** Whether a view has the pinned section above the list (folder views without a search). */
export const hasPinnedSection = (s: Shown): boolean => s.view.kind === "folder" && s.search === null;

/** The pinned section's filter. */
export const pinnedFilter = (s: Shown, hidden: string[]): Condition =>
  listFilter(s.view, { ...s.narrow }, hidden, { pinned: true });

/** Trash and Junk: hidden from Priority and from searches. */
export const hiddenFolders = (folders: Folder[]): string[] =>
  [folders.find((x) => x.role === "trash")?.id, folders.find((x) => x.role === "junk")?.id].filter(
    (x): x is string => x !== undefined,
  );

/**
 * The view the app opens in: `start` is the `startIn` preference (`inbox`, `priority`, `folder:<id>`); `named` a
 * folder a mailbox-scoped tab's URL names (a role or an id), which wins over the Inbox but not over a chosen folder.
 * Falls back to the Inbox, then the first folder; null when there are no folders.
 */
export function startView(folders: Folder[], start: string, named?: string): View | null {
  if (start === "priority") return { kind: "priority" };
  const chosen = start.startsWith("folder:") ? folders.find((x) => `folder:${x.id}` === start) : undefined;
  const fromUrl =
    named === undefined
      ? undefined
      : folders.find((x) => ((FOLDER_ROLES as readonly string[]).includes(named) ? x.role === named : x.id === named));
  const first = chosen ?? fromUrl ?? folders.find((x) => x.role === "inbox") ?? folders[0];
  return first ? { kind: "folder", id: first.id } : null;
}

/**
 * One window of the list as JMAP calls (`Email/query` → `Email/get` → `Thread/get`, chained with result references),
 * newest first, thread-collapsed when grouping conversations. Call ids carry `prefix` so several windows fit in one
 * request.
 */
export function pageCalls(
  accountId: string,
  filter: Condition,
  position: number,
  limit: number,
  opts: { grouping: Grouping; attachments?: boolean | undefined },
  prefix = "",
): Call[] {
  const q = `${prefix}q`;
  const g = `${prefix}g`;
  const properties = opts.attachments ? [...SUMMARY, "attachments"] : SUMMARY;
  return [
    [
      "Email/query",
      {
        accountId,
        filter,
        sort: [{ property: "receivedAt", isAscending: false }],
        collapseThreads: opts.grouping === "conversations",
        position,
        limit,
        calculateTotal: true,
      },
      q,
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: q, name: "Email/query", path: "/ids" },
        properties,
        ...(opts.attachments ? { bodyProperties: ["name", "type"] } : {}),
      },
      g,
    ],
    ["Thread/get", { accountId, "#ids": { resultOf: g, name: "Email/get", path: "/list/*/threadId" } }, `${prefix}t`],
  ];
}

/** The rows and total of a window fetched with `pageCalls` (same `prefix`), in the query's order. */
export function pageRows(
  res: Map<string, Record<string, unknown>>,
  grouping: Grouping,
  prefix = "",
): { total: number; rows: ListRow[] } {
  const ids = (res.get(`${prefix}q`)?.ids ?? []) as string[];
  const total = Number(res.get(`${prefix}q`)?.total ?? ids.length);
  const emails = new Map(((res.get(`${prefix}g`)?.list ?? []) as Summary[]).map((e) => [e.id, e]));
  const threads = new Map(
    ((res.get(`${prefix}t`)?.list ?? []) as { id: string; emailIds: string[] }[]).map((t) => [t.id, t.emailIds.length]),
  );
  const rows = ids
    .map((id) => emails.get(id))
    .filter((e): e is Summary => e !== undefined)
    .map((e) => ({ ...e, threadSize: grouping === "messages" ? 1 : (threads.get(e.threadId) ?? 1) }));
  return { total, rows };
}

/** How many messages a view's count query found (`Email/query` with `limit: 0`). */
export const countCall = (accountId: string, filter: Condition, id: string): Call => [
  "Email/query",
  { accountId, filter, limit: 0, calculateTotal: true },
  id,
];

/** The first-load route's URL (`GET /api/webmail/bootstrap`) for these preferences and a tab's folder. */
export function bootstrapUrl(
  input: {
    start: string;
    grouping: Grouping;
    attachments: boolean;
    folder?: string | undefined;
    expect?: string | undefined;
  },
  origin = "",
): string {
  const q = new URLSearchParams({
    start: input.start,
    grouping: input.grouping,
    chips: input.attachments ? "1" : "0",
    ...(input.folder === undefined ? {} : { folder: input.folder }),
    ...(input.expect === undefined ? {} : { expect: input.expect }),
  });
  return `${origin}/api/webmail/bootstrap?${q.toString()}`;
}
