// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { isDeadlock } from "./repositories";

const pgError = (code: string) => Object.assign(new Error("pg"), { code });

describe("isDeadlock", () => {
  it("finds 40P01 on the driver error or in the causes drizzle wraps it in, and nothing else", () => {
    expect(isDeadlock(pgError("40P01"))).toBe(true);
    expect(isDeadlock(new Error("query failed", { cause: pgError("40P01") }))).toBe(true);
    expect(isDeadlock(new Error("a", { cause: new Error("b", { cause: pgError("40P01") }) }))).toBe(true);
    expect(isDeadlock(pgError("23505"))).toBe(false);
    expect(isDeadlock(new Error("plain"))).toBe(false);
    expect(isDeadlock("40P01")).toBe(false);
    expect(isDeadlock({ code: "40P01" })).toBe(false);
  });
});
