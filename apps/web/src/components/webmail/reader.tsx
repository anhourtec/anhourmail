// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  EllipsisVertical,
  FileCode,
  Flag,
  FolderInput,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  Pin,
  Printer,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Bone, ReaderSkeleton } from "@anhourmail/ui/skeletons";

import { authResults, senderChecks } from "@/server/webmail/original";
import type { Address, MessageView } from "@/server/webmail/view";

import { Tooltip } from "@/components/tooltip";

import {
  defaultExpanded,
  fromHere,
  isMine,
  type MailChange,
  mergeExpanded,
  recipientLabel,
  sameThread,
  senderLabel,
  touchesThread,
} from "./conversation";
import { displayName, folderLabel, folderTree, fullDate, initials, messageDate, subjectOf } from "./format";
import type { Folder, MailClient, Summary } from "./mail-client";
import { iconButtonClass, Menu, type MenuEntry } from "./menu";
import { type ImageOptions, MessageContent } from "./message-body";
import { SenderAvatar } from "./message-list";
import type { ImagePolicy } from "./remote-images";

export type ReaderAction =
  | { kind: "archive" }
  | { kind: "trash" }
  | { kind: "deleteForever" }
  | { kind: "junk" }
  | { kind: "phishing" }
  | { kind: "notJunk" }
  | { kind: "restore" }
  | { kind: "block"; address: string }
  | { kind: "move"; to: string }
  | { kind: "reply" | "replyAll" | "forward"; message: MessageView; inline: boolean };

export type ReaderActions = {
  toggleFlag: () => void;
  togglePin: () => void;
  setRead: (read: boolean) => void;
  reply: (mode: "reply" | "replyAll" | "forward") => void;
};

/** Where the webmail's pages live on this origin ("" on the webmail host, "/webmail" on a dev bare host). */
const pagesBase = () =>
  typeof window !== "undefined" && window.location.pathname.startsWith("/webmail") ? "/webmail" : "";

function AddressList({ list }: { list: Address[] }) {
  return (
    <>
      {list.map((a, i) => (
        <span key={`${a.email}-${String(i)}`}>
          {i > 0 && ", "}
          <span className="text-foreground">{displayName(a)}</span>
          {a.name ? <span className="font-mono"> &lt;{a.email}&gt;</span> : null}
        </span>
      ))}
    </>
  );
}

function BodySkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {["w-full", "w-11/12", "w-10/12", "w-full", "w-9/12", "w-8/12"].map((w, i) => (
        <Bone key={`${w}-${String(i)}`} className={`h-3.5 ${w}`} />
      ))}
    </div>
  );
}

/** "mailed-by" and "signed-by", from our mail server's own Authentication-Results (fetched when details open). */
function SenderChecks({
  client,
  emailId,
  authservIds,
}: {
  client: MailClient;
  emailId: string;
  authservIds: readonly string[];
}) {
  const [checks, setChecks] = useState<{ mailedBy: string | null; signedBy: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    client
      .traceHeaders(emailId)
      .then((headers) => {
        if (!live) return;
        setChecks(senderChecks(authResults(headers, authservIds)));
      })
      .catch(() => {
        if (live) setChecks({ mailedBy: null, signedBy: null });
      });
    return () => {
      live = false;
    };
  }, [client, emailId, authservIds]);
  if (!checks) {
    return (
      <>
        <dt>mailed-by</dt>
        <dd>
          <Bone className="h-3 w-24" />
        </dd>
      </>
    );
  }
  return (
    <>
      {checks.mailedBy && (
        <>
          <dt>mailed-by</dt>
          <dd className="font-mono">{checks.mailedBy}</dd>
        </>
      )}
      {checks.signedBy && (
        <>
          <dt>signed-by</dt>
          <dd className="font-mono">{checks.signedBy}</dd>
        </>
      )}
    </>
  );
}

