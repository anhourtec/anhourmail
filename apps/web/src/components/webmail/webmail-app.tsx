// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Archive,
  CheckCheck,
  Ellipsis,
  Flag,
  FolderInput,
  Inbox,
  ListChecks,
  Mail,
  MailOpen,
  PanelLeft,
  Pin,
  RotateCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MessageListSkeleton } from "@anhourmail/ui/skeletons";

import type { Address, MessageView } from "@/server/webmail/view";

import { type ComposeSeed, Composer } from "./composer";
import { AddMailboxDialog, ConfirmDialog, Modal } from "./dialogs";
import {
  type ComposeMode,
  folderLabel,
  folderTree,
  parseSearch,
  quoteBody,
  replyRecipients,
  replySubject,
} from "./format";
import {
  createMailClient,
  type Folder,
  type Identity,
  type ListFilter,
  listFilter,
  type ListRow,
  PAGE_SIZE,
  RefusedError,
  type SearchQuery,
  SignedOutError,
  type View,
} from "./mail-client";
import { iconButtonClass, Menu, type MenuEntry } from "./menu";
import { MessageList } from "./message-list";
import { Reader, type ReaderAction, type ReaderActions } from "./reader";
import { type Mailboxes, Sidebar } from "./sidebar";
import { ToastHost, useToasts } from "./toasts";

type Shown = { view: View; narrow: Narrow; search: SearchQuery | null };
const keyOf = (s: Shown) => JSON.stringify([s.view, s.narrow, s.search]);
/** The main section's filter: pinned conversations have their own section in folder views. */
const mainFilter = (s: Shown, hidden: string[]) =>
  listFilter(
    s.view,
    { ...s.narrow, search: s.search },
    hidden,
    s.view.kind === "folder" && !s.search ? { pinned: false } : {},
  );

type ListState = { key: string; total: number | null; rows: (ListRow | undefined)[]; loaded: Set<number> };
type Narrow = Omit<ListFilter, "search">;
type Confirm = { title: string; body: string; confirm: string; run: () => void };
type ComposerState = { seed: ComposeSeed; variant: "panel" | "inline"; key: number };

const EMPTY_COPY: Record<string, string> = {
  inbox: "New mail lands here.",
  drafts: "Messages you start and don't send are kept here.",
  sent: "Mail you send is kept here.",
  archive: "Archive messages to keep them out of the Inbox without deleting them.",
  junk: "Messages our filters think are junk land here.",
  trash: "Deleted messages stay here for 30 days.",
};

export const SHORTCUTS: [string, string][] = [
  ["j / k", "Next / previous conversation"],
  ["Enter or o", "Open"],
  ["u or Esc", "Back to the list"],
  ["c", "New email"],
  ["r / a / f", "Reply / reply all / forward"],
  ["e", "Archive"],
  ["#", "Delete"],
  ["!", "Report junk"],
  ["s", "Add to or remove from Priority"],
  ["p", "Pin or unpin"],
  ["x", "Select"],
  ["Shift+U / Shift+I", "Mark unread / read"],
  ["/", "Search"],
  ["?", "Show these shortcuts"],
];

/** Remembers a collapsed sidebar; read on the server so the first paint has the right width. */
export const SIDEBAR_COOKIE = "am.webmail.sidebar";

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

const wide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;

/**
 * The webmail (Phase 4): folders · list · reader on wide screens, one pane at a time on phones (folders in a
 * drawer, actions in a bottom bar). Reads and acts through the same-origin BFF only. Actions are optimistic, with
 * undo where it makes sense; sending is held for a few seconds so it can be undone.
 */
type AppProps = { username: string; signInHref: string; helpHref: string; initialCollapsed: boolean };

export function WebmailApp(props: AppProps) {
  return (
    <ToastHost>
      <Mailroom {...props} />
    </ToastHost>
  );
}

