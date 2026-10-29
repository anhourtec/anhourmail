// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { isSignInMethod, type SignInMethod } from "@anhourmail/shared/security";
import { WEBMAIL_HANDOFF } from "@anhourmail/shared/webmail";

import { type Actor, can, type UserActor } from "../actor";
import {
  ForbiddenError,
  NotFoundError,
  StepUpRequiredError,
  UnauthenticatedError,
  ValidationError,
  WebmailHandoffError,
} from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { mutation, type MutationOutcome } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { requiredEnrolment, sessionRefusalFor } from "../security/service";
import type { WebmailAccess } from "./access";

/**
 * Console → webmail handoff (ADR-0024): "Open webmail" in the console signs the person in to their own mailbox
 * without its password.
 *
 *   1. The webmail origin sets a random verifier in a cookie and sends the browser to the console with its SHA-256
 *      (the challenge).
 *   2. `startWebmailHandoff` (console session): checks the person, the mailbox and the moment, then stores a one-time
 *      code bound to the person, this console session, the mailbox and the challenge, for 60 s.
 *   3. `redeemWebmailHandoff` (webmail origin): takes the code once, checks the verifier from the cookie (another
 *      browser has none), rebuilds the person from the database and checks everything again, then lets the caller open
 *      the session (`open`: a throwaway mail-server credential used once and destroyed, in the web app).
 *
 * Both steps are audited (`webmail.handoff_started`, `webmail.handoff_redeemed`), refusals included; no code, verifier,
 * challenge or credential is ever recorded or logged.
 */

/** What a code stands for (kept in Redis under the code's SHA-256 for `WEBMAIL_HANDOFF.codeSec`). */
export type HandoffGrant = {
  userId: string;
  email: string;
  /** The console session that asked (its id, not its token). */
  sessionId: string;
  signInMethod: SignInMethod | null;
  accountId: string;
  mailboxId: string;
  /** base64url SHA-256 of the verifier the webmail origin holds in this browser's cookie. */
  challenge: string;
  /** Epoch ms. */
  expiresAt: number;
};

/** One-time code storage: `take` returns the grant at most once (Redis `GETDEL`). Failures refuse the handoff. */
export type HandoffCodeStore = {
  put(key: string, grant: HandoffGrant, ttlSec: number): Promise<void>;
  take(key: string): Promise<HandoffGrant | null>;
};

/** Whether a mailbox may use the webmail right now (uncached: the webmail access gate's own answer). */
export type HandoffAccess = { state(address: string): Promise<WebmailAccess> };

/** The mailbox to open, for the caller's `open`. */
export type HandoffTarget = {
  accountId: string;
  mailboxId: string;
  address: string;
  externalId: string;
  /** The console session the handoff came from: the webmail session it opens ends with it. */
  console: { userId: string; sessionId: string };
};

