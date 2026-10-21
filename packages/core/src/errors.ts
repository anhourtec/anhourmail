// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Domain errors. The HTTP layer maps them: Unauthenticated → 401, Forbidden → 403, NotFound → 404 (also for
 * out-of-scope ids — never confirm another account's ids), Validation → 400, Conflict → 409, PlanLimit → 403.
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

/** Expired, used or unknown one-time token (same answer for all three: no oracle). */
export class InvalidTokenError extends DomainError {
  constructor() {
    super("This link is invalid or has expired.", "invalid_token");
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
