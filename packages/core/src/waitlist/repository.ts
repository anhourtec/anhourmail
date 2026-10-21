// SPDX-License-Identifier: AGPL-3.0-only
import type { WaitlistEntry } from "./entity";

export type WaitlistRepository = {
  get(id: string): Promise<WaitlistEntry | null>;
  findByEmailHash(emailHash: string): Promise<WaitlistEntry | null>;
  /** The pending entry whose unexpired confirmation token hashes to this value. */
  findByConfirmToken(tokenHash: string, now: Date): Promise<WaitlistEntry | null>;
  /** False when the email hash is already on the list (a concurrent join won); never throws for that. */
  insert(entry: WaitlistEntry): Promise<boolean>;
  setConfirmation(id: string, input: { tokenHash: string; expiresAt: Date; sentAt: Date }): Promise<void>;
  /** pending → confirmed; clears the token so the link can't be reused. False if the entry was not pending. */
  markConfirmed(id: string, at: Date): Promise<boolean>;
  /** confirmed → invited; false if the entry was no longer confirmed (e.g. a concurrent invite won). */
  markInvited(id: string): Promise<boolean>;
  /** Newest first. */
  list(opts: { limit: number; before?: Date }): Promise<WaitlistEntry[]>;
  count(): Promise<number>;
};
