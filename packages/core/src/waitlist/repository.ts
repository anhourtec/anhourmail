// SPDX-License-Identifier: AGPL-3.0-only
import type { WaitlistEntry } from "./entity";

export type WaitlistRepository = {
  findByEmailHash(emailHash: string): Promise<WaitlistEntry | null>;
  insert(entry: WaitlistEntry): Promise<void>;
  /** Newest first. */
  list(opts: { limit: number; before?: Date }): Promise<WaitlistEntry[]>;
  count(): Promise<number>;
};
