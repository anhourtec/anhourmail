// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  CalendarDays,
  ChevronDown,
  Download,
  Ellipsis,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  ImageOff,
  type LucideIcon,
  Mail,
  MapPin,
  User,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Bone } from "@anhourmail/ui/skeletons";

import type { CalendarEvent, MdBlock, MdInline, TextBlock } from "@/server/webmail/body";
import type { AttachmentView, MessageView } from "@/server/webmail/view";
import { Tooltip } from "@/components/tooltip";

import { Modal } from "./dialogs";
import { displayName, fileKind, fileSize, fullDate, subjectOf } from "./format";
import { IMAGE_LINK_EXPIRED, type MailClient } from "./mail-client";
import { MessageFrame } from "./message-frame";
import { type ImagePolicy, imageLinks, loadsWithoutAsking, withLoadedImages } from "./remote-images";

const KIND_ICON: Record<ReturnType<typeof fileKind>, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  sheet: FileSpreadsheet,
  archive: FileArchive,
  text: FileText,
  file: File,
};

// ---- links in plain text ------------------------------------------------------------------------------------

/** URLs and addresses in plain text (bounded quantifiers: linear on hostile input). */
const LINKS =
  /\bhttps?:\/\/[^\s<>"'`]{1,2000}|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** Plain text with web links (new tab, no referrer) and addresses (open the composer) — React text, never markup. */
export function Linkified({ text, onCompose }: { text: string; onCompose?: (address: string) => void }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINKS)) {
    const start = m.index;
    let token = m[0];
    const trail = TRAILING.exec(token)?.[0] ?? "";
    if (trail) token = token.slice(0, -trail.length);
    if (start > last) out.push(text.slice(last, start));
    if (token.startsWith("http")) {
      out.push(
        <a
          key={`${String(start)}-u`}
          href={token}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-primary underline underline-offset-2"
        >
          {token}
        </a>,
      );
    } else if (onCompose) {
      out.push(
        <button
          key={`${String(start)}-m`}
          type="button"
          onClick={() => {
            onCompose(token);
          }}
          className="font-mono text-[0.95em] text-primary underline underline-offset-2"
        >
          {token}
        </button>,
      );
    } else {
      out.push(token);
    }
    if (trail) out.push(trail);
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function QuoteBlock({ text, onCompose }: { text: string; onCompose?: (a: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Tooltip label={open ? "Hide quoted text" : "Show quoted text"}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide quoted text" : "Show quoted text"}
          onClick={() => {
            setOpen((o) => !o);
          }}
          className="inline-flex h-5 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </Tooltip>
      {open && (
        <blockquote className="border-l-2 pl-3 text-muted-foreground">
          <Linkified text={text} {...(onCompose ? { onCompose } : {})} />
        </blockquote>
      )}
    </div>
  );
}

/** Plain-text mail in our typography: line breaks kept, links live, quotes collapsed, the signature dimmed. */
export function TextBody({ blocks, onCompose }: { blocks: TextBlock[]; onCompose?: (a: string) => void }) {
  if (blocks.length === 0) return <p className="am-small">This message has no text.</p>;
  const props = onCompose ? { onCompose } : {};
  return (
    <div className="flex flex-col gap-4 whitespace-pre-wrap break-words text-[14.5px] leading-[1.65]">
      {blocks.map((b, i) =>
        b.kind === "quote" ? (
          <QuoteBlock key={String(i)} text={b.text} {...props} />
        ) : b.kind === "signature" ? (
          <div key={String(i)} className="text-[13.5px] text-muted-foreground">
            <span aria-hidden>-- </span>
            {"\n"}
            <Linkified text={b.text} {...props} />
          </div>
        ) : (
          <div key={String(i)}>
            <Linkified text={b.text} {...props} />
          </div>
        ),
      )}
    </div>
  );
}

// ---- markdown -----------------------------------------------------------------------------------------------

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        const k = String(i);
        switch (n.t) {
          case "text":
            return <Fragment key={k}>{n.v}</Fragment>;
          case "strong":
            return (
              <strong key={k} className="font-semibold">
                <Inline nodes={n.c} />
              </strong>
            );
          case "em":
            return (
              <em key={k}>
                <Inline nodes={n.c} />
              </em>
            );
          case "del":
            return (
              <del key={k}>
                <Inline nodes={n.c} />
              </del>
            );
          case "code":
            return (
              <code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
                {n.v}
              </code>
            );
          case "br":
            return <br key={k} />;
          default:
            return (
              <a
                key={k}
                href={n.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                <Inline nodes={n.c} />
              </a>
            );
        }
      })}
    </>
  );
}

