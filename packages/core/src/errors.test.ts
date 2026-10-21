// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "./errors";

describe("domain errors", () => {
  it.each([
    [new UnauthenticatedError(), "unauthorized", "UnauthenticatedError"],
    [new ForbiddenError(), "forbidden", "ForbiddenError"],
    [new NotFoundError(), "not_found", "NotFoundError"],
    [new ValidationError("bad"), "bad_request", "ValidationError"],
    [new ConflictError("dup"), "conflict", "ConflictError"],
  ])("%s has a stable code and name", (err, code, name) => {
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe(code);
    expect(err.name).toBe(name);
  });
});
