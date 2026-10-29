// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import type { RequestMeta } from "@anhourmail/core";
import { maskEmail } from "@anhourmail/core/audit";
import {
  FORWARDING_LINK_HOURS,
  type ForwardingView,
  type SignatureChange,
  type WebmailSettingsService,
  type WebmailSignaturesService,
} from "@anhourmail/core/webmail";
import { SIGNATURE_HTML_MAX, type SignatureSet } from "@anhourmail/shared/signatures";
import type { WebmailPreferences } from "@anhourmail/shared/webmail";
import { log } from "@anhourmail/server/log";

import { forwardingConfirmEmail } from "../mail/system-email";
import { type Identity, sendingTier } from "./compose";
import { type Junk, type JunkInput, type MailRules, type Vacation, VacationInput, zoneOffset } from "./sieve";
import { type RulesState, WebmailRefusedError, WebmailSignedOutError, type WebmailService } from "./service";
import { cleanSignature, identitySignature, textAsHtml } from "./signature-html";

/**
 * Webmail settings (docs/internal/05-webmail.md "Settings"): the one place that joins the control plane
 * (preferences, forwarding confirmation, audit) with the mail server (identities, quota, the managed Sieve script).
 * Every call is for the session's own active mailbox; changes also take the account the app is showing.
 */

type MailServer = Pick<
  WebmailService,
  | "session"
  | "identities"
  | "quota"
  | "mailRules"
  | "saveMailRules"
  | "updateIdentity"
  | "legacySignature"
  | "mirrorSignature"
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
  })
  .refine((v) => v.name !== undefined, { message: "Nothing to change." });

/** The longest signature request body: the HTML cap plus room for JSON escaping and the name. */
export const MAX_SIGNATURE_BODY = SIGNATURE_HTML_MAX * 2 + 4096;

/** A new signature or a change to one (the HTML is sanitised by `cleanSignature` before anything is stored). */
export const SignatureInput = z.object({
  name: z.string().max(200).optional(),
  html: z
    .string()
    .max(SIGNATURE_HTML_MAX * 2)
    .optional(),
});

const sigId = z.uuid().nullable();
export const SignatureDefaultsInput = z.object({ newMessage: sigId, reply: sigId });

/**
 * A signature change as the browser gets it: the set; whether the mail server's identities took the new default for
 * other mail apps (`mirrored`), and whether they got a shortened copy (`shortened`: the server keeps about 2 KB, so a
 * signature with images goes there without them).
 */
export type SignatureResult = SignatureSet & { mirrored: boolean; shortened: boolean };

export const VacationChange = z.object({ vacation: VacationInput, timeZone: z.string().max(64) });

export class WebmailSettings {
  constructor(
    private readonly d: {
      mail: MailServer;
      settings: WebmailSettingsService;
      signatures: WebmailSignaturesService;
      mailer: Mailer;
      webmailUrl: string;
      /** The deployment's public site host, for the footer of the confirmation email. */
      siteHost: string;
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
    });
    const fields = change.name !== undefined ? ["name"] : [];
    await this.d.settings.recordMailFlow(
      address,
      "identity.changed",
      { fields, identity: maskEmail(updated.email) },
      req,
    );
    return updated;
  }

  // ---- signatures (docs/internal/05-webmail.md "Signatures") ---------------------------------------------------

  /**
   * The mailbox's signatures and defaults. The first time, the signature its addresses had from before named
   * signatures is brought over as "Signature" (the default for both kinds of message), once.
   */
  async signatures(sessionId: string, req: RequestMeta): Promise<SignatureSet> {
    const address = await this.#address(sessionId);
    const list = await this.d.signatures.list(address);
    if (list.started || list.signatures.length > 0) return { signatures: list.signatures, defaults: list.defaults };
    const old = await this.d.mail.legacySignature(sessionId);
    if (!old) return { signatures: list.signatures, defaults: list.defaults };
    // Old signatures were plain text with an escaped HTML twin; another mail app may have written real HTML.
    const source = old.html.trim() !== "" ? old.html : textAsHtml(old.text);
    const clean = cleanSignature(source);
    const content = clean.problem === null && clean.html !== "" ? clean : cleanSignature(textAsHtml(old.text));
    if (content.problem !== null || content.html === "")
      return { signatures: list.signatures, defaults: list.defaults };
    const made = await this.d.signatures.bringOver(address, { html: content.html, text: content.text }, req);
    if (!made) {
      const again = await this.d.signatures.list(address);
      return { signatures: again.signatures, defaults: again.defaults };
    }
    // The identities keep what they had (it is the same signature); nothing to mirror yet.
    return { signatures: made.signatures, defaults: made.defaults };
  }

  /** Mirrors the new default for new messages into the identities when it changed; logs a failure (no content). */
  async #mirror(sessionId: string, account: string, change: SignatureChange): Promise<SignatureResult> {
    const out = { signatures: change.signatures, defaults: change.defaults };
    if (change.mirror === undefined) return { ...out, mirrored: true, shortened: false };
    const copy = identitySignature(change.mirror);
    try {
      const mirrored = await this.d.mail.mirrorSignature(sessionId, account, { html: copy.html, text: copy.text });
      return { ...out, mirrored, shortened: mirrored && !copy.complete };
    } catch (err) {
      if (err instanceof WebmailSignedOutError) throw err;
      log.warn("signature mirror to identities failed", { component: "webmail", err });
      return { ...out, mirrored: false, shortened: false };
    }
  }

  #content(html: string): { html: string; text: string } {
    const clean = cleanSignature(html);
    if (clean.problem !== null) throw new WebmailRefusedError(clean.problem);
    return { html: clean.html, text: clean.text };
  }

  async createSignature(
    sessionId: string,
    account: string,
    input: z.infer<typeof SignatureInput>,
    req: RequestMeta,
  ): Promise<SignatureResult> {
    const { address } = await this.#pinned(sessionId, account);
    const content = this.#content(input.html ?? "");
    const change = await this.d.signatures.create(address, { name: input.name, ...content }, req);
    return this.#mirror(sessionId, account, change);
  }

  async updateSignature(
    sessionId: string,
    account: string,
    id: string,
    input: z.infer<typeof SignatureInput>,
    req: RequestMeta,
  ): Promise<SignatureResult> {
    const { address } = await this.#pinned(sessionId, account);
    const content = input.html === undefined ? {} : this.#content(input.html);
    const change = await this.d.signatures.update(
      address,
      id,
      { ...(input.name !== undefined ? { name: input.name } : {}), ...content },
      req,
    );
    return this.#mirror(sessionId, account, change);
  }

  async removeSignature(sessionId: string, account: string, id: string, req: RequestMeta): Promise<SignatureResult> {
    const { address } = await this.#pinned(sessionId, account);
    return this.#mirror(sessionId, account, await this.d.signatures.remove(address, id, req));
  }

  async setSignatureDefaults(
    sessionId: string,
    account: string,
    defaults: z.infer<typeof SignatureDefaultsInput>,
    req: RequestMeta,
  ): Promise<SignatureResult> {
    const { address } = await this.#pinned(sessionId, account);
    return this.#mirror(sessionId, account, await this.d.signatures.setDefaults(address, defaults, req));
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
          site: this.d.siteHost,
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