/** A mailbox on the console's "Open webmail" page. */
export type HandoffMailbox = {
  accountId: string;
  mailboxId: string;
  address: string;
  /** Null when it can be opened now; otherwise why not (the page links to the sign-in page instead). */
  unavailable: "mailbox_unavailable" | "password_change_required" | null;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A 32-byte base64url value (code, verifier, challenge). */
export const isHandoffToken = (v: unknown): v is string => typeof v === "string" && TOKEN.test(v);

/** A fresh verifier for the webmail origin's cookie. */
export const newHandoffVerifier = (): string => randomBytes(32).toString("base64url");

/** The challenge for a verifier (base64url SHA-256, as in PKCE S256). */
export const handoffChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

const codeKey = (code: string): string => createHash("sha256").update(code).digest("base64url");

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const usable = (m: Mailbox): HandoffMailbox["unavailable"] =>
  m.status !== "active" || m.stalwartId === null
    ? "mailbox_unavailable"
    : m.mustChangePassword === true
      ? "password_change_required"
      : null;

/**
 * The person's own mailboxes they may open from the console (`webmail.open.own` in their account): never a shared,
 * unassigned or someone else's mailbox, and nothing while acting as someone. Read-only (no audit).
 */
export async function handoffMailboxes(deps: Deps, actor: Actor): Promise<HandoffMailbox[]> {
  if (actor.kind !== "user" || actor.actingAs) return [];
  const accounts = actor.memberships.map((m) => m.accountId).filter((a) => can(actor, "webmail.open.own", a));
  return deps.uow.run(async (r) => {
    const out: HandoffMailbox[] = [];
    for (const accountId of accounts) {
      for (const m of await r.mailboxes.listByAccount(accountId)) {
        if (m.userId !== actor.userId) continue;
        out.push({ accountId, mailboxId: m.id, address: m.address, unavailable: usable(m) });
      }
    }
    // The ones that can be opened first, then by address.
    return out.sort(
      (a, b) => Number(a.unavailable !== null) - Number(b.unavailable !== null) || a.address.localeCompare(b.address),
    );
  });
}

type StartRefusal = "act_as" | "not_found" | "mailbox_unavailable" | "password_change_required" | "step_up_required";

/**
 * Step 2: mints a one-time code for one of the person's own mailboxes (`webmail.open.own`). 404 for any mailbox that
 * isn't theirs (shared, unassigned, someone else's, unknown); 403 while acting as someone; 409 `handoff_refused` while
 * the mailbox can't be used (not active, suspended, deleting, its person suspended) or owes its first-sign-in password
 * change; 403 `step_up_required` without a recent step-up on this console session (a password or code in the last
 * few minutes, a fresh sign-in counts), as for app passwords. `challenge` comes from the webmail origin (step 1).
 * Audited, refusals as denied.
 */
export async function startWebmailHandoff(
  deps: Deps,
  codes: HandoffCodeStore,
  access: HandoffAccess,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  input: { challenge?: unknown },
  session: { sessionId: string | null },
  req: RequestMeta,
): Promise<{ code: string; expiresAt: Date }> {
  let stored: string | null = null;
  try {
    const out = await mutation(
      deps,
      actor,
      req,
      {
        action: "webmail.handoff_started",
        permission: "webmail.open.own",
        accountId,
        target: { type: "mailbox", id: mailboxId },
      },
      async (repos): Promise<MutationOutcome<{ code: string; expiresAt: Date } | StartRefusal>> => {
        if (actor.kind !== "user") throw new ForbiddenError();
        const refuse = (code: StartRefusal, label: string | null = null) => ({
          result: code,
          target: { label },
          denied: { code },
        });
        // Staff acting as someone never reach mail (ADR-0023); the matrix already refuses (Auditor), this stays if it changes.
        if (actor.actingAs) return refuse("act_as");
        const m = UUID.test(mailboxId) ? await repos.mailboxes.get(accountId, mailboxId) : null;
        // Someone else's, a shared or unassigned mailbox, or none at all: it doesn't exist for this person.
        if (m?.userId !== actor.userId) return refuse("not_found");
        if (!isHandoffToken(input.challenge)) throw new ValidationError("Open webmail from the console again.");
        if (!session.sessionId) throw new UnauthenticatedError();
        const unavailable = usable(m);
        if (unavailable) return refuse(unavailable, m.address);
        const state = await access.state(m.address);
        if (state !== "ok") return { ...refuse("mailbox_unavailable", m.address), meta: { state } };
        // A mailbox's mail is behind this: the same "confirm it's you" as an app password (ADR-0024).
        if (!(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))) {
          return refuse("step_up_required", m.address);
        }
        const code = randomBytes(32).toString("base64url");
        const expiresAt = new Date(deps.clock.now().getTime() + WEBMAIL_HANDOFF.codeSec * 1000);
        await codes.put(
          codeKey(code),
          {
            userId: actor.userId,
            email: actor.email,
            sessionId: session.sessionId,
            signInMethod: actor.signInMethod ?? null,
            accountId,
            mailboxId: m.id,
            challenge: input.challenge,
            expiresAt: expiresAt.getTime(),
          },
          WEBMAIL_HANDOFF.codeSec,
        );
        stored = code;
        return { result: { code, expiresAt }, target: { label: m.address } };
      },
    );
    if (out === "act_as") throw new ForbiddenError("Webmail can't be opened while acting as someone.");
    if (out === "not_found") throw new NotFoundError();
    if (out === "step_up_required") throw new StepUpRequiredError();
    if (out === "mailbox_unavailable" || out === "password_change_required") throw new WebmailHandoffError(out);
    return out;
  } catch (err) {
    // The code was stored but the audit entry didn't commit: take it back, so no unaudited code can be redeemed.
    const code = stored as string | null;
    if (code) await codes.take(codeKey(code)).catch(() => undefined);
    throw err;
  }
}

type PersonRefusal = "session_ended" | "act_as";

/**
 * The person behind a grant as the console would build them now (apps/web `getActorAndSession`): roles, suspension,
 * staff account suspensions, required factors and the console password change from the database. Refused when the
 * console session is gone, no longer meets an account sign-in requirement, or has support access open.
 */
