// SPDX-License-Identifier: AGPL-3.0-only
import { type CalendarEvent, markdownBlocks, type MdBlock, type TextBlock, textBlocks } from "./body";

/**
 * The webmail's message view: what `GET /api/webmail/messages/:id` returns. Types are shared with the client
 * (type-only imports); `buildMessageView` is pure so it can be tested without Stalwart.
 */

export type Address = { name: string | null; email: string };

export type BodyPart = {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  charset?: string | null;
  disposition: string | null;
  cid: string | null;
  /** The part's raw Content-Type header (for `format=flowed`). */
  "header:Content-Type"?: string | null;
};

/** The JMAP Email properties the reader asks for. */
export type JmapEmail = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[] | null;
  /** The `Sender:` header (who sent it on the From's behalf), if any. */
  sender?: Address[] | null;
  to: Address[] | null;
  cc: Address[] | null;
  bcc?: Address[] | null;
  replyTo: Address[] | null;
  subject: string | null;
  sentAt: string | null;
  receivedAt: string;
  messageId?: string[] | null;
  references?: string[] | null;
  blobId?: string | null;
  htmlBody: BodyPart[] | null;
  textBody: BodyPart[] | null;
  attachments: BodyPart[] | null;
  bodyValues: Record<string, { value: string; isTruncated?: boolean; isEncodingProblem?: boolean }> | null;
};

/** What the reader can do with an attachment beyond downloading it. */
export type AttachmentKind = "image" | "message" | "calendar" | "file";
export type AttachmentView = { blobId: string; name: string; type: string; size: number; kind: AttachmentKind };

const RASTER = /^image\/(?:png|jpe?g|gif|webp|bmp)$/i;
const CALENDAR = /^(?:text\/calendar|application\/ics)$/i;

export function attachmentKind(type: string): AttachmentKind {
  if (RASTER.test(type)) return "image";
  if (/^message\/rfc822$/i.test(type)) return "message";
  if (CALENDAR.test(type)) return "calendar";
  return "file";
}

/** Raster images previewable inline through `/api/webmail/preview` (never SVG or anything that can carry code). */
export const isPreviewableImage = (type: string): boolean => RASTER.test(type);

export type MessageView = {
  id: string;
  threadId: string;
  subject: string;
  from: Address[];
  /**
   * Who sent it for the From (the `Sender:` header) when that is someone else: "Sender on behalf of From". Only this
   * standard header is read, never a tag header (ADR-0026 §8: received mail's tag means nothing). Empty otherwise.
   */
  sender: Address[];
  to: Address[];
  cc: Address[];
  /** Only your own drafts and sent mail carry Bcc. */
  bcc: Address[];
  replyTo: Address[];
  sentAt: string | null;
  receivedAt: string;
  keywords: Record<string, boolean>;
  mailboxIds: Record<string, boolean>;
  /** Sanitised HTML body fragment (render only inside the sandboxed frame), or null for text-only mail. */
  html: string | null;
  /** Plain-text body, used when there is no HTML part. */
  text: string | null;
  /** The plain-text body as blocks (message, quoted replies, signature) for the native reader, or null. */
  textBlocks: TextBlock[] | null;
  /** A text/markdown body as a safe AST (rendered natively), or null. */
  markdown: MdBlock[] | null;
  /** Calendar invitations found in the message (text/calendar parts). */
  events: CalendarEvent[];
  /** The whole message's blob (for "View original" and downloading it as .eml). */
  blobId: string | null;
  /** The body as plain text for quoting in a reply or forward (capped). */
  quote: string;
  /** This message's Message-ID and References (for In-Reply-To / References on a reply). */
  messageId: string[];
  references: string[];
  truncated: boolean;
  blockedImages: number;
  blockedTrackers: number;
  /** Blocked images that carry an image link (`data-am-img`): "Load images" fetches them through the image proxy. */
  loadableImages: number;
  /**
   * This sender's key for "Always load images from this sender" (a keyed hash of the From address, matched against
   * the `imageSenders` preference), or null when there is no sender or nothing to load.
   */
  senderKey: string | null;
  /**
   * Whether the From address is trustworthy enough to load images without asking (remembered sender or contact):
   * our own results show DMARC or aligned DKIM passing, or the message never came in from outside.
   */
  senderVerified: boolean;
  attachments: AttachmentView[];
};

