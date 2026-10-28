// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The webmail's first-sign-in password change, enforced on the API (docs/internal/07-security.md "Mailbox passwords").
 * While a mailbox's `mustChangePassword` is set, its webmail session may only change the password or sign out: the
 * BFF asks this gate on every other request. The flag clears once the worker has applied the person's own password
 * to the mail server, so a "required" answer is never cached (the inbox opens as soon as it clears); "not required"
 * is cached for at most `ttlMs` (default 30 s), like the access gate. Read-only: it writes no audit entry.
 */

/** Whether the mailbox at this (lowercased) address must change its password first; false for unknown addresses. */
export type PasswordChangeLookup = (address: string) => Promise<boolean>;

export class PasswordChangeGate {
  readonly #lookup: PasswordChangeLookup;
  readonly #ttlMs: number;
  readonly #now: () => number;
  /** Addresses known not to need a change, until when. */
  readonly #clear = new Map<string, number>();

  constructor(lookup: PasswordChangeLookup, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#lookup = lookup;
    this.#ttlMs = Math.min(opts.ttlMs ?? 30_000, 30_000);
    this.#now = opts.now ?? Date.now;
  }

  /** Whether `address` must change its password before using the webmail. */
  async required(address: string): Promise<boolean> {
    const key = address.trim().toLowerCase();
    const now = this.#now();
    const until = this.#clear.get(key);
    if (until !== undefined && until > now) return false;
    const required = await this.#lookup(key);
    if (required) {
      this.#clear.delete(key);
      return true;
    }
    if (this.#clear.size > 10_000) this.#clear.clear();
    this.#clear.set(key, now + this.#ttlMs);
    return false;
  }

  /** Drops the cached answer for `address` (e.g. right after an administrator set the requirement). */
  forget(address: string): void {
    this.#clear.delete(address.trim().toLowerCase());
  }
}