async function personFor(r: Repositories, grant: HandoffGrant, now: Date): Promise<UserActor | PersonRefusal> {
  if (!(await r.security.sessions(grant.userId, now)).some((s) => s.id === grant.sessionId)) return "session_ended";
  if (await r.actAs.active(grant.userId, grant.sessionId, now)) return "act_as";
  if (await sessionRefusalFor(r, grant.userId, grant.signInMethod)) return "session_ended";
  const platformRoles = await r.access.platformRoles(grant.userId);
  const memberships = await r.access.memberships(grant.userId);
  const suspended = await r.access.isSuspended(grant.userId);
  const mustEnrol = await requiredEnrolment(r, grant.userId);
  const suspendedAccountIds = await r.suspensions.suspendedAccountsOf(grant.userId);
  const mustChangePassword = await r.people.passwordChangeRequired(grant.userId);
  return {
    kind: "user",
    userId: grant.userId,
    email: grant.email,
    platformRoles,
    memberships,
    suspended,
    ...(mustEnrol ? { mustEnrol } : {}),
    ...(mustChangePassword ? { mustChangePassword: true as const } : {}),
    ...(grant.signInMethod && isSignInMethod(grant.signInMethod) ? { signInMethod: grant.signInMethod } : {}),
    ...(suspendedAccountIds.length > 0 ? { suspendedAccountIds } : {}),
  };
}

/** Recorded for a grant whose console session is gone: the entry still lands in the mailbox's account log. */
const HANDOFF_SYSTEM: Actor = { kind: "system", name: "webmail handoff" };

type RedeemRefusal =
  "wrong_browser" | "expired" | PersonRefusal | "mailbox_unavailable" | "password_change_required" | "step_up_required";

/**
 * Step 3: redeems a code with the verifier from this browser's cookie and, when everything still holds, calls `open`
 * for the mailbox (the web app mints a throwaway credential, signs in once and destroys it). A code works once: an
 * unknown, used or expired code is 400 `handoff_invalid` (no audit: it names nobody); without the right verifier it is
 * 409 `wrong_browser`, audited, and the code is used up. Every other refusal is 409
 * `handoff_refused` (403 while acting as someone; the matrix's own 403s for a suspended person or account), audited as
 * denied in the mailbox's account; an `open` that throws is audited as failed.
 */
export async function redeemWebmailHandoff<T>(
  deps: Deps,
  codes: HandoffCodeStore,
  access: HandoffAccess,
  input: { code?: unknown; verifier?: unknown },
  open: (target: HandoffTarget) => Promise<T>,
  req: RequestMeta,
): Promise<T> {
  if (!isHandoffToken(input.code)) throw new WebmailHandoffError("invalid");
  // Taken first, whatever the verifier: a code presented without the right one (another browser) is used up.
  const grant = await codes.take(codeKey(input.code));
  if (!grant) throw new WebmailHandoffError("invalid");
  const verifier = isHandoffToken(input.verifier) ? input.verifier : null;
  const now = deps.clock.now();
  const person = await deps.uow.run((r) => personFor(r, grant, now));
  const actor: Actor = typeof person === "string" ? HANDOFF_SYSTEM : person;
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "webmail.handoff_redeemed",
      permission: "webmail.open.own",
      accountId: grant.accountId,
      target: { type: "mailbox", id: grant.mailboxId },
    },
    async (repos): Promise<MutationOutcome<{ value: T } | RedeemRefusal | "not_found">> => {
      const refuse = (code: RedeemRefusal | "not_found", label: string | null = null) => ({
        result: code,
        target: { label },
        denied: { code },
        meta: typeof person === "string" ? { userId: grant.userId } : {},
      });
      // The browser first: another browser holds no verifier for this code.
      if (verifier === null || !sameToken(handoffChallenge(verifier), grant.challenge)) return refuse("wrong_browser");
      if (grant.expiresAt <= now.getTime()) return refuse("expired");
      if (typeof person === "string") return refuse(person);
      if (person.actingAs) return refuse("act_as");
      const m = await repos.mailboxes.get(grant.accountId, grant.mailboxId);
      if (m?.userId !== person.userId) return refuse("not_found");
      const unavailable: RedeemRefusal | null = usable(m);
      if (unavailable || m.stalwartId === null) return refuse(unavailable ?? "mailbox_unavailable", m.address);
      const state = await access.state(m.address);
      if (state !== "ok") return { ...refuse("mailbox_unavailable", m.address), meta: { state } };
      // The step-up the mint required must still be fresh (it lasts minutes; the code one).
      if (!(await repos.security.stepUpFresh(person.userId, grant.sessionId, now))) {
        return refuse("step_up_required", m.address);
      }
      // The handoff credential is made, used and destroyed under the mailbox's credential lock, so it can't move the
      // list positions a revocation job is about to patch.
      await repos.appPasswords.lockCredentials(m.id);
      const value = await open({
        accountId: grant.accountId,
        mailboxId: m.id,
        address: m.address,
        externalId: m.stalwartId,
        console: { userId: person.userId, sessionId: grant.sessionId },
      });
      return { result: { value }, target: { label: m.address } };
    },
  );
  if (out === "act_as") throw new ForbiddenError("Webmail can't be opened while acting as someone.");
  if (out === "not_found") throw new WebmailHandoffError("mailbox_unavailable");
  if (typeof out === "string") throw new WebmailHandoffError(out);
  return out.value;
}