/** One expanded message of a conversation: sender card, recipients with details, actions, body. */
function MessageCard({
  summary,
  view,
  client,
  mine,
  authservIds,
  paneHeight,
  menu,
  knownAddresses,
  onAddContact,
  onToggleFlag,
  onReply,
  onCollapse,
  onComposeTo,
  onViewFull,
  collapsible,
  images,
}: {
  summary: Summary;
  view: MessageView | "missing" | undefined;
  client: MailClient;
  mine: ReadonlySet<string>;
  authservIds: readonly string[];
  paneHeight: number;
  menu: MenuEntry[];
  knownAddresses: ReadonlySet<string>;
  onAddContact: (person: Address) => void;
  onToggleFlag: () => void;
  onReply: () => void;
  onCollapse: () => void;
  onComposeTo: (address: string) => void;
  onViewFull: () => void;
  collapsible: boolean;
  images?: ImageOptions | undefined;
}) {
  const [details, setDetails] = useState(false);
  const from = summary.from?.[0];
  const own = isMine(from, mine);
  const flagged = summary.keywords.$flagged === true;
  const loaded = view && view !== "missing" ? view : null;
  return (
    <article aria-label={`Message from ${senderLabel(from, mine)}`} className="flex flex-col gap-4 px-3 py-3">
      <div className="flex items-start gap-3">
        <SenderAvatar email={from?.email} label={initials(from)} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2">
            {collapsible ? (
              <button
                type="button"
                onClick={onCollapse}
                aria-expanded
                className="rounded font-medium text-[14px] hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {senderLabel(from, mine)}
              </button>
            ) : (
              <span className="font-medium text-[14px]">{senderLabel(from, mine)}</span>
            )}
            {from && (
              <span className="truncate font-mono text-[12.5px] text-muted-foreground">&lt;{from.email}&gt;</span>
            )}
            {from && !own && !knownAddresses.has(from.email.toLowerCase()) && (
              <button
                type="button"
                onClick={() => {
                  onAddContact(from);
                }}
                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-primary hover:bg-accent"
              >
                <UserPlus className="size-3.5" aria-hidden /> Add to contacts
              </button>
            )}
          </div>
          {loaded ? (
            <button
              type="button"
              aria-expanded={details}
              onClick={() => {
                setDetails((d) => !d);
              }}
              className="inline-flex w-fit items-center gap-0.5 rounded text-[12.5px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {recipientLabel(loaded.to, loaded.cc, mine)}
              <ChevronDown className={`size-3.5 transition-transform ${details ? "rotate-180" : ""}`} aria-hidden />
              <span className="sr-only">Show details</span>
            </button>
          ) : (
            <Bone className="mt-1 h-3 w-32" />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <span className="mr-1 hidden text-[12px] text-muted-foreground sm:inline">
            {messageDate(summary.receivedAt)}
          </span>
          <Tooltip label={flagged ? "Remove from Priority" : "Add to Priority"}>
            <button
              type="button"
              onClick={onToggleFlag}
              aria-label="Priority"
              aria-pressed={flagged}
              className={iconButtonClass}
            >
              <Flag
                className={`size-4 ${flagged ? "fill-current text-[rgb(var(--am-status-warning-bg))]" : ""}`}
                aria-hidden
              />
            </button>
          </Tooltip>
          <Tooltip label="Reply">
            <button type="button" onClick={onReply} disabled={!loaded} aria-label="Reply" className={iconButtonClass}>
              <Reply className="size-4" aria-hidden />
            </button>
          </Tooltip>
          <Menu label="Message actions" icon={EllipsisVertical} items={menu} />
        </div>
      </div>
      <p className="-mt-3 pl-[3.25rem] text-[12px] text-muted-foreground sm:hidden">
        {messageDate(summary.receivedAt)}
      </p>

      {details && loaded && (
        <dl
          aria-label="Message details"
          className="ml-[3.25rem] grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-[12.5px] [&>dt]:text-muted-foreground"
        >
          <dt>from</dt>
          <dd className="break-words">
            <AddressList list={loaded.from} />
          </dd>
          <dt>to</dt>
          <dd className="break-words">
            <AddressList list={loaded.to} />
          </dd>
          {loaded.cc.length > 0 && (
            <>
              <dt>cc</dt>
              <dd className="break-words">
                <AddressList list={loaded.cc} />
              </dd>
            </>
          )}
          <dt>date</dt>
          <dd>{fullDate(loaded.sentAt ?? loaded.receivedAt)}</dd>
          <dt>subject</dt>
          <dd className="break-words">{subjectOf(loaded.subject)}</dd>
          <SenderChecks client={client} emailId={summary.id} authservIds={authservIds} />
        </dl>
      )}

      {view === undefined ? (
        <BodySkeleton />
      ) : view === "missing" ? (
        <p className="am-small">This message is no longer here.</p>
      ) : (
        <MessageContent
          view={view}
          client={client}
          paneHeight={paneHeight}
          onCompose={onComposeTo}
          onViewFull={onViewFull}
          {...(images ? { images } : {})}
        />
      )}
    </article>
  );
}

/** An earlier message of a conversation, folded to one line; click to expand it. */
function CollapsedRow({
  summary,
  mine,
  onExpand,
}: {
  summary: Summary;
  mine: ReadonlySet<string>;
  onExpand: () => void;
}) {
  const from = summary.from?.[0];
  const unread = summary.keywords.$seen !== true;
  return (
    <button
      type="button"
      aria-expanded={false}
      onClick={onExpand}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <SenderAvatar email={from?.email} label={initials(from)} size="sm" />
      <span className={`w-24 shrink-0 truncate text-[13px] sm:w-36 ${unread ? "font-medium" : ""}`}>
        {senderLabel(from, mine)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{summary.preview}</span>
      {summary.hasAttachment && (
        <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" />
      )}
      {summary.keywords.$flagged === true && (
        <Flag
          className="size-3.5 shrink-0 fill-current text-[rgb(var(--am-status-warning-bg))]"
          aria-label="Priority"
        />
      )}
      <span className="hidden shrink-0 text-[12px] text-muted-foreground md:inline">
        {messageDate(summary.receivedAt)}
      </span>
    </button>
  );
}

/**
 * Reading pane for one conversation: toolbar, subject with folder chips, then every message oldest first — earlier
 * ones folded to a line, the newest and any unread ones expanded (bodies load when a message is expanded) — and
 * Reply / Reply all / Forward for the last message at the bottom. Opening it marks the conversation read. On phones
 * the main actions sit in a bottom bar.
 */
export function Reader({
  client,
  threadId,
  mailChange = null,
  folders,
  currentFolder,
  hiddenMailboxIds,
  canPrev,
  canNext,
  inlineComposer,
  onPrev,
  onNext,
  onClose,
  onAction,
  onKeyword,
  onSignedOut,
  onComposeTo,
  knownAddresses,
  onAddContact,
  registerActions,
  onlyEmailId,
  mine = new Set<string>(),
  authservIds = [],
  markRead = { mode: "open", delay: 5 },
  defaultReply = "reply",
  imagePolicy,
  onRememberImages,
}: {
  client: MailClient;
  threadId: string;
  /**
   * The latest change in the mailbox: when it touches this conversation (a new reply, a message changed or removed,
   * or Refresh) the conversation loads again in place, keeping what is expanded and the scroll position.
   */
  mailChange?: MailChange | null;
  /** Show just this message of the thread (the list isn't grouping conversations). */
  onlyEmailId?: string | undefined;
  /** The signed-in person's own addresses (lowercase): their messages show as "me". */
  mine?: ReadonlySet<string>;
  /** Our mail server's authserv-ids: only its Authentication-Results are trusted for "mailed-by" / "signed-by". */
  authservIds?: readonly string[];
  /** When opened mail is marked read: at once, after `delay` seconds, or never (a setting). */
  markRead?: { mode: "open" | "delay" | "never"; delay: number };
  /** What the Reply button and `r` do (a setting). */
  defaultReply?: "reply" | "replyAll";
  /** When remote images load without asking (settings and remembered senders). */
  imagePolicy?: ImagePolicy;
  /** Remembers or forgets a sender for "Always load images from this sender". */
  onRememberImages?: (senderKey: string, on: boolean) => void;
  folders: Folder[];
  /** The folder being viewed (null in Priority or search). */
  currentFolder: Folder | null;
  /** Trash/Junk ids: their messages are hidden from a thread opened elsewhere. */
  hiddenMailboxIds: string[];
  canPrev: boolean;
  canNext: boolean;
  /** An inline reply composer, shown at the bottom instead of the reply buttons. */
  inlineComposer: ReactNode;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onAction: (action: ReaderAction) => void;
  onKeyword: (ids: string[], keyword: string, on: boolean) => Promise<void>;
  onSignedOut: () => void;
  /** Writes to an address found in a message (opens the composer). */
  onComposeTo: (address: string) => void;
  /** Addresses already in an address book (lowercase); others get "Add to contacts". */
  knownAddresses: ReadonlySet<string>;
  onAddContact: (person: Address) => void;
  registerActions: (a: ReaderActions | null) => void;
}) {
  const [thread, setThread] = useState<Summary[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const images: ImageOptions | undefined =
    imagePolicy && onRememberImages
      ? { policy: imagePolicy, contacts: knownAddresses, onRemember: onRememberImages }
      : undefined;
  const [views, setViews] = useState<Record<string, MessageView | "missing">>({});
  const [error, setError] = useState<string | null>(null);
  // The reading pane's height: an HTML message frame fills it (the frame can't measure its own content).
  const pane = useRef<HTMLDivElement>(null);
  const [paneHeight, setPaneHeight] = useState(640);
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setPaneHeight(el.clientHeight);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  });

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    client
      .thread(threadId)
      .then((all) => {
        if (!live) return;
        const visible = all.filter((e) => !hiddenMailboxIds.some((id) => e.mailboxIds[id]));
        const shown = visible.length > 0 ? visible : all;
        const one = onlyEmailId ? shown.filter((e) => e.id === onlyEmailId) : [];
        const list = one.length > 0 ? one : shown;
        setThread(list);
        setExpanded(defaultExpanded(list));
        const unread = list.filter((e) => e.keywords.$seen !== true).map((e) => e.id);
        const markSeen = () => {
          if (!live) return;
          void onKeyword(unread, "$seen", true)
            .then(() => {
              if (live) {
                setThread(
                  (t) =>
                    t?.map((e) => (unread.includes(e.id) ? { ...e, keywords: { ...e.keywords, $seen: true } } : e)) ??
                    t,
                );
              }
            })
            .catch(() => undefined);
        };
        if (unread.length > 0 && markRead.mode === "open") markSeen();
        else if (unread.length > 0 && markRead.mode === "delay")
          timer = window.setTimeout(markSeen, markRead.delay * 1000);
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof Error && err.name === "SignedOutError") onSignedOut();
        else setError("This conversation couldn't be loaded.");
      });
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // The thread id is the identity of this reader (the parent re-keys it); callbacks are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per thread
  }, [threadId]);

  // A change touching this conversation: load it again in place. The message rows keep their keys, so the scroll
  // position and loaded bodies stay; new messages open the way they would have on opening (unread and the newest).
  // New messages aren't marked read here: the person may not be looking.
  const threadRef = useRef(thread);
  useEffect(() => {
    threadRef.current = thread;
  });
  useEffect(() => {
    const now = threadRef.current;
    if (
      !mailChange ||
      !now ||
      !touchesThread(
        mailChange,
        threadId,
        now.map((e) => e.id),
      )
    )
      return;
    let live = true;
    client
      .thread(threadId)
      .then((all) => {
        const before = threadRef.current;
        if (!live || !before) return;
        const visible = all.filter((e) => !hiddenMailboxIds.some((id) => e.mailboxIds[id]));
        const shown = visible.length > 0 ? visible : all;
        const one = onlyEmailId ? shown.filter((e) => e.id === onlyEmailId) : [];
        const list = one.length > 0 ? one : shown;
        if (list.length === 0 || sameThread(before, list)) return;
        setThread(list);
        setExpanded((cur) => mergeExpanded(before, list, cur));
      })
      .catch((err: unknown) => {
        if (live && err instanceof Error && err.name === "SignedOutError") onSignedOut();
        // Otherwise keep showing what we have; the next change or Refresh tries again.
      });
    return () => {
      live = false;
    };
    // Only a new change signal reloads; the rest is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the change signal
  }, [mailChange]);

  // Bodies load lazily: only for expanded messages, once each.
  useEffect(() => {
    const missing = [...expanded].filter((id) => views[id] === undefined);
    if (missing.length === 0) return;
    let live = true;
    for (const id of missing) {
      client
        .message(id)
        .then((v) => {
          if (live) setViews((m) => ({ ...m, [id]: v ?? "missing" }));
        })
        .catch((err: unknown) => {
          if (!live) return;
          if (err instanceof Error && err.name === "SignedOutError") onSignedOut();
          else setError("This message couldn't be loaded.");
        });
    }
    return () => {
      live = false;
    };
  }, [expanded, views, client, onSignedOut]);

  // The message toolbar actions and shortcuts act on: the newest message that isn't an unsent draft.
  const current = thread ? (thread.filter((e) => e.keywords.$draft !== true).at(-1) ?? thread.at(-1) ?? null) : null;
  const currentView = current ? views[current.id] : undefined;
  const loaded = currentView && currentView !== "missing" ? currentView : null;
  const flagged = current?.keywords.$flagged === true;
  const read = current?.keywords.$seen === true;
  const pinned = thread?.some((e) => e.keywords.$pinned === true) ?? false;
  const role = currentFolder?.role ?? null;
  const inJunk = role === "junk";
  const inTrash = role === "trash";
  const allExpanded = thread !== null && thread.length > 0 && thread.every((e) => expanded.has(e.id));

  const setKeyword = (ids: string[], keyword: string, on: boolean) => {
    if (ids.length === 0) return;
    const apply = (value: boolean) => {
      setThread(
        (t) => t?.map((e) => (ids.includes(e.id) ? { ...e, keywords: { ...e.keywords, [keyword]: value } } : e)) ?? t,
      );
    };
    apply(on);
    void onKeyword(ids, keyword, on).catch(() => {
      apply(!on);
    });
  };

  const replyWith = (view: MessageView | null, mode: "reply" | "replyAll" | "forward", inline = false) => {
    if (view) onAction({ kind: mode, message: view, inline });
  };
  const reply = (mode: "reply" | "replyAll" | "forward", inline = false) => {
    replyWith(loaded, mode, inline);
  };

  const expandAll = (on: boolean) => {
    if (!thread) return;
    setExpanded(on ? new Set(thread.map((e) => e.id)) : new Set(current ? [current.id] : []));
  };

  useEffect(() => {
    registerActions({
      toggleFlag: () => {
        if (current) setKeyword([current.id], "$flagged", !flagged);
      },
      togglePin: () => {
        if (thread)
          setKeyword(
            thread.map((e) => e.id),
            "$pinned",
            !pinned,
          );
      },
      setRead: (r: boolean) => {
        if (current) setKeyword([current.id], "$seen", r);
      },
      reply: (mode) => {
        reply(mode === "reply" ? defaultReply : mode);
      },
    });
    return () => {
      registerActions(null);
    };
  });

  /** The conventional message menu: answer · delete and unread · sender and spam · print, download, source. */
  const messageMenu = (e: Summary): MenuEntry[] => {
    const v = views[e.id];
    const view = v && v !== "missing" ? v : null;
    const sender = e.from?.[0];
    const blockable = sender && !isMine(sender, mine) ? sender.email.toLowerCase() : null;
    return [
      {
        label: "Reply",
        icon: Reply,
        disabled: !view,
        onSelect: () => {
          replyWith(view, "reply");
        },
      },
      {
        label: "Reply all",
        icon: ReplyAll,
        disabled: !view,
        onSelect: () => {
          replyWith(view, "replyAll");
        },
      },
      {
        label: "Forward",
        icon: Forward,
        disabled: !view,
        onSelect: () => {
          replyWith(view, "forward");
        },
      },
      { separator: true },
      {
        label: inTrash || inJunk ? "Delete forever" : "Delete",
        icon: Trash2,
        danger: true,
        onSelect: () => {
          onAction(inTrash || inJunk ? { kind: "deleteForever" } : { kind: "trash" });
        },
      },
      {
        label: "Mark unread from here",
        icon: Mail,
        onSelect: () => {
          if (!thread) return;
          setKeyword(fromHere(thread, e.id), "$seen", false);
          onClose();
        },
      },
      { separator: true },
      ...(blockable
        ? [
            {
              label: `Block "${blockable}"`,
              icon: Ban,
              onSelect: () => {
                onAction({ kind: "block", address: blockable });
              },
            },
          ]
        : []),
      inJunk
        ? {
            label: "Not spam",
            icon: ShieldCheck,
            onSelect: () => {
              onAction({ kind: "notJunk" });
            },
          }
        : {
            label: "Report spam",
            icon: ShieldAlert,
            onSelect: () => {
              onAction({ kind: "junk" });
            },
          },
      {
        label: "Report phishing",
        icon: ShieldX,
        onSelect: () => {
          onAction({ kind: "phishing" });
        },
      },
      { separator: true },
      {
        label: "Print",
        icon: Printer,
        onSelect: () => {
          window.open(client.printUrl(e.id), "_blank", "noopener,noreferrer");
        },
      },
      {
        label: "Download message",
        icon: Download,
        onSelect: () => {
          const a = document.createElement("a");
          a.href = client.rawDownloadUrl(e.id);
          a.download = "message.eml";
          a.click();
        },
      },
      {
        label: "Show original",
        icon: FileCode,
        onSelect: () => {
          window.open(`${pagesBase()}/message/${encodeURIComponent(e.id)}/original`, "_blank", "noopener,noreferrer");
        },
      },
    ];
  };

  const moveTargets = folders.length
    ? folderTree(folders)
        .map((n) => n.folder)
        .filter((f) => f.id !== currentFolder?.id && f.role !== "drafts" && f.role !== "sent")
    : [];
  const more: MenuEntry[] = [
    ...(current ? messageMenu(current) : []),
    { separator: true },
    ...(inTrash
      ? [
          {
            label: "Restore",
            icon: ArchiveRestore,
            onSelect: () => {
              onAction({ kind: "restore" });
            },
          },
        ]
      : []),
    {
      label: read ? "Mark as unread" : "Mark as read",
      icon: read ? Mail : MailOpen,
      onSelect: () => {
        if (current) setKeyword([current.id], "$seen", !read);
      },
      hint: read ? "⇧U" : "⇧I",
    },
    {
      label: flagged ? "Remove from Priority" : "Add to Priority",
      icon: Flag,
      onSelect: () => {
        if (current) setKeyword([current.id], "$flagged", !flagged);
      },
      hint: "s",
    },
    ...(thread && thread.length > 1
      ? [
          {
            label: allExpanded ? "Collapse all" : "Expand all",
            icon: allExpanded ? ChevronsDownUp : ChevronsUpDown,
            onSelect: () => {
              expandAll(!allExpanded);
            },
          },
        ]
      : []),
    { separator: true },
    { heading: "Move to" },
    ...moveTargets.map((f) => ({
      label: folderLabel(f),
      icon: f.role === "inbox" ? Inbox : FolderInput,
      onSelect: () => {
        onAction({ kind: "move", to: f.id });
      },
    })),
  ];

  const deleteButton = (
    <Tooltip label={inTrash || inJunk ? "Delete forever" : "Delete"} shortcut={inTrash || inJunk ? undefined : "#"}>
      <button
        type="button"
        onClick={() => {
          onAction(inTrash || inJunk ? { kind: "deleteForever" } : { kind: "trash" });
        }}
        aria-label={inTrash || inJunk ? "Delete forever" : "Delete"}
        className={`${iconButtonClass} text-destructive hover:text-destructive`}
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </Tooltip>
  );

  /** Archive normally; Restore in Trash; Not spam in Junk. */
  const primaryMove = (size: "size-4" | "size-5", tip: boolean) => {
    const [label, Icon, action, shortcut]: [string, typeof Archive, ReaderAction, string | undefined] = inTrash
      ? ["Restore", ArchiveRestore, { kind: "restore" }, undefined]
      : inJunk
        ? ["Not spam", ShieldCheck, { kind: "notJunk" }, undefined]
        : ["Archive", Archive, { kind: "archive" }, "e"];
    if (role === "archive") return null;
    const button = (
      <button
        type="button"
        onClick={() => {
          onAction(action);
        }}
        aria-label={label}
        className={iconButtonClass}
      >
        <Icon className={size} aria-hidden />
      </button>
    );
    return tip ? (
      <Tooltip label={label} shortcut={shortcut}>
        {button}
      </Tooltip>
    ) : (
      button
    );
  };

  // Folder chips: where this conversation is (not Sent or Drafts). The Inbox chip's × archives it.
  const chipIds = thread
    ? [...new Set(thread.flatMap((e) => Object.keys(e.mailboxIds).filter((id) => e.mailboxIds[id])))]
    : [];
  const chips = chipIds
    .map((id) => folders.find((f) => f.id === id))
    .filter((f): f is Folder => f !== undefined && f.role !== "sent" && f.role !== "drafts");

  const last = current;
  const lastView = loaded;
  const manyRecipients = lastView ? lastView.to.length + lastView.cc.length > 1 : false;
  const ReplyIcon = defaultReply === "replyAll" ? ReplyAll : Reply;
  const pill =
    "inline-flex h-9 items-center gap-2 rounded-full border bg-background px-4 text-[13.5px] shadow-xs transition-colors hover:bg-accent disabled:opacity-50";
  return (
    <section aria-label="Message" className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-0.5 border-b px-2">
        <Tooltip label="Close" shortcut="Esc">
          <button type="button" onClick={onClose} aria-label="Close message" className={iconButtonClass}>
            <X className="hidden size-4 md:block" aria-hidden />
            <ArrowLeft className="size-4 md:hidden" aria-hidden />
          </button>
        </Tooltip>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <Tooltip label="Previous" shortcut="k">
          <button
            type="button"
            onClick={onPrev}
            disabled={!canPrev}
            aria-label="Previous message"
            className={iconButtonClass}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
        </Tooltip>
        <Tooltip label="Next" shortcut="j">
          <button
            type="button"
            onClick={onNext}
            disabled={!canNext}
            aria-label="Next message"
            className={iconButtonClass}
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip label={pinned ? "Unpin" : "Pin"} shortcut="p">
          <button
            type="button"
            disabled={!thread}
            onClick={() => {
              if (thread)
                setKeyword(
                  thread.map((e) => e.id),
                  "$pinned",
                  !pinned,
                );
            }}
            aria-label={pinned ? "Unpin" : "Pin"}
            aria-pressed={pinned}
            className={iconButtonClass}
          >
            <Pin className={`size-4 ${pinned ? "fill-current text-primary" : ""}`} aria-hidden />
          </button>
        </Tooltip>
        <span className="hidden items-center gap-0.5 md:flex">
          {primaryMove("size-4", true)}
          <Tooltip label={defaultReply === "replyAll" ? "Reply all" : "Reply"} shortcut="r">
            <button
              type="button"
              onClick={() => {
                reply(defaultReply);
              }}
              disabled={!loaded}
              aria-label={defaultReply === "replyAll" ? "Reply all" : "Reply"}
              className={iconButtonClass}
            >
              <ReplyIcon className="size-4" aria-hidden />
            </button>
          </Tooltip>
          <Menu label="More actions" icon={EllipsisVertical} items={more} />
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          {deleteButton}
        </span>
      </div>

      {error ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        </div>
      ) : thread === null || !current ? (
        <ReaderSkeleton />
      ) : (
        <div ref={pane} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-3 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h2 className="am-h2 break-words">{subjectOf(current.subject)}</h2>
              <div className="flex flex-wrap items-center gap-1.5">
                {chips.map((f) => (
                  <span
                    key={f.id}
                    className="inline-flex h-6 items-center gap-1 rounded-md bg-muted px-2 text-[12px] text-muted-foreground"
                  >
                    {folderLabel(f)}
                    {f.role === "inbox" && (
                      <button
                        type="button"
                        aria-label="Remove label Inbox"
                        onClick={() => {
                          onAction({ kind: "archive" });
                        }}
                        className="-mr-1 inline-flex size-4 items-center justify-center rounded hover:bg-accent hover:text-foreground"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    )}
                  </span>
                ))}
                {thread.length > 1 && <span className="am-micro">{String(thread.length)} messages</span>}
              </div>
            </div>
            {thread.length > 1 && (
              <Tooltip label={allExpanded ? "Collapse all" : "Expand all"}>
                <button
                  type="button"
                  onClick={() => {
                    expandAll(!allExpanded);
                  }}
                  aria-label={allExpanded ? "Collapse all" : "Expand all"}
                  className={`${iconButtonClass} hidden md:inline-flex`}
                >
                  {allExpanded ? (
                    <ChevronsDownUp className="size-4" aria-hidden />
                  ) : (
                    <ChevronsUpDown className="size-4" aria-hidden />
                  )}
                </button>
              </Tooltip>
            )}
          </div>

          <ol aria-label="Conversation" className="flex shrink-0 flex-col rounded-xl border">
            {thread.map((e) => (
              <li key={e.id} className="border-b last:border-b-0">
                {expanded.has(e.id) ? (
                  <MessageCard
                    summary={e}
                    view={views[e.id]}
                    client={client}
                    mine={mine}
                    authservIds={authservIds}
                    paneHeight={paneHeight}
                    menu={messageMenu(e)}
                    knownAddresses={knownAddresses}
                    onAddContact={onAddContact}
                    images={images}
                    collapsible={thread.length > 1}
                    onCollapse={() => {
                      setExpanded((s) => {
                        const n = new Set(s);
                        n.delete(e.id);
                        return n;
                      });
                    }}
                    onToggleFlag={() => {
                      setKeyword([e.id], "$flagged", e.keywords.$flagged !== true);
                    }}
                    onReply={() => {
                      const v = views[e.id];
                      replyWith(v && v !== "missing" ? v : null, defaultReply);
                    }}
                    onComposeTo={onComposeTo}
                    onViewFull={() => {
                      void client
                        .message(e.id, { full: true })
                        .then((v) => {
                          if (v) setViews((m) => ({ ...m, [e.id]: v }));
                        })
                        .catch(() => undefined);
                    }}
                  />
                ) : (
                  <CollapsedRow
                    summary={e}
                    mine={mine}
                    onExpand={() => {
                      setExpanded((s) => new Set([...s, e.id]));
                    }}
                  />
                )}
              </li>
            ))}
          </ol>

          {/* Reply buttons stay at the bottom of the pane while the conversation scrolls under them. */}
          <div className="sticky bottom-0 z-10 -mx-4 mt-auto shrink-0 bg-gradient-to-t from-background from-70% to-transparent px-4 pt-4 pb-1 sm:-mx-6 sm:px-6">
            {inlineComposer ?? (
              <div
                role="group"
                aria-label={`Answer ${senderLabel(last?.from?.[0], mine)}`}
                className="flex flex-wrap gap-2"
              >
                <button
                  type="button"
                  disabled={!lastView}
                  onClick={() => {
                    reply("reply", true);
                  }}
                  className={pill}
                >
                  <Reply className="size-4" aria-hidden /> Reply
                </button>
                {manyRecipients && (
                  <button
                    type="button"
                    disabled={!lastView}
                    onClick={() => {
                      reply("replyAll", true);
                    }}
                    className={pill}
                  >
                    <ReplyAll className="size-4" aria-hidden /> Reply all
                  </button>
                )}
                <button
                  type="button"
                  disabled={!lastView}
                  onClick={() => {
                    reply("forward", true);
                  }}
                  className={pill}
                >
                  <Forward className="size-4" aria-hidden /> Forward
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Phones: the main actions sit in a bottom bar. */}
      <nav
        aria-label="Message actions"
        className="flex h-14 shrink-0 items-center justify-around border-t bg-background px-2 md:hidden"
      >
        {primaryMove("size-5", false)}
        {deleteButton}
        <button
          type="button"
          onClick={() => {
            reply(defaultReply);
          }}
          disabled={!loaded}
          aria-label={defaultReply === "replyAll" ? "Reply all" : "Reply"}
          className={iconButtonClass}
        >
          <ReplyIcon className="size-5" aria-hidden />
        </button>
        <Menu label="More actions" icon={EllipsisVertical} items={more} side="top" />
      </nav>
    </section>
  );
}
