// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the webmail may ask Stalwart through the proxy (docs/internal/05-webmail.md, ADR-0003). The browser
 * sends a JMAP request; the BFF checks it against this allow-list before attaching the user's token:
 *
 * - only the capabilities and methods the webmail uses (grown per slice — nothing administrative, no `x:*`),
 * - at most `MAX_CALLS` calls (Stalwart's `maxCallsInRequest`),
 * - every call's `accountId` must be the signed-in account (shared accounts arrive with their own slice),
 * - the body is capped at `MAX_REQUEST_BYTES` before parsing,
 * - `Email/set` may only change keywords and move messages (`mailboxIds`), and destroy messages — which the service
 *   then checks are all in Trash or Junk before forwarding. Creating messages (drafts) and sending go through their
 *   own BFF endpoints (`/api/webmail/drafts`, `/api/webmail/send`), never through this proxy, so identity, size and
 *   recipient checks can't be bypassed by a hand-written JMAP request.
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

export type PolicyResult =
  | {
      ok: true;
      body: JmapRequestBody;
      /** Ids the request would destroy: the service verifies each is only in Trash or Junk before forwarding. */
      destroyIds: string[];
    }
  | { ok: false; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates a parsed JMAP request against the allow-list for `accountId`. */
/** What the policy needs to know about the mailbox: its Drafts folder (nothing may be moved into it). */
export type PolicyContext = { draftsId?: string | undefined };

/** Keywords the proxy never sets: `$draft` (drafts are only made by the BFF) and the BFF's own marker. */
const DRAFT_KEYWORD = "keywords/$draft";
const COMPOSED_PATH = "keywords/$am-composed";

export function checkJmapRequest(input: unknown, accountId: string, ctx: PolicyContext = {}): PolicyResult {
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
  const destroyIds: string[] = [];
  for (const call of methodCalls) {
    if (!Array.isArray(call) || call.length !== 3) return { ok: false, message: "Malformed method call." };
    const [name, args, id] = call as unknown[];
    if (typeof name !== "string" || typeof id !== "string" || !isRecord(args) || id.length > 64) {
      return { ok: false, message: "Malformed method call." };
    }
    if (!ALLOWED_METHODS.has(name)) return { ok: false, message: `Method not available: ${name.slice(0, 64)}` };
    if (args.accountId !== accountId) return { ok: false, message: "Unknown account." };
    if (name === "Email/set") {
      const set = checkEmailSet(args, ctx);
      if (!set.ok) return { ok: false, message: set.message };
      destroyIds.push(...set.destroyIds);
    }
    calls.push([name, args, id]);
  }
  return { ok: true, body: { using, methodCalls: calls }, destroyIds };
}

const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;
const KEYWORD_PATH = /^keywords\/[A-Za-z0-9$_-]{1,64}$/;
const MAILBOX_PATH = /^mailboxIds\/[A-Za-z0-9_-]{1,255}$/;
const MAX_SET_OBJECTS = 500;

/**
 * One `Email/set` patch entry the webmail may send: a keyword or a mailbox membership, set or cleared — except
 * making a message a draft (`$draft`, or adding it to Drafts) and touching the BFF's `$am-composed` marker, so no
 * message can be turned into something `/api/webmail/send` would submit.
 */
function patchEntryAllowed(path: string, value: unknown, ctx: PolicyContext): boolean {
  if (path === COMPOSED_PATH) return false;
  if (path === DRAFT_KEYWORD && value === true) return false;
  if (ctx.draftsId !== undefined && path === `mailboxIds/${ctx.draftsId}` && value === true) return false;
  if (KEYWORD_PATH.test(path) || MAILBOX_PATH.test(path)) return value === true || value === null;
  if (path === "mailboxIds") {
    if (!isRecord(value)) return false;
    const entries = Object.entries(value);
    return (
      entries.length > 0 &&
      entries.length <= 10 &&
      entries.every(([k, v]) => JMAP_ID.test(k) && v === true && k !== ctx.draftsId)
    );
  }
  return false;
}

/**
 * `Email/set` through the proxy: `update` of keywords and mailbox memberships (read, flag, pin, move, archive,
 * junk) and `destroy` (which the service limits to Trash and Junk). No `create`, no other property, no
 * back-references, at most 500 objects each.
 */
export function checkEmailSet(
  args: Record<string, unknown>,
  ctx: PolicyContext = {},
): { ok: true; destroyIds: string[] } | { ok: false; message: string } {
  const refuse = { ok: false as const, message: "Only reading, flagging, moving and deleting messages are available." };
  for (const key of Object.keys(args)) {
    if (key !== "accountId" && key !== "update" && key !== "destroy" && key !== "ifInState") return refuse;
  }
  const { update, destroy } = args;
  if (update === undefined && destroy === undefined) return refuse;
  if (update !== undefined) {
    if (!isRecord(update)) return refuse;
    const patches = Object.entries(update);
    if (patches.length === 0 || patches.length > MAX_SET_OBJECTS) return refuse;
    for (const [id, patch] of patches) {
      if (!JMAP_ID.test(id) || !isRecord(patch)) return refuse;
      const entries = Object.entries(patch);
      if (entries.length === 0 || !entries.every(([path, value]) => patchEntryAllowed(path, value, ctx))) return refuse;
    }
  }
  let destroyIds: string[] = [];
  if (destroy !== undefined) {
    if (!Array.isArray(destroy) || destroy.length === 0 || destroy.length > MAX_SET_OBJECTS) return refuse;
    if (!destroy.every((d): d is string => typeof d === "string" && JMAP_ID.test(d))) return refuse;
    destroyIds = destroy;
  }
  return { ok: true, destroyIds };
}

/** True when a Stalwart response is the per-user concurrency `limit` error (retryable). */
export function isLimitError(status: number, body: unknown): boolean {
  return status === 400 && isRecord(body) && body.type === "urn:ietf:params:jmap:error:limit";
}
