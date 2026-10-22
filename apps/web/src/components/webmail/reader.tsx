// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowLeft, Download, Flag, ImageOff, Mail, MailOpen, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";

import { Bone, ReaderSkeleton } from "@anhourmail/ui/skeletons";

import type { Address, MessageView } from "@/server/webmail/view";

import { displayName, fileSize, fullDate, initials, listDate, subjectOf } from "./format";
import type { MailClient, Summary } from "./mail-client";
import { SenderAvatar } from "./message-list";
import { MessageFrame } from "./message-frame";

const iconButton =
  "inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:text-foreground";

function AddressLine({ label, list }: { label: string; list: Address[] }) {
  if (list.length === 0) return null;
  return (
    <p className="am-micro truncate">
      {label}{" "}
      {list.map((a, i) => (
        <span key={`${a.email}-${String(i)}`}>
          {i > 0 && ", "}
          <span className="text-foreground/80">{displayName(a)}</span>{" "}
          <span className="font-mono">&lt;{a.email}&gt;</span>
        </span>
      ))}
    </p>
  );
}

function BlockedImages({ count }: { count: number }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-xl border bg-muted/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <ImageOff className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="flex flex-col gap-0.5">
          <p className="font-medium text-[13.5px]">
            {count === 1 ? "1 remote image blocked" : `${String(count)} remote images blocked`}
          </p>
          <p className="am-micro">
            Blocking them stops senders seeing when and where you opened this message. Loading them through our privacy
            proxy is coming soon.
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled
        title="Coming soon"
        className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border px-3 text-[13px] text-muted-foreground disabled:cursor-not-allowed"
      >
        Load images
      </button>
    </div>
  );
}

