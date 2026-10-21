// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Domain errors. The HTTP layer maps them: Unauthenticated → 401, Forbidden → 403, NotFound → 404 (also for
 * out-of-scope ids — never confirm another account's ids), Validation → 400, Conflict → 409.
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
