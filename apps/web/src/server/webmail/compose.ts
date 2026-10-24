// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { type SendLimits, TRUST_TIERS, type TrustTier, WEBMAIL_ATTACHMENTS } from "@anhourmail/shared";

/**
 * Composing mail (docs/internal/05-webmail.md "Compose"): the browser sends a draft description; the BFF validates
 * it and builds the JMAP `Email` itself, so a hand-written request can't pick another sender, another mailbox, or
 * skip the caps. Plain text only in this slice (no HTML is ever sent from the webmail yet).
 */

/**
 * The trust tier whose published limits apply to a mailbox's webmail sending (CLAUDE.md rule 27). Tiers aren't
 * stored per account yet, so every mailbox gets `new` — the strictest sending tier — until they are; wire the stored
 * tier in here (one place). `restricted` refuses sending entirely.
 */
export function sendingTier(_mailbox: string): TrustTier {
  return "new";
}

export const sendingLimits = (mailbox: string): SendLimits => TRUST_TIERS[sendingTier(mailbox)].limits;

/** The most recipients any tier allows on one message (input validation; the tier check is stricter). */
export const MAX_RECIPIENTS = Math.max(...Object.values(TRUST_TIERS).map((t) => t.limits.recipientsPerMessage));

/**
 * The sliding windows one send is charged to: per hour and per day (rolling), per mailbox and per webmail session.
 * Each recipient is one unit (03-anti-spam-and-abuse.md: expanded recipients count against the limits).
 */
export function sendWindows(
  mailbox: string,
  sessionKey: string,
  limits: SendLimits,
): { key: string; limit: number; windowSec: number }[] {
  const m = mailbox.toLowerCase();
  return [
    { key: `am:send:m:${m}:h`, limit: limits.messagesPerHour, windowSec: 3600 },
    { key: `am:send:m:${m}:d`, limit: limits.messagesPerDay, windowSec: 86_400 },
    { key: `am:send:s:${sessionKey}:h`, limit: limits.messagesPerHour, windowSec: 3600 },
    { key: `am:send:s:${sessionKey}:d`, limit: limits.messagesPerDay, windowSec: 86_400 },
  ];
}

/**
 * A keyword only the BFF sets, on drafts it built (`draftEmail`). The proxy refuses setting or clearing it, so a
 * message can't be promoted into something `/send` will submit; `sendCheck` and draft replacement require it.
 */
export const COMPOSED_KEYWORD = "$am-composed";
/** Attachments on one message: count and total size. Stalwart's own ceiling is 50 MB. */
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = WEBMAIL_ATTACHMENTS.perMessageMb * 1024 * 1024;
/** One upload (an attachment) through `/api/webmail/upload`. */
export const MAX_UPLOAD_BYTES = WEBMAIL_ATTACHMENTS.perFileMb * 1024 * 1024;
/** The whole message as Stalwart stores it (headers + body + attachments). */
export const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
/** Body text. */
export const MAX_TEXT_CHARS = 512 * 1024;
/** Seconds a sent message is held so "Undo" can cancel it (FUTURERELEASE `HOLDFOR`, verified on v0.16.27). */
export const UNDO_SECONDS = 6;

const jmapId = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
/** A Message-ID without angle brackets, as JMAP's `messageId` / `inReplyTo` / `references` carry it. */
const messageId = z
  .string()
  .max(250)
  .regex(/^[^<>\s@]{1,200}@[^<>\s@]{1,200}$/);
const address = z.object({
  name: z
    .string()
    .max(200)
    .transform((s) => s.replace(/[\r\n"<>]/g, " ").trim())
    .nullable()
    .optional(),
  email: z.email().max(254),
});

export const DraftInput = z.object({
  /** The draft this one replaces (autosave keeps one draft per message being written). */
  replaces: jmapId.optional(),
  identityId: jmapId,
  to: z.array(address).max(MAX_RECIPIENTS).default([]),
  cc: z.array(address).max(MAX_RECIPIENTS).default([]),
  bcc: z.array(address).max(MAX_RECIPIENTS).default([]),
  subject: z
    .string()
    .max(998)
    .transform((s) => s.replace(/[\r\n]+/g, " ")),
  text: z.string().max(MAX_TEXT_CHARS),
  inReplyTo: z.array(messageId).max(5).optional(),
  references: z.array(messageId).max(50).optional(),
  attachments: z
    .array(
      z.object({
        blobId: jmapId,
        name: z
          .string()
          .min(1)
          .max(180)
          .transform((s) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\/]+/gu, "_")),
        type: z
          .string()
          .max(127)
          .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i)
          .catch("application/octet-stream"),
        size: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
      }),
    )
    .max(MAX_ATTACHMENTS)
    .default([]),
});
export type DraftInput = z.infer<typeof DraftInput>;

