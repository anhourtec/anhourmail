// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm";

import type { MailboxStatus } from "@anhourmail/core/mailboxes";
import type { MailboxStatusLookup } from "@anhourmail/core/webmail";

import type { Db } from "./client";
import { mailbox, userProfile } from "./schema";

/**
 * Read-only mailbox status by address (addresses are unique across accounts) for the webmail access gate, with
 * whether the person the mailbox belongs to is suspended by staff (the same flag the console sign-in checks).
 */
export function pgMailboxStatusLookup(db: Db): MailboxStatusLookup {
  return async (address) => {
    const [row] = await db
      .select({ status: mailbox.status, personSuspended: userProfile.suspended })
      .from(mailbox)
      .leftJoin(userProfile, eq(userProfile.userId, mailbox.userId))
      .where(eq(mailbox.address, address.trim().toLowerCase()))
      .limit(1);
    return row ? { status: row.status as MailboxStatus, personSuspended: row.personSuspended === true } : null;
  };
}
