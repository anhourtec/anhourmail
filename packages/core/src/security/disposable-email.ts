// SPDX-License-Identifier: AGPL-3.0-only
import { DISPOSABLE_EMAIL } from "@anhourmail/shared/security";

import { DomainError } from "../errors";

/**
 * Disposable email check (ADR-0033): is this address at a temporary-inbox service? The adapter checks the domain (and
 * its parents) against the vendored list and the domain's mail servers against the vendored address list; the memory
 * fake answers from a list of domains.
 *
 * `disposable` says how it was recognised (`listed` or `mail_server`). `unknown` never appears: a lookup that fails or
 * runs out of time counts as not disposable (fail open: the domain list still applied, and the address is confirmed by
 * email anyway). Adapters never throw.
 */
export type DisposableVerdict = { disposable: false } | { disposable: true; via: "listed" | "mail_server" };

export type DisposableEmailCheck = {
  check(address: string): Promise<DisposableVerdict>;
};

/** A disposable address (HTTP 422 `disposable_email`). */
export class DisposableEmailError extends DomainError {
  constructor() {
    super(DISPOSABLE_EMAIL.message, DISPOSABLE_EMAIL.code);
  }
}

/**
 * The verdict for `address`, or not disposable when there's no check, the value isn't an address, or the check throws
 * despite its contract (fail open).
 */
export async function disposableVerdict(
  check: DisposableEmailCheck | undefined,
  address: unknown,
): Promise<DisposableVerdict> {
  if (!check || typeof address !== "string" || !address.includes("@") || address.length > 320) {
    return { disposable: false };
  }
  try {
    return await check.check(address);
  } catch {
    return { disposable: false };
  }
}

/** Throws `DisposableEmailError` when `check` finds `address` disposable (see `disposableVerdict`). */
export async function assertNotDisposable(check: DisposableEmailCheck | undefined, address: unknown): Promise<void> {
  if ((await disposableVerdict(check, address)).disposable) throw new DisposableEmailError();
}
