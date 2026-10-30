// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Domain errors. The HTTP layer maps them: Unauthenticated → 401, Forbidden → 403, NotFound → 404 (also for
 * out-of-scope ids — never confirm another account's ids), Validation → 400, Conflict → 409, PlanLimit → 403,
 * EnrolmentRequired → 403,
 * EmailUnverified → 403.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthenticatedError extends DomainError {
  constructor() {
    super("Sign in to continue.", "unauthorized");
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "You don't have permission to do that.") {
    super(message, "forbidden");
  }
}

export class NotFoundError extends DomainError {
  constructor(what = "Not found.") {
    super(what, "not_found");
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, "bad_request");
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, "conflict");
  }
}

/** The account's plan doesn't include this (HTTP 403 with its own code, so the UI can offer an upgrade). */
export class PlanLimitError extends DomainError {
  constructor(message: string) {
    super(message, "plan_limit");
  }
}

/**
 * The person hasn't confirmed their sign-in email address yet, and this action needs it (a free platform address).
 * HTTP 403 with its own code, so the console can offer to send the confirmation link.
 */
export class EmailUnverifiedError extends DomainError {
  constructor() {
    super("Confirm your email address first: open the link we sent you, or send a new one.", "email_unverified");
  }
}

/**
 * One of the person's accounts requires a sign-in factor they haven't set up yet (two-factor sign-in or a passkey).
 * Until they do, only their own Security page works (HTTP 403 with its own code, so the console can send them there).
 */
export class EnrolmentRequiredError extends DomainError {
  constructor(readonly factor: "two_factor" | "passkey") {
    super(
      factor === "passkey"
        ? "Your account requires a passkey. Add one on your Security page to continue."
        : "Your account requires two-factor sign-in. Turn it on on your Security page to continue.",
      "enrolment_required",
    );
  }
}

/**
 * The person's console password was set by an admin ("Add a user", "Require password change at first sign-in") and
 * they haven't chosen their own yet. Until they do, only `self` permissions work (HTTP 403 with its own code, so the
 * console can send them to the change-password page).
 */
export class PasswordChangeRequiredError extends DomainError {
  constructor() {
    super("Choose a new password to continue.", "password_change_required");
  }
}

/**
 * The action needs the person to have confirmed it's them in the last few minutes (password, a current code or a
 * fresh sign-in). HTTP 403 with its own code, so the console can ask and retry.
 */
export class StepUpRequiredError extends DomainError {
  constructor() {
    super("Confirm it's you first: enter your password or a code.", "step_up_required");
  }
}

/**
 * Anhourtec staff suspended this customer account (`platform.account.suspend`). Its people can still sign in, but every
 * account permission answers HTTP 403 with this code, so the console can show the suspension notice instead.
 */
export class AccountSuspendedError extends ForbiddenError {
  override readonly code = "account_suspended";
  constructor() {
    super("This account is suspended. Its mail is kept; see the notice in the console for how to appeal.");
  }
}

/**
 * The account is waiting to be deleted (ADR-0025): its people can still read it and its Owner can export or cancel, but
 * nothing else changes until the deletion is cancelled (HTTP 403 with its own code, so the console can say why).
 */
export class AccountDeletingError extends ForbiddenError {
  override readonly code = "account_deleting";
  constructor() {
    super("This account is being deleted. An Owner can cancel the deletion in Account settings to make changes again.");
  }
}

/**
 * An administrator set a new password for this mailbox that hasn't reached the mail server yet (or never did: the
 * console then asks them to set it again). Until it has, the mailbox's own password change is refused, so someone who
 * only knows the password being replaced can't override the administrator's (HTTP 409 with its own code).
 */
export class PasswordChangePendingError extends ConflictError {
  override readonly code = "password_change_pending";
  constructor() {
    super(
      "Your administrator has set a new password for this mailbox that isn't in use yet. Sign in again with it in a minute, or ask them to set it again.",
    );
  }
}

