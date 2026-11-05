// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { NextResponse } from "next/server";

import type { RequestMeta } from "@anhourmail/core";
import {
  claimSignUpCode,
  completeSignUpCode,
  normaliseInviteCode,
  releaseSignUpCode,
  type SignUpClaim,
} from "@anhourmail/core/billing";
import { log } from "@anhourmail/server/log";
import { checkRateLimit, LIMITS } from "@anhourmail/server/rate-limit";
import { SIGN_UP_CODE_HEADER, SIGN_UP_REFUSAL } from "@anhourmail/shared/proof-of-work";

import { container } from "../container";

/**
 * Invite codes at sign-up (ADR-0029 §8, with the sign-up gate of ADR-0031; run-67 N1). A code goes in the
 * `x-sign-up-code` header next to the proof-of-work. After the proof and the sign-up limits have passed (never instead
 * of them) the code is counted per client address (fail closed) and **claimed** atomically for this sign-up, before the
 * identity layer creates anyone: the claim is the admission, so nothing that happens to the code later (a Billing
 * redemption, a revocation, an expiry, a slow request) can let a second account in. Every way a code can be wrong is
 * the same 404.
 *
 * The claim rides with the request (`AsyncLocalStorage`) to the identity layer: its user-create hook admits a sign-up
 * while sign-up is closed only with a claimed code, and once the person exists the claim is completed (person and
 * account attached, an unbound comp applied). A sign-up that created no one gives the claim back.
 */

export type AdmittedCode = SignUpClaim;

const admitted = new AsyncLocalStorage<AdmittedCode>();

/** The code claimed for this request's sign-up, or null. */
export const admittedSignUpCode = (): AdmittedCode | null => admitted.getStore() ?? null;

/** Runs the identity layer's sign-up with the claimed code in scope. */
export const withSignUpCode = <T>(code: AdmittedCode, fn: () => Promise<T>): Promise<T> => admitted.run(code, fn);

/** The code the sign-up request carries (trimmed), or null when it carries none. */
export function signUpCodeOf(req: Request): string | null {
  const raw = req.headers.get(SIGN_UP_CODE_HEADER)?.trim() ?? "";
  return raw === "" ? null : raw.slice(0, 64);
}

/** Whether a request's code could be a code at all (shape only, no lookup): the closed-mode challenge and page use it. */
export const looksLikeInviteCode = (code: string | null | undefined): boolean => normaliseInviteCode(code) !== null;

const invalid = () =>
  NextResponse.json(
    {
      error: {
        code: SIGN_UP_REFUSAL.inviteCode,
        message: "That invite code isn't valid. Check it, or ask whoever sent it.",
      },
    },
    { status: 404 },
  );

const unavailable = () =>
  NextResponse.json(
    { error: { code: "unavailable", message: "Sign-up is unavailable for a moment. Try again shortly." } },
    { status: 503 },
  );

async function bodyEmail(req: Request): Promise<string | null> {
  try {
    const body = (await req.clone().json()) as { email?: unknown } | null;
    return typeof body?.email === "string" ? body.email : null;
  } catch {
    return null;
  }
}

/**
 * Claims the sign-up's code. `admitted` = run the sign-up with it (and `settle` afterwards); `refused` = answer with
 * this response (429, 404 or 503). Call only after the sign-up gate passed.
 */
export async function admitSignUpCode(
  req: Request,
  code: string,
  meta: RequestMeta,
  open: boolean,
): Promise<{ admitted: AdmittedCode } | { refused: Response }> {
  const ip = meta.ip ?? "direct";
  const rl = await checkRateLimit(container().counter, "inviteCodeRedeemIp", LIMITS.inviteCodeRedeemIp, `ip:${ip}`);
  if (rl.degraded) return { refused: unavailable() };
  if (!rl.allowed) {
    log.warn("sign-up refused", { component: "sign-up", code: "rate_limited", reason: "invite_code" });
    const res = NextResponse.json(
      { error: { code: "rate_limited", message: "Too many attempts. Wait a while and try again." } },
      { status: 429 },
    );
    if (rl.headers["Retry-After"]) res.headers.set("Retry-After", rl.headers["Retry-After"]);
    return { refused: res };
  }
  const email = await bodyEmail(req);
  if (email === null) return { refused: invalid() };
  const claim = await claimSignUpCode(container().deps, { code, email }, { signUpOpen: open }, meta);
  if (!claim) {
    log.warn("sign-up refused", { component: "sign-up", code: SIGN_UP_REFUSAL.inviteCode });
    return { refused: invalid() };
  }
  return { admitted: claim };
}

/** The sign-up created no one: give the claimed code back (logged on failure; the code then stays used). */
export async function releaseAdmittedCode(code: AdmittedCode, meta: RequestMeta): Promise<void> {
  try {
    await releaseSignUpCode(container().deps, code, meta);
  } catch (err) {
    log.error("sign-up code release failed", { component: "sign-up", err });
  }
}

/**
 * After the person of a sign-up that came with a code exists (whether or not the account was provisioned): attach them
 * and the account to the claim and apply an unbound comp. Errors are logged; the person and account stay as created.
 */
export async function completeAdmittedCode(
  user: { id: string },
  accountId: string | null,
  meta: RequestMeta,
): Promise<void> {
  const code = admittedSignUpCode();
  if (!code) return;
  try {
    const out = await completeSignUpCode(container().deps, { ...code, userId: user.id, accountId }, meta);
    if (!out.attached) log.warn("sign-up code not attached", { component: "sign-up", userId: user.id });
  } catch (err) {
    log.error("sign-up code completion failed", { component: "sign-up", userId: user.id, err });
  }
}
