// SPDX-License-Identifier: AGPL-3.0-only
import { GROUPINGS } from "@anhourmail/shared/webmail";

import {
  countCall,
  FOLDER_PROPERTIES,
  type Folder,
  type Grouping,
  hasPinnedSection,
  hiddenFolders,
  listFilter,
  type ListRow,
  mainFilter,
  PAGE_SIZE,
  pageCalls,
  pageRows,
  PINNED_LIMIT,
  pinnedFilter,
  type Shown,
  startView,
  type SyncState,
  type View,
} from "../../components/webmail/list-query";
import { FOLDER_ROLES } from "../../components/webmail/tab-paths";

import { jmapSessionDocument } from "./jmap-session";
import type { WebmailService } from "./service";
import { isPinAddress } from "./pin";
import { isJmapId } from "./view";

/**
 * The webmail's first load in one answer (`GET /api/webmail/bootstrap`, docs/internal/05-webmail.md "First load"):
 * the JMAP session document, the folders with their counts, the sync states the change check starts from, the
 * Priority count, and the first window of the view the app opens in (its pinned section too). The browser would
 * otherwise wait on four round trips one after another (session → folders → pinned → list); the BFF makes two calls
 * to the mail server instead, a millisecond away. The same calls as the browser's (`list-query.ts`), with the
 * person's own token through the same queue and checks as the JMAP proxy.
 */

export type BootstrapInput = {
  /** The `startIn` preference: `inbox`, `priority` or `folder:<id>`. */
  start: string;
  grouping: Grouping;
  /** Fetch attachment names for the list's chips. */
  attachments: boolean;
  /** A folder a mailbox-scoped tab's URL names (a role or an id). */
  folder?: string | undefined;
  /** The mailbox the app shows (lowercase): another active one is refused (`MailboxChangedError`, 409). */
  expect?: string | undefined;
};

export type BootstrapList = { pinned: ListRow[]; total: number; rows: ListRow[] };

export type Bootstrap = {
  session: ReturnType<typeof jmapSessionDocument>;
  folders: Folder[];
  state: SyncState;
  priorityCount: number;
  /** The view opened (null: the mailbox has no folders). */
  view: View | null;
  /** Its first window; `pinned` is empty for views without the pinned section. */
  list: BootstrapList | null;
  /** What the list was built with (the client discards it if its own preferences differ). */
  grouping: Grouping;
  attachments: boolean;
};

type Call = [string, Record<string, unknown>, string];
/** Sends JMAP calls for the active mailbox and returns the responses by call id (method errors throw). */
export type JmapCall = (calls: Call[]) => Promise<Map<string, Record<string, unknown>>>;

/** The session's mailbox isn't the one the app shows (another tab switched it meanwhile): 409, the app reloads. */
export class MailboxChangedError extends Error {
  override readonly name = "MailboxChangedError";
}

/** The mail server's answer couldn't be used (an error, another mailbox, a malformed reply). */
export class BootstrapUnavailableError extends Error {
  override readonly name = "BootstrapUnavailableError";
}

const START = /^(?:inbox|priority|folder:[A-Za-z0-9_-]{1,255})$/;

/** The input from the query string, or null when anything in it is malformed. */
export function parseBootstrapQuery(params: URLSearchParams): BootstrapInput | null {
  const start = params.get("start") ?? "inbox";
  const grouping = params.get("grouping") ?? "conversations";
  const chips = params.get("chips") ?? "0";
  const folder = params.get("folder");
  const expect = params.get("expect");
  if (!START.test(start)) return null;
  if (!(GROUPINGS as readonly string[]).includes(grouping)) return null;
  if (chips !== "0" && chips !== "1") return null;
  if (folder !== null && !((FOLDER_ROLES as readonly string[]).includes(folder) || isJmapId(folder))) return null;
  if (expect !== null && !isPinAddress(expect.trim().toLowerCase())) return null;
  return {
    start,
    grouping: grouping as Grouping,
    attachments: chips === "1",
    ...(folder === null ? {} : { folder }),
    ...(expect === null ? {} : { expect: expect.trim().toLowerCase() }),
  };
}

