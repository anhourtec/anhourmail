// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Inbox, Keyboard, Menu, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MessageListSkeleton } from "@anhourmail/ui/skeletons";

import { FolderSidebar } from "./folder-sidebar";
import { folderLabel } from "./format";
import { createMailClient, type Folder, type ListRow, PAGE_SIZE, SignedOutError } from "./mail-client";
import { MessageList } from "./message-list";
import { Reader } from "./reader";

type ListState = { folderId: string; total: number | null; rows: (ListRow | undefined)[]; loaded: Set<number> };

const EMPTY_COPY: Record<string, string> = {
  inbox: "New mail lands here.",
  drafts: "Messages you start and don't send are kept here.",
  sent: "Mail you send is kept here.",
  archive: "Archive messages to keep them out of the Inbox without deleting them.",
  junk: "Messages our filters think are junk land here.",
  trash: "Deleted messages stay here for 30 days.",
};

const SHORTCUTS: [string, string][] = [
  ["j / k", "Next / previous conversation"],
  ["Enter or o", "Open"],
  ["u or Esc", "Back to the list"],
  ["s", "Flag or unflag"],
  ["Shift+U / Shift+I", "Mark unread / read"],
  ["?", "Show these shortcuts"],
];

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * The webmail (Phase 4, slice 1): folders · thread list · reader on wide screens, one pane at a time on phones.
 * Reads through the same-origin BFF only. Actions are optimistic and roll back on failure.
 */
