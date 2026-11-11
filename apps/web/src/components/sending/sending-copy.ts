// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the Sending cards say (console Account overview, webmail Settings → Account; ADR-0034 §5): the tier's label, its
 * published limits and, for a held or paused tier, what that means in plain words. Never a threshold, a date, who set
 * it or a staff note (rule 33): only the published facts in `TRUST_TIERS` and the reason category in plain words.
 */
import { SUPPORT_EMAIL } from "@anhourmail/shared/platform";
import { type SendLimits, TRUST_TIERS, type TrustTier } from "@anhourmail/shared/sending";

/** The public docs section that explains the new-account hold (docs/public/sending-limits.mdx "New accounts"). */
export const NEW_ACCOUNTS_DOCS_PATH = "/docs/sending-limits#new-accounts";

export type SendingTone = "success" | "info" | "warning" | "danger";

export const TIER_TONE: Readonly<Record<TrustTier, SendingTone>> = {
  new: "info",
  standard: "success",
  trusted: "success",
  restricted: "danger",
};

/** The published limits as label and value pairs, in the order the docs' table uses. */
export function limitRows(limits: SendLimits): { label: string; value: number }[] {
  return [
    { label: "Per day", value: limits.messagesPerDay },
    { label: "Per hour", value: limits.messagesPerHour },
    { label: "Recipients per message", value: limits.recipientsPerMessage },
  ];
}

export type SendingCopy = {
  label: string;
  tone: SendingTone;
  /** One line under the label: what the tier allows. */
  summary: string;
  /** Extra lines (held, mail apps, paused forwarding), each a sentence or two. */
  notes: string[];
  /** Show the published limits (not while sending is paused: they're all zero). */
  showLimits: boolean;
  /** Link the public "New accounts" section. */
  linkNewAccounts: boolean;
  /** Where to appeal, while restricted. */
  appeal: string | null;
};

/**
 * The card's words for a tier. `subject` is who the card is about: the account (console) or the open mailbox
 * (webmail, whose tier also counts a restriction of that mailbox alone). `reason` is the restriction's category in
 * plain words, when the reader may see it. `settings` adds what the tier pauses in the mailbox's own settings
 * (forwarding and automatic replies), for the webmail.
 */
export function sendingCopy(
  tier: TrustTier,
  opts: { subject: "account" | "mailbox"; reason?: string | null; settings?: boolean },
): SendingCopy {
  const info = TRUST_TIERS[tier];
  const yours = opts.subject === "account" ? "your account" : "this mailbox";
  const base = { label: info.label, tone: TIER_TONE[tier], appeal: null, linkNewAccounts: false, showLimits: true };
  switch (tier) {
    case "new":
      return {
        ...base,
        linkNewAccounts: true,
        summary:
          "You can send to addresses hosted on AnhourMail. Sending to addresses outside AnhourMail opens automatically once your account is established.",
        notes: [
          "Mail apps can't send yet. They read your mail as usual, and sending from them opens at the same time.",
          ...(opts.settings
            ? ["Forwarding to an address outside AnhourMail waits until then too. Automatic replies keep working."]
            : []),
        ],
      };
    case "restricted":
      return {
        ...base,
        showLimits: false,
        summary: `Sending from ${yours} is paused while we review unusual activity. Receiving and reading mail keep working.`,
        notes: [
          ...(opts.reason ? [`Reason: ${opts.reason}.`] : []),
          ...(opts.settings ? ["Forwarding and automatic replies are paused too."] : []),
        ],
        appeal: SUPPORT_EMAIL,
      };
    case "standard":
    case "trusted":
      return {
        ...base,
        summary: "Send to anyone, from the webmail and from mail apps, within these limits.",
        notes: [],
      };
  }
}
