// SPDX-License-Identifier: AGPL-3.0-only
/** A stubbed `fetch` for the processor adapter's unit tests: routes by `METHOD /path`, records every request. */
import type { FetchLike } from "./http";

export type Recorded = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: URLSearchParams;
};

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | Error;
type Route = (req: Recorded) => Reply;

export function stubFetch(routes: Record<string, Route | Reply | (Route | Reply)[]>): {
  fetch: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const seen = new Map<string, number>();
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1/, "");
    const method = init.method ?? "GET";
    const req: Recorded = {
      method,
      path,
      query: u.searchParams,
      headers: new Headers(init.headers),
      body: new URLSearchParams(typeof init.body === "string" ? init.body : ""),
    };
    calls.push(req);
    const key = `${method} ${path}`;
    const entry = routes[key];
    if (entry === undefined) return Response.json({ error: { message: `no stub for ${key}` } }, { status: 404 });
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const pick = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
    const reply = typeof pick === "function" ? pick(req) : pick;
    if (reply === undefined) throw new Error(`empty stub for ${key}`);
    if (reply instanceof Error) throw reply;
    return Response.json(reply.json ?? {}, { status: reply.status ?? 200, headers: reply.headers ?? {} });
  };
  return { fetch, calls };
}
