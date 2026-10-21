// SPDX-License-Identifier: MIT
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { setLogContextProvider } from "./log";

/** Per-request fields every log line carries. Never mail content. */
export type RequestContext = { requestId: string; userId?: string; errorCode?: string };

const storage = new AsyncLocalStorage<RequestContext>();

setLogContextProvider(() => {
  const ctx = storage.getStore();
  return ctx ? { requestId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) } : undefined;
});

export const runWithRequestContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn);
export const requestContext = (): RequestContext | undefined => storage.getStore();

/** A valid inbound X-Request-Id (NGINX sends one), else a fresh UUID. */
export function requestIdFrom(headers: Headers): string {
  const given = headers.get("x-request-id");
  return given && /^[A-Za-z0-9._-]{8,128}$/.test(given) ? given : randomUUID();
}