const HEADING = ["am-h2", "am-h3", "am-h4", "am-h4", "am-h4", "am-h4"];

/** A text/markdown body, rendered from the server's safe AST (no HTML). */
export function MarkdownBody({ blocks }: { blocks: MdBlock[] }) {
  return (
    <div className="flex flex-col gap-3 text-[14.5px] leading-[1.65]">
      {blocks.map((b, i) => {
        const k = String(i);
        switch (b.t) {
          case "h": {
            const Tag = `h${String(Math.min(b.level + 2, 6))}` as "h3";
            return (
              <Tag key={k} className={`${HEADING[b.level - 1] ?? "am-h4"} mt-2`}>
                <Inline nodes={b.c} />
              </Tag>
            );
          }
          case "p":
            return (
              <p key={k}>
                <Inline nodes={b.c} />
              </p>
            );
          case "list": {
            const items = b.items.map((it, j) => (
              <li key={String(j)}>
                <MarkdownBody blocks={it} />
              </li>
            ));
            return b.ordered ? (
              <ol key={k} start={b.start} className="list-decimal pl-6">
                {items}
              </ol>
            ) : (
              <ul key={k} className="list-disc pl-6">
                {items}
              </ul>
            );
          }
          case "quote":
            return (
              <blockquote key={k} className="border-l-2 pl-3 text-muted-foreground">
                <MarkdownBody blocks={b.c} />
              </blockquote>
            );
          case "code":
            return (
              <pre key={k} className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-[13px]">
                {b.v}
              </pre>
            );
          default:
            return <hr key={k} className="my-1" />;
        }
      })}
    </div>
  );
}

// ---- calendar -----------------------------------------------------------------------------------------------

