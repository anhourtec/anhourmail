// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { env, senderDelegationKey } from "../env";
import { platform } from "../platform";
import { senderVerified } from "./image-proxy";
import { type AuthSummary, authResults, isInternalMail, trustedAuthservIds } from "./original";

/**
 * Whether a message's From is verified for loading images without asking (`senderVerified` in `image-proxy.ts`): our
 * own Authentication-Results, or our server's internal-mail marker (mail submitted here, which has no results of
 * ours). One place for the message view and the routes that change Safe senders from a message (ADR-0027 §1, §4).
 */

type Headers = Parameters<typeof isInternalMail>[0];

/** The internal-mail marker check, false when the key isn't usable (never thrown into a response). */
function internalMarkerValid(headers: Headers, from: string, trusted: readonly string[]): boolean {
  try {
    return isInternalMail(headers, from, senderDelegationKey(), trusted);
  } catch {
    return false;
  }
}

/** Our results and the internal-mail marker for these headers (`auth` undefined when there are no headers). */
export function senderEvidence(
  headers: Headers | undefined,
  from: string | undefined,
): { auth: AuthSummary | null | undefined; internal: boolean } {
  if (!headers) return { auth: undefined, internal: false };
  const e = env();
  const trusted = trustedAuthservIds(e.MAIL_AUTHSERV_ID, platform().hosts.mx, e.NODE_ENV === "production");
  return {
    auth: authResults(headers, trusted),
    internal: from !== undefined && internalMarkerValid(headers, from, trusted),
  };
}

/** Whether `from` is verified by these headers (callers pass null unless the message has exactly one From address). */
export function fromVerified(headers: Headers | undefined, from: string | null | undefined): boolean {
  if (!from) return false;
  const { auth, internal } = senderEvidence(headers, from);
  return senderVerified(from, auth, internal);
}
