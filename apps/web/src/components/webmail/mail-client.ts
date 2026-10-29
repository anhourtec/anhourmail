// SPDX-License-Identifier: AGPL-3.0-only
import { JmapClient, JmapError } from "@anhourmail/jmap-client";

import type { WebmailPreferences } from "@anhourmail/shared/webmail";

import type { BookView, ContactInput, ContactView } from "@/server/webmail/contacts";
import type { Junk, Vacation } from "@/server/webmail/sieve";
import type { SettingsOverview } from "@/server/webmail/settings";
import type { Address, MessageView } from "@/server/webmail/view";

import { isLoadedImageType } from "./remote-images";

/**
 * The webmail's data access in the browser. Everything goes to this origin's BFF (`/api/webmail/*`), which holds
 * the Stalwart tokens; the browser never sees one (ADR-0003). Lists use thread-collapsed `Email/query` windows and
 * summary properties only; bodies come sanitised from `/api/webmail/messages/:id`; drafts, sending, uploads and
 * mailbox switching use their own BFF endpoints (the proxy can't create or send mail).
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
export type Identity = { id: string; name: string; email: string; signature?: string };
export type { SettingsOverview };
export type Attachment = { blobId: string; name: string; type: string; size: number };
export type DraftPayload = {
  replaces?: string;
  identityId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  /** Rich-text body, already sanitised by the composer (the server sanitises it again). */
  html?: string;
  inReplyTo?: string[];
  references?: string[];
  attachments: Attachment[];
};

/** What the list shows: a folder, or "Priority" (flagged everywhere but Trash and Junk). */
export type View = { kind: "folder"; id: string } | { kind: "priority" };

export type ContactsData = {
  /** The account these contacts belong to: sent back with every change, refused if another mailbox is active. */
  accountId: string;
  books: BookView[];
  contacts: ContactView[];
  autoSave: boolean;
  /** More than the 5,000 shown. */
  truncated: boolean;
};
/** The fields the contact form edits (the BFF validates and builds the card). */
export type ContactFields = ContactInput;

/** List narrowing from the filter menu and the search box. */
export type ListFilter = {
  unread?: boolean;
  flagged?: boolean;
  attachments?: boolean;
  /** Parsed search (see `parseSearch`); searching covers every folder but Trash and Junk. */
  search?: SearchQuery | null;
};

export type SearchQuery = {
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  unread?: boolean;
  flagged?: boolean;
};

export class SignedOutError extends Error {
  override readonly name = "SignedOutError";
}

