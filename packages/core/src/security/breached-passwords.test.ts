// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  assertNotBreached,
  BreachedPasswordError,
  type BreachedPasswords,
  type BreachVerdict,
  passwordBreached,
} from "./breached-passwords";

const answering = (verdict: BreachVerdict): BreachedPasswords & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    check: (p) => {
      asked.push(p);
      return Promise.resolve(verdict);
    },
  };
};

describe("breached-password helpers", () => {
  it("refuses only a breached answer", async () => {
    expect(await passwordBreached(answering("breached"), "some password")).toBe(true);
    expect(await passwordBreached(answering("clean"), "some password")).toBe(false);
    await expect(assertNotBreached(answering("breached"), "some password")).rejects.toBeInstanceOf(
      BreachedPasswordError,
    );
    await expect(assertNotBreached(answering("clean"), "some password")).resolves.toBeUndefined();
  });

  it("fails open: unknown, a throwing check, or no check at all accepts the password", async () => {
    expect(await passwordBreached(answering("unknown"), "some password")).toBe(false);
    expect(await passwordBreached({ check: () => Promise.reject(new Error("down")) }, "some password")).toBe(false);
    expect(await passwordBreached(undefined, "some password")).toBe(false);
  });

  it("never asks about non-strings, empty or oversized input", async () => {
    const check = answering("breached");
    for (const v of [undefined, null, 42, "", "x".repeat(1025)]) expect(await passwordBreached(check, v)).toBe(false);
    expect(check.asked).toEqual([]);
  });

  it("the error has its own code and the user-facing message", () => {
    const err = new BreachedPasswordError();
    expect(err.code).toBe("password_breached");
    expect(err.message).toBe("This password has appeared in a data breach. Choose a different one.");
  });
});