export const EMAIL_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "receivedAt",
  "messageId",
  "references",
  "blobId",
  "htmlBody",
  "textBody",
  "attachments",
  "bodyValues",
] as const;

export const BODY_PROPERTIES = [
  "partId",
  "blobId",
  "size",
  "name",
  "type",
  "charset",
  "disposition",
  "cid",
  "header:Content-Type",
] as const;

/** Parts the service fetches to show natively: a markdown body and calendar invitations. */
export function markdownPart(email: JmapEmail): BodyPart | null {
  const parts = [...(email.textBody ?? []), ...(email.attachments ?? [])];
  return parts.find((p) => /^text\/(?:markdown|x-markdown)$/i.test(p.type) && p.blobId !== null) ?? null;
}
export function calendarParts(email: JmapEmail): BodyPart[] {
  const parts = [...(email.textBody ?? []), ...(email.htmlBody ?? []), ...(email.attachments ?? [])];
  const seen = new Set<string>();
  return parts
    .filter((p) => CALENDAR.test(p.type) && p.blobId !== null && !seen.has(p.blobId) && seen.add(p.blobId))
    .slice(0, 3);
}

/** Largest body value we fetch and render (bytes); longer bodies are truncated with a note. */
export const MAX_BODY_BYTES = 1_000_000;

const stripCid = (cid: string) => cid.replace(/^<|>$/g, "");

/** At most this many inline images are fetched and embedded per message. */
export const MAX_INLINE_IMAGES = 32;

