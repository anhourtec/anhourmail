// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm";

import type {
  ForwardingStatus,
  ForwardingTarget,
  WebmailMailbox,
  WebmailSettingsRepository,
} from "@anhourmail/core/webmail";

import type { Executor } from "./client";
import { forwardingTarget, mailbox, webmailPreference } from "./schema";

const isId = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

type Row = typeof forwardingTarget.$inferSelect;
const toTarget = (r: Row): ForwardingTarget => ({
  mailboxId: r.mailboxId,
  accountId: r.accountId,
  address: r.address,
  status: (r.status === "confirmed" ? "confirmed" : "pending") satisfies ForwardingStatus,
  tokenHash: r.tokenHash,
  expiresAt: r.expiresAt,
  confirmedAt: r.confirmedAt,
  requestedAt: r.requestedAt,
  sendsInWindow: r.sendsInWindow,
  windowStartedAt: r.windowStartedAt,
});

/** Webmail preferences and forwarding confirmations (docs/internal/05-webmail.md "Settings"). */
export class PgWebmailSettingsRepository implements WebmailSettingsRepository {
  constructor(private readonly x: Executor) {}

  async mailboxByAddress(address: string): Promise<WebmailMailbox | null> {
    const [r] = await this.x
      .select({ id: mailbox.id, accountId: mailbox.accountId, address: mailbox.address })
      .from(mailbox)
      .where(eq(mailbox.address, address.trim().toLowerCase()))
      .limit(1);
    return r ?? null;
  }

  async preferences(mailboxId: string): Promise<Record<string, unknown> | null> {
    if (!isId(mailboxId)) return null;
    const [r] = await this.x
      .select({ prefs: webmailPreference.prefs })
      .from(webmailPreference)
      .where(eq(webmailPreference.mailboxId, mailboxId));
    return r && r.prefs !== null && typeof r.prefs === "object" ? (r.prefs as Record<string, unknown>) : null;
  }

  async savePreferences(mailboxId: string, prefs: Record<string, unknown>, at: Date): Promise<void> {
    await this.x
      .insert(webmailPreference)
      .values({ mailboxId, prefs, updatedAt: at })
      .onConflictDoUpdate({ target: webmailPreference.mailboxId, set: { prefs, updatedAt: at } });
  }

  async forwarding(mailboxId: string): Promise<ForwardingTarget | null> {
    if (!isId(mailboxId)) return null;
    const [r] = await this.x.select().from(forwardingTarget).where(eq(forwardingTarget.mailboxId, mailboxId));
    // An empty address is the counter's lock placeholder, never a target.
    return r && r.address !== "" ? toTarget(r) : null;
  }

  async forwardingForUpdate(mailboxId: string, accountId: string): Promise<ForwardingTarget | null> {
    if (!isId(mailboxId)) return null;
    // Something to lock even on the first request: an empty placeholder (address ''), overwritten or rolled back.
    const epoch = new Date(0);
    await this.x
      .insert(forwardingTarget)
      .values({
        mailboxId,
        accountId,
        address: "",
        status: "pending",
        tokenHash: null,
        expiresAt: null,
        confirmedAt: null,
        requestedAt: epoch,
        sendsInWindow: 0,
        windowStartedAt: epoch,
      })
      .onConflictDoNothing({ target: forwardingTarget.mailboxId });
    const [r] = await this.x
      .select()
      .from(forwardingTarget)
      .where(eq(forwardingTarget.mailboxId, mailboxId))
      .for("update");
    return r && r.address !== "" ? toTarget(r) : null;
  }

  async saveForwarding(t: ForwardingTarget): Promise<void> {
    const values = { ...t };
    const { mailboxId: _id, ...set } = values;
    await this.x
      .insert(forwardingTarget)
      .values(values)
      .onConflictDoUpdate({ target: forwardingTarget.mailboxId, set });
  }

  async forwardingByToken(tokenHash: string): Promise<ForwardingTarget | null> {
    const [r] = await this.x.select().from(forwardingTarget).where(eq(forwardingTarget.tokenHash, tokenHash)).limit(1);
    return r ? toTarget(r) : null;
  }

  async clearForwarding(mailboxId: string): Promise<void> {
    if (!isId(mailboxId)) return;
    await this.x.delete(forwardingTarget).where(eq(forwardingTarget.mailboxId, mailboxId));
  }
}
