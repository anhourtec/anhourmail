// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { NextResponse } from "next/server";

import { DomainError, ValidationError } from "@anhourmail/core";
import type { RequestMeta } from "@anhourmail/core";
import { clientIp } from "@anhourmail/server/client-ip";
import { log } from "@anhourmail/server/log";
import { callerKey, checkRateLimit, LIMITS, type LimitName } from "@anhourmail/server/rate-limit";
import { type RequestContext, requestIdFrom, runWithRequestContext } from "@anhourmail/server/request-context";

import { API_CSP } from "../console-csp";
import { container } from "../container";
import { env } from "../env";
import { mailboxAccessBlock } from "../webmail/access-block";
import { DELEGATION_REFUSED } from "../webmail/http";
import { delegationBlock, type DelegationMode } from "../webmail/delegation-gate";
import { PASSWORD_CHANGE_REQUIRED, passwordChangeBlock } from "../webmail/password-gate";
import { PinnedMailboxMissingError, REFUSED_HEADER, requestPin, withPinnedMailbox } from "../webmail/pin";
import { withSessionReads } from "../webmail/session-store";
import { serverTimingHeader, timed, type Timings, timingFields, withTimings } from "./server-timing";

/**
 * Every API handler goes through `route()` (CLAUDE.md rules 12–14):
 *   request id + one access-log line, rate limit (tier per route), same-origin check on writes (CSRF for
 *   cookie auth: writes must come from this origin), the webmail's control-plane access check (suspended person or
 *   mailbox, deleting, gone), the delegation gate (a mailbox shared with the person, ADR-0026) and first-sign-in
 *   password change (webmail routes), domain-error → HTTP mapping.
 * Permission and ownership checks happen in the service layer (packages/core), never only here.
 */

const STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  password_change_pending: 409,
  plan_limit: 403,
  enrolment_required: 403,
  password_change_required: 403,
  step_up_required: 403,
  email_unverified: 403,
  account_suspended: 403,
  account_deleting: 403,
  alias_admin_locked: 403,
  rate_limited: 429,
  alias_daily_limit: 429,
  alias_yearly_limit: 429,
  alias_mailbox_limit: 409,
  // Console → webmail handoff (ADR-0024): a code we don't know (or already used), and a refusal with a reason.
  handoff_invalid: 400,
  handoff_refused: 409,
  // The mail server was busy with a mailbox (a delegated open's credential slot, ADR-0026): try again.
  unavailable: 503,
};

export type RouteOptions = {
  limit?: LimitName;
  /** Which session identifies the caller for per-caller limits: the console's (default) or the webmail's. */
  session?: "console" | "webmail";
  /**
   * Webmail routes only: still answered while the session's mailbox must change its password first. Only the
   * password change itself and sign-out set it; every other webmail route answers 403 `password_change_required`.
   */
  passwordChange?: "allowed";
  /**
   * Webmail routes only, while the active mailbox is one shared with the person (a delegated entry, ADR-0026 §6):
   * `"full_access"` — the route reads and manages that mailbox, and the grant is checked now (404 and the entry dropped
   * when it is gone); `"allowed"` — the route works whichever mailbox is active (listing, switching, signing out).
   * Unset: refused with 403 `own_mailbox_only` (sending, settings, contacts, export…).
   */
  delegated?: DelegationMode;
  /**
   * Webmail routes only, with `delegated` unset: runs when the delegation gate refuses this route in a mailbox shared
   * with the person (403 `own_mailbox_only`), to audit the refusal (`denied`). Must not throw; it can't change the
   * answer.
   */
  onSharedRefusal?: (ctx: RouteContext) => Promise<void>;
  /**
   * The handler's own `Cache-Control` is kept (profile photos, cached privately under a versioned URL). Every other
   * response is `no-store`.
   */
  cache?: "handler";
};

export type RouteContext = { req: Request; meta: RequestMeta };

type RouteParams = Record<string, string | string[] | undefined>;
/** Next passes `params` only for dynamic routes. */
type Params = { params?: Promise<RouteParams> };
type Handler = (ctx: RouteContext, params: RouteParams) => Promise<Response>;

export const ok = (data: unknown, status = 200) => NextResponse.json({ data }, { status });

const errorBody = (code: string, message: string, status: number) =>
  NextResponse.json({ error: { code, message } }, { status });

