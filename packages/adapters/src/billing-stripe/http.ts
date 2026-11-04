// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The payment processor's HTTP API over plain `fetch` (ADR-0029 §1; no SDK): one pinned API version, a 10 s timeout,
 * two retries with jittered backoff on network errors, 429 and 5xx only, an idempotency key on every POST, and
 * responses zod-parsed to the fields we read. Errors become `BillingProviderError`; request bodies are never logged.
 */
import type { z } from "zod";

import { BillingProviderError } from "@anhourmail/core/billing";
import { log as defaultLog, type Logger } from "@anhourmail/server/log";

import { encodeForm, type FormValue } from "./form";

/**
 * The API version every request and the dashboard webhook endpoint use (the endpoint is created with the same version so
 * payloads match). Current when this adapter was built (2026-11-04). Moving it is a deliberate change: read the
 * changelog's breaking changes for the fields this adapter parses, then run the live suite.
 */
export const STRIPE_API_VERSION = "2026-10-28.endive";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

const TIMEOUT_MS = 10_000;
const RETRIES = 2;
const BACKOFF_MS = 500;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type StripeHttpOptions = {
  secretKey: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: Logger;
  baseUrl?: string;
  timeoutMs?: number;
};

export type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export type StripeHttp = {
  get<S extends z.ZodType>(path: string, query: Query, schema: S): Promise<z.infer<S>>;
  post<S extends z.ZodType>(
    path: string,
    params: Record<string, FormValue>,
    idempotencyKey: string,
    schema: S,
  ): Promise<z.infer<S>>;
  del<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>>;
};

type ErrorBody = { error?: { type?: unknown; code?: unknown; message?: unknown } };

const readError = async (res: Response): Promise<ErrorBody["error"]> => {
  try {
    return ((await res.json()) as ErrorBody).error;
  } catch {
    return undefined;
  }
};

/** Builds a query string; arrays repeat as `key[]=…` (the API's `expand[]`). */
const queryString = (q: Query): string => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v as readonly string[]) parts.push(`${k}[]=${encodeURIComponent(x)}`);
    else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
};

export function stripeHttp(opts: StripeHttpOptions): StripeHttp {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const logger = opts.log ?? defaultLog;
  const base = opts.baseUrl ?? STRIPE_API_BASE;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  async function call<S extends z.ZodType>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: string | null,
    idempotencyKey: string | null,
    schema: S,
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.secretKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
    };
    if (body !== null) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey !== null) headers["Idempotency-Key"] = idempotencyKey;
    const endpoint = path.split("?")[0] ?? path;

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= RETRIES;
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers,
          ...(body === null ? {} : { body }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
      } catch (err) {
        if (!last) {
          await sleep(backoff(attempt));
          continue;
        }
        logger.warn("billing provider unreachable", { endpoint, err: err instanceof Error ? err.name : "error" });
        throw new BillingProviderError("unavailable", "the billing provider is unreachable");
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && !last && res.headers.get("stripe-should-retry") !== "false") {
        await res.body?.cancel();
        await sleep(backoff(attempt));
        continue;
      }
      if (!res.ok) throw await toError(res, endpoint);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new BillingProviderError("unavailable", "the billing provider answered something unreadable");
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        logger.error("billing provider response did not match the expected shape", {
          endpoint,
          issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), code: i.code })),
        });
        throw new BillingProviderError("unavailable", "the billing provider answered an unexpected shape");
      }
      return parsed.data;
    }

    function backoff(attempt: number): number {
      return Math.round(BACKOFF_MS * 2 ** attempt * (0.5 + random()));
    }
  }

  async function toError(res: Response, endpoint: string): Promise<BillingProviderError> {
    const err = await readError(res);
    // The provider's message names the parameter at fault; anything shaped like an email (it can echo a value we
    // sent) is masked, and it is capped.
    const message =
      typeof err?.message === "string" ? err.message.slice(0, 500).replace(/[^\s'"]+@[^\s'"]+/g, "[email]") : "";
    const code = typeof err?.code === "string" ? err.code.slice(0, 64) : null;
    if (res.status === 402) return new BillingProviderError("card_declined", "the card was declined");
    if (res.status === 404) return new BillingProviderError("not_found", "not found at the billing provider");
    if (res.status === 429) return new BillingProviderError("rate_limited", "the billing provider is rate limiting");
    if (res.status >= 500) return new BillingProviderError("unavailable", "the billing provider is unavailable");
    if (res.status === 401 || res.status === 403) {
      // Our key is wrong or lacks a permission: our outage, never the customer's (retry, change nothing).
      logger.error("billing provider refused our key", { endpoint, status: res.status, code });
      return new BillingProviderError("unavailable", "the billing provider refused our credentials");
    }
    // Only for invalid requests is the provider's message logged (ADR-0029 §1): it names the parameter at fault.
    logger.warn("billing provider refused a request", { endpoint, status: res.status, code, message });
    return new BillingProviderError("invalid_request", "the billing provider refused the request");
  }

  return {
    get: (path, query, schema) => call("GET", `${path}${queryString(query)}`, null, null, schema),
    post: (path, params, idempotencyKey, schema) => call("POST", path, encodeForm(params), idempotencyKey, schema),
    del: (path, schema) => call("DELETE", path, null, null, schema),
  };
}
