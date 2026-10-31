// SPDX-License-Identifier: AGPL-3.0-only
import { PASSKEY_NAME_MAX, SIGN_IN_POLICIES, type SignInMethod, type SignInPolicy } from "@anhourmail/shared/security";

import { ValidationError } from "../errors";
import type { AccountSignInPolicy, MissingFactor, SecurityFactors } from "./entity";

/** Rank of a policy: a passkey is the strictest, then any second factor, then nothing extra. */
const rank = (p: SignInPolicy): number => SIGN_IN_POLICIES.indexOf(p);

/** The strictest policy among the person's accounts (they must satisfy all of them). */
export function strictestPolicy(policies: readonly AccountSignInPolicy[]): SignInPolicy {
  return policies.reduce<SignInPolicy>((acc, p) => (rank(p.policy) > rank(acc) ? p.policy : acc), "none");
}

/**
 * The factor a person still needs for `policy`, or null when they meet it. A passkey counts as two-factor sign-in
 * (it is a complete, phishing-resistant sign-in on its own).
 */
export function missingFactor(policy: SignInPolicy, f: SecurityFactors): MissingFactor | null {
  if (policy === "passkey") return f.passkeys > 0 ? null : "passkey";
  if (policy === "two_factor") return f.totp || f.passkeys > 0 ? null : "two_factor";
  return null;
}

/**
 * Whether a session signed in with `method` may use the console under `policy` (null = yes, else the refusal):
 * - `two_factor`: anything but the password alone (a trusted browser counts: it was trusted after a second step);
 * - `passkey`: only a sign-in whose second step was a passkey (`password+passkey`).
 * Someone who doesn't have the required factor yet may sign in with the password: the enrolment gate keeps them on
 * their Security page until they set it up. A passwordless `passkey` session (from before ADR-0028) is refused under
 * every policy: it ends, and the person signs in again.
 */
export function sessionRefusal(policy: SignInPolicy, f: SecurityFactors, method: SignInMethod | null): string | null {
  const m = method ?? "password";
  if (m === "passkey") return PASSWORDLESS_ENDED;
  if (policy === "none" || missingFactor(policy, f) !== null) return null;
  if (policy === "two_factor") {
    return m === "password"
      ? "Your account requires a second step. Sign in again and use your passkey or authenticator app."
      : null;
  }
  return m === "password+passkey"
    ? null
    : "Your account requires a passkey. Sign in again and use your passkey on the second step.";
}

/** Why a passwordless passkey session from before ADR-0028 ends. */
export const PASSWORDLESS_ENDED = "Sign in again with your password, then your passkey.";

/** What would be missing after removing a factor (null = removing it is fine). */
export function missingAfterRemoving(
  policy: SignInPolicy,
  f: SecurityFactors,
  removing: "totp" | "passkey",
): MissingFactor | null {
  const after: SecurityFactors =
    removing === "totp" ? { ...f, totp: false, recoveryCodesLeft: 0 } : { ...f, passkeys: Math.max(0, f.passkeys - 1) };
  return missingFactor(policy, after);
}

/** A passkey name from untrusted input: trimmed, single-spaced, 1–60 printable characters. */
export function passkeyName(input: unknown): string {
  if (typeof input !== "string") throw new ValidationError("Give the passkey a name.");
  // Control characters are refused rather than shown.
  // eslint-disable-next-line no-control-regex -- the point is to reject control characters.
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new ValidationError("Use letters, numbers and spaces in the name.");
  const name = input.trim().replace(/\s+/g, " ");
  if (name === "") throw new ValidationError("Give the passkey a name.");
  if (name.length > PASSKEY_NAME_MAX) {
    throw new ValidationError(`Keep the name to ${String(PASSKEY_NAME_MAX)} characters or fewer.`);
  }
  return name;
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPad\b/, "iPadOS"],
  [/\b(?:iPhone|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * A short, human description of a user agent ("Firefox on Linux") for the Security page. Only the browser family
 * and system: no versions, so the page never shows a fingerprint.
 */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}
