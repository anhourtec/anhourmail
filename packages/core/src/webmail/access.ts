// SPDX-License-Identifier: AGPL-3.0-only
import type { MailboxStatus } from "../mailboxes/entity";

/**
 * Who may use the webmail (docs/internal/05-webmail.md "Session acquisition"). Stalwart's suspension disables
 * sign-in, but tokens issued before it are our responsibility: the BFF asks this gate at sign-in and on every use
 * of a session, so a suspended, deleting or removed mailbox — or one whose person staff suspended — loses webmail
 * access within `ttlMs` (default 30 s). Read-only: it never changes a mailbox, so it writes no audit entry.
 */

/** What the control plane knows about a mailbox: its status and whether the person it belongs to is suspended. */
export type MailboxAccessRecord = { status: MailboxStatus; personSuspended: boolean };

/** A mailbox's control-plane record by address, or null when no mailbox has that address. */
export type MailboxStatusLookup = (address: string) => Promise<MailboxAccessRecord | null>;

/**
 * Whether a mailbox may use the webmail now, and if not, why: the person it belongs to is suspended by staff
 * (`person_suspended`, which wins over the mailbox's own state), the mailbox is suspended (by its account or by a
 * staff suspension of the account), it is being deleted, or no mailbox has that address (`gone`).
 */
export type WebmailAccess = "ok" | "person_suspended" | "suspended" | "deleting" | "gone";

/** The reasons a mailbox can't use the webmail. */
export type WebmailRefusal = Exclude<WebmailAccess, "ok">;

/** The webmail access for a control-plane record. Unknown mailboxes may not use it. */
export function webmailAccess(record: MailboxAccessRecord | null): WebmailAccess {
  if (record === null) return "gone";
  if (record.personSuspended) return "person_suspended";
  if (record.status === "suspended") return "suspended";
  if (record.status === "deleting") return "deleting";
  return "ok";
}

/** True when a mailbox with this record may use the webmail. */
export function webmailAllowed(record: MailboxAccessRecord | null): boolean {
  return webmailAccess(record) === "ok";
}

export class MailboxAccessGate {
  readonly #lookup: MailboxStatusLookup;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, { access: WebmailAccess; until: number }>();

  constructor(lookup: MailboxStatusLookup, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#lookup = lookup;
    this.#ttlMs = Math.min(opts.ttlMs ?? 30_000, 30_000);
    this.#now = opts.now ?? Date.now;
  }

  /** The webmail access of `address` now (cached for at most 30 s, per normalised address). */
  async state(address: string): Promise<WebmailAccess> {
    const key = address.trim().toLowerCase();
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (hit && hit.until > now) return hit.access;
    const access = webmailAccess(await this.#lookup(key));
    if (this.#cache.size > 10_000) this.#cache.clear();
    this.#cache.set(key, { access, until: now + this.#ttlMs });
    return access;
  }

  /** Whether `address` may use the webmail now (cached for at most 30 s). */
  async allowed(address: string): Promise<boolean> {
    return (await this.state(address)) === "ok";
  }

  /** Drops the cached answer for `address` (e.g. right after a sign-in was refused). */
  forget(address: string): void {
    this.#cache.delete(address.trim().toLowerCase());
  }
}
