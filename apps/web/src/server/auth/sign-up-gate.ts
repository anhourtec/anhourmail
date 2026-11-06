// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { NextResponse } from "next/server";

import type { RequestMeta } from "@anhourmail/core";
import {
  type IssuedChallenge,
  issueChallenge,
  type PowKey,
  powKeyFrom,
  recordSignUpRefusal,
  SIGNED_REFUSALS,
  type SignUpClient,
  signUpClient,
  type SignUpRefusal,
  verifyProof,
} from "@anhourmail/core/sign-up";
import { disposableVerdict } from "@anhourmail/core/security";
import { log } from "@anhourmail/server/log";
import type { OneTimeStore } from "@anhourmail/server/one-time";
import { checkRateLimit, LIMITS, type LimitName, type RateLimitResult } from "@anhourmail/server/rate-limit";
import { POW_BITS, POW_HEADERS, SIGN_UP_REFUSAL } from "@anhourmail/shared/proof-of-work";
import { DISPOSABLE_EMAIL } from "@anhourmail/shared/security";

import { container } from "../container";
import { type Env, env } from "../env";

/**
 * The sign-up gate (ADR-0031), in front of better-auth's `POST /api/auth/sign-up/email`, before any account exists:
 *
 * 1. a proof-of-work solved in the browser, checked and spent once;
 * 2. the request's shape (strings of sane length; the identity layer validates the values);
 * 3. the attempts tier (per address, an IPv6 client per /64), counted for every attempt that got this far;
 * 4. a temporary-inbox address is refused (ADR-0033; the domain list, then the domain's mail servers, failing open);
 * 5. the account tiers (per address and per network), taken now and given back by `settle` unless the identity layer
 *    created the account — so failed sign-ups (an address already in use, a refused password or name) never use up a
 *    shared network's allowance. Taking before and giving back after means concurrent sign-ups can't overshoot.
 *
 * Email confirmation still follows. Every refusal is logged; those worth keeping are audited once per network and
 * reason per hour. The body is read only for its shape and never logged or audited.
 */

/** The difficulty new challenges get (and the least a proof must meet). */
export const signUpPowBits = (): number => env().SIGNUP_POW_BITS ?? POW_BITS.default;

let key: { secret: string; key: PowKey } | null = null;
const powKey = (): PowKey => {
  const secret = env().BETTER_AUTH_SECRET;
  if (key?.secret !== secret) key = { secret, key: powKeyFrom(secret) };
  return key.key;
};

export function newSignUpChallenge(ip: string | null, now = new Date()): IssuedChallenge {
  return issueChallenge({ key: powKey(), bits: signUpPowBits(), client: signUpClient(ip).address, now });
}

type Step = {
  name: LimitName;
  reason: Extract<SignUpRefusal, { code: "sign_up_limited" }>["reason"];
  setting: (e: Env) => number | undefined;
  /** The client's key for this tier, or null when it doesn't apply (the IPv6-only tiers for IPv4). */
  subject: (c: SignUpClient) => string | null;
};

/** Account tiers, checked in this order; the first one used up refuses. */
const STEPS: readonly Step[] = [
  { name: "signup", reason: "address_hour", setting: (e) => e.SIGNUP_LIMIT_ADDRESS_HOUR, subject: (c) => c.address },
  { name: "signupDay", reason: "address_day", setting: (e) => e.SIGNUP_LIMIT_ADDRESS_DAY, subject: (c) => c.address },
  {
    name: "signupNetwork",
    reason: "network_hour",
    setting: (e) => e.SIGNUP_LIMIT_NETWORK_HOUR,
    subject: (c) => c.network,
  },
  {
    name: "signupNetworkDay",
    reason: "network_day",
    setting: (e) => e.SIGNUP_LIMIT_NETWORK_DAY,
    subject: (c) => c.network,
  },
  {
    name: "signupNetwork56Day",
    reason: "network56_day",
    setting: (e) => e.SIGNUP_LIMIT_NETWORK56_DAY,
    subject: (c) => c.network56,
  },
  {
    name: "signupNetwork48Day",
    reason: "network48_day",
    setting: (e) => e.SIGNUP_LIMIT_NETWORK48_DAY,
    subject: (c) => c.network48,
  },
];

/** Bodies larger than this aren't a sign-up form. */
const MAX_BODY = 8 * 1024;

const refusal = (code: string, message: string, status: number) =>
  NextResponse.json({ error: { code, message } }, { status });

const unavailable = () => refusal("unavailable", "Sign-up is unavailable for a moment. Try again shortly.", 503);

/** A store that refuses every claim: what the gate does without one (fail closed). */
const noStore: OneTimeStore = () => Promise.reject(new Error("no single-use store"));

async function audit(r: SignUpRefusal, meta: RequestMeta, once: OneTimeStore): Promise<void> {
  await recordSignUpRefusal(container().deps, once, r, meta).catch((err: unknown) => {
    log.error("audit write failed", { component: "sign-up", err });
  });
}

const str = (v: unknown, min: number, max: number): boolean =>
  typeof v === "string" && v.length >= min && v.length <= max;

/**
 * The sign-up request's shape: a JSON object with an email address, a password and a name (strings, sane lengths).
 * Returns the email address when the shape is right (for the disposable-address check), null otherwise.
 */
async function wellFormed(req: Request): Promise<string | null> {
  const text = await req.clone().text();
  if (text.length > MAX_BODY) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  return str(b.email, 3, 320) &&
    typeof b.email === "string" &&
    /^[^\s@]+@[^\s@]+$/.test(b.email) &&
    str(b.password, 1, 1024) &&
    str(b.name, 1, 300)
    ? b.email
    : null;
}

