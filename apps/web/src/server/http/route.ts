// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { NextResponse } from "next/server";

import { DomainError, ValidationError } from "@anhourmail/core";
import type { RequestMeta } from "@anhourmail/core";
import { clientIp } from "@anhourmail/server/client-ip";
import { log } from "@anhourmail/server/log";
import { callerKey, checkRateLimit, LIMITS, type LimitName } from "@anhourmail/server/rate-limit";
import { requestIdFrom, runWithRequestContext } from "@anhourmail/server/request-context";

import { container } from "../container";
import { env } from "../env";

/**
 * Every API handler goes through `route()` (CLAUDE.md rules 12–14):
 *   request id + one access-log line, rate limit (tier per route), same-origin check on writes (CSRF for
 *   cookie auth; `public` routes accept the marketing site's origin), domain-error → HTTP mapping.
 * Permission and ownership checks happen in the service layer (packages/core), never only here.
 */

const STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
};

export type RouteOptions = {
  limit?: LimitName;
  /** `same`: only this origin may POST/PUT/DELETE. `public`: also the marketing site (e.g. the waitlist). */
  origin?: "same" | "public";
};

export type RouteContext = { req: Request; meta: RequestMeta };

type RouteParams = Record<string, string | string[] | undefined>;
type Params = { params: Promise<RouteParams> };
type Handler = (ctx: RouteContext, params: RouteParams) => Promise<Response>;

export const ok = (data: unknown, status = 200) => NextResponse.json({ data }, { status });

const errorBody = (code: string, message: string, status: number) =>
  NextResponse.json({ error: { code, message } }, { status });

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Path segments that carry one-time tokens (reset links, invites, …) are never logged (CLAUDE.md rule 12). */
const TOKEN_PATH = /(\/(?:reset-password|verify-email|invite|magic-link|confirm)\/)[^/?#]+/gi;
export const logPath = (path: string): string => path.replace(TOKEN_PATH, "$1[redacted]").slice(0, 512);

function originAllowed(req: Request, mode: "same" | "public"): boolean {
  if (SAFE.has(req.method)) return true;
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin) return mode === "public"; // server-to-server callers (the site's rewrite, curl) send none
  try {
    const o = new URL(origin);
    if (host && o.host === host) return true;
    if (mode === "public" && o.origin === new URL(env().SITE_URL).origin) return true;
    // Dev: the marketing site on any *.localhost / LAN host talks to us through its rewrite.
    return mode === "public" && env().NODE_ENV !== "production";
  } catch {
    return false;
  }
}

function sessionCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)(?:__Secure-)?am\.session_token=([^;]+)/.exec(cookie);
  return m?.[1] ?? null;
}

export function route(handler: Handler, opts: RouteOptions = {}) {
  return async (req: Request, ctx: Params): Promise<Response> => {
    const requestId = requestIdFrom(req.headers);
    const started = performance.now();
    return runWithRequestContext({ requestId }, async () => {
      const path = new URL(req.url).pathname;
      let res: Response;
      let errorCode: string | undefined;
      try {
        const ip = clientIp(req.headers);
        const limitName = opts.limit ?? (SAFE.has(req.method) ? "read" : "write");
        if (ip === null && LIMITS[limitName].by === "ip" && env().NODE_ENV === "production") {
          // Never fall back to one shared bucket for anonymous callers (security audit 2026-10-21).
          throw new ValidationError("Missing client address.");
        }
        const rl = await checkRateLimit(
          container().counter,
          `${limitName}:${req.method} ${logPath(path).replace(/[0-9a-f-]{20,}/gi, ":id")}`,
          LIMITS[limitName],
          LIMITS[limitName].by === "ip" ? `ip:${ip ?? "direct"}` : callerKey(sessionCookie(req), ip),
        );
        if (!rl.allowed) {
          errorCode = "rate_limited";
          res = errorBody("rate_limited", "Too many requests. Wait a moment and try again.", 429);
          for (const [k, v] of Object.entries(rl.headers)) res.headers.set(k, v);
        } else if (!originAllowed(req, opts.origin ?? "same")) {
          errorCode = "forbidden";
          res = errorBody("forbidden", "Cross-origin request blocked.", 403);
        } else {
          const meta: RequestMeta = { requestId, ip, userAgent: req.headers.get("user-agent") };
          res = await handler({ req, meta }, await ctx.params);
          for (const [k, v] of Object.entries(rl.headers)) res.headers.set(k, v);
        }
      } catch (err) {
        if (err instanceof DomainError) {
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
      res.headers.set("Cache-Control", "no-store");
      const status = res.status;
      log.at(status >= 500 ? "error" : status >= 400 && status !== 401 && status !== 404 ? "warn" : "info", "request", {
        method: req.method,
        path: logPath(path),
        status,
        durationMs: Math.round(performance.now() - started),
        ...(errorCode ? { errorCode } : {}),
      });
      return res;
    });
  };
}

/** Parses a JSON body; malformed JSON surfaces as a 400 via `route()`. */
export async function readJson(req: Request): Promise<unknown> {
  return (await req.json()) as unknown;
}