/** `JmapCall` over the BFF's proxy call (`WebmailService.jmap`): anything but a clean 200 answer throws. */
export function jmapCaller(
  run: (body: { using: string[]; methodCalls: Call[] }) => Promise<{ status: number; body: unknown }>,
): JmapCall {
  return async (calls) => {
    const res = await run({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: calls });
    const responses = (res.body as { methodResponses?: unknown } | null)?.methodResponses;
    if (res.status !== 200 || !Array.isArray(responses)) throw new BootstrapUnavailableError("mail server refused");
    const out = new Map<string, Record<string, unknown>>();
    for (const r of responses as unknown[]) {
      if (!Array.isArray(r) || r.length !== 3) throw new BootstrapUnavailableError("malformed answer");
      const [name, args, id] = r as [unknown, unknown, unknown];
      if (name === "error" || typeof id !== "string" || typeof args !== "object" || args === null) {
        throw new BootstrapUnavailableError("method error");
      }
      if (!out.has(id)) out.set(id, args as Record<string, unknown>);
    }
    return out;
  };
}

const asState = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Everything but the session document, for `accountId` (the active mailbox's). Two calls: the folders and states,
 * then — once Trash and Junk are known — the Priority count and the opened view's first window.
 */
export async function loadFirstView(
  call: JmapCall,
  accountId: string,
  input: BootstrapInput,
): Promise<Omit<Bootstrap, "session">> {
  const first = await call([
    ["Mailbox/get", { accountId, ids: null, properties: FOLDER_PROPERTIES }, "m"],
    ["Email/get", { accountId, ids: [], properties: ["id"] }, "s"],
  ]);
  const m = first.get("m");
  // Answered for the mailbox asked about, or not at all (the active one changed meanwhile).
  if (m?.accountId !== accountId || !Array.isArray(m.list)) throw new BootstrapUnavailableError("another mailbox");
  const folders = m.list as Folder[];
  const state: SyncState = { email: asState(first.get("s")?.state), mailbox: asState(m.state) };
  const hidden = hiddenFolders(folders);
  const view = startView(folders, input.start, input.folder);
  const look = { grouping: input.grouping, attachments: input.attachments };
  const calls: Call[] = [countCall(accountId, listFilter({ kind: "priority" }, {}, hidden), "p")];
  const shown: Shown | null = view ? { view, narrow: {}, search: null } : null;
  const pinnedToo = shown !== null && hasPinnedSection(shown);
  if (shown) {
    if (pinnedToo) calls.push(...pageCalls(accountId, pinnedFilter(shown, hidden), 0, PINNED_LIMIT, look, "pin-"));
    calls.push(...pageCalls(accountId, mainFilter(shown, hidden), 0, PAGE_SIZE, look, "main-"));
  }
  const second = await call(calls);
  const main = shown ? pageRows(second, input.grouping, "main-") : null;
  return {
    folders,
    state,
    priorityCount: Number(second.get("p")?.total ?? 0),
    view,
    list: main
      ? { pinned: pinnedToo ? pageRows(second, input.grouping, "pin-").rows : [], total: main.total, rows: main.rows }
      : null,
    grouping: input.grouping,
    attachments: input.attachments,
  };
}

/**
 * The whole first load for webmail session `sessionId` (the route's work): the session as this request sees it — the
 * active mailbox, or a tab's pinned shared one — then its first view with that session's own token. Null when signed
 * out. The webmail errors (`WebmailSignedOutError`, a refused delegated mailbox, …) propagate for the route to map.
 */
export async function firstLoad(
  svc: Pick<WebmailService, "session" | "jmap">,
  sessionId: string,
  input: BootstrapInput,
): Promise<Bootstrap | null> {
  const s = await svc.session(sessionId);
  if (!s) return null;
  if (input.expect !== undefined && s.username.toLowerCase() !== input.expect) {
    throw new MailboxChangedError("another mailbox is active");
  }
  const first = await loadFirstView(
    jmapCaller((body) => svc.jmap(sessionId, body)),
    s.accountId,
    input,
  );
  return { session: jmapSessionDocument(s), ...first };
}