/** Too much work in progress right now (e.g. image decoding): try again in a moment (HTTP 429). */
export class BusyError extends DomainError {
  constructor(message = "Busy right now. Try again in a moment.") {
    super(message, "rate_limited");
  }
}

/**
 * An account administrator turned this alias off, and only an administrator can turn it back on (HTTP 403 with its
 * own code, so the console can say why). Its person can still see it.
 */
export class AliasAdminLockedError extends ForbiddenError {
  override readonly code = "alias_admin_locked";
  constructor() {
    super("An administrator turned this alias off. Ask an account admin if you need it back on.");
  }
}

/**
 * The account has created as many aliases (or masked aliases) today as its plan allows per UTC day
 * (`PLANS[plan].aliasCreationsPerDay`): HTTP 429 with its own code, so the console can say when it resets.
 */
export class AliasDailyLimitError extends DomainError {
  constructor(message: string) {
    super(message, "alias_daily_limit");
  }
}

/**
 * The account has created as many new aliases (or masked aliases) in the rolling year as its plan allows
 * (`PLANS[plan].aliasCreationsPerYear`, Free only): HTTP 429 with its own code; the message says the date a slot
 * comes back. Deleting an alias never gives one back.
 */
export class AliasYearlyLimitError extends DomainError {
  constructor(message: string) {
    super(message, "alias_yearly_limit");
  }
}

/**
 * The mailbox already has `ALIASES_PER_MAILBOX` aliases and masked aliases pointing at it: HTTP 409 with its own
 * code (deleting one makes room again).
 */
export class AliasMailboxLimitError extends DomainError {
  constructor(message: string) {
    super(message, "alias_mailbox_limit");
  }
}

/** Why a console → webmail handoff was refused (ADR-0024); the people-facing message says what to do instead. */
export type WebmailHandoffRefusal =
  | "invalid"
  | "wrong_browser"
  | "expired"
  | "session_ended"
  | "mailbox_unavailable"
  | "password_change_required"
  | "step_up_required";

const HANDOFF_MESSAGES: Record<WebmailHandoffRefusal, string> = {
  invalid: "This link to your mailbox has expired or was already used. Open webmail from the console again.",
  wrong_browser:
    "This link to your mailbox was already used, or opened in a different browser. Open webmail from the console again, in this browser.",
  expired: "This link to your mailbox has expired. Open webmail from the console again.",
  session_ended: "You're no longer signed in to the console. Sign in there and open webmail again.",
  mailbox_unavailable: "This mailbox can't be opened right now: it's suspended, being deleted or not ready yet.",
  step_up_required: "Confirm it's you in the console first, then open webmail again.",
  password_change_required:
    "This mailbox needs a new password first. Sign in to the webmail with the password you were given to choose your own.",
};

/**
 * The console → webmail handoff can't go ahead (ADR-0024): HTTP 409 `handoff_refused` (400 `handoff_invalid` for a
 * code we don't know), and the page offers the ordinary sign-in instead.
 */
export class WebmailHandoffError extends DomainError {
  constructor(readonly reason: WebmailHandoffRefusal) {
    super(HANDOFF_MESSAGES[reason], reason === "invalid" ? "handoff_invalid" : "handoff_refused");
  }
}

/**
 * A delegated mailbox can't be opened or used (ADR-0026 §6): no grant now, no such address, another account's address,
 * the plan doesn't include delegation, or the mailbox can't be used. HTTP 404 with one message in every case, so the
 * answer never confirms that an address exists (rule 25).
 */
export class DelegatedMailboxRefusedError extends NotFoundError {
  constructor() {
    super("You don't have access to this mailbox.");
  }
}

/** The mail server was busy with this mailbox (a credential slot taken by a concurrent open): HTTP 503, try again. */
export class TryAgainError extends DomainError {
  constructor(message = "The mail server is busy with this mailbox. Try again in a moment.") {
    super(message, "unavailable");
  }
}
