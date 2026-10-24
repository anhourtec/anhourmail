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
};
