// SPDX-License-Identifier: AGPL-3.0-only
import type { MailboxStatus } from "../mailboxes/entity";

/**
 * Who may use the webmail (docs/internal/05-webmail.md "Session acquisition"). Stalwart's suspension disables
 * sign-in, but tokens issued before it are our responsibility: the BFF asks this gate at sign-in and on every use
 * of a session, so a suspended, deleting or removed mailbox loses webmail access within `ttlMs` (default 30 s).
 * Read-only: it never changes a mailbox, so it writes no audit entry.
 */

/** A mailbox's control-plane status by address, or null when no mailbox has that address. */
export type MailboxStatusLookup = (address: string) => Promise<MailboxStatus | null>;

const BLOCKED: ReadonlySet<MailboxStatus> = new Set(["suspended", "deleting"]);

/** True when a mailbox in this state may use the webmail. Unknown mailboxes may not. */
export function webmailAllowed(status: MailboxStatus | null): boolean {
  return status !== null && !BLOCKED.has(status);
}

export class MailboxAccessGate {
  readonly #lookup: MailboxStatusLookup;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, { allowed: boolean; until: number }>();

  constructor(lookup: MailboxStatusLookup, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#lookup = lookup;
    this.#ttlMs = Math.min(opts.ttlMs ?? 30_000, 30_000);
    this.#now = opts.now ?? Date.now;
  }

  /** Whether `address` may use the webmail now (cached for at most 30 s). */
  async allowed(address: string): Promise<boolean> {
    const key = address.trim().toLowerCase();
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (hit && hit.until > now) return hit.allowed;
    const allowed = webmailAllowed(await this.#lookup(key));
    if (this.#cache.size > 10_000) this.#cache.clear();
    this.#cache.set(key, { allowed, until: now + this.#ttlMs });
    return allowed;
  }

  /** Drops the cached answer for `address` (e.g. right after a sign-in was refused). */
  forget(address: string): void {
    this.#cache.delete(address.trim().toLowerCase());
  }
}
