// SPDX-License-Identifier: AGPL-3.0-only
import { JmapClient, JmapError } from "@anhourmail/jmap-client";

import type { BookView, ContactInput, ContactView } from "@/server/webmail/contacts";
import type { Address, MessageView } from "@/server/webmail/view";

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

export type ListRow = Summary & { threadSize: number };
export type Identity = { id: string; name: string; email: string };
export type Attachment = { blobId: string; name: string; type: string; size: number };
export type DraftPayload = {
  replaces?: string;
  identityId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
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

/** The account the app is showing, sent with contacts changes (the BFF refuses another active mailbox). */
const ACCOUNT = "X-Webmail-Account";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
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
    if (res.status === 400 || res.status === 413 || res.status === 429) {
      throw new RefusedError(body?.error?.message ?? "That didn't work. Try again.");
    }
    throw new Error(`HTTP ${String(res.status)}`);
  }
  return body?.data as T;
}

/** `origin` "" (the default) means same-origin relative URLs, which is what the browser app uses. */
export function createMailClient(origin = "") {
  const jmap = new JmapClient({
    sessionUrl: `${origin}/api/webmail/session`,
    rewriteUrl: (u) => (origin === "" ? u : new URL(u, origin).href),
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
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = Object.fromEntries(ids.slice(i, i + 400).map((id) => [id, patches[id]]));
      const res = await call([["Email/set", { accountId: a, update: chunk }, "s"]]);
      const notUpdated = res.get("s")?.notUpdated as Record<string, unknown> | undefined;
      if (notUpdated && Object.keys(notUpdated).length > 0) throw new Error("Some messages were not updated");
    }
  }

  return {
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
    async page(filter: Condition, position: number, limit = PAGE_SIZE): Promise<{ total: number; rows: ListRow[] }> {
      const a = await accountId();
      const res = await call([
        [
          "Email/query",
          {
            accountId: a,
            filter,
            sort: [{ property: "receivedAt", isAscending: false }],
            collapseThreads: true,
            position,
            limit,
            calculateTotal: true,
          },
          "q",
        ],
        [
          "Email/get",
          { accountId: a, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: SUMMARY },
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
        .map((e) => ({ ...e, threadSize: threads.get(e.threadId) ?? 1 }));
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
      for (let i = 0; i < ids.length; i += 400) {
        const res = await call([["Email/set", { accountId: a, destroy: ids.slice(i, i + 400) }, "s"]]);
        const notDestroyed = res.get("s")?.notDestroyed as Record<string, unknown> | undefined;
        if (notDestroyed && Object.keys(notDestroyed).length > 0) throw new Error("Some messages were not deleted");
      }
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
      const res = await fetch(`${origin}/api/webmail/messages/${encodeURIComponent(id)}${opts.full ? "?full=1" : ""}`, {
        headers: { Accept: "application/json" },
      });
      if (res.status === 401) throw new SignedOutError("signed out");
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`message HTTP ${String(res.status)}`);
      return ((await res.json()) as { data: MessageView }).data;
    },

    /** A forwarded or attached message (message/rfc822) of `emailId`, ready for the reader. */
    async attachedMessage(emailId: string, blobId: string): Promise<MessageView | null> {
      const res = await fetch(
        `${origin}/api/webmail/messages/${encodeURIComponent(emailId)}/attached/${encodeURIComponent(blobId)}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status === 401) throw new SignedOutError("signed out");
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`attached HTTP ${String(res.status)}`);
      return ((await res.json()) as { data: MessageView }).data;
    },

    /** The message source as text for "View original" (first 2 MB). */
    async rawText(emailId: string): Promise<{ text: string; cut: boolean }> {
      const res = await fetch(`${origin}/api/webmail/messages/${encodeURIComponent(emailId)}/raw`);
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

    identities: () => api<Identity[]>(`${origin}/api/webmail/identities`),
    saveDraft: (d: DraftPayload) =>
      api<{ id: string }>(`${origin}/api/webmail/drafts`, { method: "PUT", body: JSON.stringify(d) }),
    send: (draftId: string, identityId: string) =>
      api<{ submissionId: string; sendAt: string }>(`${origin}/api/webmail/send`, {
        method: "POST",
        body: JSON.stringify({ draftId, identityId }),
      }),
    undoSend: (submissionId: string) =>
      api<{ draftId: string }>(`${origin}/api/webmail/send/undo`, {
        method: "POST",
        body: JSON.stringify({ submissionId }),
      }),
    upload: (file: File) =>
      api<Attachment & { blobId: string }>(`${origin}/api/webmail/upload`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      }),
    mailboxes: () => api<{ active: string; others: string[] }>(`${origin}/api/webmail/mailboxes`),
    addMailbox: (address: string, password: string) =>
      api<{ active: string; others: string[] }>(`${origin}/api/webmail/mailboxes`, {
        method: "POST",
        body: JSON.stringify({ address, password }),
      }),
    switchMailbox: (address: string) =>
      api<{ active: string; others: string[] }>(`${origin}/api/webmail/mailboxes/active`, {
        method: "PUT",
        body: JSON.stringify({ address }),
      }),

    contacts: () => api<ContactsData>(`${origin}/api/webmail/contacts`),
    createContact: (account: string, contact: ContactFields, book: "mine" | "other" = "mine") =>
      api<{ id: string }>(`${origin}/api/webmail/contacts`, {
        method: "POST",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ contact, book }),
      }),
    updateContact: (account: string, id: string, contact: ContactFields) =>
      api<{ id: string }>(`${origin}/api/webmail/contacts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify(contact),
      }),
    deleteContacts: (account: string, ids: string[]) =>
      api<{ deleted: number }>(`${origin}/api/webmail/contacts`, {
        method: "DELETE",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ ids }),
      }),
    moveContacts: (account: string, ids: string[], to: "mine" | "other") =>
      api<{ moved: number }>(`${origin}/api/webmail/contacts/move`, {
        method: "POST",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ ids, to }),
      }),
    setAutoSave: (account: string, autoSave: boolean) =>
      api<{ autoSave: boolean }>(`${origin}/api/webmail/contacts/settings`, {
        method: "PUT",
        headers: { [ACCOUNT]: account },
        body: JSON.stringify({ autoSave }),
      }),
    importContacts: (account: string, file: File) =>
      api<{ imported: number; skipped: number; full: boolean }>(`${origin}/api/webmail/contacts/import`, {
        method: "POST",
        headers: { "Content-Type": "text/vcard", [ACCOUNT]: account },
        body: file,
      }),
    exportContactsUrl: (ids?: string[]) =>
      `${origin}/api/webmail/contacts/export${ids && ids.length > 0 ? `?ids=${ids.map(encodeURIComponent).join(",")}` : ""}`,

    async signOut(): Promise<void> {
      await fetch(`${origin}/api/webmail/auth`, { method: "DELETE" });
    },
  };
}