/** A sending identity; `signature` is its plain-text signature (Identity.textSignature), when one is set. */
export type Identity = { id: string; name: string; email: string; signature?: string };

export type ComposeProblem = { message: string };

/** Checks what JSON can't express: recipient count, attachment total. */
export function draftProblem(d: DraftInput): ComposeProblem | null {
  if (d.to.length + d.cc.length + d.bcc.length > MAX_RECIPIENTS) {
    return { message: `A message can go to at most ${String(MAX_RECIPIENTS)} people.` };
  }
  if (d.attachments.reduce((n, a) => n + a.size, 0) > MAX_ATTACHMENT_BYTES) {
    return { message: `Attachments can add up to ${String(WEBMAIL_ATTACHMENTS.perMessageMb)} MB per message.` };
  }
  return null;
}

/**
 * The display name for the From header ("Name <addr>"): the identity's name (Stalwart seeds it from the account's
 * description, which is the mailbox's display name), or none when it is blank or just repeats the address.
 */
export function senderName(identity: Identity): string | null {
  const name = identity.name.replace(/[\r\n"<>]/g, " ").trim();
  return name === "" || name.toLowerCase() === identity.email.toLowerCase() ? null : name;
}

/** The JMAP Email for a draft, in Drafts, from one of the person's own identities. */
export function draftEmail(d: DraftInput, identity: Identity, draftsId: string): Record<string, unknown> {
  const addr = (list: DraftInput["to"]) => list.map((a) => ({ name: a.name ?? null, email: a.email.toLowerCase() }));
  return {
    mailboxIds: { [draftsId]: true },
    keywords: { $draft: true, $seen: true, [COMPOSED_KEYWORD]: true },
    from: [{ name: senderName(identity), email: identity.email }],
    // An empty list would still be written as an empty header (`Cc:`), so empty lists are left out entirely.
    ...(d.to.length ? { to: addr(d.to) } : {}),
    ...(d.cc.length ? { cc: addr(d.cc) } : {}),
    ...(d.bcc.length ? { bcc: addr(d.bcc) } : {}),
    subject: d.subject,
    ...(d.inReplyTo?.length ? { inReplyTo: d.inReplyTo } : {}),
    ...(d.references?.length ? { references: d.references } : {}),
    bodyValues: { body: { value: d.text } },
    textBody: [{ partId: "body", type: "text/plain" }],
    attachments: d.attachments.map((a) => ({
      blobId: a.blobId,
      type: a.type,
      name: a.name,
      disposition: "attachment",
    })),
  };
}

/** A draft as Stalwart holds it: enough to decide whether it may be sent. */
export type StoredDraft = {
  id: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: { email: string; name?: string | null }[] | null;
  to: { email: string; name?: string | null }[] | null;
  cc: { email: string; name?: string | null }[] | null;
  bcc: { email: string; name?: string | null }[] | null;
  size: number;
};

/**
 * Whether `draft` may be sent as `identity`: it is a draft in Drafts, from exactly that identity, with 1 to
 * `MAX_RECIPIENTS` recipients and within the size cap. Returns the envelope recipients, or a problem.
 */
export function sendCheck(
  draft: StoredDraft,
  identity: Identity,
  draftsId: string,
  limits: SendLimits = TRUST_TIERS.new.limits,
): { ok: true; rcptTo: string[] } | { ok: false; message: string } {
  if (limits.messagesPerDay === 0 || limits.messagesPerHour === 0) {
    return { ok: false, message: "Sending is paused for this mailbox. Receiving mail keeps working." };
  }
  if (
    draft.mailboxIds[draftsId] !== true ||
    draft.keywords.$draft !== true ||
    draft.keywords[COMPOSED_KEYWORD] !== true
  ) {
    return { ok: false, message: "Only a saved draft can be sent." };
  }
  const from = draft.from ?? [];
  if (from.length !== 1 || from[0]?.email.toLowerCase() !== identity.email.toLowerCase()) {
    return { ok: false, message: "You can only send from your own addresses." };
  }
  const rcpt = [
    ...new Set([...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])].map((a) => a.email.toLowerCase())),
  ];
  if (rcpt.length === 0) return { ok: false, message: "Add at least one recipient." };
  if (rcpt.length > limits.recipientsPerMessage) {
    return { ok: false, message: `A message can go to at most ${String(limits.recipientsPerMessage)} people.` };
  }
  if (draft.size > MAX_MESSAGE_BYTES) return { ok: false, message: "This message is too large to send." };
  return { ok: true, rcptTo: rcpt };
}

/** A safe Content-Type for an upload (a MIME type token pair), else application/octet-stream. */
export function uploadType(raw: string | null): string {
  const t = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]{1,63}\/[a-z0-9!#$&^_.+-]{1,63}$/.test(t) ? t : "application/octet-stream";
}
