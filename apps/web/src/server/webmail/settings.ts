// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import type { RequestMeta } from "@anhourmail/core";
import { maskEmail } from "@anhourmail/core/audit";
import { FORWARDING_LINK_HOURS, type ForwardingView, type WebmailSettingsService } from "@anhourmail/core/webmail";
import type { WebmailPreferences } from "@anhourmail/shared/webmail";
import { log } from "@anhourmail/server/log";

import { forwardingConfirmEmail } from "../mail/system-email";
import { type Identity, sendingTier } from "./compose";
import { type Junk, type JunkInput, type MailRules, type Vacation, VacationInput, zoneOffset } from "./sieve";
import { type RulesState, WebmailRefusedError, WebmailSignedOutError, type WebmailService } from "./service";

/**
 * Webmail settings (docs/internal/05-webmail.md "Settings"): the one place that joins the control plane
 * (preferences, forwarding confirmation, audit) with the mail server (identities, quota, the managed Sieve script).
 * Every call is for the session's own active mailbox; changes also take the account the app is showing.
 */

type MailServer = Pick<
  WebmailService,
  "session" | "identities" | "quota" | "mailRules" | "saveMailRules" | "updateIdentity"
>;
type Mailer = { send(message: ReturnType<typeof forwardingConfirmEmail>): Promise<void> };

export type SettingsOverview = {
  accountId: string;
  address: string;
  preferences: WebmailPreferences;
  identities: Identity[];
  quota: { used: number; limit: number | null };
  rules: { vacation: Vacation; junk: Junk; forwarding: MailRules["forwarding"] };
  rulesState: RulesState;
  /** The forwarding target and whether its owner confirmed it (control plane). */
  forwardingTarget: ForwardingView | null;
};

