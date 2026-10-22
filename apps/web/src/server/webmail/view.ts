// SPDX-License-Identifier: AGPL-3.0-only
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
};

/** The JMAP Email properties the reader asks for. */
export type JmapEmail = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[] | null;
  to: Address[] | null;
  cc: Address[] | null;
  replyTo: Address[] | null;
  subject: string | null;
  sentAt: string | null;
  receivedAt: string;
  htmlBody: BodyPart[] | null;
  textBody: BodyPart[] | null;
  attachments: BodyPart[] | null;
  bodyValues: Record<string, { value: string; isTruncated?: boolean; isEncodingProblem?: boolean }> | null;
};

export type AttachmentView = { blobId: string; name: string; type: string; size: number };

export type MessageView = {
  id: string;
  threadId: string;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  sentAt: string | null;
  receivedAt: string;
  keywords: Record<string, boolean>;
  mailboxIds: Record<string, boolean>;
  /** Sanitised HTML body fragment (render only inside the sandboxed frame), or null for text-only mail. */
  html: string | null;
  /** Plain-text body, used when there is no HTML part. */
  text: string | null;
  truncated: boolean;
  blockedImages: number;
  blockedTrackers: number;
  attachments: AttachmentView[];
};

export const EMAIL_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "cc",
  "replyTo",
  "subject",
  "sentAt",
  "receivedAt",
  "htmlBody",
  "textBody",
  "attachments",
  "bodyValues",
] as const;

export const BODY_PROPERTIES = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid"] as const;

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

export function buildMessageView(
  email: JmapEmail,
  sanitize: (html: string) => { html: string; blockedImages: number; blockedTrackers: number },
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
  if (htmlParts.length > 0) {
    const r = sanitize(htmlParts.map((p) => values[p.partId ?? ""]?.value ?? "").join("\n"));
    html = r.html;
    blockedImages = r.blockedImages;
    blockedTrackers = r.blockedTrackers;
  }
  const text = html === null ? textParts.map((p) => values[p.partId ?? ""]?.value ?? "").join("\n\n") : null;

  const inlineCids = referencedCids(email);
  const attachments: AttachmentView[] = (email.attachments ?? [])
    .filter((p) => p.blobId !== null)
    .filter((p) => !(p.disposition === "inline" && p.cid !== null && inlineCids.has(stripCid(p.cid))))
    .map((p) => ({
      blobId: p.blobId ?? "",
      // The same sanitised name the download route uses, so what you see is what you get.
      name: safeFilename(p.name ?? "attachment"),
      type: p.type,
      size: p.size,
    }));

  return {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject ?? "",
    from: email.from ?? [],
    to: email.to ?? [],
    cc: email.cc ?? [],
    replyTo: email.replyTo ?? [],
    sentAt: email.sentAt,
    receivedAt: email.receivedAt,
    keywords: email.keywords,
    mailboxIds: email.mailboxIds,
    html,
    text,
    truncated,
    blockedImages,
    blockedTrackers,
    attachments,
  };
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