export function WebmailApp({ username, signInHref }: { username: string; signInHref: string }) {
  const client = useMemo(() => createMailClient(), []);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [list, setList] = useState<ListState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const readerActions = useRef<{ toggleFlag: () => void; setRead: (read: boolean) => void } | null>(null);

  const signedOut = useCallback(() => {
    window.location.assign(signInHref);
  }, [signInHref]);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof SignedOutError) signedOut();
      else setError("Couldn't reach the mail server. Check your connection and try again.");
    },
    [signedOut],
  );

  const loadFolders = useCallback(async () => {
    try {
      setFolders(await client.folders());
    } catch (err) {
      fail(err);
    }
  }, [client, fail]);

  const loadPage = useCallback(
    async (fid: string, page: number) => {
      const key = `${fid}:${String(page)}`;
      if (pending.current.has(key)) return;
      pending.current.add(key);
      try {
        const { total, rows } = await client.page(fid, page * PAGE_SIZE);
        setList((cur) => {
          if (cur?.folderId !== fid) return cur;
          const next = [...cur.rows];
          next.length = total;
          rows.forEach((r, i) => {
            next[page * PAGE_SIZE + i] = r;
          });
          return { ...cur, total, rows: next, loaded: new Set([...cur.loaded, page]) };
        });
        setError(null);
      } catch (err) {
        fail(err);
      } finally {
        pending.current.delete(key);
      }
    },
    [client, fail],
  );

  /** Shows a folder: a fresh list and its first window. */
  const switchFolder = useCallback(
    (fid: string) => {
      setFolderId(fid);
      setList({ folderId: fid, total: null, rows: [], loaded: new Set() });
      setSelected(null);
      setOpenThread(null);
      void loadPage(fid, 0);
    },
    [loadPage],
  );

  // First paint: folders, then the Inbox.
  useEffect(() => {
    let live = true;
    client
      .folders()
      .then((f) => {
        if (!live) return;
        setFolders(f);
        const first = f.find((x) => x.role === "inbox") ?? f[0];
        if (first) switchFolder(first.id);
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [client, fail, switchFolder]);

  const onRange = useCallback(
    (start: number, end: number) => {
      if (!list) return;
      if (list.total === null) return;
      for (let p = Math.floor(start / PAGE_SIZE); p <= Math.floor(Math.max(start, end - 1) / PAGE_SIZE); p++) {
        if (!list.loaded.has(p)) void loadPage(list.folderId, p);
      }
    },
    [list, loadPage],
  );

  const refresh = useCallback(() => {
    void loadFolders();
    if (list) {
      const fid = list.folderId;
      for (const p of list.loaded) void loadPage(fid, p);
    }
  }, [list, loadFolders, loadPage]);

  // Until push lands (next slice): refresh when the tab comes back, and a 5-minute safety resync.
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onFocus);
    const t = window.setInterval(refresh, 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(t);
    };
  }, [refresh]);

  const folder = folders?.find((f) => f.id === folderId) ?? null;
  const hiddenMailboxIds = useMemo(
    () =>
      (folders ?? []).filter((f) => (f.role === "trash" || f.role === "junk") && f.id !== folderId).map((f) => f.id),
    [folders, folderId],
  );

  /** Optimistic keyword change on list rows and folder counts; rolls back if the server refuses. */
  const onKeyword = useCallback(
    async (ids: string[], keyword: "$seen" | "$flagged", on: boolean) => {
      const apply = (value: boolean) => {
        setList((cur) =>
          cur
            ? {
                ...cur,
                rows: cur.rows.map((r) =>
                  r && ids.includes(r.id) ? { ...r, keywords: { ...r.keywords, [keyword]: value } } : r,
                ),
              }
            : cur,
        );
      };
      apply(on);
      try {
        await client.setKeyword(ids, keyword, on);
        if (keyword === "$seen") void loadFolders();
      } catch (err) {
        apply(!on);
        fail(err);
        throw err;
      }
    },
    [client, fail, loadFolders],
  );

  const open = useCallback(
    (index: number) => {
      const row = list?.rows[index];
      if (!row) return;
      setSelected(index);
      setOpenThread(row.threadId);
    },
    [list],
  );

  const close = useCallback(() => {
    setOpenThread(null);
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (!list?.total) return;
      const next = Math.min(list.total - 1, Math.max(0, (selected ?? -1) + delta));
      setSelected(next);
      // With the reader showing, moving opens the next conversation (desktop reading flow).
      if (openThread !== null && list.rows[next]) setOpenThread(list.rows[next].threadId);
    },
    [list, selected, openThread],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "Escape") {
        if (help) setHelp(false);
        else if (drawer) setDrawer(false);
        else close();
        return;
      }
      if (help || drawer) return;
      switch (e.key) {
        case "j":
          move(1);
          break;
        case "k":
          move(-1);
          break;
        case "Enter":
        case "o":
          if (selected !== null && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement)) {
            open(selected);
          } else return;
          break;
        case "u":
          close();
          break;
        case "s":
          readerActions.current?.toggleFlag();
          break;
        case "U":
          readerActions.current?.setRead(false);
          break;
        case "I":
          readerActions.current?.setRead(true);
          break;
        case "?":
          setHelp(true);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [move, open, close, selected, help, drawer]);

  const registerActions = useCallback((a: { toggleFlag: () => void; setRead: (read: boolean) => void } | null) => {
    readerActions.current = a;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await client.signOut();
    } finally {
      signedOut();
    }
  }, [client, signedOut]);

  const selectFolder = (id: string) => {
    setDrawer(false);
    if (id === folderId) {
      setOpenThread(null);
      return;
    }
    switchFolder(id);
  };

  const sidebar = (
    <FolderSidebar
      folders={folders}
      currentId={folderId}
      username={username}
      onSelect={selectFolder}
      onSignOut={() => {
        void signOut();
      }}
    />
  );

  const title = folder ? folderLabel(folder) : "Mail";
  const total = list?.total ?? null;
  const unread = folder?.unreadEmails ?? 0;

  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden md:grid-cols-[22rem_minmax(0,1fr)] lg:grid-cols-[15rem_24rem_minmax(0,1fr)]">
      <aside className="hidden min-h-0 border-r border-sidebar-border lg:block">{sidebar}</aside>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close folders"
            onClick={() => {
              setDrawer(false);
            }}
            className="absolute inset-0 bg-foreground/30"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Folders"
            className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r shadow-xl"
          >
            {sidebar}
          </div>
        </div>
      )}

      <section
        aria-label={title}
        className={`flex min-h-0 flex-col border-r ${openThread !== null ? "hidden md:flex" : "flex"}`}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
          <button
            type="button"
            onClick={() => {
              setDrawer(true);
            }}
            aria-label="Open folders"
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
          >
            <Menu className="size-4" aria-hidden />
          </button>
          <div className="flex min-w-0 flex-1 items-baseline gap-2 pl-1">
            <h1 className="am-h3 truncate">{title}</h1>
            {unread > 0 && (
              <span className="font-mono text-[12px] text-muted-foreground tabular-nums">{unread} unread</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setHelp(true);
            }}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            className="hidden size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground md:inline-flex"
          >
            <Keyboard className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={refresh}
            aria-label="Refresh"
            title="Refresh"
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCw className="size-4" aria-hidden />
          </button>
        </header>
        {error && (
          <div role="alert" className="flex items-center justify-between gap-3 border-b bg-destructive/8 px-4 py-2.5">
            <p className="am-small text-destructive">{error}</p>
            <button
              type="button"
              onClick={refresh}
              className="am-small shrink-0 font-medium text-foreground underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        )}
        {!list || total === null ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <MessageListSkeleton rows={10} />
          </div>
        ) : total === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Inbox className="size-5" aria-hidden />
            </span>
            <p className="am-h4">Nothing in {title}</p>
            <p className="am-small max-w-64">{(folder?.role && EMPTY_COPY[folder.role]) ?? "This folder is empty."}</p>
          </div>
        ) : (
          <MessageList
            total={total}
            rows={list.rows}
            selectedIndex={selected}
            sentFolder={folder?.role === "sent" || folder?.role === "drafts"}
            label={`${title} messages`}
            onOpen={open}
            onRange={onRange}
          />
        )}
      </section>

      <main className={`min-h-0 ${openThread !== null ? "flex flex-col" : "hidden md:flex md:flex-col"}`}>
        {openThread !== null ? (
          <Reader
            key={openThread}
            client={client}
            threadId={openThread}
            hiddenMailboxIds={hiddenMailboxIds}
            onBack={close}
            onKeyword={onKeyword}
            onSignedOut={signedOut}
            registerActions={registerActions}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Inbox className="size-6" aria-hidden />
            </span>
            <p className="am-h3">No message selected</p>
            <p className="am-small max-w-72">
              Pick a conversation to read it. Press <kbd className="font-mono">j</kbd> and{" "}
              <kbd className="font-mono">k</kbd> to move, <kbd className="font-mono">?</kbd> for all shortcuts.
            </p>
          </div>
        )}
      </main>

      {help && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close shortcuts"
            onClick={() => {
              setHelp(false);
            }}
            className="absolute inset-0 bg-foreground/30"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            className="relative w-full max-w-sm rounded-xl border bg-popover p-5 shadow-xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 id="shortcuts-title" className="am-h3">
                Keyboard shortcuts
              </h2>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setHelp(false);
                }}
                aria-label="Close"
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <dl className="flex flex-col gap-2.5">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={keys} className="flex items-center justify-between gap-4">
                  <dt className="am-small">{what}</dt>
                  <dd className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[12px]">{keys}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
