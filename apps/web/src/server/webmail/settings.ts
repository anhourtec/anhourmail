// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { NotFoundError, type RequestMeta } from "@anhourmail/core";
import { maskEmail } from "@anhourmail/core/audit";
import type { WebmailSenderName } from "@anhourmail/core/people";
import {
  FORWARDING_LINK_HOURS,
  type ForwardingView,
  type SignatureChange,
  type WebmailSettingsService,
  type WebmailSignaturesService,
  type WebmailTemplatesService,
} from "@anhourmail/core/webmail";
import { MAIL_RULES, type MailRule, MailRuleList } from "@anhourmail/shared/mail-rules";
import { fromAddress, matchSafeSender, MAX_SENDER_ENTRIES, type SafeSenderMatch } from "@anhourmail/shared/senders";
import { SIGNATURE_HTML_MAX, type SignatureSet } from "@anhourmail/shared/signatures";
import { TEMPLATE_HTML_MAX, type TemplateView } from "@anhourmail/shared/templates";
import type { WebmailPreferences } from "@anhourmail/shared/webmail";
import { log } from "@anhourmail/server/log";

import { forwardingConfirmEmail } from "../mail/system-email";
import type { Identity } from "./compose";
import { type Junk, JunkInput, type MailRules, type Vacation, VacationInput, zoneOffset } from "./sieve";
import {
  ownMailbox,
  type RulesState,
  WebmailConflictError,
  WebmailRefusedError,
  WebmailSenderBlockedError,
  WebmailSignedOutError,
  type WebmailService,
} from "./service";
import { cleanSignature, identitySignature, textAsHtml } from "./signature-html";
import { cleanTemplate } from "./template-html";
import { isJmapId } from "./view";
import type { DisposableEmailCheck } from "@anhourmail/core/security";
import { externalHeld, SendingHeldError } from "@anhourmail/core/trust";
import type { TrustTier } from "@anhourmail/shared/sending";

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
  | "refreshIdentities"
  | "legacySignature"
  | "mirrorSignature"
  | "folderPaths"
  | "sendingTier"
  | "outsideOf"
>;
type Mailer = { send(message: ReturnType<typeof forwardingConfirmEmail>): Promise<void> };

/**
 * A message's From in the person's own active mailbox and whether it is verified (`sender-check.ts`), read with the
 * session's token; null when the session can't see that message.
 */
type MessageSender = (sessionId: string, emailId: string) => Promise<{ from: string | null; verified: boolean } | null>;

/** "Always for <sender>" adds the From's address; "Stop loading" removes whichever entry it matched. */
export type SafeSenderChange = "add" | "remove";

/** What a Safe senders change from a message answers: the entry the From matches now (null: none). */
export type SafeSenderResult = { safeSender: SafeSenderMatch | null; changed: boolean };

/** `POST|DELETE /api/webmail/settings/junk/safe`: the message, never an address (the server reads its From). */
export const SafeSenderInput = z.object({ emailId: z.string().max(255).refine(isJmapId) }).strict();

export const SAFE_SENDER_UNVERIFIED =
  "Images from this sender can't be remembered because we couldn't confirm who sent it.";
export const SAFE_SENDERS_FULL = "Your Safe senders list is full. Remove some entries in Settings first.";
const SETTINGS_CHANGED = "Your settings changed in another window. Try again.";

/** The mailbox's sender name (core `WebmailSenderName`): the one source, and whether the webmail may change it. */
export type SenderNameView = WebmailSenderName;

/** The control plane's sender names (core `webmailSenderName` / `setWebmailSenderName`). */
type SenderNames = {
  get(address: string): Promise<WebmailSenderName | null>;
  set(address: string, input: { name: string }, req: RequestMeta): Promise<WebmailSenderName>;
};

