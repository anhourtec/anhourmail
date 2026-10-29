// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Control-plane state behind webmail settings (docs/internal/05-webmail.md "Settings"). Preferences hold display
 * choices only (no mail content, no addresses). A forwarding target is the one outside address a mailbox may forward
 * to, with its confirmation state: forwarding only works once the target's owner confirmed it.
 */

export type ForwardingStatus = "pending" | "confirmed";

export type ForwardingTarget = {
  mailboxId: string;
  accountId: string;
  /** Lowercased target address. */
  address: string;
  status: ForwardingStatus;
  /** sha256 of the confirmation token while pending; null once confirmed. */
  tokenHash: string | null;
  /** When the pending confirmation link stops working. */
  expiresAt: Date | null;
  confirmedAt: Date | null;
  requestedAt: Date;
  /** Confirmation emails sent in the current 24-hour window (a per-mailbox cap). */
  sendsInWindow: number;
  windowStartedAt: Date;
};

/** The mailbox a webmail session belongs to, found by its address (addresses are unique across accounts). */
export type WebmailMailbox = {
  id: string;
  accountId: string;
  address: string;
  /** Set by "Add a user": the webmail asks for a new password before the inbox. */
  mustChangePassword: boolean;
};

export type WebmailSettingsRepository = {
  mailboxByAddress(address: string): Promise<WebmailMailbox | null>;
  preferences(mailboxId: string): Promise<Record<string, unknown> | null>;
  /** Insert or replace the mailbox's preferences. */
  savePreferences(mailboxId: string, prefs: Record<string, unknown>, at: Date): Promise<void>;
  forwarding(mailboxId: string): Promise<ForwardingTarget | null>;
  /**
   * Like `forwarding`, but row-locked for the rest of the transaction (the daily-email counter). The very first
   * request has no row to lock, so adapters first insert an empty placeholder (`ON CONFLICT DO NOTHING`) and lock
   * that; the caller always overwrites it with `saveForwarding` or the transaction rolls back, so it never persists.
   * A placeholder reads back as null.
   */
  forwardingForUpdate(mailboxId: string, accountId: string): Promise<ForwardingTarget | null>;
  /** Insert or replace the mailbox's one forwarding target. */
  saveForwarding(target: ForwardingTarget): Promise<void>;
  /** The pending target with this token hash (any mailbox), or null. */
  forwardingByToken(tokenHash: string): Promise<ForwardingTarget | null>;
  clearForwarding(mailboxId: string): Promise<void>;
} & SignatureRepository;

/**
 * One of a mailbox's named signatures (docs/internal/05-webmail.md "Signatures"). `html` was sanitised by the BFF
 * before it got here and `text` was generated from it; neither is ever logged or audited.
 */
export type StoredSignature = {
  id: string;
  mailboxId: string;
  accountId: string;
  name: string;
  html: string;
  text: string;
  /** The default for new messages (at most one per mailbox). */
  defaultNew: boolean;
  /** The default for replies and forwards (at most one per mailbox). */
  defaultReply: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SignatureRepository = {
  /**
   * Holds the mailbox's signatures for the rest of the transaction, so parallel changes can't both pass the count and
   * size caps (Postgres: a transaction-scoped advisory lock keyed by the mailbox id).
   */
  lockSignatures(mailboxId: string): Promise<void>;
  /** The mailbox's signatures, oldest first. */
  signatures(mailboxId: string): Promise<StoredSignature[]>;
  /** Whether the mailbox's signatures were started (the old single signature was brought over, or one was added). */
  signaturesStarted(mailboxId: string): Promise<boolean>;
  markSignaturesStarted(mailboxId: string, at: Date): Promise<void>;
  insertSignature(signature: StoredSignature): Promise<void>;
  /** Changes the name and/or content of one of the mailbox's signatures; false when it isn't there. */
  updateSignature(
    mailboxId: string,
    id: string,
    change: { name?: string; html?: string; text?: string },
    at: Date,
  ): Promise<boolean>;
  /** Deletes one of the mailbox's signatures (a default it was falls back to none); false when it isn't there. */
  deleteSignature(mailboxId: string, id: string): Promise<boolean>;
  /** Sets both defaults (null is none); ids must be the mailbox's own (checked by the caller). */
  setSignatureDefaults(mailboxId: string, defaults: { newMessage: string | null; reply: string | null }): Promise<void>;
};
