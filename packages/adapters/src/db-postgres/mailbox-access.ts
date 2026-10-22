// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm";

import type { MailboxStatus } from "@anhourmail/core/mailboxes";
import type { MailboxStatusLookup } from "@anhourmail/core/webmail";

import type { Db } from "./client";
import { mailbox } from "./schema";

/** Read-only mailbox status by address (addresses are unique across accounts) for the webmail access gate. */
export function pgMailboxStatusLookup(db: Db): MailboxStatusLookup {
  return async (address) => {
    const [row] = await db
      .select({ status: mailbox.status })
      .from(mailbox)
      .where(eq(mailbox.address, address.trim().toLowerCase()))
      .limit(1);
    return row ? (row.status as MailboxStatus) : null;
  };
}
