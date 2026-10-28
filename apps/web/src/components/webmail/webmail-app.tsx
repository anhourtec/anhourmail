// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Archive,
  ArchiveRestore,
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
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MessageListSkeleton } from "@anhourmail/ui/skeletons";
import type { WebmailPreferences } from "@anhourmail/shared/webmail";
import { useTheme } from "next-themes";

import type { Address, MessageView } from "@/server/webmail/view";
import { Tooltip } from "@/components/tooltip";

import { type ComposeSeed, Composer } from "./composer";
import { SettingsWindow } from "./settings/settings-window";
import { ContactsView } from "./contacts-view";
import { AddMailboxDialog, ConfirmDialog, Modal } from "./dialogs";
import {
  type ComposeMode,
  displayName,
  folderLabel,
  folderTree,
  parseSearch,
  quoteBody,
  replyRecipients,
  replySubject,
  setDateStyle,
} from "./format";
import { quoteHtml } from "./rich-text";
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
  type ContactsData,
} from "./mail-client";
import { iconButtonClass, Menu, type MenuEntry } from "./menu";
import { MessageList } from "./message-list";
import { type MailChange, restoreTarget } from "./conversation";
import { newMailToAnnounce, playChime, pollDelay, shouldPoll, tabTitle } from "./sync";
import { Reader, type ReaderAction, type ReaderActions } from "./reader";
import { type Mailboxes, Sidebar } from "./sidebar";
import { ToastHost, useToasts } from "./toasts";

type Shown = { view: View; narrow: Narrow; search: SearchQuery | null };
const keyOf = (
  s: Shown,
  look: { grouping: string; attachmentChips: boolean } = { grouping: "", attachmentChips: false },
) => JSON.stringify([s.view, s.narrow, s.search, look.grouping, look.attachmentChips]);
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
  ["!", "Report spam (in Junk: not spam)"],
  ["s", "Add to or remove from Priority"],
  ["p", "Pin or unpin"],
  ["x", "Select"],
  ["Shift+U / Shift+I", "Mark unread / read"],
  ["/", "Search"],
  [",", "Settings"],
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
type AppProps = {
  username: string;
  signInHref: string;
  helpHref: string;
  /** The console's Aliases page (Settings → Account links there). */
  consoleHref: string;
  initialCollapsed: boolean;
  /** This mailbox's saved preferences (read on the server, so the first paint already follows them). */
  initialPreferences: WebmailPreferences;
  /** Our mail server's authserv-ids (only its Authentication-Results are trusted in message details). */
  authservIds?: string[];
};

export function WebmailApp(props: AppProps) {
  return (
    <ToastHost>
      <Mailroom {...props} />
    </ToastHost>
  );
}

