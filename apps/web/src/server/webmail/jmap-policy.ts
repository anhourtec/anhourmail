// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the webmail may ask Stalwart through the proxy (docs/internal/05-webmail.md, ADR-0003). The browser
 * sends a JMAP request; the BFF checks it against this allow-list before attaching the user's token:
 *
 * - only the capabilities and methods the webmail uses (grown per slice — nothing administrative, no `x:*`),
 * - at most `MAX_CALLS` calls (Stalwart's `maxCallsInRequest`),
 * - every call's `accountId` must be the signed-in account (shared accounts arrive with their own slice),
 * - the body is capped at `MAX_REQUEST_BYTES` before parsing.
 */

export const ALLOWED_CAPABILITIES: ReadonlySet<string> = new Set([
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
]);

export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "Mailbox/get",
  "Mailbox/changes",
  "Mailbox/query",
  "Mailbox/queryChanges",
  "Thread/get",
  "Thread/changes",
  "Email/get",
  "Email/changes",
  "Email/query",
  "Email/queryChanges",
  "Email/set",
  "SearchSnippet/get",
  "Identity/get",
]);

export const MAX_CALLS = 16;
export const MAX_REQUEST_BYTES = 256 * 1024;

export type JmapRequestBody = { using: string[]; methodCalls: [string, Record<string, unknown>, string][] };

export type PolicyResult = { ok: true; body: JmapRequestBody } | { ok: false; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates a parsed JMAP request against the allow-list for `accountId`. */
export function checkJmapRequest(input: unknown, accountId: string): PolicyResult {
  if (!isRecord(input)) return { ok: false, message: "Request must be a JMAP request object." };
  const { using, methodCalls } = input;
  if (!Array.isArray(using) || using.length === 0 || !using.every((u) => typeof u === "string")) {
    return { ok: false, message: "Request must list the capabilities it uses." };
  }
  const refused = using.find((u) => !ALLOWED_CAPABILITIES.has(u));
  if (refused !== undefined) return { ok: false, message: `Capability not available: ${refused}` };
  if (!Array.isArray(methodCalls) || methodCalls.length === 0) return { ok: false, message: "No method calls." };
  if (methodCalls.length > MAX_CALLS) return { ok: false, message: `At most ${String(MAX_CALLS)} calls per request.` };
  const calls: JmapRequestBody["methodCalls"] = [];
  for (const call of methodCalls) {
    if (!Array.isArray(call) || call.length !== 3) return { ok: false, message: "Malformed method call." };
    const [name, args, id] = call as unknown[];
    if (typeof name !== "string" || typeof id !== "string" || !isRecord(args) || id.length > 64) {
      return { ok: false, message: "Malformed method call." };
    }
    if (!ALLOWED_METHODS.has(name)) return { ok: false, message: `Method not available: ${name.slice(0, 64)}` };
    if (args.accountId !== accountId) return { ok: false, message: "Unknown account." };
    if (name === "Email/set" && !keywordUpdatesOnly(args)) {
      return { ok: false, message: "Only read and flag changes are available." };
    }
    calls.push([name, args, id]);
  }
  return { ok: true, body: { using, methodCalls: calls } };
}

/**
 * Until the composer and move slices land, `Email/set` may only set or clear keywords (`keywords/$seen`,
 * `keywords/$flagged`, …) on existing messages: no `create`, no `destroy`, no other property, no back-references.
 */
const KEYWORD_PATH = /^keywords\/[A-Za-z0-9$_-]{1,64}$/;
export function keywordUpdatesOnly(args: Record<string, unknown>): boolean {
  for (const key of Object.keys(args)) {
    if (key !== "accountId" && key !== "update" && key !== "ifInState") return false;
  }
  const update = args.update;
  if (!isRecord(update) || Object.keys(update).length === 0 || Object.keys(update).length > 500) return false;
  return Object.values(update).every(
    (patch) =>
      isRecord(patch) &&
      Object.keys(patch).length > 0 &&
      Object.entries(patch).every(([path, value]) => KEYWORD_PATH.test(path) && (value === true || value === null)),
  );
}

/** True when a Stalwart response is the per-user concurrency `limit` error (retryable). */
export function isLimitError(status: number, body: unknown): boolean {
  return status === 400 && isRecord(body) && body.type === "urn:ietf:params:jmap:error:limit";
}