/** A sender name: one line, no characters that change how it's read in a header. */
export const IdentityChange = z
  .object({
    name: z
      .string()
      .max(100)
      .transform((s) =>
        s
          .replace(/[\p{Cc}"<>]/gu, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .optional(),
    signature: z
      .string()
      .max(2_000)
      .transform((s) =>
        s
          .replace(/\r\n?/g, "\n")
          .replace(/[^\P{Cc}\n\t]/gu, "")
          .replace(/\s+$/u, ""),
      )
      .optional(),
  })
  .refine((v) => v.name !== undefined || v.signature !== undefined, { message: "Nothing to change." });

export const VacationChange = z.object({ vacation: VacationInput, timeZone: z.string().max(64) });

export class WebmailSettings {
  constructor(
    private readonly d: {
      mail: MailServer;
      settings: WebmailSettingsService;
      mailer: Mailer;
      webmailUrl: string;
    },
  ) {}

  async #address(sessionId: string): Promise<string> {
    const s = await this.d.mail.session(sessionId);
    if (!s) throw new WebmailSignedOutError("signed out");
    return s.username;
  }

  /**
   * The session's mailbox, read once, with the account-pin check first (before any control-plane or mail-server
   * lookup). Every writer uses this so a mailbox switched in another tab can't aim a change at the wrong account.
   */
  async #pinned(sessionId: string, account: string): Promise<{ address: string; accountId: string }> {
    const s = await this.d.mail.session(sessionId);
    if (!s) throw new WebmailSignedOutError("signed out");
    if (s.accountId !== account) throw new WebmailRefusedError("Your active mailbox changed. Try again.");
    return { address: s.username, accountId: s.accountId };
  }

  async overview(sessionId: string): Promise<SettingsOverview> {
    const address = await this.#address(sessionId);
    const [preferences, identities, quota, rules, forwardingTarget] = await Promise.all([
      this.d.settings.preferences(address),
      this.d.mail.identities(sessionId),
      this.d.mail.quota(sessionId),
      this.d.mail.mailRules(sessionId),
      this.d.settings.forwarding(address),
    ]);
    return {
      accountId: rules.accountId,
      address,
      preferences,
      identities,
      quota,
      rules: { vacation: rules.rules.vacation, junk: rules.rules.junk, forwarding: rules.rules.forwarding },
      rulesState: rules.state,
      forwardingTarget,
    };
  }

  async preferences(sessionId: string): Promise<WebmailPreferences> {
    return this.d.settings.preferences(await this.#address(sessionId));
  }

  /** Saves preferences for the mailbox the app is showing (refused if another one became active meanwhile). */
  async updatePreferences(
    sessionId: string,
    account: string,
    patch: unknown,
    req: RequestMeta,
  ): Promise<WebmailPreferences> {
    const s = await this.d.mail.session(sessionId);
    if (!s) throw new WebmailSignedOutError("signed out");
    if (s.accountId !== account) throw new WebmailRefusedError("Your active mailbox changed. Try again.");
    return this.d.settings.updatePreferences(s.username, patch, req);
  }

  async updateIdentity(
    sessionId: string,
    account: string,
    identityId: string,
    change: z.infer<typeof IdentityChange>,
    req: RequestMeta,
  ): Promise<Identity> {
    const { address } = await this.#pinned(sessionId, account);
    const updated = await this.d.mail.updateIdentity(sessionId, account, identityId, {
      ...(change.name !== undefined ? { name: change.name } : {}),
      ...(change.signature !== undefined ? { signature: change.signature } : {}),
    });
    const fields = [
      ...(change.name !== undefined ? ["name"] : []),
      ...(change.signature !== undefined ? ["signature"] : []),
    ];
    await this.d.settings.recordMailFlow(
      address,
      "identity.changed",
      { fields, identity: maskEmail(updated.email) },
      req,
    );
    return updated;
  }

  /**
   * The current rules to carry forward on a write. Forwarding is filtered by `WebmailService.saveMailRules` itself
   * (kept only when it's the control-plane confirmed target), so every caller — these settings and the contacts
   * refresh — goes through the same check.
   */
  async #rules(sessionId: string): Promise<Omit<MailRules, "include">> {
    const { rules } = await this.d.mail.mailRules(sessionId);
    const { include: _include, ...rest } = rules;
    return rest;
  }

  async saveVacation(
    sessionId: string,
    account: string,
    input: z.infer<typeof VacationChange>,
    req: RequestMeta,
  ): Promise<Vacation> {
    const { address } = await this.#pinned(sessionId, account);
    // Automatic replies, like forwarding, are gated on the mailbox's trust tier.
    if (input.vacation.enabled && sendingTier(address) === "restricted") {
      throw new WebmailRefusedError("Automatic replies are paused while sending from this mailbox is paused.");
    }
    const rules = await this.#rules(sessionId);
    const zone = zoneOffset(
      input.timeZone,
      input.vacation.from ? new Date(`${input.vacation.from}T12:00:00Z`) : new Date(),
    );
    await this.d.mail.saveMailRules(sessionId, account, { ...rules, vacation: input.vacation, zone });
    await this.d.settings.recordMailFlow(
      address,
      "vacation.changed",
      {
        enabled: input.vacation.enabled,
        contactsOnly: input.vacation.contactsOnly,
        dated: input.vacation.from !== null || input.vacation.to !== null,
      },
      req,
    );
    return input.vacation;
  }

  async saveJunk(sessionId: string, account: string, junk: z.infer<typeof JunkInput>, req: RequestMeta): Promise<Junk> {
    const { address } = await this.#pinned(sessionId, account);
    const rules = await this.#rules(sessionId);
    await this.d.mail.saveMailRules(sessionId, account, { ...rules, junk });
    await this.d.settings.recordMailFlow(
      address,
      "junk_rules.changed",
      { blocked: junk.blocked.length, safe: junk.safe.length, trustedOnly: junk.trustedOnly },
      req,
    );
    return junk;
  }

  /**
   * Asks the target's owner to confirm (an email with a one-time link). A forwarding rule to another address that is
   * on now is turned off first: only a confirmed target ever receives mail.
   */
  async requestForwarding(
    sessionId: string,
    account: string,
    target: unknown,
    req: RequestMeta,
  ): Promise<{ target: string; emailed: boolean }> {
    const { address } = await this.#pinned(sessionId, account);
    const identities = await this.d.mail.identities(sessionId);
    const rules = await this.#rules(sessionId);
    const out = await this.d.settings.requestForwarding(
      address,
      { target, ownAddresses: identities.map((i) => i.email), tier: sendingTier(address) },
      req,
    );
    if (rules.forwarding.enabled && rules.forwarding.address !== out.target) {
      await this.d.mail.saveMailRules(sessionId, account, {
        ...rules,
        forwarding: { ...rules.forwarding, enabled: false, address: null },
      });
    }
    let emailed = true;
    try {
      await this.d.mailer.send(
        forwardingConfirmEmail({
          to: out.target,
          // Masked in the email (anyone who sees it); the full address shows on the confirm page (reached with the
          // one-time token).
          mailbox: maskEmail(address),
          url: `${this.d.webmailUrl.replace(/\/$/, "")}/forwarding/confirm/${out.token}`,
          hours: FORWARDING_LINK_HOURS,
        }),
      );
    } catch (err) {
      emailed = false;
      log.error("forwarding confirmation email failed", { component: "webmail", err });
    }
    return { target: out.target, emailed };
  }

  /** Turns forwarding to the confirmed target on or off, keeping a copy or not. */
  async setForwarding(
    sessionId: string,
    account: string,
    input: { enabled: boolean; keepCopy: boolean },
    req: RequestMeta,
  ): Promise<MailRules["forwarding"]> {
    const { address } = await this.#pinned(sessionId, account);
    if (input.enabled && sendingTier(address) === "restricted") {
      throw new WebmailRefusedError("Forwarding is paused while sending from this mailbox is paused.");
    }
    const target = await this.d.settings.forwarding(address);
    if (target?.status !== "confirmed") {
      throw new WebmailRefusedError("Forwarding starts once the other address confirms it.");
    }
    const rules = await this.#rules(sessionId);
    const forwarding = { enabled: input.enabled, address: target.address, keepCopy: input.keepCopy };
    await this.d.mail.saveMailRules(sessionId, account, { ...rules, forwarding });
    await this.d.settings.recordMailFlow(
      address,
      "forwarding.changed",
      { enabled: input.enabled, keepCopy: input.keepCopy, forwardTo: maskEmail(target.address) },
      req,
    );
    return forwarding;
  }

  /** Stops forwarding and forgets the target. */
  async removeForwarding(sessionId: string, account: string, req: RequestMeta): Promise<void> {
    const { address } = await this.#pinned(sessionId, account);
    const rules = await this.#rules(sessionId);
    if (rules.forwarding.enabled || rules.forwarding.address !== null) {
      await this.d.mail.saveMailRules(sessionId, account, {
        ...rules,
        forwarding: { enabled: false, address: null, keepCopy: true },
      });
    }
    await this.d.settings.removeForwarding(address, req);
  }
}