export type SettingsOverview = {
  accountId: string;
  address: string;
  /** The sender name on mail from this mailbox; null for an address the control plane doesn't hold. */
  sender: SenderNameView | null;
  preferences: WebmailPreferences;
  identities: Identity[];
  quota: { used: number; limit: number | null };
  rules: { vacation: Vacation; junk: Junk; forwarding: MailRules["forwarding"] };
  /** The account's Safe senders (ADR-0032 §1), shown read-only beside the mailbox's own. */
  accountSafe: string[];
  rulesState: RulesState;
  /** The forwarding target and whether its owner confirmed it (control plane). */
  forwardingTarget: ForwardingView | null;
  /**
   * The mailbox's effective sending tier now (its account's, `restricted` while the mailbox itself is restricted;
   * ADR-0034 §5) for the Account card; null when it couldn't be read. Only the tier: the card shows its published facts.
   */
  sending: { tier: TrustTier } | null;
};

/** A sender name: one line, no characters that change how it's read in a header (the service checks the rest). */
export const SenderNameChange = z
  .object({
    name: z
      .string()
      .max(200)
      .transform((s) =>
        s
          .replace(/[\p{Cc}"<>]/gu, " ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
  })
  .strict();

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

/** The longest template request body: the HTML cap plus room for JSON escaping and the name. */
export const MAX_TEMPLATE_BODY = TEMPLATE_HTML_MAX * 2 + 4096;

/** A new template or a change to one (the HTML is sanitised by `cleanTemplate` before anything is stored). */
export const TemplateInput = z
  .object({
    name: z.string().max(400).optional(),
    html: z
      .string()
      .max(TEMPLATE_HTML_MAX * 2)
      .optional(),
  })
  .strict();

export const VacationChange = z.object({ vacation: VacationInput, timeZone: z.string().max(64) });

/** `PUT /api/webmail/settings/rules`: the whole ordered list, against the version it was read at (ADR-0032 §2). */
export const RulesChange = z
  .object({
    rules: z.array(z.record(z.string(), z.unknown())).max(MAIL_RULES.maxRules),
    version: z.string().max(512).nullable(),
  })
  .strict();

/** Mail rules as Settings shows them: the list, the version to save against, folders and the forwarding target. */
export type RulesView = {
  rules: MailRule[];
  /** The rules version read (null: no rules script yet). Saving answers 409 if it changed meanwhile. */
  version: string | null;
  /** The mailbox's folders with their current paths (a rule whose folder moved shows a warning). */
  folders: { id: string; path: string }[];
  /** The confirmed forwarding address a rule's "forward" sends to, or null (rules can't forward then). */
  forwardTo: string | null;
  rulesState: RulesState;
};

/** The mail server's namespace for folders other accounts share (Stalwart's default name). */
export const SHARED_FOLDERS_PREFIX = "Shared Folders";

/**
 * Whether a rule's folder path is one of the person's own folders: not under the shared-folders namespace, and every
 * level of it ("A", "A/B", "A/B/C") is itself one of their folders, so a "/" inside a folder name can't make the
 * path name another folder.
 */
export function ownFolderPath(path: string, own: ReadonlySet<string>): boolean {
  const parts = path.split("/");
  const first = parts[0] ?? "";
  if (first.trim().toLowerCase() === SHARED_FOLDERS_PREFIX.toLowerCase() || parts.some((p) => p === "")) return false;
  return parts.every((_, i) => own.has(parts.slice(0, i + 1).join("/")));
}

const FORWARDING_PAUSED = "Forwarding is paused while sending from this mailbox is paused.";

export const RULES_CHANGED = "Your rules changed in another window. Reload them and try again.";
export const RULE_FORWARD_UNCONFIRMED =
  "A rule can forward only to your confirmed forwarding address. Set one up in Forwarding first.";

export class WebmailSettings {
  constructor(
    private readonly d: {
      mail: MailServer;
      settings: WebmailSettingsService;
      signatures: WebmailSignaturesService;
      /** Templates (canned replies, ADR-0032 §3); absent where a caller doesn't use them. */
      templates?: WebmailTemplatesService;
      senderNames: SenderNames;
      mailer: Mailer;
      /** Reads a message's From for Safe senders changes made from it. */
      messageSender: MessageSender;
      /** The account-wide Safe senders for a mailbox, by its address (ADR-0032 §1); absent: none. */
      accountSafe?: (address: string) => Promise<readonly string[]>;
      webmailUrl: string;
      /** The deployment's public site host, for the footer of the confirmation email. */
      siteHost: string;
      /** Temporary-inbox forwarding targets are refused (ADR-0033); absent: no check. */
      disposable?: DisposableEmailCheck;
    },
  ) {}

  async #address(sessionId: string): Promise<string> {
    // The person's own mailbox only, decided on this one read (a mailbox shared with them never, ADR-0026 §6).
    const s = ownMailbox(await this.d.mail.session(sessionId));
    return s.username;
  }

  /**
   * The session's mailbox, read once, with the account-pin check first (before any control-plane or mail-server
   * lookup). Every writer uses this so a mailbox switched in another tab can't aim a change at the wrong account.
   */
  async #pinned(sessionId: string, account: string): Promise<{ address: string; accountId: string }> {
    // The person's own mailbox only, decided on this one read (a mailbox shared with them never, ADR-0026 §6).
    const s = ownMailbox(await this.d.mail.session(sessionId));
    if (s.accountId !== account) throw new WebmailRefusedError("Your active mailbox changed. Try again.");
    return { address: s.username, accountId: s.accountId };
  }

  async overview(sessionId: string): Promise<SettingsOverview> {
    const address = await this.#address(sessionId);
    const [preferences, identities, quota, rules, forwardingTarget, sender, accountSafe, sending] = await Promise.all([
      this.d.settings.preferences(address),
      this.d.mail.identities(sessionId),
      this.d.mail.quota(sessionId),
      this.d.mail.mailRules(sessionId),
      this.d.settings.forwarding(address),
      this.d.senderNames.get(address),
      this.d.accountSafe?.(address) ?? Promise.resolve([]),
      // A failed read shows the card as unavailable rather than failing the whole window (sending still checks it).
      this.d.mail.sendingTier(address).then(
        (tier) => ({ tier }),
        () => null,
      ),
    ]);
    return {
      accountId: rules.accountId,
      address,
      sender,
      preferences,
      identities,
      quota,
      rules: { vacation: rules.rules.vacation, junk: rules.rules.junk, forwarding: rules.rules.forwarding },
      accountSafe: [...accountSafe],
      rulesState: rules.state,
      forwardingTarget,
      sending,
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
    // The person's own mailbox only, decided on this one read (a mailbox shared with them never, ADR-0026 §6).
    const s = ownMailbox(await this.d.mail.session(sessionId));
    if (s.accountId !== account) throw new WebmailRefusedError("Your active mailbox changed. Try again.");
    return this.d.settings.updatePreferences(s.username, patch, req);
  }

  /**
   * "Sender name": changes the one source (core `setWebmailSenderName`: the mailbox person's name, audited as their
   * profile change), then renames the mailbox's identities on the mail server with the session's token right away.
   * Refused (403) when an admin set the mailbox's name, or the person is in another account too.
   */
  async updateSenderName(
    sessionId: string,
    account: string,
    change: z.infer<typeof SenderNameChange>,
    req: RequestMeta,
  ): Promise<{ sender: SenderNameView; identities: Identity[] }> {
    const { address } = await this.#pinned(sessionId, account);
    const sender = await this.d.senderNames.set(address, { name: change.name }, req);
    const identities = await this.d.mail.refreshIdentities(sessionId, account);
    return { sender, identities };
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

  // ---- templates (canned replies, ADR-0032 §3) ----------------------------------------------------------------

  #templatesService(): WebmailTemplatesService {
    if (!this.d.templates) throw new Error("templates are not configured");
    return this.d.templates;
  }

  #template(html: string): { html: string; text: string } {
    const clean = cleanTemplate(html);
    if (clean.problem !== null) throw new WebmailRefusedError(clean.problem);
    return { html: clean.html, text: clean.text };
  }

  async templates(sessionId: string): Promise<TemplateView[]> {
    return this.#templatesService().list(await this.#address(sessionId));
  }

  async createTemplate(
    sessionId: string,
    account: string,
    input: z.infer<typeof TemplateInput>,
    req: RequestMeta,
  ): Promise<TemplateView[]> {
    const { address } = await this.#pinned(sessionId, account);
    const content = this.#template(input.html ?? "");
    return this.#templatesService().create(address, { name: input.name, ...content }, req);
  }

  async updateTemplate(
    sessionId: string,
    account: string,
    id: string,
    input: z.infer<typeof TemplateInput>,
    req: RequestMeta,
  ): Promise<TemplateView[]> {
    const { address } = await this.#pinned(sessionId, account);
    const content = input.html === undefined ? {} : this.#template(input.html);
    return this.#templatesService().update(
      address,
      id,
      { ...(input.name !== undefined ? { name: input.name } : {}), ...content },
      req,
    );
  }

  async removeTemplate(sessionId: string, account: string, id: string, req: RequestMeta): Promise<TemplateView[]> {
    const { address } = await this.#pinned(sessionId, account);
    return this.#templatesService().remove(address, id, req);
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
    // Automatic replies are paused only while the mailbox's trust tier is `restricted` (the external hold of a `new`
    // tier keeps them: one reply per sender per period, to people who wrote first; ADR-0034 §3).
    if (input.vacation.enabled && (await this.d.mail.sendingTier(address)) === "restricted") {
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

  /** The current rules and the version they were read at (for a compare-and-swap write). */
  async #rulesAt(sessionId: string): Promise<{ rules: Omit<MailRules, "include">; at: { ifInState?: string | null } }> {
    const { rules, version } = await this.d.mail.mailRules(sessionId);
    const { include: _include, ...rest } = rules;
    return { rules: rest, at: version === undefined ? {} : { ifInState: version } };
  }

  async saveJunk(sessionId: string, account: string, junk: z.infer<typeof JunkInput>, req: RequestMeta): Promise<Junk> {
    const { address } = await this.#pinned(sessionId, account);
    // On the version just read: a change saved meanwhile (another window, "Always for" in the reader) isn't lost
    // silently — this save answers 409 and the person tries again on what is there now.
    const { rules, at } = await this.#rulesAt(sessionId);
    await this.d.mail.saveMailRules(sessionId, account, { ...rules, junk }, at);
    await this.#auditJunk(address, junk, { via: "settings" }, req);
    return junk;
  }

  // ---- mail rules (ADR-0032 §2) ------------------------------------------------------------------------------

  /**
   * Whether the mailbox's trust tier lets it forward to `target` now (ADR-0034 §3): `paused` while `restricted`,
   * `held` while `new` and the target is outside the addresses we host, else null. A billing send-block keeps
   * forwarding on (ADR-0029 SA60-03).
   */
  async #forwardBlock(address: string, target: string): Promise<"paused" | "held" | null> {
    const tier = await this.d.mail.sendingTier(address);
    if (tier === "restricted") return "paused";
    if (externalHeld(tier) && (await this.d.mail.outsideOf([target])).length > 0) return "held";
    return null;
  }

  /**
   * Where a rule's forward would go: the confirmed forwarding address, or null without one or while the mailbox's trust
   * tier doesn't let it forward there (the same check as Forwarding).
   */
  async #forwardTo(address: string): Promise<string | null> {
    const f = await this.d.settings.forwarding(address);
    if (f?.status !== "confirmed") return null;
    return (await this.#forwardBlock(address, f.address)) === null ? f.address : null;
  }

  async rules(sessionId: string): Promise<RulesView> {
    const s = ownMailbox(await this.d.mail.session(sessionId));
    const [current, paths, forwardTo] = await Promise.all([
      this.d.mail.mailRules(sessionId),
      this.d.mail.folderPaths(sessionId, s.accountId),
      this.#forwardTo(s.username),
    ]);
    return {
      rules: current.rules.filters,
      version: current.version ?? null,
      folders: [...paths].map(([id, path]) => ({ id, path })).sort((a, b) => a.path.localeCompare(b.path)),
      forwardTo,
      rulesState: current.state,
    };
  }

  /**
   * Saves the whole ordered list of rules (ADR-0032 §2) against the version the browser read: a change made meanwhile
   * answers 409 rather than being lost. New rules get ids here; each move's folder path is resolved now from its id
   * with the session's token; a forward needs the confirmed forwarding address (the rule holds no address). Audited
   * `sieve.changed` with counts only — never a name, a value or a folder (rule 48).
   */
  async saveRules(
    sessionId: string,
    account: string,
    input: z.infer<typeof RulesChange>,
    req: RequestMeta,
  ): Promise<RulesView> {
    const { address } = await this.#pinned(sessionId, account);
    const seen = new Set<string>();
    const withIds = input.rules.map((r) => {
      const id = typeof r.id === "string" && !seen.has(r.id) ? r.id : randomUUID();
      seen.add(id);
      return { ...r, id };
    });
    // Never `parse`: its error would carry a value into the logs (rule 24). Our messages name no value.
    const parsed = MailRuleList.safeParse(withIds);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WebmailRefusedError(
        issue?.code === "custom" || issue?.code === "too_small" ? issue.message : "One of these rules can't be saved.",
      );
    }
    const paths = await this.d.mail.folderPaths(sessionId, account);
    const own = new Set(paths.values());
    const filters: MailRule[] = [];
    for (const rule of parsed.data) {
      const move = rule.actions.move;
      if (move?.kind === "folder") {
        const path = paths.get(move.folderId);
        if (path === undefined) {
          throw new WebmailRefusedError("A rule moves mail to a folder that no longer exists. Choose another folder.");
        }
        // Only a path made of the person's own folders, level by level, and never one under the mail server's shared
        // folders prefix (security review run-63, SA-63-02): a folder name with "/" in it can't point elsewhere.
        if (!ownFolderPath(path, own)) {
          throw new WebmailRefusedError("A rule can only move mail to one of your own folders. Choose another folder.");
        }
        filters.push({ ...rule, actions: { ...rule.actions, move: { ...move, path } } });
      } else filters.push(rule);
    }
    const forwarding = filters.filter((f) => f.enabled && f.actions.forward).length;
    if (forwarding > 0) {
      const f = await this.d.settings.forwarding(address);
      if (f?.status !== "confirmed") throw new WebmailRefusedError(RULE_FORWARD_UNCONFIRMED);
      const block = await this.#forwardBlock(address, f.address);
      if (block === "paused") throw new WebmailRefusedError(FORWARDING_PAUSED);
      // 422 `sending_held`: a new account's rules forward only to addresses we host (ADR-0034 §3).
      if (block === "held") throw new SendingHeldError();
    }
    const { rules, at } = await this.#rulesAt(sessionId);
    const now = at.ifInState === undefined ? undefined : at.ifInState;
    if (now !== undefined && now !== input.version) throw new WebmailConflictError(RULES_CHANGED);
    try {
      await this.d.mail.saveMailRules(sessionId, account, { ...rules, filters }, at);
    } catch (err) {
      if (err instanceof WebmailConflictError) throw new WebmailConflictError(RULES_CHANGED);
      throw err;
    }
    try {
      await this.d.settings.recordMailFlow(
        address,
        "sieve.changed",
        {
          rules: filters.length,
          enabled: filters.filter((f) => f.enabled).length,
          forwarding,
          moving: filters.filter((f) => f.enabled && f.actions.move !== null).length,
        },
        req,
      );
    } catch (err) {
      // Written on the mail server first (outside our transaction), audited right after, as junk rules are.
      log.error("mail rules change not audited", {
        component: "webmail",
        error: err instanceof Error ? err.name : "unknown",
      });
    }
    return this.rules(sessionId);
  }

  /** `junk_rules.changed`, counts and kinds only — never an address or a domain (rule 48). */
  async #auditJunk(address: string, junk: Junk, extra: Record<string, string>, req: RequestMeta): Promise<void> {
    const meta = { ...extra, blocked: junk.blocked.length, safe: junk.safe.length, trustedOnly: junk.trustedOnly };
    // The script lives on the mail server, outside our transaction: written first, audited right after (ADR-0027 §7).
    // A failed audit after a successful write is logged at error level; the change itself stands.
    try {
      await this.d.settings.recordMailFlow(address, "junk_rules.changed", meta, req);
    } catch (err) {
      log.error("junk rules change not audited", {
        component: "webmail",
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  /**
   * "Always for <sender>" / "Stop loading" from a message (ADR-0027 §4): reads that message's From with the session's
   * token (never an address from the browser), re-checks it is verified, and applies one change to Safe senders —
   * add the address, or remove whichever entry it matched (its address, or its domain). Own mailbox only. A change
   * that is already true (the address already covered, nothing to remove) succeeds without a write. On a concurrent
   * change the delta is applied once more on what is there now, then 409.
   */
  async changeSafeSender(
    sessionId: string,
    account: string,
    emailId: string,
    change: SafeSenderChange,
    req: RequestMeta,
  ): Promise<SafeSenderResult> {
    const { address } = await this.#pinned(sessionId, account);
    const sender = await this.d.messageSender(sessionId, emailId);
    if (!sender) throw new NotFoundError();
    // The From in the form verification checked (ASCII domain, nothing mapped): what is added is what was verified.
    const from = sender.from === null ? null : fromAddress(sender.from);
    if (!sender.verified || !from?.includes("@")) {
      throw new WebmailRefusedError(SAFE_SENDER_UNVERIFIED);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const { rules, at } = await this.#rulesAt(sessionId);
      const safe = rules.junk.safe;
      const matched = matchSafeSender(from, safe);
      let next: string[];
      let kind: SafeSenderMatch["kind"];
      if (change === "add") {
        if (matched) return { safeSender: matched, changed: false };
        if (matchSafeSender(from, rules.junk.blocked)) {
          throw new WebmailSenderBlockedError(`${from} is on your blocked list. Remove it there first.`);
        }
        if (safe.length >= MAX_SENDER_ENTRIES) throw new WebmailRefusedError(SAFE_SENDERS_FULL);
        next = [...safe, from];
        kind = "address";
      } else {
        if (!matched) return { safeSender: null, changed: false };
        next = safe.filter((e) => e !== matched.value);
        kind = matched.kind;
      }
      // Never `parse`: its error would carry an entry into the logs (rule 24).
      const parsed = JunkInput.safeParse({ ...rules.junk, safe: next });
      if (!parsed.success) throw new WebmailRefusedError(SAFE_SENDER_UNVERIFIED);
      const junk = parsed.data;
      try {
        await this.d.mail.saveMailRules(sessionId, account, { ...rules, junk }, at);
      } catch (err) {
        if (err instanceof WebmailConflictError && attempt === 0) continue;
        if (err instanceof WebmailConflictError) throw new WebmailConflictError(SETTINGS_CHANGED);
        throw err;
      }
      await this.#auditJunk(
        address,
        junk,
        { via: "message", change: change === "add" ? "added" : "removed", kind },
        req,
      );
      return { safeSender: change === "add" ? { kind: "address", value: from } : null, changed: true };
    }
    throw new WebmailConflictError(SETTINGS_CHANGED);
  }

  /**
   * A Safe senders change tried in a tab of a mailbox shared with the person (ADR-0026 §6, ADR-0027 §8): the route
   * answers 403 `own_mailbox_only`; this records the refusal (`denied`) with the person — the mailbox they signed in
   * with — as the actor, in the shared mailbox's account log. Best effort: never throws.
   */
  async refusedInSharedMailbox(sessionId: string, req: RequestMeta): Promise<void> {
    try {
      // `session()` checks the delegation grant again now (the gate's own-only refusal didn't): with the grant gone it
      // throws, and nothing is written into the shared mailbox's account log — the answer stays 403.
      const s = await this.d.mail.session(sessionId);
      if (!s?.delegated) return;
      await this.d.settings.recordMailFlowDenied(
        s.delegated.via,
        s.username,
        "junk_rules.changed",
        "own_mailbox_only",
        { via: "message" },
        req,
      );
    } catch (err) {
      log.warn("shared mailbox refusal not audited", {
        component: "webmail",
        error: err instanceof Error ? err.name : "unknown",
      });
    }
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
    const out = await this.d.settings.requestForwarding(
      address,
      {
        target,
        ownAddresses: identities.map((i) => i.email),
        tier: await this.d.mail.sendingTier(address),
        ...(this.d.disposable ? { disposable: this.d.disposable } : {}),
      },
      req,
    );
    // The old target is no longer confirmed: rewrite the script whenever it has a redirect (Forwarding, or a rule that
    // forwards, ADR-0032 §2), from a read taken now and written on that read's version, so a rules save racing this
    // request can't leave a redirect to the old target behind (security review run-63, SA-63-03). On a conflict the
    // rewrite runs once more on what is there then.
    for (let attempt = 0; ; attempt++) {
      const { rules, at } = await this.#rulesAt(sessionId);
      const ruleForwards = rules.filters.some((f) => f.enabled && f.actions.forward);
      if (!rules.forwarding.enabled && rules.forwarding.address === null && !ruleForwards) break;
      try {
        await this.d.mail.saveMailRules(
          sessionId,
          account,
          {
            ...rules,
            forwarding:
              rules.forwarding.address !== out.target
                ? { ...rules.forwarding, enabled: false, address: null }
                : rules.forwarding,
          },
          at,
        );
        break;
      } catch (err) {
        if (err instanceof WebmailConflictError && attempt === 0) continue;
        throw err;
      }
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
    if (input.enabled && (await this.d.mail.sendingTier(address)) === "restricted") {
      throw new WebmailRefusedError(FORWARDING_PAUSED);
    }
    const target = await this.d.settings.forwarding(address);
    if (target?.status !== "confirmed") {
      throw new WebmailRefusedError("Forwarding starts once the other address confirms it.");
    }
    // 422 `sending_held`: a new account forwards only to addresses we host (ADR-0034 §3).
    if (input.enabled && (await this.#forwardBlock(address, target.address)) === "held") throw new SendingHeldError();
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
    const ruleForwards = rules.filters.some((f) => f.enabled && f.actions.forward);
    if (rules.forwarding.enabled || rules.forwarding.address !== null || ruleForwards) {
      // No redirect to the target being removed, from Forwarding or from a rule (ADR-0032 §2).
      await this.d.mail.saveMailRules(
        sessionId,
        account,
        { ...rules, forwarding: { enabled: false, address: null, keepCopy: true } },
        { dropForwardTarget: true },
      );
    }
    await this.d.settings.removeForwarding(address, req);
    if (rules.forwarding.enabled || rules.forwarding.address !== null || ruleForwards) {
      // Once more now that the target is gone, on a fresh read: a rules save that started before the removal and wrote
      // after the rewrite above is replaced (security review run-63, SA-63-03); on a conflict, once more on what is
      // there then.
      for (let attempt = 0; ; attempt++) {
        const now = await this.#rulesAt(sessionId);
        try {
          await this.d.mail.saveMailRules(sessionId, account, now.rules, { ...now.at, dropForwardTarget: true });
          break;
        } catch (err) {
          if (err instanceof WebmailConflictError && attempt === 0) continue;
          throw err;
        }
      }
    }
  }
}