function eventWhen(e: CalendarEvent): string {
  if (!e.start) return "Time not given";
  if (e.allDay) {
    const d = new Date(`${e.start}T12:00:00`);
    return d.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  const zone = e.timeZone;
  const fmt = (iso: string) => {
    // UTC instants show in the reader's zone; floating times show as written, with their zone name.
    const d = iso.endsWith("Z") ? new Date(iso) : new Date(`${iso}:00`);
    return d.toLocaleString("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };
  const end = e.end ? new Date(e.end.endsWith("Z") ? e.end : `${e.end}:00`) : null;
  const endText = end ? end.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }) : null;
  return `${fmt(e.start)}${endText ? ` – ${endText}` : ""}${zone ? ` (${zone})` : ""}`;
}

/** An invitation as a card: what, when, where, who. Answering invitations comes later. */
export function EventCard({ event }: { event: CalendarEvent }) {
  return (
    <section
      aria-label={`Event: ${event.summary || "Untitled event"}`}
      className="flex gap-3 rounded-xl border bg-card px-4 py-3"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
        <CalendarDays className="size-5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium text-[14.5px]">{event.summary || "Untitled event"}</p>
        <p className="text-[13px]">{eventWhen(event)}</p>
        {event.location && (
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{event.location}</span>
          </p>
        )}
        {event.organizer && (
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <User className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {event.organizer.name ?? ""}{" "}
              {event.organizer.email && <span className="font-mono">{event.organizer.email}</span>}
            </span>
          </p>
        )}
        {event.description && (
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-[13px] text-muted-foreground">{event.description}</p>
        )}
        <p className="am-micro mt-1">
          {event.method === "CANCEL" ? "This event was cancelled." : "Replying to invitations is coming soon."}
        </p>
      </div>
    </section>
  );
}

// ---- attachments --------------------------------------------------------------------------------------------

function AttachmentChips({
  view,
  client,
  onOpenMessage,
}: {
  view: MessageView;
  client: MailClient;
  onOpenMessage: (a: AttachmentView) => void;
}) {
  const [open, setOpen] = useState(true);
  const [preview, setPreview] = useState<AttachmentView | null>(null);
  if (view.attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="inline-flex w-fit items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        Attachments ({view.attachments.length})
        <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <ul aria-label="Attachments" className="flex flex-wrap gap-2">
          {view.attachments.map((a) => {
            const Icon =
              a.kind === "message" ? Mail : a.kind === "calendar" ? CalendarDays : KIND_ICON[fileKind(a.type, a.name)];
            return (
              <li
                key={a.blobId}
                className="flex max-w-80 items-stretch overflow-hidden rounded-lg bg-secondary text-[12.5px]"
              >
                {a.kind === "image" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setPreview(a);
                    }}
                    aria-label={`Preview ${a.name}`}
                    className="flex min-w-0 items-center gap-2 py-1 pr-1 pl-1 transition-colors hover:bg-accent"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated attachment preview: Next's image optimiser can't carry the webmail session */}
                    <img
                      src={client.previewUrl(a.blobId, a.type)}
                      alt=""
                      loading="lazy"
                      className="size-8 shrink-0 rounded object-cover"
                    />
                    <span className="truncate">{a.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fileSize(a.size)}</span>
                  </button>
                ) : a.kind === "message" ? (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenMessage(a);
                    }}
                    aria-label={`Open ${a.name}`}
                    className="flex min-w-0 items-center gap-2 py-1.5 pl-2.5 transition-colors hover:bg-accent"
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{a.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fileSize(a.size)}</span>
                  </button>
                ) : (
                  <span className="flex min-w-0 items-center gap-2 py-1.5 pl-2.5">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{a.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fileSize(a.size)}</span>
                  </span>
                )}
                <Tooltip label="Download">
                  <a
                    href={client.downloadUrl(a.blobId)}
                    download={a.name}
                    aria-label={`Download ${a.name}`}
                    className="flex items-center px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Download className="size-3.5" aria-hidden />
                  </a>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
      {preview && (
        <Modal
          title={preview.name}
          wide
          onClose={() => {
            setPreview(null);
          }}
        >
          <div className="flex flex-col items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated attachment preview: Next's image optimiser can't carry the webmail session */}
            <img
              src={client.previewUrl(preview.blobId, preview.type)}
              alt={preview.name}
              className="max-h-[65vh] max-w-full rounded-lg object-contain"
            />
            <a
              href={client.downloadUrl(preview.blobId)}
              download={preview.name}
              className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[13.5px] hover:bg-accent"
            >
              <Download className="size-4" aria-hidden /> Download ({fileSize(preview.size)})
            </a>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** What the reader can do with remote images: the setting, remembered senders, contacts, and remembering one. */
export type ImageOptions = {
  policy: ImagePolicy;
  /** Addresses on a contact card (lowercase), for "Load from contacts". */
  contacts: ReadonlySet<string>;
  /** Remembers (or forgets) a sender's key in the `imageSenders` preference. */
  onRemember: (senderKey: string, on: boolean) => void;
};

type ImageState = "blocked" | "loading" | "loaded";

/** Images of one message fetched through the image proxy at once (the proxy limits each session too). */
const IMAGE_CONCURRENCY = 4;

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

function ImageNotice({
  state,
  count,
  loadable,
  trackers,
  failed,
  remembered,
  canRemember,
  onLoad,
  onRemember,
}: {
  state: ImageState;
  count: number;
  loadable: number;
  trackers: number;
  failed: number;
  remembered: boolean;
  canRemember: boolean;
  onLoad: () => void;
  onRemember: (on: boolean) => void;
}) {
  const removed = trackers > 0 ? ` · ${plural(trackers, "tracker")} removed` : "";
  const title = [
    count > 0 ? `${plural(count, "remote image")} blocked` : null,
    trackers > 0 ? `${plural(trackers, "tracker")} removed` : null,
  ]
    .filter((t) => t !== null)
    .join(" · ")
    .replace(/^./, (c) => c.toUpperCase());
  const button =
    "inline-flex h-8 shrink-0 items-center rounded-lg border bg-background px-3 text-[12.5px] transition-colors hover:bg-accent disabled:opacity-60";
  const link = "text-left text-[12.5px] text-primary underline-offset-2 hover:underline";
  if (state === "loaded") {
    return (
      <div role="status" className="flex flex-wrap items-start gap-3 rounded-xl border bg-muted/60 px-4 py-3">
        <ImageIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="font-medium text-[13px]">Images loaded through our privacy proxy{removed}</p>
          <p className="am-micro">
            The sender can't see your IP address or your browser
            {failed > 0 ? `. ${plural(failed, "image")} couldn't be loaded.` : "."}
          </p>
        </div>
        {canRemember && (
          <button
            type="button"
            className={link}
            onClick={() => {
              onRemember(!remembered);
            }}
          >
            {remembered ? "Stop loading from this sender" : "Always load from this sender"}
          </button>
        )}
      </div>
    );
  }
  return (
    <div role="status" className="flex flex-wrap items-start gap-3 rounded-xl border bg-muted/60 px-4 py-3">
      <ImageOff className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium text-[13px]">{title}</p>
        <p className="am-micro">
          {loadable > 0
            ? "Senders can't see when or where you opened this. Loading them goes through our privacy proxy, so the sender never sees your IP address."
            : "Senders can't see when or where you opened this."}
        </p>
        {loadable > 0 && canRemember && (
          <button
            type="button"
            className={`${link} mt-1 w-fit`}
            disabled={state === "loading"}
            onClick={() => {
              onRemember(true);
            }}
          >
            Always load from this sender
          </button>
        )}
      </div>
      {loadable > 0 && (
        <button type="button" className={button} disabled={state === "loading"} onClick={onLoad}>
          {state === "loading" ? "Loading images…" : "Load images"}
        </button>
      )}
    </div>
  );
}

/**
 * Remote images of one message: blocked until the person loads them (or a setting or a remembered sender does), then
 * fetched through the image proxy and shown as `data:` images in the frame. Expired links (an old view) are
 * refreshed once by loading the message again.
 */
function useRemoteImages(
  view: MessageView,
  client: MailClient,
  reload: () => Promise<MessageView | null>,
  images: ImageOptions | undefined,
) {
  const [html, setHtml] = useState(view.html);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, string>>(new Map());
  const [state, setState] = useState<ImageState>("blocked");
  const [failed, setFailed] = useState(0);
  const busy = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (busy.current || html === null) return;
    busy.current = true;
    setState("loading");
    const out = new Map<string, string>();
    let source = html;
    try {
      for (let round = 0; round < 2; round++) {
        const queue = imageLinks(source);
        const seen = { expired: false };
        const worker = async () => {
          for (let link = queue.shift(); link !== undefined; link = queue.shift()) {
            const got = await client.remoteImage(link);
            if (got === IMAGE_LINK_EXPIRED) seen.expired = true;
            else if (got !== null) out.set(link, got);
          }
        };
        await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
        if (!seen.expired || round > 0) break;
        // The view is older than its image links: load the message again for fresh ones, once.
        const fresh = await reload();
        if (!fresh?.html) break;
        source = fresh.html;
        out.clear();
      }
    } catch {
      // Signed out or offline meanwhile: what loaded is shown, the rest stays blocked.
    } finally {
      busy.current = false;
    }
    if (!live.current) return;
    setHtml(source);
    setLoaded(out);
    setFailed(imageLinks(source).length - out.size);
    setState("loaded");
  }, [client, html, reload]);

  const auto =
    images !== undefined &&
    view.loadableImages > 0 &&
    loadsWithoutAsking(images.policy, view.senderKey, view.from[0]?.email, images.contacts);
  useEffect(() => {
    if (auto && state === "blocked") void load();
  }, [auto, state, load]);

  const shown = useMemo(() => (html === null ? null : withLoadedImages(html, loaded)), [html, loaded]);
  return { html: shown, state, failed, load };
}

/** A forwarded or attached message, opened from its attachment chip. */
function NestedMessage({
  client,
  emailId,
  attachment,
  onClose,
}: {
  client: MailClient;
  emailId: string;
  attachment: AttachmentView;
  onClose: () => void;
}) {
  const [view, setView] = useState<MessageView | null | "missing" | "error">(null);
  useEffect(() => {
    let live = true;
    client
      .attachedMessage(emailId, attachment.blobId)
      .then((v) => {
        if (live) setView(v ?? "missing");
      })
      .catch(() => {
        if (live) setView("error");
      });
    return () => {
      live = false;
    };
  }, [client, emailId, attachment.blobId]);
  return (
    <Modal title={attachment.name} onClose={onClose} wide>
      {view === null ? (
        <div className="flex flex-col gap-3">
          <Bone className="h-5 w-2/3" />
          <Bone className="h-3.5 w-1/2" />
          <Bone className="h-32 w-full" />
        </div>
      ) : view === "missing" || view === "error" ? (
        <p className="am-small">This attached message couldn't be opened.</p>
      ) : (
        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
          <div className="flex flex-col gap-0.5">
            <p className="am-h4">{subjectOf(view.subject)}</p>
            <p className="am-micro">
              From {displayName(view.from[0])} <span className="font-mono">{view.from[0]?.email}</span>
              {view.sentAt ? ` · ${fullDate(view.sentAt)}` : ""}
            </p>
          </div>
          <MessageContent
            view={view}
            client={client}
            paneHeight={420}
            reload={() => client.attachedMessage(emailId, attachment.blobId)}
          />
        </div>
      )}
    </Modal>
  );
}

/**
 * The body area of a message: blocked-image notice, attachments, calendar cards, and the body itself — plain
 * text and markdown natively in the reader's flow; HTML in the sandboxed frame, sized to the reading pane.
 */
export function MessageContent({
  view,
  client,
  paneHeight,
  onCompose,
  onViewFull,
  images,
  reload,
}: {
  view: MessageView;
  client: MailClient;
  /** Height of the reading pane in px: an HTML frame fills it (it can't measure its own content). */
  paneHeight: number;
  onCompose?: (address: string) => void;
  onViewFull?: () => void;
  /** Remote image settings; without them images still load on request, but never by themselves. */
  images?: ImageOptions;
  /** Loads this message again (fresh image links); defaults to the reader's own message. */
  reload?: () => Promise<MessageView | null>;
}) {
  const [nested, setNested] = useState<AttachmentView | null>(null);
  const again = useCallback(() => (reload ? reload() : client.message(view.id)), [reload, client, view.id]);
  const remote = useRemoteImages(view, client, again, images);
  const remembered = view.senderKey !== null && (images?.policy.senders.includes(view.senderKey) ?? false);
  return (
    <div className="flex flex-col gap-4">
      {view.blockedImages + view.blockedTrackers > 0 && (
        <ImageNotice
          state={remote.state}
          count={view.blockedImages}
          loadable={view.loadableImages}
          trackers={view.blockedTrackers}
          failed={remote.failed}
          remembered={remembered}
          canRemember={images !== undefined && view.senderKey !== null}
          onLoad={() => {
            void remote.load();
          }}
          onRemember={(on) => {
            if (view.senderKey === null || !images) return;
            images.onRemember(view.senderKey, on);
          }}
        />
      )}
      <AttachmentChips view={view} client={client} onOpenMessage={setNested} />
      {view.events.map((e, i) => (
        <EventCard key={`${e.summary}-${String(i)}`} event={e} />
      ))}
      {view.truncated && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/50 px-4 py-2.5">
          <p className="am-small flex-1">This message is very long; only the first part is shown.</p>
          {onViewFull && (
            <button
              type="button"
              onClick={onViewFull}
              className="h-8 rounded-lg border bg-background px-3 text-[13px] hover:bg-accent"
            >
              View entire message
            </button>
          )}
        </div>
      )}
      {remote.html !== null ? (
        <MessageFrame
          html={remote.html}
          title={`Message: ${subjectOf(view.subject)}`}
          height={Math.max(paneHeight - 24, 384)}
        />
      ) : view.markdown ? (
        <MarkdownBody blocks={view.markdown} />
      ) : (
        <TextBody blocks={view.textBlocks ?? []} {...(onCompose ? { onCompose } : {})} />
      )}
      {nested && (
        <NestedMessage
          client={client}
          emailId={view.id}
          attachment={nested}
          onClose={() => {
            setNested(null);
          }}
        />
      )}
    </div>
  );
}