function Attachments({ view, client }: { view: MessageView; client: MailClient }) {
  if (view.attachments.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2">
      {view.attachments.map((a) => (
        <li key={a.blobId}>
          <a
            href={client.downloadUrl(a.blobId)}
            download={a.name}
            className="group flex max-w-72 items-center gap-2.5 rounded-lg border bg-card px-3 py-2 transition-colors hover:bg-accent"
          >
            <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium">{a.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{fileSize(a.size)}</span>
            </span>
            <Download className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
            <span className="sr-only">Download</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function MessageBody({ view }: { view: MessageView }) {
  if (view.html !== null) {
    return (
      <div className="flex min-h-[24rem] flex-1 flex-col">
        <MessageFrame html={view.html} title={`Message: ${subjectOf(view.subject)}`} />
      </div>
    );
  }
  return (
    <div className="am-body min-h-0 flex-1 whitespace-pre-wrap break-words rounded-xl border bg-card px-6 py-5">
      {view.text?.trim() ? view.text : <span className="text-muted-foreground">This message has no text.</span>}
    </div>
  );
}

function BodySkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card px-6 py-5">
      {["w-full", "w-11/12", "w-10/12", "w-full", "w-9/12", "w-8/12"].map((w, i) => (
        <Bone key={`${w}-${String(i)}`} className={`h-3.5 ${w}`} />
      ))}
    </div>
  );
}

/**
 * Reading pane for one thread: subject, the conversation strip (when there is more than one message), and the
 * chosen message with headers, attachments, blocked-image notice and its body. Opening it marks the thread read.
 */
export function Reader({
  client,
  threadId,
  hiddenMailboxIds,
  onBack,
  onKeyword,
  onSignedOut,
  registerActions,
}: {
  client: MailClient;
  threadId: string;
  /** Trash/Junk ids: their messages are hidden from a thread opened elsewhere. */
  hiddenMailboxIds: string[];
  onBack: () => void;
  onKeyword: (ids: string[], keyword: "$seen" | "$flagged", on: boolean) => Promise<void>;
  onSignedOut: () => void;
  registerActions: (a: { toggleFlag: () => void; setRead: (read: boolean) => void } | null) => void;
}) {
  const [thread, setThread] = useState<Summary[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, MessageView | "missing">>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client
      .thread(threadId)
      .then((all) => {
        if (!live) return;
        const visible = all.filter((e) => !hiddenMailboxIds.some((id) => e.mailboxIds[id]));
        const list = visible.length > 0 ? visible : all;
        setThread(list);
        setExpandedId(list.at(-1)?.id ?? null);
        const unread = list.filter((e) => e.keywords.$seen !== true).map((e) => e.id);
        if (unread.length > 0) {
          void onKeyword(unread, "$seen", true).then(() => {
            if (live)
              setThread(
                (t) =>
                  t?.map((e) => (unread.includes(e.id) ? { ...e, keywords: { ...e.keywords, $seen: true } } : e)) ?? t,
              );
          });
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
  const flagged = expanded?.keywords.$flagged === true;
  const read = expanded?.keywords.$seen === true;

  const setKeyword = (keyword: "$seen" | "$flagged", on: boolean) => {
    if (!expanded) return;
    const id = expanded.id;
    setThread((t) => t?.map((e) => (e.id === id ? { ...e, keywords: { ...e.keywords, [keyword]: on } } : e)) ?? t);
    void onKeyword([id], keyword, on).catch(() => {
      setThread((t) => t?.map((e) => (e.id === id ? { ...e, keywords: { ...e.keywords, [keyword]: !on } } : e)) ?? t);
    });
  };

  useEffect(() => {
    registerActions({
      toggleFlag: () => {
        setKeyword("$flagged", !flagged);
      },
      setRead: (r: boolean) => {
        setKeyword("$seen", r);
      },
    });
    return () => {
      registerActions(null);
    };
  });

  return (
    <section aria-label="Message" className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b px-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to list"
          title="Back to list (u)"
          className={`${iconButton} lg:hidden`}
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          disabled={!expanded}
          onClick={() => {
            setKeyword("$seen", !read);
          }}
          aria-label={read ? "Mark as unread" : "Mark as read"}
          title={read ? "Mark as unread (Shift+U)" : "Mark as read (Shift+I)"}
          className={iconButton}
        >
          {read ? <Mail className="size-4" aria-hidden /> : <MailOpen className="size-4" aria-hidden />}
        </button>
        <button
          type="button"
          disabled={!expanded}
          onClick={() => {
            setKeyword("$flagged", !flagged);
          }}
          aria-label="Flag"
          aria-pressed={flagged}
          title={flagged ? "Remove flag (s)" : "Flag (s)"}
          className={iconButton}
        >
          <Flag
            className={`size-4 ${flagged ? "fill-current text-[rgb(var(--am-status-warning-bg))]" : ""}`}
            aria-hidden
          />
        </button>
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
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-4 sm:px-6">
          <div className="flex flex-col gap-1">
            <h2 className="am-h2 break-words">{subjectOf(expanded.subject)}</h2>
            {thread.length > 1 && <p className="am-micro">{thread.length} messages in this conversation</p>}
          </div>

          {thread.length > 1 && (
            <ol aria-label="Conversation" className="flex max-h-44 shrink-0 flex-col overflow-y-auto rounded-xl border">
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
                      <SenderAvatar email={e.from?.[0]?.email} label={initials(e.from?.[0])} />
                      <span className="w-32 shrink-0 truncate font-medium text-[13px] sm:w-40">
                        {displayName(e.from?.[0])}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{e.preview}</span>
                      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground tabular-nums">
                        {listDate(e.receivedAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="flex shrink-0 items-start gap-3">
            <SenderAvatar email={expanded.from?.[0]?.email} label={initials(expanded.from?.[0])} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-[15px]">{displayName(expanded.from?.[0])}</span>
                <span className="truncate font-mono text-[12.5px] text-muted-foreground">
                  {expanded.from?.[0]?.email}
                </span>
              </div>
              <time dateTime={expanded.receivedAt} className="font-mono text-[11.5px] text-muted-foreground sm:hidden">
                {fullDate(expanded.receivedAt)}
              </time>
              {view && view !== "missing" ? (
                <>
                  <AddressLine label="To" list={view.to} />
                  <AddressLine label="Cc" list={view.cc} />
                </>
              ) : (
                <Bone className="mt-1 h-3 w-48" />
              )}
            </div>
            <time
              dateTime={expanded.receivedAt}
              className="hidden shrink-0 pt-1 font-mono text-[11.5px] text-muted-foreground sm:block"
            >
              {fullDate(expanded.receivedAt)}
            </time>
          </div>

          {view === undefined ? (
            <BodySkeleton />
          ) : view === "missing" ? (
            <p className="am-small">This message is no longer here.</p>
          ) : (
            <>
              {view.blockedImages > 0 && <BlockedImages count={view.blockedImages} />}
              <Attachments view={view} client={client} />
              {view.truncated && <p className="am-micro">This message is very long; only the first part is shown.</p>}
              <MessageBody view={view} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
