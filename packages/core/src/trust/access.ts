// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What a mailbox may do on the mail server (ADR-0034 §4), from everything that can limit it. `mailbox.ensure` applies
 * the result and the reconciler compares it with the server. The most restrictive source wins:
 *
 *   staff suspension or deletion (`suspended`) > billing (`send_blocked`; a receive-blocked hold is applied as
 *   send-blocked, ADR-0029) > effective tier `restricted`, i.e. the account's tier or a mailbox restriction
 *   (`send_blocked`) > effective tier `new` (`smtp_blocked`: no SMTP submission from mail apps, webmail sending kept)
 *   > `active` (`standard`, `trusted`).
 *
 * On top of the access state, a mailbox whose effective tier is `new` or `restricted` is on the mail server's relay
 * hold (`mailboxRelayHold`): it may send only to addresses the server hosts, on every authenticated path. For `new`
 * that is what closes JMAP submission to outside addresses (`smtp_blocked` leaves JMAP open for the webmail); for
 * `restricted` it is defence in depth behind `send_blocked`.
 *
 * Pure: no I/O. Webmail limits per tier are applied separately by the BFF (`TRUST_TIERS`).
 */
import type { TrustTier } from "@anhourmail/shared/sending";

import type { BillingMailboxAccess } from "../billing/lifecycle";

import { effectiveTier } from "./entity";

/** Least to most restrictive. `smtp_blocked` and `send_blocked` keep sign-in, reading and delivery. */
export const MAILBOX_SEND_ACCESS = ["active", "smtp_blocked", "send_blocked", "suspended"] as const;
export type MailboxSendAccess = (typeof MAILBOX_SEND_ACCESS)[number];

export type MailboxSendAccessInput = {
  /** Off entirely: suspended (by staff, a hold or the account itself) or being deleted. */
  suspended: boolean;
  /** What billing allows (`billingMailboxAccess`). */
  billing: BillingMailboxAccess;
  accountTier: TrustTier;
  /** Staff restricted this mailbox's sending (ADR-0034 §6). */
  mailboxRestricted: boolean;
};

/** The stricter of two access states. */
export const stricterAccess = (a: MailboxSendAccess, b: MailboxSendAccess): MailboxSendAccess =>
  MAILBOX_SEND_ACCESS.indexOf(a) >= MAILBOX_SEND_ACCESS.indexOf(b) ? a : b;

const TIER_ACCESS: Readonly<Record<TrustTier, MailboxSendAccess>> = {
  restricted: "send_blocked",
  new: "smtp_blocked",
  standard: "active",
  trusted: "active",
};

/** Whether the mailbox belongs on the mail server's relay hold: its effective tier doesn't allow outside recipients. */
export function mailboxRelayHold(accountTier: TrustTier, mailboxRestricted: boolean): boolean {
  const tier = effectiveTier(accountTier, mailboxRestricted);
  return tier === "new" || tier === "restricted";
}

/** The access to apply on the mail server for a mailbox with these limits. */
export function mailboxSendAccess(input: MailboxSendAccessInput): MailboxSendAccess {
  const fromSuspension: MailboxSendAccess = input.suspended ? "suspended" : "active";
  const fromBilling: MailboxSendAccess = input.billing === "active" ? "active" : "send_blocked";
  const fromTier = TIER_ACCESS[effectiveTier(input.accountTier, input.mailboxRestricted)];
  return stricterAccess(fromSuspension, stricterAccess(fromBilling, fromTier));
}