function Mailroom({
  username,
  signInHref,
  helpHref,
  consoleHref,
  initialCollapsed,
  initialPreferences,
  authservIds = [],
}: AppProps) {
  const client = useMemo(() => {
    const c = createMailClient();
    c.setGrouping(initialPreferences.grouping);
    return c;
    // Created once; grouping changes go through setGrouping below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one client per app
  }, []);
  const [prefs, setPrefs] = useState<WebmailPreferences>(initialPreferences);
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rowKey = useCallback((r: ListRow) => (prefs.grouping === "messages" ? r.id : r.threadId), [prefs.grouping]);
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
  /** The open row's key (its conversation, or the message when not grouping) and the row itself. */
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<ListRow | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [priorityCount, setPriorityCount] = useState(0);
  const [mailboxes, setMailboxes] = useState<Mailboxes>({ active: username, others: [] });
  const [identities, setIdentities] = useState<Identity[]>([]);
  /** Your own addresses (lowercase): the mailbox and its sender identities. */
  const mine = useMemo(
    () => new Set([username, ...identities.map((i) => i.email)].map((e) => e.toLowerCase())),
    [username, identities],
  );
  const [contacts, setContacts] = useState<Address[]>([]);
  const [section, setSection] = useState<"mail" | "contacts">("mail");
  const [book, setBook] = useState<ContactsData | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** List windows being fetched (`key:page`), each with the ticket of its latest request. */
  const pending = useRef(new Map<string, number>());
  const tickets = useRef(0);
  /**
   * What the list shows now, and which `load` is the latest. Reloads read it (an action that finishes after the
   * person moved on — a pin saved after leaving a search — reloads what is shown then, not what was shown when it
   * started), and an older load's answer never overwrites a newer one's.
   */
  const shownRef = useRef<{ shown: Shown; hidden: string[]; seq: number } | null>(null);
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
    /** `fresh`: fetch again even if this window is on its way (its answer may predate a change); the newest wins. */
    async (key: string, filter: Record<string, unknown>, page: number, fresh = false) => {
      const k = `${key}:${String(page)}`;
      if (!fresh && pending.current.has(k)) return;
      const ticket = ++tickets.current;
      pending.current.set(k, ticket);
      const latest = () => pending.current.get(k) === ticket;
      try {
        const { total, rows } = await client.page(filter, page * PAGE_SIZE, PAGE_SIZE, {
          attachments: prefsRef.current.attachmentChips,
        });
        if (!latest()) return;
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
        if (latest()) fail(err);
      } finally {
        if (latest()) pending.current.delete(k);
      }
    },
    [client, fail],
  );

  /** Loads the list for `shown`: the pinned section (folder views), then the first window (or the loaded ones). */
  const load = useCallback(
    async (shown: Shown, hiddenIds: string[], opts: { keep?: boolean } = {}) => {
      const key = keyOf(shown, prefsRef.current);
      const main = mainFilter(shown, hiddenIds);
      const seq = (shownRef.current?.seq ?? 0) + 1;
      shownRef.current = { shown, hidden: hiddenIds, seq };
      const newest = () => shownRef.current?.seq === seq;
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
            { attachments: prefsRef.current.attachmentChips },
          );
          if (newest()) setPinned(p.rows);
        } catch (err) {
          if (newest()) fail(err);
        }
      } else {
        setPinned([]);
      }
      if (!newest()) return;
      const pages = opts.keep && listRef.current?.key === key ? [...listRef.current.loaded] : [];
      if (opts.keep) setList((cur) => (cur?.key === key ? { ...cur, loaded: new Set() } : cur));
      for (const page of pages.length > 0 ? pages : [0]) void loadPage(key, main, page, true);
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

  /** Reloads what is shown now (keeping the scroll position's windows with `keep`). */
  const reload = useCallback(
    async (opts: { keep?: boolean } = {}) => {
      const now = shownRef.current;
      if (now) await load(now.shown, now.hidden, opts);
    },
    [load],
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
        const start = prefsRef.current.startIn;
        const chosen = start.startsWith("folder:") ? f.find((x) => `folder:${x.id}` === start) : undefined;
        const first = chosen ?? f.find((x) => x.role === "inbox") ?? f[0];
        if (start === "priority") {
          const shown: Shown = { view: { kind: "priority" }, narrow: {}, search: null };
          setView(shown.view);
          void load(shown, h);
        } else if (first) {
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
    client
      .contacts()
      .then(setBook)
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

  // What changed since the last check, for the open conversation (it loads again when it is touched).
  const [mailChange, setMailChange] = useState<MailChange | null>(null);
  const changeSeq = useRef(0);
  const announceChange = useCallback((patch: Omit<MailChange, "seq">) => {
    changeSeq.current += 1;
    setMailChange({ ...patch, seq: changeSeq.current });
  }, []);

  const refresh = useCallback(() => {
    void loadFolders();
    void reload({ keep: true });
  }, [loadFolders, reload]);

  /** Refresh asked for by the person: the list, the folders and the open conversation. */
  const refreshAll = useCallback(() => {
    refresh();
    announceChange({ all: true, threadIds: new Set(), emailIds: new Set() });
  }, [refresh, announceChange]);

  // Automatic refresh (until push lands): one cheap Email/changes call every 30 s while the tab is visible, at once
  // when it becomes visible, gains focus or comes back online, backing off after errors. Only a real change reloads.
  const syncRefs = useRef({ refresh, announceChange, signedOut, roles, mine, prefs });
  useEffect(() => {
    syncRefs.current = { refresh, announceChange, signedOut, roles, mine, prefs };
  });
  useEffect(() => {
    let state: string | null = null;
    let failures = 0;
    let timer: number | undefined;
    let running = false;
    const life = { stopped: false };
    const stoppedNow = () => life.stopped;
    const tick = async () => {
      window.clearTimeout(timer);
      if (life.stopped || running || !shouldPoll(document.visibilityState, navigator.onLine)) return;
      running = true;
      try {
        const first = state === null;
        const r = await client.mailChanges(state);
        state = r.state;
        failures = 0;
        if (!first && r.changed) {
          const ref = syncRefs.current;
          ref.refresh();
          ref.announceChange({
            all: r.reset,
            threadIds: new Set(r.created.map((e) => e.threadId)),
            emailIds: new Set([...r.touched, ...r.created.map((e) => e.id)]),
          });
          const fresh = newMailToAnnounce(r.created, {
            inboxId: ref.roles.inbox,
            junkId: ref.roles.junk,
            mine: ref.mine,
            firstCheck: first,
          });
          if (fresh.length > 0) {
            if (ref.prefs.newMailSound) playChime();
            if (
              ref.prefs.desktopNotifications &&
              typeof Notification !== "undefined" &&
              Notification.permission === "granted" &&
              !document.hasFocus()
            ) {
              const who = fresh[0]?.from?.[0];
              new Notification(who ? displayName(who) : "New message", {
                body: fresh.length > 1 ? `${String(fresh.length)} new messages` : "New message",
                tag: "anhourmail-new-mail",
              });
            }
          }
        }
      } catch (err) {
        if (err instanceof SignedOutError) {
          syncRefs.current.signedOut();
          return;
        }
        failures += 1;
      } finally {
        running = false;
      }
      // The page may have closed while the check was out.
      if (!stoppedNow()) timer = window.setTimeout(() => void tick(), pollDelay(failures));
    };
    const wake = () => void tick();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    void tick();
    return () => {
      life.stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [client]);

  // The tab title shows the view and how much unread mail the Inbox has.
  const inboxUnread = folders?.find((f) => f.role === "inbox")?.unreadEmails ?? 0;
  const viewName = currentFolder ? folderLabel(currentFolder) : view?.kind === "priority" ? "Priority" : null;
  useEffect(() => {
    document.title = tabTitle(viewName, inboxUnread);
  }, [viewName, inboxUnread]);

  // ---- preferences --------------------------------------------------------------------------------------

  /** Applies a preference change at once, then saves it (rolled back with a message if saving fails). */
  const updatePrefs = useCallback(
    (patch: Partial<WebmailPreferences>) => {
      const before = prefsRef.current;
      const next = { ...before, ...patch };
      prefsRef.current = next;
      setPrefs(next);
      client.updatePreferences(patch).catch((err: unknown) => {
        prefsRef.current = before;
        setPrefs(before);
        fail(err, "That setting couldn't be saved. Try again.");
      });
    },
    [client, fail],
  );

  // Theme: the saved choice wins on load; switching it anywhere (the sidebar toggle too) is saved.
  const { theme, setTheme } = useTheme();
  const expectedTheme = useRef<string>(initialPreferences.theme);
  /** False until the page shows the saved theme: this browser's remembered theme must not overwrite it. */
  const themeSynced = useRef(false);
  useEffect(() => {
    expectedTheme.current = prefs.theme;
    if (theme !== prefs.theme) setTheme(prefs.theme);
    // Only when the saved preference changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows prefs.theme
  }, [prefs.theme]);
  useEffect(() => {
    if (!themeSynced.current) {
      if (theme === expectedTheme.current) themeSynced.current = true;
      return;
    }
    if (theme && theme !== expectedTheme.current && (theme === "light" || theme === "dark" || theme === "system")) {
      expectedTheme.current = theme;
      updatePrefs({ theme });
    }
  }, [theme, updatePrefs]);

  // Motion and how dates are written.
  useEffect(() => {
    const root = document.documentElement;
    if (prefs.motion === "reduced") root.dataset.motion = "reduced";
    else delete root.dataset.motion;
    return () => {
      delete root.dataset.motion;
    };
  }, [prefs.motion]);
  setDateStyle({
    locale: prefs.region,
    ...(prefs.timeZone !== "auto" ? { timeZone: prefs.timeZone } : {}),
    ...(prefs.hourCycle !== "auto" ? { hourCycle: prefs.hourCycle } : {}),
  });

  // Grouping and attachment chips change what the list fetches: reload it.
  const listShape = `${prefs.grouping}:${String(prefs.attachmentChips)}`;
  const shapeRef = useRef(listShape);
  useEffect(() => {
    if (shapeRef.current === listShape) return;
    shapeRef.current = listShape;
    client.setGrouping(prefs.grouping);
    setOpenThread(null);
    setOpenRow(null);
    setChecked(new Set());
    void reload();
  }, [listShape, prefs.grouping, client, reload]);

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
      setPinned((p) => p.filter((r) => !threadIds.has(rowKey(r))));
      setList((cur) => {
        if (!cur) return cur;
        const rows = cur.rows.filter((r) => !r || !threadIds.has(rowKey(r)));
        const removed = cur.rows.length - rows.length;
        return { ...cur, rows, total: cur.total === null ? null : Math.max(0, cur.total - removed) };
      });
      setChecked(new Set());
      if (openThread && threadIds.has(openThread)) {
        // Then open the next or previous conversation, or go back to the list (a setting).
        const after = prefsRef.current.afterMove;
        const target =
          after === "list" || selected === null ? undefined : rowAt(after === "next" ? selected + 1 : selected - 1);
        if (target && !threadIds.has(rowKey(target))) {
          setOpenThread(rowKey(target));
          setOpenRow(target);
          if (after === "previous" && selected !== null) setSelected(selected - 1);
        } else {
          setOpenThread(null);
          setOpenRow(null);
          setSelected(null);
        }
      }
    },
    [openThread, selected, rowAt, rowKey],
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
      // "Mark as read when moving" (a setting): never for Trash.
      if (prefsRef.current.markReadOnMove && to !== roles.trash) keywords = { $seen: true, ...keywords };
      dropThreads(new Set(threadIds));
      try {
        const skip = [roles.sent, roles.drafts].filter((x): x is string => x !== undefined);
        const before = await client.move(threadIds, from, to, keywords, skip);
        void loadFolders();
        // A reload that started before the move landed (e.g. after a pin) would bring the rows back: load again.
        void reload({ keep: true });
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
              void reload({ keep: true });
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
        patchRows((r) => (threadIds.includes(rowKey(r)) ? { ...r, keywords: { ...r.keywords, [keyword]: on } } : r));
      } catch (err) {
        fail(err);
      }
    },
    [client, currentFolder, onKeyword, patchRows, fail, rowKey],
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
          void moveThreads(threadIds, roles.junk, "Reported as spam.", { $junk: true, $notjunk: null });
          break;
        case "phishing":
          void moveThreads(threadIds, roles.junk, "Reported as phishing.", {
            $junk: true,
            $notjunk: null,
            $phishing: true,
          });
          break;
        case "restore": {
          // Each message goes back by its sender: your own to Sent, everything else to the Inbox.
          const trashId = roles.trash;
          if (!trashId || threadIds.length === 0) break;
          dropThreads(new Set(threadIds));
          void (async () => {
            try {
              const { before, targets } = await client.restoreFromTrash(threadIds, trashId, (from) =>
                restoreTarget(from, mine, roles),
              );
              void loadFolders();
              void reload({ keep: true });
              const names = targets.map((id) => {
                const f = folders?.find((x) => x.id === id);
                return f ? folderLabel(f) : "Inbox";
              });
              toasts.show({
                message: `Restored to ${names.join(" and ") || "Inbox"}.`,
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
          })();
          break;
        }
        case "block": {
          const address = action.address;
          void (async () => {
            try {
              const s = await client.settings();
              const junk = s.rules.junk;
              if (!junk.blocked.includes(address)) {
                await client.saveJunk(s.accountId, { ...junk, blocked: [...junk.blocked, address] });
              }
              if (currentFolder?.role === "junk") toasts.show({ message: `Blocked ${address}.` });
              else
                await moveThreads(threadIds, roles.junk, `Blocked ${address}. Moved to Junk.`, {
                  $junk: true,
                  $notjunk: null,
                });
            } catch (err) {
              fail(err, "Couldn't block this sender. Try again.");
            }
          })();
          break;
        }
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
    [
      moveThreads,
      roles,
      currentFolder,
      deleteForever,
      folders,
      mine,
      client,
      toasts,
      fail,
      dropThreads,
      loadFolders,
      reload,
      refresh,
    ],
  );

  // ---- composing ----------------------------------------------------------------------------------------

  /**
   * Address suggestions for the composer: everyone in the address books plus recent correspondents, the people
   * this mailbox emails most first.
   */
  const ensureContacts = useCallback(() => {
    if (contacts.length > 0) return;
    void Promise.all([
      client.recentCorrespondents(roles.sent).catch(() => []),
      client.contacts().catch(() => null),
    ]).then(([recent, saved]) => {
      const all = new Map<string, Address & { score: number }>();
      for (const r of recent) all.set(r.email, { ...r });
      for (const c of saved?.contacts ?? []) {
        for (const e of c.emails) {
          const cur = all.get(e.address);
          if (cur) cur.name = c.name || cur.name;
          else all.set(e.address, { name: c.name || null, email: e.address, score: 0 });
        }
      }
      setContacts(
        [...all.values()]
          .sort((a, b) => b.score - a.score || (a.name ?? a.email).localeCompare(b.name ?? b.email))
          .map(({ name, email }) => ({ name, email })),
      );
    });
  }, [contacts.length, client, roles.sent]);

  const loadBook = useCallback(async () => {
    try {
      setBook(await client.contacts());
    } catch (err) {
      fail(err, "Couldn't load your contacts. Try again.");
    }
  }, [client, fail]);

  const known = useMemo(
    () => new Set((book?.contacts ?? []).flatMap((c) => c.emails.map((e) => e.address.toLowerCase()))),
    [book],
  );

  /** "Add to contacts" from a sender card or an address chip: saved to My contacts. */
  const addContact = useCallback(
    (person: Address) => {
      const email = person.email.toLowerCase();
      void (async () => {
        try {
          // The account the contacts belong to (loaded with them); changes refuse another active mailbox.
          const current = book ?? (await client.contacts());
          const existing = current.contacts.find((c) => c.emails.some((e) => e.address === email));
          if (existing) await client.moveContacts(current.accountId, [existing.id], "mine");
          else
            await client.createContact(current.accountId, {
              given: "",
              surname: "",
              name: (person.name ?? "").trim().slice(0, 200),
              emails: [{ address: email, label: "" }],
              phones: [],
              organization: "",
              notes: "",
              birthday: null,
              labels: [],
            });
          await loadBook();
          toasts.show({ message: `${person.name ?? email} added to contacts.` });
        } catch (err) {
          fail(err);
        }
      })();
    },
    [book, client, loadBook, toasts, fail],
  );

  const openContacts = () => {
    setDrawer(false);
    setOpenThread(null);
    setChecked(new Set());
    setSection("contacts");
    void loadBook();
  };

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
      signature: true,
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
          html: quoteHtml(m, mode),
          ...(mode !== "forward" && m.messageId.length > 0
            ? { inReplyTo: m.messageId, references: [...m.references, ...m.messageId].slice(-50) }
            : {}),
          attachments: mode === "forward" ? m.attachments : [],
          ...(toMe ? { fromEmail: toMe } : {}),
          focus: mode === "forward" ? "to" : "body",
          signature: true,
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
          // A draft written in rich text reopens in rich text; a plain one stays plain.
          ...(m.html !== null ? { html: m.html } : { mode: "plain" as const }),
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
    (submissionId: string, _draftId: string, holdSeconds: number) => {
      setComposer(null);
      setContacts([]); // New recipients may have been saved: suggestions reload next time.
      refresh();
      toasts.show({
        message: "Message sent.",
        // Undo works while the server holds the message (the chosen delay), less a moment for the request.
        duration: Math.max(3000, holdSeconds * 1000 - 500),
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
      setOpenThread(rowKey(row));
      setOpenRow(row);
    },
    [rowAt, currentFolder, openDraft, rowKey],
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
      if (openThread !== null && row && currentFolder?.role !== "drafts") {
        setOpenThread(rowKey(row));
        setOpenRow(row);
      }
    },
    [flatTotal, selected, rowAt, openThread, currentFolder, rowKey],
  );

  const toggleCheck = useCallback(
    (index: number, range: boolean) => {
      setChecked((cur) => {
        const next = new Set(cur);
        if (range && anchor.current !== null) {
          const [a, b] = anchor.current < index ? [anchor.current, index] : [index, anchor.current];
          for (let i = a; i <= b; i++) {
            const r = rowAt(i);
            if (r) next.add(rowKey(r));
          }
        } else {
          const r = rowAt(index);
          if (r) {
            if (next.has(rowKey(r))) next.delete(rowKey(r));
            else next.add(rowKey(r));
          }
          anchor.current = index;
        }
        return next;
      });
    },
    [rowAt, rowKey],
  );

  const selectView = (v: View) => {
    setSection("mail");
    setDrawer(false);
    setSearchText("");
    setOpenThread(null);
    show({ view: v, narrow: {}, search: null });
  };

  const targets = (): string[] => {
    if (checked.size > 0) return [...checked];
    if (openThread) return [openThread];
    const r = selected !== null ? rowAt(selected) : undefined;
    return r ? [rowKey(r)] : [];
  };

  // ---- keyboard -----------------------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (composer?.variant === "panel" || confirm || adding || settingsOpen) return;
      // With shortcuts off (a setting), only Escape works.
      if (!prefs.shortcuts && e.key !== "Escape") return;
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (e.key === "Escape") {
        if (help) setHelp(false);
        else if (drawer) setDrawer(false);
        else if (checked.size > 0) setChecked(new Set());
        else close();
        return;
      }
      if (help || drawer) return;
      if (section === "contacts") {
        if (e.key === "c") compose();
        else if (e.key === "?") setHelp(true);
        else return;
        e.preventDefault();
        return;
      }
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
      // "Empty Trash when I sign out" (a setting the person turned on).
      if (prefs.emptyTrashOnSignOut && roles.trash) await client.emptyFolder(roles.trash).catch(() => undefined);
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
      view={section === "mail" ? view : null}
      contactsCurrent={section === "contacts"}
      onContacts={openContacts}
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
      onSettings={() => {
        setDrawer(false);
        setSettingsOpen(true);
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

  // Reading pane (a setting): beside the list, below it, or instead of it (the list comes back on close).
  const pane = prefs.readingPane;
  const open_ = openThread !== null;
  const mailGrid =
    pane === "right"
      ? "md:grid-cols-[23rem_minmax(0,1fr)] lg:grid-cols-[26rem_minmax(0,1fr)]"
      : pane === "bottom"
        ? "md:grid-rows-[minmax(0,2fr)_minmax(0,3fr)]"
        : "";
  const listVisibility = pane === "off" ? (open_ ? "hidden" : "flex") : open_ ? "hidden md:flex" : "flex";
  const readerVisibility =
    pane === "off" ? (open_ ? "flex flex-col" : "hidden") : open_ ? "flex flex-col" : "hidden md:flex md:flex-col";

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
          if (r) all.add(rowKey(r));
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
        knownAddresses={known}
        onAddContact={addContact}
        seed={composer.seed}
        variant="inline"
        trashId={roles.trash}
        alwaysCcBcc={prefs.showCcBcc}
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
      className={`grid h-dvh grid-cols-1 overflow-hidden ${
        collapsed ? "lg:grid-cols-[3.5rem_minmax(0,1fr)]" : "lg:grid-cols-[15rem_minmax(0,1fr)]"
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

      {section === "contacts" ? (
        <ContactsView
          client={client}
          data={book}
          onChanged={loadBook}
          onToggleSidebar={toggleSidebar}
          onCompose={(address, name) => {
            openComposer({
              title: "New message",
              to: [{ name: name || null, email: address }],
              cc: [],
              bcc: [],
              subject: "",
              text: "",
              attachments: [],
              focus: "body",
              signature: true,
            });
          }}
        />
      ) : (
        <div className={`grid min-h-0 grid-cols-1 ${mailGrid}`} data-reading-pane={pane}>
          <section
            aria-label={title}
            className={`flex min-h-0 flex-col ${pane === "bottom" ? "md:border-b" : pane === "right" ? "border-r" : ""} ${listVisibility}`}
          >
            <header className="flex h-14 shrink-0 items-center gap-1 px-2">
              <Tooltip label="Folders">
                <button type="button" onClick={toggleSidebar} aria-label="Toggle folders" className={iconButtonClass}>
                  <PanelLeft className="size-4" aria-hidden />
                </button>
              </Tooltip>
              <span aria-hidden className="mx-1 h-4 w-px bg-border" />
              <h1 className="min-w-0 flex-1 truncate font-display font-medium text-[1.25rem] tracking-tight">
                {title}
              </h1>
              <Menu
                label={narrowed ? "Filter (on)" : "Filter"}
                icon={SlidersHorizontal}
                items={filterItems}
                className={narrowed ? "[&>span>button]:text-primary" : ""}
              />
              <Tooltip label="Refresh">
                <button type="button" onClick={refreshAll} aria-label="Refresh" className={iconButtonClass}>
                  <RotateCw className="size-4" aria-hidden />
                </button>
              </Tooltip>
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
                {currentFolder?.role === "trash" ? (
                  <Tooltip label="Restore">
                    <button
                      type="button"
                      onClick={() => {
                        act(t, { kind: "restore" });
                      }}
                      aria-label="Restore selected"
                      className={iconButtonClass}
                    >
                      <ArchiveRestore className="size-4" aria-hidden />
                    </button>
                  </Tooltip>
                ) : currentFolder?.role === "junk" ? (
                  <Tooltip label="Not spam" shortcut="!">
                    <button
                      type="button"
                      onClick={() => {
                        act(t, { kind: "notJunk" });
                      }}
                      aria-label="Not spam (selected)"
                      className={iconButtonClass}
                    >
                      <ShieldCheck className="size-4" aria-hidden />
                    </button>
                  </Tooltip>
                ) : (
                  currentFolder?.role !== "archive" && (
                    <Tooltip label="Archive" shortcut="e">
                      <button
                        type="button"
                        onClick={() => {
                          act(t, { kind: "archive" });
                        }}
                        aria-label="Archive selected"
                        className={iconButtonClass}
                      >
                        <Archive className="size-4" aria-hidden />
                      </button>
                    </Tooltip>
                  )
                )}
                <Tooltip label="Delete" shortcut="#">
                  <button
                    type="button"
                    onClick={() => {
                      act(t, { kind: "trash" });
                    }}
                    aria-label="Delete selected"
                    className={`${iconButtonClass} text-destructive hover:text-destructive`}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </Tooltip>
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
                          label: "Not spam",
                          icon: ShieldCheck,
                          onSelect: () => {
                            act(t, { kind: "notJunk" });
                          },
                        }
                      : {
                          label: "Report spam",
                          icon: ShieldAlert,
                          onSelect: () => {
                            act(t, { kind: "junk" });
                          },
                        },
                    {
                      label: "Report phishing",
                      icon: ShieldX,
                      onSelect: () => {
                        act(t, { kind: "phishing" });
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
                  <Search
                    className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
                    aria-hidden
                  />
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
                    placeholder="Search (from:, subject:, has:attachment)"
                    aria-label="Search mail"
                    className="h-8 w-full rounded-lg border bg-background pr-8 pl-8 text-[13px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <kbd className="pointer-events-none absolute right-2.5 hidden font-mono text-[11px] text-muted-foreground md:block">
                    /
                  </kbd>
                </label>
              </form>
            )}

            {error && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 border-y bg-destructive/8 px-4 py-2.5"
              >
                <p className="am-small text-destructive">{error}</p>
                <button
                  type="button"
                  onClick={refreshAll}
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
                  look={prefs}
                  rowKey={rowKey}
                  onOpen={open}
                  onCheck={toggleCheck}
                  onRange={onRange}
                />
              )}
            </div>
          </section>

          <main className={`min-h-0 ${readerVisibility}`}>
            {openThread !== null ? (
              <Reader
                key={openThread}
                client={client}
                threadId={openRow?.threadId ?? openThread}
                mailChange={mailChange}
                onlyEmailId={prefs.grouping === "messages" ? (openRow?.id ?? openThread) : undefined}
                markRead={{ mode: prefs.markRead, delay: prefs.markReadDelay }}
                mine={mine}
                authservIds={authservIds}
                defaultReply={prefs.defaultReply}
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
                    signature: true,
                  });
                }}
                knownAddresses={known}
                onAddContact={addContact}
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
        </div>
      )}

      {composer?.variant === "panel" && (
        <Composer
          key={composer.key}
          client={client}
          identities={identities}
          contacts={contacts}
          knownAddresses={known}
          onAddContact={addContact}
          seed={composer.seed}
          variant="panel"
          trashId={roles.trash}
          alwaysCcBcc={prefs.showCcBcc}
          onClose={({ savedDraft }) => {
            setComposer(null);
            if (savedDraft) toasts.show({ message: "Draft saved." });
            void loadFolders();
            if (currentFolder?.role === "drafts") void reload({ keep: true });
          }}
          onSent={onSent}
        />
      )}

      {settingsOpen && (
        <SettingsWindow
          client={client}
          preferences={prefs}
          folders={folders ?? []}
          consoleHref={consoleHref}
          shortcuts={SHORTCUTS}
          onChange={updatePrefs}
          onIdentitiesChanged={setIdentities}
          onSignOut={() => {
            void signOut();
          }}
          onClose={() => {
            setSettingsOpen(false);
          }}
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
