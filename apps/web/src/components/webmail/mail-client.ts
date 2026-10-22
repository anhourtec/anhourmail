// SPDX-License-Identifier: AGPL-3.0-only
import { JmapClient, JmapError } from "@anhourmail/jmap-client";

import type { Address, MessageView } from "@/server/webmail/view";

/**
 * The webmail's data access in the browser. Everything goes to this origin's BFF (`/api/webmail/*`), which holds
 * the Stalwart token; the browser never sees one (ADR-0003). Lists use thread-collapsed `Email/query` windows
 * and summary properties only; bodies come sanitised from `/api/webmail/messages/:id`.
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
  subject: string | null;
  receivedAt: string;
  preview: string;
  hasAttachment: boolean;
};

export type ListRow = Summary & { threadSize: number };

export class SignedOutError extends Error {
  override readonly name = "SignedOutError";
}

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const SUMMARY = [
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "subject",
  "receivedAt",
  "preview",
  "hasAttachment",
];
export const PAGE_SIZE = 50;

export type MailClient = ReturnType<typeof createMailClient>;

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

    /** One window of the thread-collapsed list, newest first, with each thread's size. */
    async page(mailboxId: string, position: number): Promise<{ total: number; rows: ListRow[] }> {
      const a = await accountId();
      const res = await call([
        [
          "Email/query",
          {
            accountId: a,
            filter: { inMailbox: mailboxId },
            sort: [{ property: "receivedAt", isAscending: false }],
            collapseThreads: true,
            position,
            limit: PAGE_SIZE,
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

    /** Sets or clears a keyword ($seen, $flagged) on messages. */
    async setKeyword(ids: string[], keyword: "$seen" | "$flagged", on: boolean): Promise<void> {
      if (ids.length === 0) return;
      const a = await accountId();
      const update = Object.fromEntries(ids.map((id) => [id, { [`keywords/${keyword}`]: on ? true : null }]));
      const res = await call([["Email/set", { accountId: a, update }, "s"]]);
      const notUpdated = res.get("s")?.notUpdated as Record<string, unknown> | undefined;
      if (notUpdated && Object.keys(notUpdated).length > 0) throw new Error("Some messages were not updated");
    },

    /** The sanitised message for the reader; null when it no longer exists. */
    async message(id: string): Promise<MessageView | null> {
      const res = await fetch(`${origin}/api/webmail/messages/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
      });
      if (res.status === 401) throw new SignedOutError("signed out");
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`message HTTP ${String(res.status)}`);
      return ((await res.json()) as { data: MessageView }).data;
    },

    /** The attachment's URL. Its name goes on the link's `download` attribute, never in the URL. */
    downloadUrl(blobId: string): string {
      return `${origin}/api/webmail/download/${encodeURIComponent(blobId)}`;
    },

    async signOut(): Promise<void> {
      await fetch(`${origin}/api/webmail/auth`, { method: "DELETE" });
    },
  };
}