/** Content-IDs the HTML body actually references (`cid:…` in any attribute or CSS). */
export function referencedCids(email: JmapEmail): Set<string> {
  const values = email.bodyValues ?? {};
  const out = new Set<string>();
  for (const p of email.htmlBody ?? []) {
    const html = p.partId !== null ? (values[p.partId]?.value ?? "") : "";
    for (const m of html.matchAll(/cid:([^"'\s>)]{1,255})/gi)) out.add((m[1] ?? "").replace(/^<|>$/g, ""));
  }
  return out;
}

/**
 * Raster image parts that the HTML body references by `cid:`, deduplicated by blob, at most `MAX_INLINE_IMAGES`
 * (to be fetched and inlined as data: URIs). Parts nobody references are never fetched.
 */
export function inlineImageParts(email: JmapEmail): BodyPart[] {
  const wanted = referencedCids(email);
  const seen = new Set<string>();
  const out: BodyPart[] = [];
  for (const p of [...(email.htmlBody ?? []), ...(email.attachments ?? [])]) {
    if (out.length >= MAX_INLINE_IMAGES) break;
    if (p.cid === null || p.blobId === null || !/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(p.type)) continue;
    const cid = stripCid(p.cid);
    if (!wanted.has(cid) || seen.has(cid)) continue;
    seen.add(cid);
    out.push(p);
  }
  return out;
}

/** Longest quote carried into a reply or forward. */
export const MAX_QUOTE_CHARS = 100_000;

/** Content the service fetched separately: the markdown body and calendar events. */
export type BodyExtras = { markdown?: string; events?: CalendarEvent[] };

export function buildMessageView(
  email: JmapEmail,
  sanitize: (html: string) => {
    html: string;
    blockedImages: number;
    blockedTrackers: number;
    loadableImages?: number;
  },
  toText: (html: string) => string = (h) => h,
  extras: BodyExtras = {},
): MessageView {
  const values = email.bodyValues ?? {};
  const read = (parts: BodyPart[] | null, type: string) =>
    (parts ?? []).filter((p) => p.type.toLowerCase() === type && p.partId !== null && values[p.partId] !== undefined);
  const htmlParts = read(email.htmlBody, "text/html");
  const textParts = read(email.textBody, "text/plain");
  const truncated = [...htmlParts, ...textParts].some((p) => values[p.partId ?? ""]?.isTruncated === true);

  let html: string | null = null;
  let blockedImages = 0;
  let blockedTrackers = 0;
  let loadableImages = 0;
  if (htmlParts.length > 0) {
    const r = sanitize(htmlParts.map((p) => values[p.partId ?? ""]?.value ?? "").join("\n"));
    html = r.html;
    blockedImages = r.blockedImages;
    blockedTrackers = r.blockedTrackers;
    loadableImages = r.loadableImages ?? 0;
  }
  const plain = textParts.map((p) => values[p.partId ?? ""]?.value ?? "").join("\n\n");
  const markdown = html === null && plain.trim() === "" && extras.markdown ? markdownBlocks(extras.markdown) : null;
  const text = html === null ? (markdown ? (extras.markdown ?? "") : plain) : null;
  const ctype = (textParts[0]?.["header:Content-Type"] ?? "").toLowerCase();
  const blocks =
    html === null && markdown === null
      ? textBlocks(plain, { flowed: /format\s*=\s*"?flowed/.test(ctype), delsp: /delsp\s*=\s*"?yes/.test(ctype) })
      : null;
  const quote = (
    plain.trim() !== ""
      ? plain
      : markdown
        ? (extras.markdown ?? "")
        : toText(htmlParts.map((p) => values[p.partId ?? ""]?.value ?? "").join("\n"))
  ).slice(0, MAX_QUOTE_CHARS);

  const inlineCids = referencedCids(email);
  const shownMarkdown = markdown ? markdownPart(email) : null;
  const attachments: AttachmentView[] = (email.attachments ?? [])
    .filter((p) => p.blobId !== null)
    // A markdown body shown in the reader isn't listed again as an attachment (unless it has a file name).
    .filter((p) => shownMarkdown?.blobId !== p.blobId || Boolean(p.name))
    .filter((p) => !(p.disposition === "inline" && p.cid !== null && inlineCids.has(stripCid(p.cid))))
    .map((p) => ({
      blobId: p.blobId ?? "",
      // The same sanitised name the download route uses, so what you see is what you get.
      name: safeFilename(p.name ?? "attachment"),
      type: p.type,
      size: p.size,
      kind: attachmentKind(p.type),
    }));

  return {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject ?? "",
    from: email.from ?? [],
    sender: onBehalfSender(email.from ?? [], email.sender ?? []),
    to: email.to ?? [],
    cc: email.cc ?? [],
    bcc: email.bcc ?? [],
    replyTo: email.replyTo ?? [],
    sentAt: email.sentAt,
    receivedAt: email.receivedAt,
    keywords: email.keywords,
    mailboxIds: email.mailboxIds,
    html,
    text,
    textBlocks: blocks,
    markdown,
    events: extras.events ?? [],
    blobId: email.blobId ?? null,
    quote,
    messageId: email.messageId ?? [],
    references: email.references ?? [],
    truncated,
    blockedImages,
    blockedTrackers,
    loadableImages,
    senderKey: null,
    senderVerified: false,
    attachments,
  };
}

/**
 * The `Sender:` to show as "on behalf of": one address that isn't the (single) From's. A Sender equal to the From, or
 * any odd shape (several From or Sender addresses), shows nothing extra.
 */
export function onBehalfSender(from: Address[], sender: Address[]): Address[] {
  const [s] = sender;
  const [f] = from;
  if (sender.length !== 1 || from.length !== 1 || !s || !f) return [];
  return s.email.trim().toLowerCase() === f.email.trim().toLowerCase() ? [] : [s];
}

/** A safe download filename: no paths, no control or quote characters, bounded length. */
export function safeFilename(name: string): string {
  const cleaned = name
    // Control, format (incl. bidi overrides like U+202E) and line/paragraph separators: they can disguise
    // "invoice‮fdp.exe" as "invoice.pdf" or break headers.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, "_")
    .replace(/["\\/:*?<>|]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned === "" ? "attachment" : cleaned;
}

/** JMAP ids (RFC 8620 §1.2): 1–255 URL-safe base64 characters. */
export const isJmapId = (v: string): boolean => /^[A-Za-z0-9_-]{1,255}$/.test(v);
