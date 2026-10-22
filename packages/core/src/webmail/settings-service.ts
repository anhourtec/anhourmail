// SPDX-License-Identifier: AGPL-3.0-only
import type { TrustTier } from "@anhourmail/shared/sending";
import { normalizePreferences, parsePreferencePatch, type WebmailPreferences } from "@anhourmail/shared/webmail";

import type { Actor } from "../actor";
import type { AuditAction } from "../audit/catalogue";
import { maskEmail } from "../audit/record";
import { NotFoundError, ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import { hashToken, isTokenShaped, newToken } from "../tokens";
import type { ForwardingStatus, ForwardingTarget, WebmailMailbox } from "./settings-repository";

/**
 * Webmail settings that live in the control plane (docs/internal/05-webmail.md "Settings"): a mailbox's display
 * preferences, the confirmation of its forwarding target, and the audit trail of mail-flow changes it makes in the
 * mail server (automatic replies, forwarding, junk rules, sender names and signatures).
 *
 * The caller is a webmail session: the mailbox proved its password to the mail server, and the BFF passes the
 * session's own address. There is no console actor, so entries are written as the mailbox itself (a `system` actor
 * named by its address) in the owning account's log, where its admins see them (rule 49 in spirit).
 */

/** How long a forwarding confirmation link works. */
export const FORWARDING_LINK_HOURS = 72;
/** Confirmation emails one mailbox may trigger per 24 hours (each one emails an outside address). */
export const FORWARDING_EMAILS_PER_DAY = 5;

export type ForwardingView = { address: string; status: ForwardingStatus; expiresAt: Date | null };

/** Mail-flow changes made in the mail server that the control plane records (no content, no full addresses). */
export type MailFlowAction = Extract<
  AuditAction,
  "forwarding.changed" | "vacation.changed" | "junk_rules.changed" | "identity.changed"
>;

const ADDRESS =
  /^[^\s@"<>()[\]\\,;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A forwarding target as typed: trimmed, lowercased, a plain address, else null. */
export function forwardingAddress(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input.trim().toLowerCase();
  return v.length <= 254 && ADDRESS.test(v) ? v : null;
}

export class WebmailSettingsService {
  constructor(private readonly deps: Deps) {}

  #actor(address: string): Actor {
    return { kind: "system", name: address };
  }

  /** The mailbox behind a webmail session; unknown addresses are not found. */
  async mailbox(address: string): Promise<WebmailMailbox> {
    const key = address.trim().toLowerCase();
    const m = await this.deps.uow.run((r) => r.webmailSettings.mailboxByAddress(key));
    if (!m) throw new NotFoundError();
    return m;
  }

  async preferences(address: string): Promise<WebmailPreferences> {
    const m = await this.mailbox(address);
    return normalizePreferences(await this.deps.uow.run((r) => r.webmailSettings.preferences(m.id)));
  }

  /** Applies a change (known keys with allowed values only) and returns the full set. */
  async updatePreferences(address: string, patch: unknown, req: RequestMeta): Promise<WebmailPreferences> {
    const change = parsePreferencePatch(patch);
    if (!change) throw new ValidationError("That setting can't be changed to that value.");
    const m = await this.mailbox(address);
    return mutation(
      this.deps,
      this.#actor(m.address),
      req,
      {
        action: "webmail.preferences_changed",
        permission: "mailbox.read",
        accountId: m.accountId,
        target: { type: "mailbox", id: m.id, label: m.address },
      },
      async (repos) => {
        const next = { ...normalizePreferences(await repos.webmailSettings.preferences(m.id)), ...change };
        await repos.webmailSettings.savePreferences(m.id, next, this.deps.clock.now());
        return { result: next, meta: { changed: Object.keys(change) } };
      },
    );
  }

  async forwarding(address: string): Promise<ForwardingView | null> {
    const m = await this.mailbox(address);
    const t = await this.deps.uow.run((r) => r.webmailSettings.forwarding(m.id));
    if (!t) return null;
    const expired = t.status === "pending" && t.expiresAt !== null && t.expiresAt <= this.deps.clock.now();
    return { address: t.address, status: t.status, expiresAt: expired ? new Date(0) : t.expiresAt };
  }

  /** True when `target` is this mailbox's confirmed forwarding address. */
  async forwardingConfirmed(address: string, target: string): Promise<boolean> {
    const f = await this.forwarding(address);
    return f !== null && f.status === "confirmed" && f.address === target.trim().toLowerCase();
  }

  /**
   * Starts (or restarts) confirmation of a forwarding target and returns the one-time token for the email. Refuses
   * the mailbox's own addresses (a loop), a paused sender (restricted tier) and more than
   * `FORWARDING_EMAILS_PER_DAY` confirmation emails a day. Replaces any earlier target, which stops working at once.
   */
  async requestForwarding(
    address: string,
    input: { target: unknown; ownAddresses: readonly string[]; tier: TrustTier },
    req: RequestMeta,
  ): Promise<{ token: string; target: string; expiresAt: Date }> {
    const target = forwardingAddress(input.target);
    if (!target) throw new ValidationError("Enter an email address to forward to.");
    const m = await this.mailbox(address);
    const own = new Set([m.address, ...input.ownAddresses].map((a) => a.trim().toLowerCase()));
    if (own.has(target)) throw new ValidationError("Forward to another mailbox, not to one of your own addresses.");
    if (input.tier === "restricted") {
      throw new ValidationError("Forwarding is paused while sending from this mailbox is paused.");
    }
    const now = this.deps.clock.now();
    const token = newToken();
    const expiresAt = new Date(now.getTime() + FORWARDING_LINK_HOURS * 3_600_000);
    return mutation(
      this.deps,
      this.#actor(m.address),
      req,
      {
        action: "forwarding.verification_sent",
        permission: "forwarding.manage.own",
        accountId: m.accountId,
        target: { type: "mailbox", id: m.id, label: m.address },
      },
      async (repos) => {
        const prev = await repos.webmailSettings.forwardingForUpdate(m.id, m.accountId);
        if (prev?.status === "confirmed" && prev.address === target) {
          throw new ValidationError("That address is already confirmed.");
        }
        const sameWindow = prev !== null && now.getTime() - prev.windowStartedAt.getTime() < 86_400_000;
        const sends = sameWindow ? prev.sendsInWindow : 0;
        if (sends >= FORWARDING_EMAILS_PER_DAY) {
          throw new ValidationError("You've asked for several confirmations today. Try again tomorrow.");
        }
        const row: ForwardingTarget = {
          mailboxId: m.id,
          accountId: m.accountId,
          address: target,
          status: "pending",
          tokenHash: hashToken(token),
          expiresAt,
          confirmedAt: null,
          requestedAt: now,
          sendsInWindow: sends + 1,
          windowStartedAt: sameWindow ? prev.windowStartedAt : now,
        };
        await repos.webmailSettings.saveForwarding(row);
        return { result: { token, target, expiresAt }, meta: { forwardTo: maskEmail(target) } };
      },
    );
  }

  /**
   * The target's owner followed the link: the target is confirmed (the mailbox owner can now turn forwarding on).
   * An unknown, used or expired token is not found. Returns the mailbox address for the page (the page is reached
   * with the one-time token, so the owner who is confirming sees which mailbox in full; the email showed it masked).
   */
  async confirmForwarding(token: unknown, req: RequestMeta): Promise<{ mailbox: string; target: string }> {
    if (!isTokenShaped(token)) throw new NotFoundError("This link has expired or was already used.");
    const hash = hashToken(token);
    const found = await this.deps.uow.run((r) => r.webmailSettings.forwardingByToken(hash));
    const now = this.deps.clock.now();
    if (found?.status !== "pending" || (found.expiresAt !== null && found.expiresAt <= now)) {
      throw new NotFoundError("This link has expired or was already used.");
    }
    return mutation(
      this.deps,
      { kind: "system", name: "forwarding confirmation link" },
      req,
      {
        action: "forwarding.confirmed",
        permission: "forwarding.manage.own",
        accountId: found.accountId,
        target: { type: "mailbox", id: found.mailboxId },
      },
      async (repos) => {
        // Re-read inside the transaction: a newer request (another token) wins over this link.
        const cur = await repos.webmailSettings.forwardingByToken(hash);
        if (cur?.mailboxId !== found.mailboxId) {
          throw new NotFoundError("This link has expired or was already used.");
        }
        await repos.webmailSettings.saveForwarding({ ...cur, status: "confirmed", tokenHash: null, confirmedAt: now });
        const owner = await repos.mailboxes.get(cur.accountId, cur.mailboxId);
        return {
          result: { mailbox: owner?.address ?? "", target: cur.address },
          target: { label: owner?.address ?? null },
          meta: { forwardTo: maskEmail(cur.address) },
        };
      },
    );
  }

  /** Forgets the forwarding target (forwarding itself is removed from the mail server by the caller). */
  async removeForwarding(address: string, req: RequestMeta): Promise<void> {
    const m = await this.mailbox(address);
    await mutation(
      this.deps,
      this.#actor(m.address),
      req,
      {
        action: "forwarding.changed",
        permission: "forwarding.manage.own",
        accountId: m.accountId,
        target: { type: "mailbox", id: m.id, label: m.address },
      },
      async (repos) => {
        await repos.webmailSettings.clearForwarding(m.id);
        return { result: undefined, meta: { enabled: false, removed: true } };
      },
    );
  }

  /** Records a mail-flow change already applied in the mail server (meta: flags and counts only). */
  async recordMailFlow(
    address: string,
    action: MailFlowAction,
    meta: Record<string, string | number | boolean | string[]>,
    req: RequestMeta,
  ): Promise<void> {
    const m = await this.mailbox(address);
    await mutation(
      this.deps,
      this.#actor(m.address),
      req,
      {
        action,
        permission: "forwarding.manage.own",
        accountId: m.accountId,
        target: { type: "mailbox", id: m.id, label: m.address },
      },
      async () => ({ result: undefined, meta }),
    );
  }
}
