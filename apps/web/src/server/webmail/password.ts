// SPDX-License-Identifier: AGPL-3.0-only
import type { RequestMeta } from "@anhourmail/core";
import type { PasswordJobState } from "@anhourmail/core/mailboxes";
import { mailboxPasswordProblem } from "@anhourmail/shared/security";
import { log } from "@anhourmail/server/log";

import { ownMailbox, WebmailRefusedError, type WebmailService, WebmailSignInError } from "./service";

/**
 * A person changing their own mailbox password from the webmail (docs/internal/05-webmail.md "Settings"). Customer
 * accounts can't change their own Password on the mail server (the self-service objects are denied; ADR-0020), so
 * the change goes the way an admin's reset does: the current password is proved to the mail server first (a sign-in
 * whose tokens are dropped), the new one is hashed by the control plane and the worker applies only the hash. The
 * mail server then revokes every token of the mailbox; this session signs in again with the new password, so it stays
 * signed in while every other webmail session of the mailbox ends. Neither password is kept, queued, logged or audited.
 */
export type PasswordChangeDeps = {
  mail: Pick<WebmailService, "session" | "checkPassword" | "renewMailbox">;
  /**
   * Core `changeOwnMailboxPassword` (hashes, queues the worker, audits): the job that applies it, and the console
   * address of the person the mailbox belongs to (for the notice), if any.
   */
  change: (
    address: string,
    password: string,
    meta: RequestMeta,
  ) => Promise<{ jobId: string; ownerEmail: string | null }>;
  /** Emails the person (their console address) that the password changed; never throws. */
  notify: (ownerEmail: string, address: string) => Promise<void>;
  /** Core `passwordJobState`. */
  state: (jobId: string) => Promise<PasswordJobState>;
  /** Wrong current passwords per address (the webmail sign-in's failure-only limit; fail closed). */
  failures: { exceeded(address: string): Promise<boolean>; record(address: string): Promise<void> };
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the worker before answering (it normally takes a few seconds). */
  waitMs?: number;
};

export type PasswordChangeResult = {
  /** The mail server has the new password. False: still applying; it takes effect within a minute. */
  applied: boolean;
  /** This session is signed in again with the new password (false: the person signs in again). */
  signedIn: boolean;
  /** The session's new id when it was renewed (the route sets the cookie; never in the response body). */
  sessionId?: string;
};

const WRONG_CURRENT = "Your current password isn't right.";

export async function changeWebmailPassword(
  d: PasswordChangeDeps,
  sessionId: string,
  input: { current: string; next: string; account: string | null },
  meta: RequestMeta,
): Promise<PasswordChangeResult> {
  // The person's own mailbox only, decided on this one read: never a mailbox shared with them (ADR-0026 §6).
  const session = ownMailbox(await d.mail.session(sessionId));
  // The page must be showing the mailbox whose password this is (a mailbox switched in another tab isn't changed).
  if (input.account !== session.accountId) throw new WebmailRefusedError("Reload the page and try again.");
  const address = session.username;
  const problem = mailboxPasswordProblem(input.next, address);
  if (problem) throw new WebmailRefusedError(problem);
  if (input.next === input.current) throw new WebmailRefusedError("Choose a password different from your current one.");
  if (await d.failures.exceeded(address)) {
    throw new WebmailRefusedError("Too many wrong passwords. Wait a few minutes and try again.");
  }
  try {
    await d.mail.checkPassword(address, input.current);
  } catch (err) {
    if (err instanceof WebmailSignInError) {
      await d.failures.record(address);
      throw new WebmailRefusedError(WRONG_CURRENT);
    }
    throw err;
  }
  const { jobId, ownerEmail } = await d.change(address, input.next, meta);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (d.waitMs ?? 20_000);
  let state: PasswordJobState = await d.state(jobId);
  while (state === "pending" && Date.now() < deadline) {
    await sleep(500);
    state = await d.state(jobId);
  }
  if (state === "failed") {
    throw new WebmailRefusedError("Your password couldn't be changed. Your current password still works; try again.");
  }
  if (ownerEmail) await d.notify(ownerEmail, address);
  if (state === "pending") return { applied: false, signedIn: false };
  try {
    const renewed = await d.mail.renewMailbox(sessionId, address, input.next);
    return { applied: true, signedIn: true, sessionId: renewed };
  } catch (err) {
    // Changed, but this session couldn't sign in again (e.g. the mail server was busy): the person signs in again.
    log.warn("webmail session renewal after a password change failed", {
      component: "webmail",
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return { applied: true, signedIn: false };
  }
}