/** A domain error as `route()` would answer it, for handlers that must add headers to the error response. */
export const domainErrorResponse = (err: DomainError): NextResponse =>
  errorBody(err.code, err.message, STATUS[err.code] ?? 400);

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Path segments that carry one-time tokens (reset links, invites, …) are never logged (CLAUDE.md rule 12). */
const TOKEN_PATH = /(\/(?:reset-password|verify-email|invite|magic-link|confirm)\/)[^/?#]+/gi;
export const logPath = (path: string): string => path.replace(TOKEN_PATH, "$1[redacted]").slice(0, 512);

/**
 * The route pattern for a request path: every segment that is a route parameter becomes `:name`
 * (`/api/accounts/3f…/mailboxes/9a…` → `/api/accounts/:accountId/mailboxes/:mailboxId`). Rate-limit buckets use it so
 * a caller can't get fresh buckets by varying ids. Unknown tails are cut at 512 characters.
 */
export function routeTemplate(path: string, params: RouteParams): string {
  const byValue = new Map<string, string>();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) byValue.set(v, `:${key}`);
  }
  const decode = (seg: string) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  };
  return path
    .split("/")
    .map((seg) => (seg === "" ? seg : (byValue.get(decode(seg)) ?? byValue.get(seg) ?? seg)))
    .join("/")
    .slice(0, 512);
}

/** Writes (POST/PUT/PATCH/DELETE) must come from this origin: the CSRF guard for cookie auth. */
function originAllowed(req: Request): boolean {
  if (SAFE.has(req.method)) return true;
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sessionCookie(req: Request, kind: "console" | "webmail" = "console"): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const m =
    kind === "webmail"
      ? /(?:^|;\s*)(?:__Host-)?am\.webmail=([^;]+)/.exec(cookie)
      : /(?:^|;\s*)(?:__Secure-)?am\.session_token=([^;]+)/.exec(cookie);
  return m?.[1] ?? null;
}

/** The request context plus a fresh set of `Server-Timing` phases for one request. */
const runTimed = <T>(context: RequestContext, fn: (timings: Timings) => Promise<T>): Promise<T> =>
  withTimings((timings) => runWithRequestContext(context, () => fn(timings)));

/** Webmail routes share one read of the session record across the gates and the handler (`withSessionReads`). */
const sharedReads = <T>(webmail: boolean, fn: () => Promise<T>): Promise<T> => (webmail ? withSessionReads(fn) : fn());

