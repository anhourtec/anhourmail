// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the composer says when a send is refused (ADR-0034 §5, ADR-0029 §5): the BFF's message, plus what to do next.
 * For a held send (`sending_held`, a new account and a recipient outside the addresses we host) it names the recipients
 * that look outside, worked out here from the draft and the domains this app knows we host: the server never echoes
 * recipients back (rule 24), and only knows which ones it refused, not why each.
 */
import { SUPPORT_EMAIL } from "@anhourmail/shared/platform";

import { RefusedError, SignedOutError, UnavailableError } from "./mail-client";

export type SendProblem = {
  message: string;
  /** Recipients of a held send that look outside AnhourMail (lowercase, in the draft's order). */
  outside?: string[];
  /** Link the public "New accounts" section. */
  learnMore?: boolean;
  /** Where to appeal a paused mailbox. */
  appeal?: string;
};

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/**
 * The recipients whose domain isn't one the app knows we host: the platform's own domains and the domains of the
 * addresses this person sends from (their mailbox, aliases and shared mailboxes). Another customer's domain isn't
 * known here, so it may be listed too; the server's check is the one that counts.
 */
export function outsideRecipients(recipients: readonly string[], hosted: readonly string[]): string[] {
  const ours = new Set(hosted.map((d) => d.trim().toLowerCase()).filter((d) => d !== ""));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of recipients) {
    const a = r.trim().toLowerCase();
    if (a === "" || seen.has(a)) continue;
    seen.add(a);
    if (!ours.has(domainOf(a))) out.push(a);
  }
  return out;
}

/** The domains of the addresses the person sends from, for `outsideRecipients`. */
export const domainsOf = (addresses: readonly string[]) => addresses.map(domainOf);

/**
 * The composer's message for a failed send. `recipients` are the draft's To, Cc and Bcc; `hosted` the domains the app
 * knows we host. A signed-out session isn't a send problem (the caller lets it through).
 */
export function sendProblem(err: unknown, recipients: readonly string[], hosted: readonly string[]): SendProblem {
  if (err instanceof SignedOutError) throw err;
  if (err instanceof UnavailableError) {
    return {
      message: "Sending isn't available right now, so nothing was sent. Your draft is saved: try again in a moment.",
    };
  }
  if (!(err instanceof RefusedError)) return { message: "Couldn't send. Check your connection and try again." };
  switch (err.code) {
    case "sending_held": {
      const outside = outsideRecipients(recipients, hosted);
      return { message: err.message, ...(outside.length > 0 ? { outside } : {}), learnMore: true };
    }
    case "sending_paused":
      return { message: err.message, appeal: SUPPORT_EMAIL };
    case "sending_limit":
      return { message: `${err.message} Your draft is saved.` };
    default:
      return { message: err.message };
  }
}
