// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { DISPOSABLE_EMAIL } from "@anhourmail/shared/security";

import {
  assertNotDisposable,
  type DisposableEmailCheck,
  DisposableEmailError,
  disposableVerdict,
} from "./disposable-email";

const answering = (disposable: boolean): DisposableEmailCheck & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    check(address) {
      asked.push(address);
      return Promise.resolve(disposable ? { disposable: true, via: "listed" } : { disposable: false });
    },
  };
};

describe("disposable email helpers", () => {
  it("passes the check's verdict through", async () => {
    await expect(disposableVerdict(answering(true), "a@temp.example")).resolves.toEqual({
      disposable: true,
      via: "listed",
    });
    await expect(disposableVerdict(answering(false), "a@example.com")).resolves.toEqual({ disposable: false });
  });

  it("fails open: no check, not an address, too long, or a check that throws", async () => {
    await expect(disposableVerdict(undefined, "a@temp.example")).resolves.toEqual({ disposable: false });
    const check = answering(true);
    await expect(disposableVerdict(check, 42)).resolves.toEqual({ disposable: false });
    await expect(disposableVerdict(check, "no-at")).resolves.toEqual({ disposable: false });
    await expect(disposableVerdict(check, `${"a".repeat(320)}@x.io`)).resolves.toEqual({ disposable: false });
    expect(check.asked).toEqual([]);
    const throwing: DisposableEmailCheck = { check: () => Promise.reject(new Error("boom")) };
    await expect(disposableVerdict(throwing, "a@temp.example")).resolves.toEqual({ disposable: false });
  });

  it("assertNotDisposable throws the 422 error with the shared message", async () => {
    const err = await assertNotDisposable(answering(true), "a@temp.example").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisposableEmailError);
    expect((err as DisposableEmailError).code).toBe(DISPOSABLE_EMAIL.code);
    expect((err as DisposableEmailError).message).toBe(DISPOSABLE_EMAIL.message);
    await expect(assertNotDisposable(answering(false), "a@example.com")).resolves.toBeUndefined();
  });
});