export function route(handler: Handler, opts: RouteOptions = {}) {
  return async (req: Request, ctx: Params): Promise<Response> => {
    const requestId = requestIdFrom(req.headers);
    const started = performance.now();
    const context: RequestContext = { requestId };
    return runTimed(context, async (timings) => {
      const path = new URL(req.url).pathname;
      let res: Response;
      let errorCode: string | undefined;
      try {
        const ip = clientIp(req.headers);
        context.clientIp = ip;
        const limitName = opts.limit ?? (SAFE.has(req.method) ? "read" : "write");
        if (ip === null && LIMITS[limitName].by === "ip" && env().NODE_ENV === "production") {
          // Never fall back to one shared bucket for anonymous callers (security audit 2026-10-21).
          throw new ValidationError("Missing client address.");
        }
        const params: RouteParams = (await ctx.params) ?? {};
        const rl = await timed("rate", () =>
          checkRateLimit(
            container().counter,
            // One bucket per route, not per id: `/api/webmail/messages/:emailId`, whatever the id.
            `${limitName}:${req.method} ${routeTemplate(path, params)}`,
            LIMITS[limitName],
            LIMITS[limitName].by === "ip" ? `ip:${ip ?? "direct"}` : callerKey(sessionCookie(req, opts.session), ip),
          ),
        );
        if (!rl.allowed) {
          errorCode = "rate_limited";
          res = errorBody("rate_limited", "Too many requests. Wait a moment and try again.", 429);
          for (const [k, v] of Object.entries(rl.headers)) res.headers.set(k, v);
        } else if (!originAllowed(req)) {
          errorCode = "forbidden";
          res = errorBody("forbidden", "Cross-origin request blocked.", 403);
        } else {
          // A mailbox-scoped tab pins its shared mailbox on every request (`webmail/pin.ts`), or the person's own
          // mailbox on its compose requests: the gates and the handler all see that mailbox as the active one, and the
          // session's real active mailbox is left alone.
          const pin = opts.session === "webmail" ? requestPin(req) : null;
          res = await sharedReads(opts.session === "webmail", () =>
            withPinnedMailbox(
              pin?.address ?? null,
              async () => {
                // A blocked mailbox first (every webmail route, sign-out and the password change included), then the
                // password change the mailbox still owes.
                const unavailable =
                  opts.session === "webmail" ? await timed("access", () => mailboxAccessBlock(req)) : null;
                // Then a mailbox shared with the person: the grant now, or the person's own mailbox for this route.
                const shared =
                  !unavailable && opts.session === "webmail"
                    ? await timed("delegation", () => delegationBlock(req, opts.delegated))
                    : null;
                const blocked =
                  !unavailable && !shared && opts.session === "webmail" && opts.passwordChange !== "allowed"
                    ? await timed("password", () => passwordChangeBlock(req))
                    : null;
                if (unavailable) {
                  errorCode = "mailbox_unavailable";
                  return unavailable;
                }
                if (shared) {
                  errorCode = "delegation";
                  if (opts.onSharedRefusal && shared.status === 403) {
                    const meta: RequestMeta = { requestId, ip, userAgent: req.headers.get("user-agent") };
                    await opts.onSharedRefusal({ req, meta }).catch(() => undefined);
                  }
                  return shared;
                }
                if (blocked) {
                  errorCode = PASSWORD_CHANGE_REQUIRED;
                  return blocked;
                }
                const meta: RequestMeta = { requestId, ip, userAgent: req.headers.get("user-agent") };
                return timed("handler", () => handler({ req, meta }, params));
              },
              pin?.kind,
            ),
          );
          for (const [k, v] of Object.entries(rl.headers)) res.headers.set(k, v);
        }
      } catch (err) {
        if (err instanceof PinnedMailboxMissingError) {
          // The tab's shared mailbox isn't open in this session (any more): the one delegation refusal (ADR-0026 §6).
          errorCode = "delegation";
          res = errorBody("not_found", DELEGATION_REFUSED, 404);
          res.headers.set(REFUSED_HEADER, "mailbox");
        } else if (err instanceof DomainError) {
          errorCode = err.code;
          res = errorBody(err.code, err.message, STATUS[err.code] ?? 400);
        } else if (err instanceof SyntaxError) {
          errorCode = "bad_request";
          res = errorBody("bad_request", "Request body must be JSON.", 400);
        } else {
          errorCode = "server_error";
          log.error("unhandled route error", { component: "http", path: logPath(path), err });
          res = errorBody("server_error", "Something went wrong.", 500);
        }
      }
      res.headers.set("X-Request-Id", requestId);
      // API responses are data, never pages: a strict CSP unless the route set its own (e.g. a sandboxed print view).
      if (!res.headers.has("Content-Security-Policy")) {
        res.headers.set("Content-Security-Policy", API_CSP);
      }
      if (opts.cache !== "handler" || !res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "no-store");
      const status = res.status;
      const durationMs = performance.now() - started;
      if (opts.session === "webmail") {
        // Where the time went: fixed phase names, durations and counts only (no ids or content; rule 24).
        res.headers.set("Server-Timing", serverTimingHeader(timings, durationMs));
        log.debug("request timing", { component: "http", path: logPath(path), ...timingFields(timings, durationMs) });
      }
      log.at(status >= 500 ? "error" : status >= 400 && status !== 401 && status !== 404 ? "warn" : "info", "request", {
        method: req.method,
        path: logPath(path),
        status,
        durationMs: Math.round(durationMs),
        ...(errorCode ? { errorCode } : {}),
      });
      return res;
    });
  };
}

/** A second, per-subject limit inside a handler (e.g. per account and per client address) was reached: 429. */
export class RateLimitedError extends DomainError {
  constructor() {
    super("Too many requests. Wait a while and try again.", "rate_limited");
  }
}

/**
 * Checks and counts one more request against `name` for `subject` (`account:<id>`, `ip:<address>`), in addition to the
 * route's own tier. Throws `RateLimitedError` (429) when it is used up; the tier's fail mode applies when Redis is down.
 */
export async function enforceLimit(name: LimitName, subject: string): Promise<void> {
  const rl = await checkRateLimit(container().counter, name, LIMITS[name], subject);
  if (!rl.allowed) throw new RateLimitedError();
}

/** Parses a JSON body; malformed JSON surfaces as a 400 via `route()`. */
export async function readJson(req: Request): Promise<unknown> {
  return (await req.json()) as unknown;
}

/**
 * Parses a body that may be left out (`DELETE` with options, `POST` whose fields all have defaults): no body (or only
 * whitespace) is `null`; anything else must be JSON, and malformed JSON surfaces as a 400 via `route()` — never read as
 * "no options", so a request that meant something is never carried out without it.
 */
export async function readOptionalJson(req: Request): Promise<unknown> {
  const text = await req.text();
  return text.trim() === "" ? null : (JSON.parse(text) as unknown);
}