/** A refusal from the BFF with a message meant for the person (e.g. "You can only send from your own addresses."). */
export class RefusedError extends Error {
  override readonly name = "RefusedError";
}

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const SUMMARY = [
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
export const PAGE_SIZE = 50;
const PINNED_LIMIT = 50;

type Condition = Record<string, unknown>;

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

export type MailClient = ReturnType<typeof createMailClient>;

/** What `remoteImage` answers for an expired image link (never a `data:` URL). */
export const IMAGE_LINK_EXPIRED = "expired";

/** A raster image blob as a `data:` URL; null for any other type (the proxy only serves these). */
export async function imageDataUrl(blob: Blob): Promise<string | null> {
  if (!isLoadedImageType(blob.type)) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(bin)}`;
}

/** The account the app is showing, sent with contacts changes (the BFF refuses another active mailbox). */
const ACCOUNT = "X-Webmail-Account";

/** The browser's fetch, called plainly (browsers throw "Illegal invocation" when it is called with another `this`). */
const plainFetch: typeof fetch = (input, init) => fetch(input, init);

async function api<T>(path: string, init: RequestInit = {}, go: typeof fetch = plainFetch): Promise<T> {
  const res = await go(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body && !(init.body instanceof Blob) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string } } | null;
  // A wrong password while adding a mailbox is a refusal, not the end of this session.
  if (res.status === 401 && body?.error?.code === "invalid_credentials") {
    throw new RefusedError(body.error.message ?? "Mailbox address or password is wrong.");
  }
  if (res.status === 401) throw new SignedOutError("signed out");
  if (!res.ok) {
    // An administrator's new password not in use yet: the own password change says so (409 with its own code).
    const pending = res.status === 409 && body?.error?.code === "password_change_pending";
    if (res.status === 400 || res.status === 413 || res.status === 429 || pending) {
      throw new RefusedError(body?.error?.message ?? "That didn't work. Try again.");
    }
    throw new Error(`HTTP ${String(res.status)}`);
  }
  return body?.data as T;
}

const asState = (v: unknown): string => (typeof v === "string" ? v : "");

/** Where automatic refresh is: the mail server's `Email` and `Mailbox` states after the last check. */
export type SyncState = { email: string; mailbox: string };

/** `origin` "" (the default) means same-origin relative URLs, which is what the browser app uses. */
export function createMailClient(origin = "") {
  /** Rows are conversations (keys are thread ids) or single messages (keys are email ids). */
  let grouping: Grouping = "conversations";

  // A webmail session shows one active mailbox, and the BFF answers every request for that one. Adding or switching
  // a mailbox changes it for the whole session, so a request still on its way (a list refresh, a reload after a
  // send) would reach the new mailbox with the old one's account id and ids, which the proxy refuses (400). So a
  // change waits until the requests in flight have been answered and holds new ones while it runs. On success it
  // keeps holding them: the app reloads to show the other mailbox, so they are never sent.
  let inFlight = 0;
  const drained: (() => void)[] = [];
  let hold: Promise<void> | null = null;

  /** Every request of this client except the mailbox change itself goes through here. */
  async function gated<T>(fn: () => Promise<T>): Promise<T> {
    while (hold) await hold;
    inFlight += 1;
    try {
      return await fn();
    } finally {
      inFlight -= 1;
      if (inFlight === 0) for (const done of drained.splice(0)) done();
    }
  }

  /** Runs a mailbox change (add or switch) once nothing else is in flight; the caller reloads the page on success. */
  async function changeMailbox<T>(fn: () => Promise<T>): Promise<T> {
    while (hold) await hold;
    let release: (() => void) | undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      if (inFlight > 0) await new Promise<void>((resolve) => drained.push(resolve));
      return await fn();
    } catch (err) {
      hold = null;
      release?.();
      throw err;
    }
  }

  // Anything that changes which folders messages are in, or their read or draft state, tells the listeners when it
  // has been answered (folder counts reload from there, in one place, whatever the action). A refusal changed
  // nothing; any other failure may have changed part of it (a batch), so it tells them too.
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own; the change itself went through.
      }
    }
  };
  async function mutating<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      changed();
      return result;
    } catch (err) {
      if (!(err instanceof SignedOutError) && !(err instanceof RefusedError)) changed();
      throw err;
    }
  }

  const net: typeof fetch = (input, init) => gated(() => fetch(input, init));
  const bff = <T>(path: string, init: RequestInit = {}) => api<T>(path, init, net);

  const jmap = new JmapClient({
    sessionUrl: `${origin}/api/webmail/session`,
    rewriteUrl: (u) => (origin === "" ? u : new URL(u, origin).href),
    fetch: net,
  });

  async function call(calls: [string, Record<string, unknown>, string][]) {
    try {
      return await jmap.request(calls, USING);
    } catch (err) {
      if (err instanceof JmapError && err.type === "http") {
        const status = (err.detail as { status?: number } | undefined)?.status;
        if (status === 401) throw new SignedOutError("signed out");
        if (status === 400) throw new RefusedError("That action isn't available.");
      }
      throw err;
    }
  }

  const accountId = async () => {
    try {
      return await jmap.accountId();
    } catch (err) {
      if (err instanceof JmapError && (err.detail as { status?: number } | undefined)?.status === 401) {
        throw new SignedOutError("signed out");
      }
      throw err;
    }
  };

  /** Every message of these threads (mailbox memberships and keywords), for whole-conversation actions. */
  async function threadEmails(threadIds: string[]): Promise<{ id: string; mailboxIds: Record<string, boolean> }[]> {
    if (threadIds.length === 0) return [];
    const a = await accountId();
    if (grouping === "messages") {
      // Each row is one message: its key is the email id.
      const res = await call([["Email/get", { accountId: a, ids: threadIds, properties: ["mailboxIds"] }, "g"]]);
      return (res.get("g")?.list ?? []) as { id: string; mailboxIds: Record<string, boolean> }[];
    }
    const res = await call([
      ["Thread/get", { accountId: a, ids: threadIds }, "t"],
      [
        "Email/get",
        {
          accountId: a,
          "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
          properties: ["mailboxIds"],
        },
        "g",
      ],
    ]);
    return (res.get("g")?.list ?? []) as { id: string; mailboxIds: Record<string, boolean> }[];
  }

  async function update(patches: Record<string, Record<string, unknown>>): Promise<void> {
    const ids = Object.keys(patches);
    if (ids.length === 0) return;
    const a = await accountId();
    await mutating(async () => {
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = Object.fromEntries(ids.slice(i, i + 400).map((id) => [id, patches[id]]));
        const res = await call([["Email/set", { accountId: a, update: chunk }, "s"]]);
        const notUpdated = res.get("s")?.notUpdated as Record<string, unknown> | undefined;
        if (notUpdated && Object.keys(notUpdated).length > 0) throw new Error("Some messages were not updated");
      }
    });
  }

  return {
    /** Switches how rows are keyed and listed (a preference); the app reloads the list afterwards. */
    setGrouping(next: Grouping): void {
      grouping = next;
    },
    get grouping(): Grouping {
      return grouping;
    },

    /**
     * Calls `listener` after every change this client makes to folder membership or read/draft state (moves,
     * keywords, deletes, saving a new draft, sending, undoing a send). Returns the unsubscribe.
     */
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async folders(): Promise<Folder[]> {
      const a = await accountId();
      const res = await call([
        [
          "Mailbox/get",
          {
            accountId: a,
            ids: null,
            properties: [
              "name",
              "role",
              "parentId",
              "sortOrder",
              "totalEmails",
              "unreadEmails",
              "totalThreads",
              "unreadThreads",
            ],
          },
          "m",
        ],
      ]);
      return (res.get("m")?.list ?? []) as Folder[];
    },

    /** How many flagged messages there are outside Trash and Junk ("Priority"). */
    async priorityCount(hidden: string[]): Promise<number> {
      const a = await accountId();
      const res = await call([
        [
          "Email/query",
          {
            accountId: a,
            filter: listFilter({ kind: "priority" }, {}, hidden),
            limit: 0,
            calculateTotal: true,
          },
          "q",
        ],
      ]);
      return Number(res.get("q")?.total ?? 0);
    },

    /** One window of the thread-collapsed list, newest first, with each thread's size. */
    async page(
      filter: Condition,
      position: number,
      limit = PAGE_SIZE,
      opts: { attachments?: boolean } = {},
    ): Promise<{ total: number; rows: ListRow[] }> {
      const a = await accountId();
      const properties = opts.attachments ? [...SUMMARY, "attachments"] : SUMMARY;
      const res = await call([
        [
          "Email/query",
          {
            accountId: a,
            filter,
            sort: [{ property: "receivedAt", isAscending: false }],
            collapseThreads: grouping === "conversations",
            position,
            limit,
            calculateTotal: true,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId: a,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties,
            ...(opts.attachments ? { bodyProperties: ["name", "type"] } : {}),
          },
          "g",
        ],
        ["Thread/get", { accountId: a, "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" } }, "t"],
      ]);
      const ids = (res.get("q")?.ids ?? []) as string[];
      const total = Number(res.get("q")?.total ?? ids.length);
      const emails = new Map(((res.get("g")?.list ?? []) as Summary[]).map((e) => [e.id, e]));
      const threads = new Map(
        ((res.get("t")?.list ?? []) as { id: string; emailIds: string[] }[]).map((t) => [t.id, t.emailIds.length]),
      );
      const rows = ids
        .map((id) => emails.get(id))
        .filter((e): e is Summary => e !== undefined)
        .map((e) => ({ ...e, threadSize: grouping === "messages" ? 1 : (threads.get(e.threadId) ?? 1) }));
      return { total, rows };
    },

    pinnedLimit: PINNED_LIMIT,

    /** Every message in a thread, oldest first (summaries only). */
    async thread(threadId: string): Promise<Summary[]> {
      const a = await accountId();
      const res = await call([
        ["Thread/get", { accountId: a, ids: [threadId] }, "t"],
        [
          "Email/get",
          {
            accountId: a,
            "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
            properties: SUMMARY,
          },
          "g",
        ],
      ]);
      return ((res.get("g")?.list ?? []) as Summary[]).sort((x, y) => x.receivedAt.localeCompare(y.receivedAt));
    },

    /**
     * A message's header fields in order, topmost first (for "mailed-by" and "signed-by"): deciding whether an
     * `Authentication-Results` header is our server's needs its position relative to `Received`.
     */
    async traceHeaders(emailId: string): Promise<{ name: string; value: string }[]> {
      const a = await accountId();
      const res = await call([["Email/get", { accountId: a, ids: [emailId], properties: ["headers"] }, "g"]]);
      const e = ((res.get("g")?.list ?? []) as Record<string, unknown>[])[0];
      const v = e?.headers;
      if (!Array.isArray(v)) return [];
      return v.flatMap((h: unknown) => {
        if (typeof h !== "object" || h === null) return [];
        const { name, value } = h as { name?: unknown; value?: unknown };
        return typeof name === "string" && typeof value === "string" ? [{ name, value: value.trim() }] : [];
      });
    },

    /**
     * The mail state for automatic refresh, in one request: with `since` null just the current states; otherwise
     * what changed since then (`Email/changes`, with the newly created messages' summaries for the new-mail sound,
     * and `Mailbox/changes`, whose counts move when mail is read, moved or deleted anywhere — another device, an
     * IMAP app). `reset` when the server can't say (a state is too old): the caller reloads everything.
     */
    async mailChanges(since: SyncState | null): Promise<{
      state: SyncState;
      /** Messages were created, changed or removed since `since`. */
      changed: boolean;
      /** Folders changed since `since` (their counts, names or the folders themselves). */
      foldersChanged: boolean;
      created: Summary[];
      /** Ids of messages changed (keywords, folders) or removed since `since`. */
      touched: string[];
      reset: boolean;
    }> {
      const a = await accountId();
      const current = async (): Promise<SyncState> => {
        const res = await call([
          ["Email/get", { accountId: a, ids: [], properties: ["id"] }, "g"],
          ["Mailbox/get", { accountId: a, ids: [], properties: ["id"] }, "m"],
        ]);
        return { email: asState(res.get("g")?.state), mailbox: asState(res.get("m")?.state) };
      };
      if (since === null) {
        return {
          state: await current(),
          changed: false,
          foldersChanged: false,
          created: [],
          touched: [],
          reset: false,
        };
      }
      try {
        const res = await call([
          ["Email/changes", { accountId: a, sinceState: since.email, maxChanges: 200 }, "c"],
          [
            "Email/get",
            {
              accountId: a,
              "#ids": { resultOf: "c", name: "Email/changes", path: "/created" },
              properties: SUMMARY,
            },
            "g",
          ],
          ["Mailbox/changes", { accountId: a, sinceState: since.mailbox, maxChanges: 200 }, "b"],
        ]);
        const c = res.get("c") ?? {};
        const b = res.get("b") ?? {};
        const count = (r: Record<string, unknown>, k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).length : 0);
        const moved = (r: Record<string, unknown>) => count(r, "created") + count(r, "updated") + count(r, "destroyed");
        const ids = (k: string) =>
          Array.isArray(c[k]) ? (c[k] as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const state = { email: asState(c.newState) || since.email, mailbox: asState(b.newState) || since.mailbox };
        return {
          state,
          changed: state.email !== since.email || moved(c) > 0,
          foldersChanged: state.mailbox !== since.mailbox || moved(b) > 0,
          created: (res.get("g")?.list ?? []) as Summary[],
          touched: [...ids("updated"), ...ids("destroyed")],
          reset: c.hasMoreChanges === true,
        };
      } catch (err) {
        if (err instanceof JmapError && err.type === "cannotCalculateChanges") {
          return { state: await current(), changed: true, foldersChanged: true, created: [], touched: [], reset: true };
        }
        throw err;
      }
    },

    /** Sets or clears a keyword on messages. */
    async setKeyword(ids: string[], keyword: string, on: boolean): Promise<void> {
      await update(Object.fromEntries(ids.map((id) => [id, { [`keywords/${keyword}`]: on ? true : null }])));
    },

    threadEmails,

    /**
     * Moves the messages of these threads that are in `from` (or, with `from` null, all of them) to `to`, with
     * optional keyword changes. Returns the previous memberships so the move can be undone.
     */
    async move(
      threadIds: string[],
      from: string | null,
      to: string,
      keywords: Record<string, boolean | null> = {},
      /** With `from` null: leave messages in these folders alone (e.g. your copies in Sent and Drafts). */
      skip: string[] = [],
    ): Promise<Record<string, Record<string, boolean>>> {
      const emails = (await threadEmails(threadIds)).filter((e) =>
        from === null ? !skip.some((id) => e.mailboxIds[id]) : e.mailboxIds[from],
      );
      const before = Object.fromEntries(emails.map((e) => [e.id, e.mailboxIds]));
      const kw = Object.fromEntries(Object.entries(keywords).map(([k, v]) => [`keywords/${k}`, v]));
      await update(
        Object.fromEntries(
          emails.map((e) => [
            e.id,
            from === null
              ? { mailboxIds: { [to]: true }, ...kw }
              : { [`mailboxIds/${from}`]: null, [`mailboxIds/${to}`]: true, ...kw },
          ]),
        ),
      );
      return before;
    },

    /**
     * "Restore" from Trash: each message of these threads that is in Trash goes to the folder `target` picks for it
     * (by its sender). Returns the previous memberships so it can be undone, and where messages went.
     */
    async restoreFromTrash(
      threadIds: string[],
      trashId: string,
      target: (from: Address[] | null) => string | undefined,
      keywords: Record<string, boolean | null> = {},
    ): Promise<{ before: Record<string, Record<string, boolean>>; targets: string[] }> {
      if (threadIds.length === 0) return { before: {}, targets: [] };
      const a = await accountId();
      const props = ["mailboxIds", "from"];
      const res =
        grouping === "messages"
          ? await call([["Email/get", { accountId: a, ids: threadIds, properties: props }, "g"]])
          : await call([
              ["Thread/get", { accountId: a, ids: threadIds }, "t"],
              [
                "Email/get",
                {
                  accountId: a,
                  "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
                  properties: props,
                },
                "g",
              ],
            ]);
      const emails = (
        (res.get("g")?.list ?? []) as { id: string; mailboxIds: Record<string, boolean>; from: Address[] | null }[]
      ).filter((e) => e.mailboxIds[trashId]);
      const kw = Object.fromEntries(Object.entries(keywords).map(([k, v]) => [`keywords/${k}`, v]));
      const patches: Record<string, Record<string, unknown>> = {};
      const targets = new Set<string>();
      for (const e of emails) {
        const to = target(e.from);
        if (!to) continue;
        targets.add(to);
        patches[e.id] = { [`mailboxIds/${trashId}`]: null, [`mailboxIds/${to}`]: true, ...kw };
      }
      await update(patches);
      return {
        before: Object.fromEntries(emails.filter((e) => patches[e.id]).map((e) => [e.id, e.mailboxIds])),
        targets: [...targets],
      };
    },

    /** Puts messages back where they were (undo for a move). */
    async restore(before: Record<string, Record<string, boolean>>): Promise<void> {
      await update(
        Object.fromEntries(
          Object.entries(before).map(([id, boxes]) => [
            id,
            {
              mailboxIds: Object.fromEntries(
                Object.keys(boxes)
                  .filter((b) => boxes[b])
                  .map((b) => [b, true]),
              ),
            },
          ]),
        ),
      );
    },

    /** Marks everything matching `filter` as read, in batches. */
    async markAllRead(filter: Condition): Promise<void> {
      const a = await accountId();
      for (let round = 0; round < 25; round++) {
        const res = await call([
          [
            "Email/query",
            { accountId: a, filter: { operator: "AND", conditions: [filter, { notKeyword: "$seen" }] }, limit: 400 },
            "q",
          ],
        ]);
        const ids = (res.get("q")?.ids ?? []) as string[];
        if (ids.length === 0) return;
        await update(Object.fromEntries(ids.map((id) => [id, { "keywords/$seen": true }])));
      }
    },

    /** Deletes forever (only allowed for messages in Trash or Junk; the BFF checks). */
    async destroy(ids: string[]): Promise<void> {
      const a = await accountId();
      await mutating(async () => {
        for (let i = 0; i < ids.length; i += 400) {
          const res = await call([["Email/set", { accountId: a, destroy: ids.slice(i, i + 400) }, "s"]]);
          const notDestroyed = res.get("s")?.notDestroyed as Record<string, unknown> | undefined;
          if (notDestroyed && Object.keys(notDestroyed).length > 0) throw new Error("Some messages were not deleted");
        }
      });
    },

    /** Deletes everything in a Trash or Junk folder, in batches. */
    async emptyFolder(mailboxId: string): Promise<void> {
      const a = await accountId();
      for (let round = 0; round < 50; round++) {
        const res = await call([["Email/query", { accountId: a, filter: { inMailbox: mailboxId }, limit: 400 }, "q"]]);
        const ids = (res.get("q")?.ids ?? []) as string[];
        if (ids.length === 0) return;
        await this.destroy(ids);
      }
    },

    /**
     * People this mailbox recently wrote to (and heard from), most emailed first: how many of the last 200 sent
     * messages went to each (for address suggestions).
     */
    async recentCorrespondents(sentId: string | undefined): Promise<(Address & { score: number })[]> {
      const a = await accountId();
      const filter = sentId ? { inMailbox: sentId } : {};
      const res = await call([
        [
          "Email/query",
          { accountId: a, filter, sort: [{ property: "receivedAt", isAscending: false }], limit: 200 },
          "q",
        ],
        [
          "Email/get",
          {
            accountId: a,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["to", "cc", "from"],
          },
          "g",
        ],
      ]);
      const seen = new Map<string, Address & { score: number }>();
      for (const e of (res.get("g")?.list ?? []) as {
        to: Address[] | null;
        cc: Address[] | null;
        from: Address[] | null;
      }[]) {
        for (const x of [...(e.to ?? []), ...(e.cc ?? []), ...(e.from ?? [])]) {
          const key = x.email.toLowerCase();
          const cur = seen.get(key);
          if (cur) {
            cur.score += 1;
            if (!cur.name && x.name) cur.name = x.name;
          } else seen.set(key, { name: x.name, email: key, score: 1 });
        }
      }
      return [...seen.values()].sort((x, y) => y.score - x.score);
    },

    /** The sanitised message for the reader; null when it no longer exists. `full` lifts the body cap. */
    async message(id: string, opts: { full?: boolean } = {}): Promise<MessageView | null> {
      const res = await net(`${origin}/api/webmail/messages/${encodeURIComponent(id)}${opts.full ? "?full=1" : ""}`, {
        headers: { Accept: "application/json" },
      });
      if (res.status === 401) throw new SignedOutError("signed out");
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`message HTTP ${String(res.status)}`);
      return ((await res.json()) as { data: MessageView }).data;
    },

    /** A forwarded or attached message (message/rfc822) of `emailId`, ready for the reader. */
    async attachedMessage(emailId: string, blobId: string): Promise<MessageView | null> {
      const res = await net(
        `${origin}/api/webmail/messages/${encodeURIComponent(emailId)}/attached/${encodeURIComponent(blobId)}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status === 401) throw new SignedOutError("signed out");
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`attached HTTP ${String(res.status)}`);
      return ((await res.json()) as { data: MessageView }).data;
    },

    /**
     * One remote image through the image proxy, as a `data:` URL for the message frame (which loads nothing itself).
     * `EXPIRED` when the message's image links are too old (load the message again); null when it can't be loaded.
     */
    async remoteImage(token: string): Promise<string | null> {
      for (let attempt = 0; ; attempt++) {
        const res = await net(`${origin}/api/webmail/img`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (res.status === 401) throw new SignedOutError("signed out");
        if (res.status === 410) return IMAGE_LINK_EXPIRED;
        // The server is busy with other images: wait a moment, twice at most.
        if (res.status === 429 && attempt < 2) {
          await res.body?.cancel();
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          return null;
        }
        return imageDataUrl(await res.blob());
      }
    },

    /** The message source as text for "View original" (first 2 MB). */
    async rawText(emailId: string): Promise<{ text: string; cut: boolean }> {
      const res = await net(`${origin}/api/webmail/messages/${encodeURIComponent(emailId)}/raw`);
      if (res.status === 401) throw new SignedOutError("signed out");
      if (!res.ok) throw new Error(`raw HTTP ${String(res.status)}`);
      const text = await res.text();
      const max = 2 * 1024 * 1024;
      return { text: text.slice(0, max), cut: text.length > max };
    },

    rawDownloadUrl: (emailId: string) => `${origin}/api/webmail/messages/${encodeURIComponent(emailId)}/raw?download=1`,
    printUrl: (emailId: string) => `${origin}/api/webmail/messages/${encodeURIComponent(emailId)}/print`,
    /** Inline preview of a raster image attachment (served only as that image type). */
    previewUrl: (blobId: string, type: string) =>
      `${origin}/api/webmail/preview/${encodeURIComponent(blobId)}?type=${encodeURIComponent(type)}`,

    /** The attachment's URL. Its name goes on the link's `download` attribute, never in the URL. */
    downloadUrl(blobId: string): string {
      return `${origin}/api/webmail/download/${encodeURIComponent(blobId)}`;
    },

    identities: () => bff<Identity[]>(`${origin}/api/webmail/identities`),
    // Drafts, sending, undo and uploads carry the account this tab shows: if another tab switched the session to a
    // different mailbox meanwhile, the BFF refuses (400) instead of acting on that other mailbox.
    // A new draft adds one to Drafts; saving over an existing one (`replaces`) leaves the count as it was.
    saveDraft: async (d: DraftPayload) => {
      const headers = { [ACCOUNT]: await accountId() };
      const save = () =>
        bff<{ id: string }>(`${origin}/api/webmail/drafts`, { method: "PUT", headers, body: JSON.stringify(d) });
      return d.replaces ? save() : mutating(save);
    },
    // Sending moves the draft from Drafts to Sent; undoing puts it back.
    send: async (draftId: string, identityId: string) => {
      const headers = { [ACCOUNT]: await accountId() };
      return mutating(() =>
        bff<{ submissionId: string; sendAt: string; holdSeconds: number }>(`${origin}/api/webmail/send`, {
          method: "POST",
          headers,
          body: JSON.stringify({ draftId, identityId }),
        }),
      );
    },
    undoSend: async (submissionId: string) => {
      const headers = { [ACCOUNT]: await accountId() };
      return mutating(() =>
        bff<{ draftId: string }>(`${origin}/api/webmail/send/undo`, {
          method: "POST",
          headers,
          body: JSON.stringify({ submissionId }),
        }),
      );
    },
    upload: async (file: File) =>
      bff<Attachment & { blobId: string }>(`${origin}/api/webmail/upload`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", [ACCOUNT]: await accountId() },
        body: file,
      }),
    mailboxes: () => bff<{ active: string; others: string[] }>(`${origin}/api/webmail/mailboxes`),
    /** Signs another mailbox in and makes it active; reload the page on success (other requests stay held). */
    addMailbox: (address: string, password: string) =>
      changeMailbox(() =>
        api<{ active: string; others: string[] }>(`${origin}/api/webmail/mailboxes`, {
          method: "POST",
          body: JSON.stringify({ address, password }),
        }),
      ),
    /** Makes another signed-in mailbox active; reload the page on success (other requests stay held). */
    switchMailbox: (address: string) =>
      changeMailbox(() =>
        api<{ active: string; others: string[] }>(`${origin}/api/webmail/mailboxes/active`, {
          method: "PUT",
          body: JSON.stringify({ address }),
        }),
      ),

    contacts: () => bff<ContactsData>(`${origin}/api/webmail/contacts`),
    createContact: (account: string, contact: ContactFields, book: "mine" | "other" = "mine") =>
      bff<{ id: string }>(`${origin}/api/webmail/contacts`, {
        method: "POST",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ contact, book }),
      }),
    updateContact: (account: string, id: string, contact: ContactFields) =>
      bff<{ id: string }>(`${origin}/api/webmail/contacts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify(contact),
      }),
    deleteContacts: (account: string, ids: string[]) =>
      bff<{ deleted: number }>(`${origin}/api/webmail/contacts`, {
        method: "DELETE",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ ids }),
      }),
    moveContacts: (account: string, ids: string[], to: "mine" | "other") =>
      bff<{ moved: number }>(`${origin}/api/webmail/contacts/move`, {
        method: "POST",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ ids, to }),
      }),
    setAutoSave: (account: string, autoSave: boolean) =>
      bff<{ autoSave: boolean }>(`${origin}/api/webmail/contacts/settings`, {
        method: "PUT",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ autoSave }),
      }),
    importContacts: (account: string, file: File) =>
      bff<{ imported: number; skipped: number; full: boolean }>(`${origin}/api/webmail/contacts/import`, {
        method: "POST",
        headers: { "Content-Type": "text/vcard", [ACCOUNT]: account },
        body: file,
      }),
    exportContactsUrl: (ids?: string[]) =>
      `${origin}/api/webmail/contacts/export${ids && ids.length > 0 ? `?ids=${ids.map(encodeURIComponent).join(",")}` : ""}`,

    settings: () => bff<SettingsOverview>(`${origin}/api/webmail/settings`),
    /** Saves preferences for the mailbox the app shows (its JMAP account id; refused if another became active). */
    updatePreferences: async (patch: Partial<WebmailPreferences>) =>
      bff<WebmailPreferences>(`${origin}/api/webmail/settings/preferences`, {
        method: "PATCH",
        headers: { [ACCOUNT]: await accountId() },
        body: JSON.stringify(patch),
      }),
    updateIdentity: (account: string, id: string, change: { name?: string; signature?: string }) =>
      bff<Identity>(`${origin}/api/webmail/settings/identities/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify(change),
      }),
    saveVacation: (account: string, vacation: Vacation, timeZone: string) =>
      bff<Vacation>(`${origin}/api/webmail/settings/vacation`, {
        method: "PUT",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ vacation, timeZone }),
      }),
    saveJunk: (account: string, junk: Junk) =>
      bff<Junk>(`${origin}/api/webmail/settings/junk`, {
        method: "PUT",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify(junk),
      }),
    requestForwarding: (account: string, address: string) =>
      bff<{ target: string; emailed: boolean }>(`${origin}/api/webmail/settings/forwarding`, {
        method: "POST",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ address }),
      }),
    setForwarding: (account: string, enabled: boolean, keepCopy: boolean) =>
      bff<{ enabled: boolean; address: string | null; keepCopy: boolean }>(
        `${origin}/api/webmail/settings/forwarding`,
        {
          method: "PUT",
          headers: { [ACCOUNT]: account },
          body: JSON.stringify({ enabled, keepCopy }),
        },
      ),
    /** Changes the mailbox's own password (current one checked by the mail server); this session stays signed in. */
    changePassword: (account: string, current: string, next: string) =>
      bff<{ applied: boolean; signedIn: boolean }>(`${origin}/api/webmail/settings/password`, {
        method: "POST",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ current, next }),
      }),
    removeForwarding: (account: string) =>
      bff<{ removed: boolean }>(`${origin}/api/webmail/settings/forwarding`, {
        method: "DELETE",
        headers: { [ACCOUNT]: account },
      }),

    async signOut(): Promise<void> {
      await fetch(`${origin}/api/webmail/auth`, { method: "DELETE" });
    },
  };
}