/** Gives the taken account tiers back. A failed give-back leaves them counted (the safe side) and is logged. */
async function giveBack(keys: readonly string[]): Promise<void> {
  const uncount = container().uncount;
  if (!uncount) return;
  for (const k of keys) {
    await uncount(k).catch((err: unknown) => {
      log.warn("sign-up limit give-back failed", { component: "sign-up", err });
    });
  }
}

export type SignUpGateResult =
  | { refused: Response }
  | {
      /** Call with the identity layer's answer: anything but a created account gives the account tiers back. */
      settle: (created: boolean) => Promise<void>;
    };

export async function signUpGate(req: Request, meta: RequestMeta, now = new Date()): Promise<SignUpGateResult> {
  const once = container().oneTime ?? noStore;
  const client = signUpClient(meta.ip);
  let proof;
  try {
    proof = await verifyProof({
      key: powKey(),
      minBits: signUpPowBits(),
      client: client.address,
      challenge: req.headers.get(POW_HEADERS.challenge),
      proof: req.headers.get(POW_HEADERS.proof),
      now,
      claim: once,
    });
  } catch (err) {
    log.warn("sign-up check unavailable", { component: "sign-up", err });
    return { refused: unavailable() };
  }
  if (!proof.ok) {
    log.warn("sign-up refused", { component: "sign-up", code: SIGN_UP_REFUSAL.proofOfWork, reason: proof.reason });
    if (SIGNED_REFUSALS.has(proof.reason)) {
      await audit({ code: "proof_of_work", reason: proof.reason }, meta, once);
    }
    return {
      refused: refusal(
        SIGN_UP_REFUSAL.proofOfWork,
        "The automatic check didn't go through. Reload the page and try again.",
        400,
      ),
    };
  }

  const email = await wellFormed(req);
  if (email === null) {
    log.warn("sign-up refused", { component: "sign-up", code: "bad_request", reason: "shape" });
    return { refused: refusal("bad_request", "Check your details and try again.", 400) };
  }

  const e = env();
  const at = now.getTime();
  const counter = container().counter;
  const attempts = await checkRateLimit(
    counter,
    "signupAttempt",
    { ...LIMITS.signupAttempt, limit: e.SIGNUP_LIMIT_ATTEMPTS_HOUR ?? LIMITS.signupAttempt.limit },
    client.attempt,
    at,
  );
  if (attempts.degraded) return { refused: unavailable() };
  if (!attempts.allowed) {
    log.warn("sign-up refused", { component: "sign-up", code: SIGN_UP_REFUSAL.attempts, reason: "attempts_hour" });
    await audit({ code: "sign_up_attempts", reason: "attempts_hour" }, meta, once);
    return { refused: withRetry(refusal(SIGN_UP_REFUSAL.attempts, ATTEMPTS_MESSAGE, 429), attempts) };
  }

  // A temporary-inbox address (ADR-0033): refused before the account tiers, so it never takes an account slot. The log
  // line carries the domain only; the audit entry (once per network an hour) carries how it was recognised.
  const disposable = await disposableVerdict(container().disposable, email);
  if (disposable.disposable) {
    log.warn("sign-up refused", {
      component: "sign-up",
      code: SIGN_UP_REFUSAL.disposableEmail,
      reason: disposable.via,
      domain: email.slice(email.lastIndexOf("@") + 1).toLowerCase(),
    });
    await audit({ code: "disposable_email", reason: disposable.via }, meta, once);
    return { refused: refusal(SIGN_UP_REFUSAL.disposableEmail, DISPOSABLE_EMAIL.message, 422) };
  }

  const taken: string[] = [];
  for (const step of STEPS) {
    const subject = step.subject(client);
    if (subject === null) continue;
    const limit = { ...LIMITS[step.name], limit: step.setting(e) ?? LIMITS[step.name].limit };
    const rl = await checkRateLimit(counter, step.name, limit, subject, at);
    if (rl.key) taken.push(rl.key);
    if (rl.degraded) {
      await giveBack(taken);
      return { refused: unavailable() };
    }
    if (!rl.allowed) {
      await giveBack(taken);
      log.warn("sign-up refused", { component: "sign-up", code: SIGN_UP_REFUSAL.limited, reason: step.reason });
      await audit({ code: "sign_up_limited", reason: step.reason }, meta, once);
      return { refused: withRetry(refusal(SIGN_UP_REFUSAL.limited, LIMITED_MESSAGE, 429), rl) };
    }
  }
  return {
    settle: async (created) => {
      if (!created) await giveBack(taken);
    },
  };
}

const ATTEMPTS_MESSAGE = "Too many sign-up attempts from your network. Try again later.";
const LIMITED_MESSAGE = "Too many accounts were created from your network recently. Try again later.";

function withRetry(res: Response, rl: RateLimitResult): Response {
  if (rl.headers["Retry-After"]) res.headers.set("Retry-After", rl.headers["Retry-After"]);
  return res;
}

/**
 * Whether a successful sign-up answer created a login. With the address confirmed before the first sign-in, the identity
 * layer answers an address already in use exactly like a new one (no enumeration), with a made-up user id: the answer
 * created a login only when its id is the real login for that address. Anything unreadable counts as created (the safe
 * side: the account tiers stay counted and an invite code stays spent).
 */
export async function signUpCreatedLogin(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  try {
    const body = (await res.clone().json()) as { user?: { id?: unknown; email?: unknown } } | null;
    const id = body?.user?.id;
    const email = body?.user?.email;
    if (typeof id !== "string" || typeof email !== "string") return true;
    const login = await container().deps.uow.run((r) => r.people.userByEmail(email.trim().toLowerCase()));
    return login?.id === id;
  } catch (err) {
    log.warn("sign-up outcome unreadable", { component: "sign-up", err });
    return true;
  }
}
