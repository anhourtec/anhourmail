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
