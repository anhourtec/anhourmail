// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
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
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Bone, ReaderSkeleton } from "@anhourmail/ui/skeletons";

import type { Address, MessageView } from "@/server/webmail/view";

import { displayName, folderLabel, folderTree, fullDate, initials, subjectOf } from "./format";
import type { Folder, MailClient, Summary } from "./mail-client";
import { iconButtonClass, Menu, type MenuEntry } from "./menu";
import { Modal } from "./dialogs";
import { MessageContent } from "./message-body";
import { SenderAvatar } from "./message-list";

export type ReaderAction =
  | { kind: "archive" }
  | { kind: "trash" }
  | { kind: "deleteForever" }
  | { kind: "junk" }
  | { kind: "notJunk" }
  | { kind: "move"; to: string }
  | { kind: "reply" | "replyAll" | "forward"; message: MessageView; inline: boolean };

export type ReaderActions = {
  toggleFlag: () => void;
  togglePin: () => void;
  setRead: (read: boolean) => void;
  reply: (mode: "reply" | "replyAll" | "forward") => void;
};

function AddressLine({ label, list }: { label: string; list: Address[] }) {
  if (list.length === 0) return null;
  return (
    <p className="truncate text-[12.5px] text-muted-foreground">
      {label}{" "}
      {list.map((a, i) => (
        <span key={`${a.email}-${String(i)}`}>
          {i > 0 && ", "}
          <span className="text-foreground">{displayName(a)}</span>
          {a.name ? <span className="font-mono"> &lt;{a.email}&gt;</span> : null}
        </span>
      ))}
    </p>
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

/**
 * Reading pane for one conversation: toolbar, subject and date, the conversation strip (when there is more than one
 * message), the chosen message with its sender card, attachments, blocked-image notice and body, and an inline reply
 * box. Opening it marks the conversation read. On phones the main actions sit in a bottom bar.
 */
export function Reader({
  client,
  threadId,
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
  registerActions,
}: {
  client: MailClient;
  threadId: string;
  folders: Folder[];
  /** The folder being viewed (null in Priority or search). */
  currentFolder: Folder | null;
  /** Trash/Junk ids: their messages are hidden from a thread opened elsewhere. */
  hiddenMailboxIds: string[];
  canPrev: boolean;
  canNext: boolean;
  /** An inline reply composer, shown at the bottom instead of the reply box. */
  inlineComposer: ReactNode;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onAction: (action: ReaderAction) => void;
  onKeyword: (ids: string[], keyword: string, on: boolean) => Promise<void>;
  onSignedOut: () => void;
  /** Writes to an address found in a message (opens the composer). */
  onComposeTo: (address: string) => void;
  registerActions: (a: ReaderActions | null) => void;
}) {
  const [thread, setThread] = useState<Summary[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, MessageView | "missing">>({});
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState<{ text: string; cut: boolean } | "loading" | null>(null);
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
    client
      .thread(threadId)
      .then((all) => {
        if (!live) return;
        const visible = all.filter((e) => !hiddenMailboxIds.some((id) => e.mailboxIds[id]));
        const list = visible.length > 0 ? visible : all;
        setThread(list);
        // Open the newest message that isn't an unsent draft (a draft reply stays listed in the conversation).
        setExpandedId(list.filter((e) => e.keywords.$draft !== true).at(-1)?.id ?? list.at(-1)?.id ?? null);
        const unread = list.filter((e) => e.keywords.$seen !== true).map((e) => e.id);
        if (unread.length > 0) {
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
        }
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof Error && err.name === "SignedOutError") onSignedOut();
        else setError("This conversation couldn't be loaded.");
      });
    return () => {
      live = false;
    };
    // The thread id is the identity of this reader (the parent re-keys it); callbacks are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per thread
  }, [threadId]);

  useEffect(() => {
    if (!expandedId || views[expandedId] !== undefined) return;
    let live = true;
    client
      .message(expandedId)
      .then((v) => {
        if (live) setViews((m) => ({ ...m, [expandedId]: v ?? "missing" }));
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof Error && err.name === "SignedOutError") onSignedOut();
        else setError("This message couldn't be loaded.");
      });
    return () => {
      live = false;
    };
  }, [expandedId, views, client, onSignedOut]);

  const expanded = thread?.find((e) => e.id === expandedId) ?? null;
  const view = expandedId ? views[expandedId] : undefined;
  const loaded = view && view !== "missing" ? view : null;
  const flagged = expanded?.keywords.$flagged === true;
  const read = expanded?.keywords.$seen === true;
  const pinned = thread?.some((e) => e.keywords.$pinned === true) ?? false;
  const role = currentFolder?.role ?? null;
  const inJunk = role === "junk";
  const inTrash = role === "trash";

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

  const reply = (mode: "reply" | "replyAll" | "forward", inline = false) => {
    if (loaded) onAction({ kind: mode, message: loaded, inline });
  };

  useEffect(() => {
    registerActions({
      toggleFlag: () => {
        if (expanded) setKeyword([expanded.id], "$flagged", !flagged);
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
        if (expanded) setKeyword([expanded.id], "$seen", r);
      },
      reply: (mode) => {
        reply(mode);
      },
    });
    return () => {
      registerActions(null);
    };
  });

  const moveTargets = folders.length
    ? folderTree(folders)
        .map((n) => n.folder)
        .filter((f) => f.id !== currentFolder?.id && f.role !== "drafts" && f.role !== "sent")
    : [];
  const more: MenuEntry[] = [
    {
      label: "Reply all",
      icon: ReplyAll,
      onSelect: () => {
        reply("replyAll");
      },
      disabled: !loaded,
      hint: "a",
    },
    {
      label: "Forward",
      icon: Forward,
      onSelect: () => {
        reply("forward");
      },
      disabled: !loaded,
      hint: "f",
    },
    { separator: true },
    {
      label: read ? "Mark as unread" : "Mark as read",
      icon: read ? Mail : MailOpen,
      onSelect: () => {
        if (expanded) setKeyword([expanded.id], "$seen", !read);
      },
      hint: read ? "⇧U" : "⇧I",
    },
    {
      label: flagged ? "Remove from Priority" : "Add to Priority",
      icon: Flag,
      onSelect: () => {
        if (expanded) setKeyword([expanded.id], "$flagged", !flagged);
      },
      hint: "s",
    },
    inJunk
      ? {
          label: "Not junk",
          icon: ShieldCheck,
          onSelect: () => {
            onAction({ kind: "notJunk" });
          },
        }
      : {
          label: "Report junk",
          icon: ShieldAlert,
          onSelect: () => {
            onAction({ kind: "junk" });
          },
          hint: "!",
        },
    { separator: true },
    {
      label: "View original",
      icon: FileCode,
      disabled: !expanded,
      onSelect: () => {
        if (!expanded) return;
        setOriginal("loading");
        client
          .rawText(expanded.id)
          .then(setOriginal)
          .catch(() => {
            setOriginal({ text: "The original couldn't be loaded.", cut: false });
          });
      },
    },
    {
      label: "Print",
      icon: Printer,
      disabled: !expanded,
      onSelect: () => {
        if (expanded) window.open(client.printUrl(expanded.id), "_blank", "noopener,noreferrer");
      },
    },
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
    <button
      type="button"
      onClick={() => {
        onAction(inTrash || inJunk ? { kind: "deleteForever" } : { kind: "trash" });
      }}
      aria-label={inTrash || inJunk ? "Delete forever" : "Delete"}
      title={inTrash || inJunk ? "Delete forever" : "Delete (#)"}
      className={`${iconButtonClass} text-destructive hover:text-destructive`}
    >
      <Trash2 className="size-4" aria-hidden />
    </button>
  );

  const senderName = displayName(expanded?.from?.[0]);
  return (
    <section aria-label="Message" className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-0.5 border-b px-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close message"
          title="Close (Esc)"
          className={iconButtonClass}
        >
          <X className="hidden size-4 md:block" aria-hidden />
          <ArrowLeft className="size-4 md:hidden" aria-hidden />
        </button>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="Previous message"
          title="Previous (k)"
          className={iconButtonClass}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          aria-label="Next message"
          title="Next (j)"
          className={iconButtonClass}
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
        <div className="flex-1" />
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
          title={pinned ? "Unpin (p)" : "Pin (p)"}
          className={iconButtonClass}
        >
          <Pin className={`size-4 ${pinned ? "fill-current text-primary" : ""}`} aria-hidden />
        </button>
        <button
          type="button"
          disabled={!expanded}
          onClick={() => {
            if (expanded) setKeyword([expanded.id], "$flagged", !flagged);
          }}
          aria-label="Priority"
          aria-pressed={flagged}
          title={flagged ? "Remove from Priority (s)" : "Add to Priority (s)"}
          className={iconButtonClass}
        >
          <Flag
            className={`size-4 ${flagged ? "fill-current text-[rgb(var(--am-status-warning-bg))]" : ""}`}
            aria-hidden
          />
        </button>
        <span className="hidden items-center gap-0.5 md:flex">
          {role !== "archive" && (
            <button
              type="button"
              onClick={() => {
                onAction({ kind: "archive" });
              }}
              aria-label="Archive"
              title="Archive (e)"
              className={iconButtonClass}
            >
              <Archive className="size-4" aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              reply("reply");
            }}
            disabled={!loaded}
            aria-label="Reply"
            title="Reply (r)"
            className={iconButtonClass}
          >
            <Reply className="size-4" aria-hidden />
          </button>
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
      ) : thread === null || !expanded ? (
        <ReaderSkeleton />
      ) : (
        <div ref={pane} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-3 sm:px-6">
          <div className="flex flex-col gap-1.5">
            <h2 className="am-h2 break-words">{subjectOf(expanded.subject)}</h2>
            <p className="am-micro">
              {fullDate(expanded.receivedAt)}
              {thread.length > 1 ? ` · ${String(thread.length)} messages` : ""}
            </p>
          </div>

          {thread.length > 1 && (
            <ol aria-label="Conversation" className="flex max-h-40 shrink-0 flex-col overflow-y-auto rounded-xl border">
              {thread.map((e) => {
                const current = e.id === expandedId;
                return (
                  <li key={e.id} className="border-b last:border-b-0">
                    <button
                      type="button"
                      aria-current={current ? "true" : undefined}
                      onClick={() => {
                        setExpandedId(e.id);
                      }}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${current ? "bg-accent" : "hover:bg-accent/50"}`}
                    >
                      <SenderAvatar email={e.from?.[0]?.email} label={initials(e.from?.[0])} size="sm" />
                      <span className="w-28 shrink-0 truncate font-medium text-[13px] sm:w-36">
                        {displayName(e.from?.[0])}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{e.preview}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="flex shrink-0 items-start gap-3 border-y py-3">
            <SenderAvatar email={expanded.from?.[0]?.email} label={initials(expanded.from?.[0])} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2">
                <span className="font-medium text-[14px]">{senderName}</span>
                <span aria-hidden className="h-3 w-px bg-border" />
                <span className="truncate font-mono text-[12.5px] text-muted-foreground">
                  {expanded.from?.[0]?.email}
                </span>
              </div>
              {loaded ? (
                <>
                  <AddressLine label="To:" list={loaded.to} />
                  <AddressLine label="Cc:" list={loaded.cc} />
                </>
              ) : (
                <Bone className="mt-1 h-3 w-48" />
              )}
            </div>
          </div>

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
              onViewFull={() => {
                void client
                  .message(view.id, { full: true })
                  .then((v) => {
                    if (v) setViews((m) => ({ ...m, [view.id]: v }));
                  })
                  .catch(() => undefined);
              }}
            />
          )}

          {/* The reply box stays at the bottom of the pane while the message scrolls under it. */}
          <div className="sticky bottom-0 z-10 -mx-4 mt-auto shrink-0 bg-gradient-to-t from-background from-70% to-transparent px-4 pt-4 pb-1 sm:-mx-6 sm:px-6">
            {inlineComposer ?? (
              <button
                type="button"
                disabled={!loaded}
                onClick={() => {
                  reply("reply", true);
                }}
                className="flex h-11 w-full items-center gap-3 rounded-xl border bg-background px-3.5 text-left text-[13.5px] text-muted-foreground shadow-xs transition-colors hover:border-ring/50 hover:text-foreground"
              >
                <Reply className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Reply to {senderName}…</span>
                <Paperclip className="size-4 shrink-0 opacity-60" aria-hidden />
                <Send className="size-4 shrink-0 opacity-60" aria-hidden />
              </button>
            )}
          </div>
        </div>
      )}

      {original !== null && (
        <Modal
          title="Original message"
          wide
          onClose={() => {
            setOriginal(null);
          }}
        >
          {original === "loading" ? (
            <Bone className="h-48 w-full" />
          ) : (
            <div className="flex flex-col gap-3">
              <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
                {original.text}
              </pre>
              {original.cut && <p className="am-micro">Only the first 2 MB is shown here.</p>}
              {expanded && (
                <a
                  href={client.rawDownloadUrl(expanded.id)}
                  download="message.eml"
                  className="inline-flex h-9 w-fit items-center gap-2 rounded-lg border px-3 text-[13.5px] hover:bg-accent"
                >
                  <Download className="size-4" aria-hidden /> Download .eml
                </a>
              )}
            </div>
          )}
        </Modal>
      )}

      {/* Phones: the main actions sit in a bottom bar. */}
      <nav
        aria-label="Message actions"
        className="flex h-14 shrink-0 items-center justify-around border-t bg-background px-2 md:hidden"
      >
        {role !== "archive" && (
          <button
            type="button"
            onClick={() => {
              onAction({ kind: "archive" });
            }}
            aria-label="Archive"
            className={iconButtonClass}
          >
            <Archive className="size-5" aria-hidden />
          </button>
        )}
        {deleteButton}
        <button
          type="button"
          onClick={() => {
            reply("reply");
          }}
          disabled={!loaded}
          aria-label="Reply"
          className={iconButtonClass}
        >
          <Reply className="size-5" aria-hidden />
        </button>
        <Menu label="More actions" icon={EllipsisVertical} items={more} side="top" />
      </nav>
    </section>
  );
}
