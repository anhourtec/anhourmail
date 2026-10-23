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
 * The action needs the person to have confirmed it's them in the last few minutes (password, a current code or a
 * fresh sign-in). HTTP 403 with its own code, so the console can ask and retry.
 */
export class StepUpRequiredError extends DomainError {
  constructor() {
    super("Confirm it's you first: enter your password or a code.", "step_up_required");
  }
}