function Mailroom({ username, signInHref, helpHref, initialCollapsed }: AppProps) {
  const client = useMemo(() => createMailClient(), []);
  const toasts = useToasts();
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [narrow, setNarrow] = useState<Narrow>({});
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState<SearchQuery | null>(null);
  const [list, setList] = useState<ListState | null>(null);
  const listRef = useRef<ListState | null>(null);
  useEffect(() => {
    listRef.current = list;
  });
  const [pinned, setPinned] = useState<ListRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [priorityCount, setPriorityCount] = useState(0);
  const [mailboxes, setMailboxes] = useState<Mailboxes>({ active: username, others: [] });
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [contacts, setContacts] = useState<Address[]>([]);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const readerActions = useRef<ReaderActions | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const composerKey = useRef(0);

  const roles = useMemo(() => {
    const r: Partial<Record<string, string>> = {};
    for (const f of folders ?? []) if (f.role && !r[f.role]) r[f.role] = f.id;
    return r;
  }, [folders]);
  const hidden = useMemo(() => [roles.trash, roles.junk].filter((x): x is string => x !== undefined), [roles]);
  const currentFolder = view?.kind === "folder" ? (folders?.find((f) => f.id === view.id) ?? null) : null;
  const searching = search !== null;

  const signedOut = useCallback(() => {
    window.location.assign(signInHref);
  }, [signInHref]);

  const fail = useCallback(
    (err: unknown, message = "Couldn't reach the mail server. Check your connection and try again.") => {
      if (err instanceof SignedOutError) signedOut();
      else if (err instanceof RefusedError) toasts.show({ message: err.message, tone: "error" });
      else setError(message);
    },
    [signedOut, toasts],
  );

  // ---- loading ------------------------------------------------------------------------------------------

  const loadFolders = useCallback(async () => {
    try {
      const f = await client.folders();
      setFolders(f);
      const h = [f.find((x) => x.role === "trash")?.id, f.find((x) => x.role === "junk")?.id].filter(
        (x): x is string => x !== undefined,
      );
      setPriorityCount(await client.priorityCount(h));
      return f;
    } catch (err) {
      fail(err);
      return null;
    }
  }, [client, fail]);

  const loadPage = useCallback(
    async (key: string, filter: Record<string, unknown>, page: number) => {
      const k = `${key}:${String(page)}`;
      if (pending.current.has(k)) return;
      pending.current.add(k);
      try {
        const { total, rows } = await client.page(filter, page * PAGE_SIZE);
        setList((cur) => {
          if (cur?.key !== key) return cur;
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
        pending.current.delete(k);
      }
    },
    [client, fail],
  );

  /** Loads the list for `shown`: the pinned section (folder views), then the first window (or the loaded ones). */
  const load = useCallback(
    async (shown: Shown, hiddenIds: string[], opts: { keep?: boolean } = {}) => {
      const key = keyOf(shown);
      const main = mainFilter(shown, hiddenIds);
      if (!opts.keep) {
        setList({ key, total: null, rows: [], loaded: new Set() });
        setSelected(null);
        anchor.current = null;
      }
      const pinnedSection = shown.view.kind === "folder" && shown.search === null;
      if (pinnedSection) {
        try {
          const p = await client.page(
            listFilter(shown.view, { ...shown.narrow }, hiddenIds, { pinned: true }),
            0,
            client.pinnedLimit,
          );
          setPinned(p.rows);
        } catch (err) {
          fail(err);
        }
      } else {
        setPinned([]);
      }
      const pages = opts.keep && listRef.current?.key === key ? [...listRef.current.loaded] : [];
      if (opts.keep) setList((cur) => (cur?.key === key ? { ...cur, loaded: new Set() } : cur));
      for (const page of pages.length > 0 ? pages : [0]) void loadPage(key, main, page);
    },
    [client, fail, loadPage],
  );

  /** Shows another view, narrowing or search (whatever isn't given stays), and loads it. */
  const show = useCallback(
    (patch: Partial<Shown>) => {
      const v = patch.view ?? view;
      if (!v) return;
      const next: Shown = {
        view: v,
        narrow: patch.narrow ?? narrow,
        search: patch.search === undefined ? search : patch.search,
      };
      setView(next.view);
      setNarrow(next.narrow);
      setSearch(next.search);
      setChecked(new Set());
      void load(next, hidden);
    },
    [view, narrow, search, hidden, load],
  );

  /** Reloads what is shown (keeping the scroll position's windows with `keep`). */
  const reload = useCallback(
    async (opts: { keep?: boolean } = {}) => {
      if (view) await load({ view, narrow, search }, hidden, opts);
    },
    [view, narrow, search, hidden, load],
  );

  // First paint: folders, the Inbox, the person's mailboxes and identities.
  useEffect(() => {
    let live = true;
    client
      .folders()
      .then(async (f) => {
        if (!live) return;
        setFolders(f);
        const h = [f.find((x) => x.role === "trash")?.id, f.find((x) => x.role === "junk")?.id].filter(
          (x): x is string => x !== undefined,
        );
        const first = f.find((x) => x.role === "inbox") ?? f[0];
        if (first) {
          const shown: Shown = { view: { kind: "folder", id: first.id }, narrow: {}, search: null };
          setView(shown.view);
          void load(shown, h);
        }
        setPriorityCount(await client.priorityCount(h));
      })
      .catch((err: unknown) => {
        fail(err);
      });
    client
      .mailboxes()
      .then(setMailboxes)
      .catch(() => undefined);
    client
      .identities()
      .then(setIdentities)
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // First paint only.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once
  }, []);

  const onRange = useCallback(
    (start: number, end: number) => {
      if (list?.total == null || !view) return;
      for (let p = Math.floor(start / PAGE_SIZE); p <= Math.floor(Math.max(start, end - 1) / PAGE_SIZE); p++) {
        if (!list.loaded.has(p)) void loadPage(list.key, mainFilter({ view, narrow, search }, hidden), p);
      }
    },
    [list, view, narrow, search, hidden, loadPage],
  );

  const refresh = useCallback(() => {
    void loadFolders();
    void reload({ keep: true });
  }, [loadFolders, reload]);

  // Until push lands: refresh when the tab comes back, and a 5-minute safety resync.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const t = window.setInterval(refresh, 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(t);
    };
  }, [refresh]);

  // ---- rows ---------------------------------------------------------------------------------------------

  const flatTotal = pinned.length + (list?.total ?? 0);
  const rowAt = useCallback(
    (i: number): ListRow | undefined => (i < pinned.length ? pinned[i] : list?.rows[i - pinned.length]),
    [pinned, list],
  );

  const patchRows = useCallback((fn: (r: ListRow) => ListRow) => {
    setPinned((p) => p.map(fn));
    setList((cur) => (cur ? { ...cur, rows: cur.rows.map((r) => (r ? fn(r) : r)) } : cur));
  }, []);

  /** Takes conversations out of the list right away (they moved elsewhere). */
  const dropThreads = useCallback(
    (threadIds: Set<string>) => {
      setPinned((p) => p.filter((r) => !threadIds.has(r.threadId)));
      setList((cur) => {
        if (!cur) return cur;
        const rows = cur.rows.filter((r) => !r || !threadIds.has(r.threadId));
        const removed = cur.rows.length - rows.length;
        return { ...cur, rows, total: cur.total === null ? null : Math.max(0, cur.total - removed) };
      });
      setChecked(new Set());
      if (openThread && threadIds.has(openThread)) {
        // Open the next conversation, like a mail client.
        const next = selected !== null ? rowAt(selected + 1) : undefined;
        setOpenThread(next && !threadIds.has(next.threadId) ? next.threadId : null);
        if (!next) setSelected(null);
      }
    },
    [openThread, selected, rowAt],
  );

  // ---- actions ------------------------------------------------------------------------------------------

  const onKeyword = useCallback(
    async (ids: string[], keyword: string, on: boolean) => {
      const apply = (value: boolean) => {
        patchRows((r) => (ids.includes(r.id) ? { ...r, keywords: { ...r.keywords, [keyword]: value } } : r));
      };
      apply(on);
      try {
        await client.setKeyword(ids, keyword, on);
        if (keyword === "$seen" || keyword === "$flagged") void loadFolders();
        if (keyword === "$pinned") void reload({ keep: true });
      } catch (err) {
        apply(!on);
        fail(err);
        throw err;
      }
    },
    [client, fail, loadFolders, patchRows, reload],
  );

  /** Moves conversations (archive, delete, junk, move to…), with an Undo toast. */
  const moveThreads = useCallback(
    async (
      threadIds: string[],
      to: string | undefined,
      done: string,
      keywords: Record<string, boolean | null> = {},
    ) => {
      if (!to || threadIds.length === 0) return;
      const from = currentFolder?.id ?? null;
      dropThreads(new Set(threadIds));
      try {
        const skip = [roles.sent, roles.drafts].filter((x): x is string => x !== undefined);
        const before = await client.move(threadIds, from, to, keywords, skip);
        void loadFolders();
        toasts.show({
          message: done,
          action: {
            label: "Undo",
            onClick: () => {
              void client
                .restore(before)
                .then(() => {
                  refresh();
                })
                .catch((err: unknown) => {
                  fail(err);
                });
            },
          },
        });
      } catch (err) {
        fail(err);
        void reload({ keep: true });
      }
    },
    [currentFolder, dropThreads, roles, client, loadFolders, toasts, refresh, fail, reload],
  );

  const deleteForever = useCallback(
    (threadIds: string[]) => {
      const folderId = currentFolder?.id;
      if (!folderId || threadIds.length === 0) return;
      setConfirm({
        title:
          threadIds.length === 1
            ? "Delete this conversation forever?"
            : `Delete ${String(threadIds.length)} conversations forever?`,
        body: "This can't be undone.",
        confirm: "Delete forever",
        run: () => {
          dropThreads(new Set(threadIds));
          void client
            .threadEmails(threadIds)
            .then((emails) => client.destroy(emails.filter((e) => e.mailboxIds[folderId]).map((e) => e.id)))
            .then(() => {
              void loadFolders();
              toasts.show({ message: "Deleted forever." });
            })
            .catch((err: unknown) => {
              fail(err);
              void reload({ keep: true });
            });
        },
      });
    },
    [currentFolder, dropThreads, client, loadFolders, toasts, fail, reload],
  );

  const bulkKeyword = useCallback(
    async (threadIds: string[], keyword: string, on: boolean) => {
      try {
        const emails = await client.threadEmails(threadIds);
        const inView = currentFolder ? emails.filter((e) => e.mailboxIds[currentFolder.id]) : emails;
        await onKeyword(
          (inView.length > 0 ? inView : emails).map((e) => e.id),
          keyword,
          on,
        );
        patchRows((r) => (threadIds.includes(r.threadId) ? { ...r, keywords: { ...r.keywords, [keyword]: on } } : r));
      } catch (err) {
        fail(err);
      }
    },
    [client, currentFolder, onKeyword, patchRows, fail],
  );

  const act = useCallback(
    (threadIds: string[], action: ReaderAction) => {
      switch (action.kind) {
        case "archive":
          void moveThreads(
            threadIds,
            roles.archive,
            threadIds.length === 1 ? "Archived." : `${String(threadIds.length)} archived.`,
          );
          break;
        case "trash":
          if (currentFolder?.role === "trash" || currentFolder?.role === "junk") deleteForever(threadIds);
          else
            void moveThreads(
              threadIds,
              roles.trash,
              threadIds.length === 1 ? "Moved to Trash." : `${String(threadIds.length)} moved to Trash.`,
            );
          break;
        case "deleteForever":
          deleteForever(threadIds);
          break;
        case "junk":
          void moveThreads(threadIds, roles.junk, "Reported as junk.", { $junk: true, $notjunk: null });
          break;
        case "notJunk":
          void moveThreads(threadIds, roles.inbox, "Moved to Inbox.", { $notjunk: true, $junk: null });
          break;
        case "move": {
          const f = folders?.find((x) => x.id === action.to);
          void moveThreads(threadIds, action.to, `Moved to ${f ? folderLabel(f) : "folder"}.`);
          break;
        }
        default:
          break;
      }
    },
    [moveThreads, roles, currentFolder, deleteForever, folders],
  );

  // ---- composing ----------------------------------------------------------------------------------------

  const ensureContacts = useCallback(() => {
    if (contacts.length > 0) return;
    client
      .recentCorrespondents(roles.sent)
      .then(setContacts)
      .catch(() => undefined);
  }, [contacts.length, client, roles.sent]);

  const openComposer = useCallback(
    (seed: ComposeSeed, variant: "panel" | "inline" = "panel") => {
      ensureContacts();
      composerKey.current += 1;
      setComposer({ seed, variant: variant === "inline" && wide() ? "inline" : "panel", key: composerKey.current });
    },
    [ensureContacts],
  );

  const compose = useCallback(() => {
    openComposer({
      title: "New message",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      text: "",
      attachments: [],
      focus: "to",
    });
  }, [openComposer]);

  const replyTo = useCallback(
    (m: MessageView, mode: Exclude<ComposeMode, "new">, inline: boolean) => {
      const self = identities.map((i) => i.email);
      const { to, cc } = replyRecipients(m, mode, self.length > 0 ? self : [mailboxes.active]);
      const toMe = [...m.to, ...m.cc].map((a) => a.email.toLowerCase()).find((e) => self.includes(e));
      openComposer(
        {
          title: mode === "forward" ? "Forward" : mode === "replyAll" ? "Reply all" : "Reply",
          to,
          cc,
          bcc: [],
          subject: replySubject(m.subject, mode),
          text: quoteBody(m, mode),
          ...(mode !== "forward" && m.messageId.length > 0
            ? { inReplyTo: m.messageId, references: [...m.references, ...m.messageId].slice(-50) }
            : {}),
          attachments: mode === "forward" ? m.attachments : [],
          ...(toMe ? { fromEmail: toMe } : {}),
          focus: mode === "forward" ? "to" : "body",
        },
        inline ? "inline" : "panel",
      );
    },
    [identities, mailboxes.active, openComposer],
  );

  const openDraft = useCallback(
    async (emailId: string) => {
      try {
        const m = await client.message(emailId);
        if (!m) return;
        openComposer({
          title: "Draft",
          to: m.to,
          cc: m.cc,
          bcc: m.bcc,
          subject: m.subject,
          text: m.text ?? m.quote,
          attachments: m.attachments,
          draftId: m.id,
          ...(m.from[0] ? { fromEmail: m.from[0].email } : {}),
          focus: "body",
        });
      } catch (err) {
        fail(err);
      }
    },
    [client, openComposer, fail],
  );

  const onSent = useCallback(
    (submissionId: string) => {
      setComposer(null);
      refresh();
      toasts.show({
        message: "Message sent.",
        duration: 5500,
        action: {
          label: "Undo",
          onClick: () => {
            void client
              .undoSend(submissionId)
              .then(({ draftId }) => {
                refresh();
                void openDraft(draftId);
              })
              .catch((err: unknown) => {
                fail(err);
              });
          },
        },
      });
    },
    [refresh, toasts, client, openDraft, fail],
  );

  // ---- navigation ---------------------------------------------------------------------------------------

  const open = useCallback(
    (index: number) => {
      const row = rowAt(index);
      if (!row) return;
      setSelected(index);
      anchor.current = index;
      if (currentFolder?.role === "drafts") {
        void openDraft(row.id);
        return;
      }
      setOpenThread(row.threadId);
    },
    [rowAt, currentFolder, openDraft],
  );

  const close = useCallback(() => {
    setOpenThread(null);
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (flatTotal === 0) return;
      const next = Math.min(flatTotal - 1, Math.max(0, (selected ?? -1) + delta));
      setSelected(next);
      anchor.current = next;
      const row = rowAt(next);
      if (openThread !== null && row && currentFolder?.role !== "drafts") setOpenThread(row.threadId);
    },
    [flatTotal, selected, rowAt, openThread, currentFolder],
  );

  const toggleCheck = useCallback(
    (index: number, range: boolean) => {
      setChecked((cur) => {
        const next = new Set(cur);
        if (range && anchor.current !== null) {
          const [a, b] = anchor.current < index ? [anchor.current, index] : [index, anchor.current];
          for (let i = a; i <= b; i++) {
            const r = rowAt(i);
            if (r) next.add(r.threadId);
          }
        } else {
          const r = rowAt(index);
          if (r) {
            if (next.has(r.threadId)) next.delete(r.threadId);
            else next.add(r.threadId);
          }
          anchor.current = index;
        }
        return next;
      });
    },
    [rowAt],
  );

  const selectView = (v: View) => {
    setDrawer(false);
    setSearchText("");
    setOpenThread(null);
    show({ view: v, narrow: {}, search: null });
  };

  const targets = (): string[] => {
    if (checked.size > 0) return [...checked];
    if (openThread) return [openThread];
    const r = selected !== null ? rowAt(selected) : undefined;
    return r ? [r.threadId] : [];
  };

  // ---- keyboard -----------------------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (composer?.variant === "panel" || confirm || adding) return;
      if (e.key === "Escape") {
        if (help) setHelp(false);
        else if (drawer) setDrawer(false);
        else if (checked.size > 0) setChecked(new Set());
        else close();
        return;
      }
      if (help || drawer) return;
      const t = targets();
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
        case "c":
          compose();
          break;
        case "r":
          readerActions.current?.reply("reply");
          break;
        case "a":
          readerActions.current?.reply("replyAll");
          break;
        case "f":
          readerActions.current?.reply("forward");
          break;
        case "e":
          if (currentFolder?.role !== "archive") act(t, { kind: "archive" });
          break;
        case "#":
          act(t, { kind: "trash" });
          break;
        case "!":
          act(t, currentFolder?.role === "junk" ? { kind: "notJunk" } : { kind: "junk" });
          break;
        case "s":
          if (readerActions.current && checked.size === 0) readerActions.current.toggleFlag();
          else if (t.length > 0) {
            const on = !(rowAt(selected ?? -1)?.keywords.$flagged === true);
            void bulkKeyword(t, "$flagged", on);
          }
          break;
        case "p":
          if (readerActions.current && checked.size === 0) readerActions.current.togglePin();
          else if (t.length > 0) void bulkKeyword(t, "$pinned", true);
          break;
        case "x":
          if (selected !== null) toggleCheck(selected, false);
          break;
        case "U":
          if (readerActions.current && checked.size === 0) readerActions.current.setRead(false);
          else void bulkKeyword(t, "$seen", false);
          break;
        case "I":
          if (readerActions.current && checked.size === 0) readerActions.current.setRead(true);
          else void bulkKeyword(t, "$seen", true);
          break;
        case "/":
          searchBox.current?.focus();
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
  });

  // ---- mailboxes ----------------------------------------------------------------------------------------

  const switchMailbox = (address: string) => {
    client
      .switchMailbox(address)
      .then(() => {
        window.location.reload();
      })
      .catch((err: unknown) => {
        fail(err);
      });
  };

  const signOut = async () => {
    try {
      await client.signOut();
    } finally {
      signedOut();
    }
  };

  const toggleSidebar = () => {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      setCollapsed((c) => {
        document.cookie = `${SIDEBAR_COOKIE}=${c ? "expanded" : "collapsed"}; Path=/; Max-Age=31536000; SameSite=Lax`;
        return !c;
      });
    } else {
      setDrawer(true);
    }
  };

  // ---- render -------------------------------------------------------------------------------------------

  const sidebar = (rail: boolean) => (
    <Sidebar
      folders={folders}
      view={view}
      priorityCount={priorityCount}
      mailboxes={mailboxes}
      collapsed={rail}
      helpHref={helpHref}
      onSelect={selectView}
      onCompose={() => {
        setDrawer(false);
        compose();
      }}
      onShortcuts={() => {
        setDrawer(false);
        setHelp(true);
      }}
      onSignOut={() => {
        void signOut();
      }}
      onAddMailbox={() => {
        setDrawer(false);
        setAdding(true);
      }}
      onSwitchMailbox={switchMailbox}
    />
  );

  const title = searching
    ? "Search results"
    : view?.kind === "priority"
      ? "Priority"
      : currentFolder
        ? folderLabel(currentFolder)
        : "Mail";
  const total = list?.total ?? null;
  const t = targets();
  const narrowed = narrow.unread === true || narrow.flagged === true || narrow.attachments === true;
  const moveTargets = folders
    ? folderTree(folders)
        .map((n) => n.folder)
        .filter((f) => f.id !== currentFolder?.id && f.role !== "drafts" && f.role !== "sent")
    : [];
  const filterItems: MenuEntry[] = [
    { heading: "Show only" },
    {
      label: "Unread",
      checked: narrow.unread === true,
      onSelect: () => {
        show({ narrow: { ...narrow, unread: !narrow.unread } });
      },
    },
    {
      label: "Priority",
      checked: narrow.flagged === true,
      onSelect: () => {
        show({ narrow: { ...narrow, flagged: !narrow.flagged } });
      },
    },
    {
      label: "With attachments",
      checked: narrow.attachments === true,
      onSelect: () => {
        show({ narrow: { ...narrow, attachments: !narrow.attachments } });
      },
    },
    { separator: true },
    {
      label: "Show everything",
      icon: X,
      onSelect: () => {
        show({ narrow: {} });
      },
      disabled: !narrowed,
    },
  ];
  const moreItems: MenuEntry[] = [
    {
      label: "Mark all as read",
      icon: CheckCheck,
      onSelect: () => {
        if (!view) return;
        void client
          .markAllRead(listFilter(view, { ...narrow, search }, hidden))
          .then(refresh)
          .catch((err: unknown) => {
            fail(err);
          });
      },
    },
    {
      label: "Select all loaded",
      icon: ListChecks,
      onSelect: () => {
        const all = new Set<string>();
        for (let i = 0; i < flatTotal; i++) {
          const r = rowAt(i);
          if (r) all.add(r.threadId);
        }
        setChecked(all);
      },
    },
    ...(currentFolder?.role === "trash" || currentFolder?.role === "junk"
      ? [
          { separator: true as const },
          {
            label: `Empty ${folderLabel(currentFolder)}`,
            icon: Trash2,
            danger: true,
            onSelect: () => {
              const f = currentFolder;
              setConfirm({
                title: `Empty ${folderLabel(f)}?`,
                body: `Everything in ${folderLabel(f)} will be deleted forever. This can't be undone.`,
                confirm: `Empty ${folderLabel(f)}`,
                run: () => {
                  setList((cur) => (cur ? { ...cur, rows: [], total: 0 } : cur));
                  setPinned([]);
                  void client
                    .emptyFolder(f.id)
                    .then(() => {
                      refresh();
                      toasts.show({ message: `${folderLabel(f)} is empty.` });
                    })
                    .catch((err: unknown) => {
                      fail(err);
                      refresh();
                    });
                },
              });
            },
          },
        ]
      : []),
  ];
  const bulkMove: MenuEntry[] = moveTargets.map((f) => ({
    label: folderLabel(f),
    icon: f.role === "inbox" ? Inbox : FolderInput,
    onSelect: () => {
      act(t, { kind: "move", to: f.id });
    },
  }));

  const inlineComposer =
    composer?.variant === "inline" ? (
      <Composer
        key={composer.key}
        client={client}
        identities={identities}
        contacts={contacts}
        seed={composer.seed}
        variant="inline"
        trashId={roles.trash}
        onClose={({ savedDraft }) => {
          setComposer(null);
          if (savedDraft) toasts.show({ message: "Draft saved." });
          void loadFolders();
        }}
        onSent={onSent}
      />
    ) : null;

  return (
    <div
      className={`grid h-dvh grid-cols-1 overflow-hidden md:grid-cols-[23rem_minmax(0,1fr)] ${
        collapsed ? "lg:grid-cols-[3.5rem_26rem_minmax(0,1fr)]" : "lg:grid-cols-[15rem_26rem_minmax(0,1fr)]"
      }`}
    >
      <aside className="hidden min-h-0 border-sidebar-border border-r lg:block">{sidebar(collapsed)}</aside>

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
            {sidebar(false)}
          </div>
        </div>
      )}

      <section
        aria-label={title}
        className={`flex min-h-0 flex-col border-r ${openThread !== null ? "hidden md:flex" : "flex"}`}
      >
        <header className="flex h-14 shrink-0 items-center gap-1 px-2">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Toggle folders"
            title="Folders"
            className={iconButtonClass}
          >
            <PanelLeft className="size-4" aria-hidden />
          </button>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <h1 className="min-w-0 flex-1 truncate font-display font-medium text-[1.25rem] tracking-tight">{title}</h1>
          <Menu
            label={narrowed ? "Filter (on)" : "Filter"}
            icon={SlidersHorizontal}
            items={filterItems}
            className={narrowed ? "[&>button]:text-primary" : ""}
          />
          <button type="button" onClick={refresh} aria-label="Refresh" title="Refresh" className={iconButtonClass}>
            <RotateCw className="size-4" aria-hidden />
          </button>
          <Menu label="More" icon={Ellipsis} items={moreItems} />
        </header>

        {checked.size > 0 ? (
          <div
            role="toolbar"
            aria-label="Selected conversations"
            className="mx-2 mb-2 flex h-10 shrink-0 items-center gap-0.5 rounded-lg border bg-accent/60 px-1.5"
          >
            <button
              type="button"
              onClick={() => {
                setChecked(new Set());
              }}
              aria-label="Clear selection"
              className={iconButtonClass}
            >
              <X className="size-4" aria-hidden />
            </button>
            <span className="min-w-0 flex-1 truncate px-1 font-medium text-[13px]">{checked.size} selected</span>
            {currentFolder?.role !== "archive" && (
              <button
                type="button"
                onClick={() => {
                  act(t, { kind: "archive" });
                }}
                aria-label="Archive selected"
                title="Archive"
                className={iconButtonClass}
              >
                <Archive className="size-4" aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                act(t, { kind: "trash" });
              }}
              aria-label="Delete selected"
              title="Delete"
              className={`${iconButtonClass} text-destructive hover:text-destructive`}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
            <Menu
              label="More for selected"
              icon={Ellipsis}
              items={[
                { label: "Mark as read", icon: MailOpen, onSelect: () => void bulkKeyword(t, "$seen", true) },
                { label: "Mark as unread", icon: Mail, onSelect: () => void bulkKeyword(t, "$seen", false) },
                { label: "Add to Priority", icon: Flag, onSelect: () => void bulkKeyword(t, "$flagged", true) },
                { label: "Pin", icon: Pin, onSelect: () => void bulkKeyword(t, "$pinned", true) },
                { label: "Unpin", icon: Pin, onSelect: () => void bulkKeyword(t, "$pinned", false) },
                currentFolder?.role === "junk"
                  ? {
                      label: "Not junk",
                      icon: ShieldAlert,
                      onSelect: () => {
                        act(t, { kind: "notJunk" });
                      },
                    }
                  : {
                      label: "Report junk",
                      icon: ShieldAlert,
                      onSelect: () => {
                        act(t, { kind: "junk" });
                      },
                    },
                { separator: true },
                { heading: "Move to" },
                ...bulkMove,
              ]}
            />
          </div>
        ) : (
          <form
            role="search"
            className="mx-2 mb-2 shrink-0"
            onSubmit={(e) => {
              e.preventDefault();
              show({ search: parseSearch(searchText) });
              setOpenThread(null);
            }}
          >
            <label className="relative flex items-center">
              <span className="sr-only">Search mail</span>
              <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden />
              <input
                ref={searchBox}
                type="search"
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value);
                  if (e.target.value === "" && search) show({ search: null });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchText("");
                    if (search) show({ search: null });
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Search…"
                aria-label="Search mail"
                title="from:, to:, subject:, has:attachment, is:unread"
                className="h-8 w-full rounded-lg border bg-background pr-8 pl-8 text-[13px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
              />
              <kbd className="pointer-events-none absolute right-2.5 hidden font-mono text-[11px] text-muted-foreground md:block">
                /
              </kbd>
            </label>
          </form>
        )}

        {error && (
          <div role="alert" className="flex items-center justify-between gap-3 border-y bg-destructive/8 px-4 py-2.5">
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
        <div className="flex min-h-0 flex-1 flex-col border-t">
          {!list || total === null ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <MessageListSkeleton rows={8} />
            </div>
          ) : total === 0 && pinned.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                {searching ? <Search className="size-5" aria-hidden /> : <Inbox className="size-5" aria-hidden />}
              </span>
              <p className="am-h4">
                {searching ? "No messages match" : narrowed ? "Nothing matches the filter" : `Nothing in ${title}`}
              </p>
              <p className="am-small max-w-64">
                {searching
                  ? "Try other words, or from:, to:, subject: and has:attachment."
                  : view?.kind === "priority"
                    ? "Flag a message (s) to keep it here."
                    : ((currentFolder?.role && EMPTY_COPY[currentFolder.role]) ?? "This folder is empty.")}
              </p>
            </div>
          ) : (
            <MessageList
              pinned={pinned}
              total={total}
              rows={list.rows}
              sectionLabel={title}
              selectedIndex={selected}
              checked={checked}
              sentFolder={currentFolder?.role === "sent" || currentFolder?.role === "drafts"}
              label={`${title} messages`}
              onOpen={open}
              onCheck={toggleCheck}
              onRange={onRange}
            />
          )}
        </div>
      </section>

      <main className={`min-h-0 ${openThread !== null ? "flex flex-col" : "hidden md:flex md:flex-col"}`}>
        {openThread !== null ? (
          <Reader
            key={openThread}
            client={client}
            threadId={openThread}
            folders={folders ?? []}
            currentFolder={currentFolder}
            hiddenMailboxIds={hidden.filter((id) => id !== currentFolder?.id)}
            canPrev={(selected ?? 0) > 0}
            canNext={selected !== null && selected < flatTotal - 1}
            inlineComposer={inlineComposer}
            onPrev={() => {
              move(-1);
            }}
            onNext={() => {
              move(1);
            }}
            onClose={close}
            onAction={(a) => {
              if (a.kind === "reply" || a.kind === "replyAll" || a.kind === "forward")
                replyTo(a.message, a.kind, a.inline);
              else act([openThread], a);
            }}
            onKeyword={onKeyword}
            onSignedOut={signedOut}
            onComposeTo={(address) => {
              openComposer({
                title: "New message",
                to: [{ name: null, email: address.toLowerCase() }],
                cc: [],
                bcc: [],
                subject: "",
                text: "",
                attachments: [],
                focus: "body",
              });
            }}
            registerActions={(a) => {
              readerActions.current = a;
            }}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Inbox className="size-6" aria-hidden />
            </span>
            <p className="am-h3">No message selected</p>
            <p className="am-small max-w-72">
              Pick a conversation to read it. Press <kbd className="font-mono">c</kbd> to write,{" "}
              <kbd className="font-mono">?</kbd> for all shortcuts.
            </p>
          </div>
        )}
      </main>

      {composer?.variant === "panel" && (
        <Composer
          key={composer.key}
          client={client}
          identities={identities}
          contacts={contacts}
          seed={composer.seed}
          variant="panel"
          trashId={roles.trash}
          onClose={({ savedDraft }) => {
            setComposer(null);
            if (savedDraft) toasts.show({ message: "Draft saved." });
            void loadFolders();
            if (currentFolder?.role === "drafts") void reload({ keep: true });
          }}
          onSent={onSent}
        />
      )}

      {help && (
        <Modal
          title="Keyboard shortcuts"
          onClose={() => {
            setHelp(false);
          }}
        >
          <dl className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys} className="flex items-center justify-between gap-4">
                <dt className="am-small">{what}</dt>
                <dd className="shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[12px]">{keys}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}
      {adding && (
        <AddMailboxDialog
          client={client}
          onClose={() => {
            setAdding(false);
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirm={confirm.confirm}
          onConfirm={confirm.run}
          onClose={() => {
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
