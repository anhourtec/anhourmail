// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The demo world's trust tiers (ADR-0034 build slice 20; CLAUDE.md rule 50): one account per tier state, reset on every
 * `--demo` run. Written as the trust service leaves them (the account's tier, source, reason, staff-only note and
 * `last_restricted_at`; a mailbox's sending restriction), then each mailbox's `mailbox.ensure` is queued so the worker
 * applies the mail-server side (`smtp_blocked`, `send_blocked`, the relay hold), as staff changes do (rule 26). The web
 * app's start-up pass pauses the managed scripts. Accounts left out (the suspended one, the billing demos) keep what
 * their own seeding gives them.
 */
import { and, eq, inArray } from "drizzle-orm";

import { type Db, schema } from "@anhourmail/adapters/postgres";
import type { Deps } from "@anhourmail/core";
import { enqueueProvisioning } from "@anhourmail/core/provisioning";

import { type AccountKey, FREE_DOMAIN, RESTRICTED_MAILBOX, TRUST_DEMO } from "./people";

/** Sets each demo account's tier and the one mailbox restriction; returns the credentials.md "Special states" lines. */
export async function seedTrustTiers(
  db: Db,
  deps: Deps,
  accountIds: ReadonlyMap<AccountKey, string>,
): Promise<{ label: string; detail: string }[]> {
  const now = new Date();
  const touched: string[] = [];
  for (const [key, want] of Object.entries(TRUST_DEMO) as [AccountKey, (typeof TRUST_DEMO)[AccountKey]][]) {
    const accountId = accountIds.get(key);
    if (!want || !accountId) continue;
    const restricted = want.tier === "restricted" || key === RESTRICTED_MAILBOX.account;
    await db
      .update(schema.customerAccount)
      .set({
        trustTier: want.tier,
        trustTierSince: now,
        trustTierSource: want.source,
        trustReason: want.reason ?? null,
        trustNote: want.note ?? null,
        trustSetBy: null,
        // A restriction (of the account or a mailbox of it) keeps it from automatic promotion; the rest start clean.
        lastRestrictedAt: restricted ? now : null,
      })
      .where(eq(schema.customerAccount.id, accountId));
    touched.push(accountId);
  }

  // The one mailbox restricted on its own; every other demo mailbox of these accounts has none.
  if (touched.length > 0) {
    await db
      .update(schema.mailbox)
      .set({
        sendingRestrictedAt: null,
        sendingRestrictedReason: null,
        sendingRestrictedNote: null,
        sendingRestrictedBy: null,
      })
      .where(inArray(schema.mailbox.accountId, touched));
  }
  const restrictedAccount = accountIds.get(RESTRICTED_MAILBOX.account);
  if (restrictedAccount) {
    await db
      .update(schema.mailbox)
      .set({
        sendingRestrictedAt: now,
        sendingRestrictedReason: RESTRICTED_MAILBOX.reason,
        sendingRestrictedNote: RESTRICTED_MAILBOX.note,
        sendingRestrictedBy: null,
      })
      .where(
        and(eq(schema.mailbox.accountId, restrictedAccount), eq(schema.mailbox.address, RESTRICTED_MAILBOX.address)),
      );
  }

  // The mail server follows through the worker, like a staff change.
  if (touched.length > 0) {
    const boxes = await db
      .select({ id: schema.mailbox.id, status: schema.mailbox.status })
      .from(schema.mailbox)
      .where(inArray(schema.mailbox.accountId, touched));
    for (const b of boxes) {
      if (b.status === "active" || b.status === "provisioning" || b.status === "failed") {
        await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: b.id });
      }
    }
  }

  return [
    {
      label: "Trust tier New",
      detail: `\`free@${FREE_DOMAIN}\` (Free user): sends to AnhourMail addresses only (a send to \`someone@example.com\` is held with the recipient named), no SMTP from mail apps, automatic replies and outside forwarding paused`,
    },
    {
      label: "Trust tier Standard",
      detail: "Demo Family, Demo Group and Supporter: send anywhere within the Standard limits, mail apps included",
    },
    {
      label: "Trust tier Restricted",
      detail: `\`restricted-owner@${FREE_DOMAIN}\` (Restricted sending): sending paused (reason Sending spam, the appeal address on the Sending card); receiving and reading work`,
    },
    {
      label: "Mailbox restricted",
      detail: `\`${RESTRICTED_MAILBOX.address}\` (Restricted mailbox): the account is Standard, this mailbox's sending alone is paused (reason Abuse)`,
    },
  ];
}
