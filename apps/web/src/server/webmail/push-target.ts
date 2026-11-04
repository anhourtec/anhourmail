// SPDX-License-Identifier: AGPL-3.0-only
import { PinnedMailboxMissingError, withPinnedMailbox } from "./pin";
import type { PushHubDeps, PushTargetResult } from "./push-hub";
import {
  WebmailBlockedError,
  WebmailDelegationRefusedError,
  WebmailOwnMailboxOnlyError,
  type WebmailService,
  WebmailSignedOutError,
} from "./service";

/**
 * The push hub's `target` (`./push-hub`): what the session says now, with the BFF's errors read as the hub's outcomes.
 * Always read **unpinned**: the hub's timers are created inside the request that opened the channel, and would
 * otherwise carry that request's pin (`./pin`) into every later check — the session's real active mailbox decides.
 * A pin naming a mailbox no longer in the session counts as `moved` (the channel ends), never as "can't tell".
 */
export function pushTargetFrom(svc: () => Pick<WebmailService, "pushTarget">): PushHubDeps["target"] {
  return (sessionId, opts) =>
    withPinnedMailbox(null, async (): Promise<PushTargetResult> => {
      try {
        const target = await svc().pushTarget(sessionId, { connect: opts.connect });
        return target ? { kind: "ok", target } : { kind: "signedout" };
      } catch (err) {
        if (err instanceof WebmailSignedOutError || err instanceof WebmailBlockedError) return { kind: "signedout" };
        if (
          err instanceof WebmailOwnMailboxOnlyError ||
          err instanceof WebmailDelegationRefusedError ||
          err instanceof PinnedMailboxMissingError
        ) {
          return { kind: "moved" };
        }
        return { kind: "unavailable" };
      }
    });
}
