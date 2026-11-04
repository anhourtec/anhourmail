// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Which recipients of a webmail send the mail server could not deliver to, read from the submission's
 * `deliveryStatus` (RFC 8621 §7). The mail server refuses an unknown address on one of our own domains at `RCPT`
 * while the message is still held for undo, and for a JMAP submission that refusal sends no bounce: without this
 * the person would never know (05-webmail.md "Delivery problems").
 *
 * Only `delivered: "no"` is a failure (the server has given up on that address). `queued` (still trying, every
 * accepted address while the undo hold lasts and external ones afterwards), `unknown` and `yes` are not. The person
 * sees the address (one they typed), a plain-language reason and the short status code; the server's own reply text
 * never leaves the BFF, and none of this is ever logged (rules 12, 24).
 */

export type Undelivered = {
  /** The envelope recipient, as the person sent to it. */
  email: string;
  /** The short status code: the enhanced code (`5.1.2`) when the reply has one, else the reply code (`550`). */
  code: string | null;
  /** Why, in plain language. */
  reason: string;
};

export type DeliveryReport = {
  /** Addresses the mail server gave up on (sorted, at most `MAX_REPORTED`). */
  undelivered: Undelivered[];
  /**
   * Nothing more is expected soon: the hold is over (or it was undone) and every recipient has a status other than
   * `queued`. External recipients can stay `queued` for a long time, so a caller re-checks an unsettled report only
   * for a short, bounded time.
   */
  settled: boolean;
  /** Still in the undo hold (`undoStatus: pending`): undo can still cancel it. */
  held: boolean;
};

type RecipientStatus = { delivered?: unknown; smtpReply?: unknown };
export type SubmissionStatus = { undoStatus?: unknown; deliveryStatus?: unknown };

/** No more than this many addresses are reported for one send (the send cap is 100 recipients anyway). */
export const MAX_REPORTED = 100;

const NO_MAILBOX = "No mailbox with this address exists.";
const REFUSED = "The receiving server refused this message.";

/** Plain-language reasons by the subject and detail of the enhanced status code (RFC 3463), class aside. */
const REASONS: Record<string, string> = {
  "1.1": NO_MAILBOX,
  "1.2": NO_MAILBOX,
  "1.3": "This address isn't valid.",
  "1.6": "This mailbox has moved and has no forwarding address.",
  "1.10": "This domain doesn't accept mail.",
  "2.1": "This mailbox isn't accepting mail.",
  "2.2": "The recipient's mailbox is full.",
  "2.3": "The message is too large for the recipient.",
  "3.4": "The message is too large for the recipient.",
  "4.5": "Too many messages to this address for now. Try again later.",
};

/** The status code and reason for one refused recipient's SMTP reply. Never returns the reply text itself. */
export function refusalOf(smtpReply: unknown): { code: string | null; reason: string } {
  const reply = typeof smtpReply === "string" ? smtpReply.slice(0, 512) : "";
  const m = /^([245]\d\d)(?:[ -]+([245])\.(\d{1,3})\.(\d{1,3})\b)?/.exec(reply);
  if (!m) return { code: null, reason: REFUSED };
  const [, basic, cls, subject, detail] = m;
  if (cls === undefined || subject === undefined || detail === undefined)
    return { code: basic ?? null, reason: REFUSED };
  const code = `${cls}.${subject}.${detail}`;
  const known = REASONS[`${subject}.${detail}`];
  if (known) return { code, reason: known };
  if (subject === "7") return { code, reason: REFUSED };
  return {
    code,
    reason: cls === "4" ? "The receiving server couldn't take it right now. Try sending it again later." : REFUSED,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads one submission's delivery report (an `EmailSubmission/get` item). Missing or odd fields are "unsettled". */
export function deliveryReport(sub: SubmissionStatus | undefined): DeliveryReport {
  const held = sub?.undoStatus === "pending";
  const status = isRecord(sub?.deliveryStatus) ? sub.deliveryStatus : null;
  if (!sub || status === null) return { undelivered: [], settled: sub?.undoStatus === "canceled", held };
  // Undone: nothing was sent, so nothing to report.
  if (sub.undoStatus === "canceled") return { undelivered: [], settled: true, held: false };
  const undelivered: Undelivered[] = [];
  let answered = true;
  for (const [email, raw] of Object.entries(status)) {
    const s: RecipientStatus = isRecord(raw) ? raw : {};
    if (typeof s.delivered !== "string" || s.delivered === "queued") {
      answered = false;
      continue;
    }
    if (s.delivered !== "no") continue;
    // Only plain addresses go back to the browser (they are envelope recipients the person entered).
    if (email.length > 254 || !/^[^\s@<>"]+@[^\s@<>"]+$/.test(email)) continue;
    undelivered.push({ email, ...refusalOf(s.smtpReply) });
  }
  undelivered.sort((a, b) => a.email.localeCompare(b.email));
  return {
    undelivered: undelivered.slice(0, MAX_REPORTED),
    settled: answered && Object.keys(status).length > 0 && !held,
    held,
  };
}
