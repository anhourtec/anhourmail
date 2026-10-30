// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks";

import type { MailboxTokens, WebmailSession } from "./session-store";

/**
 * A browser tab scoped to one mailbox shared with the person (ADR-0026 §6 "Open another mailbox": `/mailbox/<address>/`)
 * shows that mailbox only, while the person's other tabs keep theirs. The session's active mailbox is one value for
 * every tab (one cookie), so such a tab doesn't switch it: it **pins** its mailbox on each request instead, with
 * `PIN_HEADER` (or `PIN_QUERY` on links and downloads, which can't carry headers).
 *
 * While a request runs pinned, the session store reads the session as if that mailbox were the active one (`pinView`)
 * and writes it back with the real active mailbox restored (`unpinWrite`), so every check the BFF makes — the access
 * gate, the delegation gate, own-mailbox-only, token refresh — applies to the pinned entry, and nothing the tab does
 * changes what another tab shows. A pin can only name a **delegated entry already in the session** (opened by
 * `POST /api/webmail/mailboxes/delegated`, which checked the grant); the person's own mailboxes and anything not open
 * are refused with the one delegation refusal (404), never served from another mailbox.
 *
 * The same tab writes mail **from** its mailbox through the person's own one (ADR-0026 §6 "Sending from one": the
 * draft lives in the person's own mailbox, the server rebuilds it in the shared one at send time). Those requests
 * (drafts, uploads, the From picker, send and undo) carry `OWN_PIN_HEADER` instead, naming the person's own mailbox
 * the shared one comes through: the request then sees that **own** entry as the active one, exactly as if this tab had
 * switched to it, again without changing what other tabs show. An own pin can only name one of the session's own
 * sign-ins (never a delegated entry), so every own-mailbox-only check still holds; it is a header only (a link can't
 * carry it, and a cross-site page can't send it without a preflight), and a request can't carry both kinds.
 */

/** The request header a mailbox-scoped tab sends with every webmail API call. */
export const PIN_HEADER = "x-webmail-shared";
/**
 * The request header a mailbox-scoped tab sends with its compose requests: the person's own mailbox they go through.
 * Header only, never a query parameter.
 */
export const OWN_PIN_HEADER = "x-webmail-own";
/** The query parameter carrying the same on links (downloads, print, raw source, "Show original"). */
export const PIN_QUERY = "shared";
/** Set on the delegation refusal (404), so a mailbox-scoped tab can tell it from "that message is gone". */
export const REFUSED_HEADER = "x-webmail-refused";

/** The pinned mailbox is not (or no longer) an open delegated entry of this session: the delegation refusal (404). */
export class PinnedMailboxMissingError extends Error {
  override readonly name = "PinnedMailboxMissingError";
}

/** Which kind of entry a pin names: a delegated entry opened for reading (`shared`), or one of the person's own. */
export type PinKind = "shared" | "own";

type PinContext = {
  /** The pinned mailbox address (lowercase). */
  address: string;
  kind: PinKind;
};

const pins = new AsyncLocalStorage<PinContext>();

const ADDRESS = /^[^\s@<>"|]{1,64}@[^\s@<>"|]{1,253}$/;

/** Whether `v` (lowercased) has the shape of a mailbox address a pin may name. */
export const isPinAddress = (v: string): boolean => v.length <= 254 && ADDRESS.test(v);

/**
 * The pin a request carries (header first, then the query parameter), lowercased; null when it carries none.
 * A value that isn't an address is refused (never ignored: the tab must not be answered from another mailbox). The
 * query form is honoured only on same-origin requests (or ones that don't say): a link from another site can't pin.
 */
export function pinFrom(req: Request): string | null {
  const header = req.headers.get(PIN_HEADER);
  const raw = header ?? new URL(req.url).searchParams.get(PIN_QUERY);
  if (raw === null) return null;
  if (header === null && !pinLinkAllowed(req.headers.get("sec-fetch-site"))) {
    throw new PinnedMailboxMissingError("cross-site pin");
  }
  const v = raw.trim().toLowerCase();
  if (!isPinAddress(v)) throw new PinnedMailboxMissingError("malformed pin");
  return v;
}

/** The own-mailbox pin a request carries (`OWN_PIN_HEADER`, lowercased), or null. Malformed → refused (404). */
export function ownPinFrom(req: Request): string | null {
  const raw = req.headers.get(OWN_PIN_HEADER);
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (!isPinAddress(v)) throw new PinnedMailboxMissingError("malformed own pin");
  return v;
}

/** The pin of a request, of either kind, or null. Both kinds at once are refused: a request is one mailbox's. */
export function requestPin(req: Request): { address: string; kind: PinKind } | null {
  const shared = pinFrom(req);
  const own = ownPinFrom(req);
  if (shared !== null && own !== null) throw new PinnedMailboxMissingError("two pins");
  if (shared !== null) return { address: shared, kind: "shared" };
  return own === null ? null : { address: own, kind: "own" };
}

/** Whether a pin in a link's query may be used: only from this origin (or a client that sends no fetch metadata). */
export const pinLinkAllowed = (secFetchSite: string | null): boolean =>
  secFetchSite === null || secFetchSite === "same-origin";

/**
 * Whether a page navigation came from us, by its Fetch Metadata: our own origin or site (Open another mailbox, the
 * webmail's links), or the person's own address bar or bookmark (`none`). A navigation from another site — or a
 * browser that doesn't say — must not open a mailbox by itself (the `open-webmail` page's rule, plus `none`).
 */
export const navigationFromUs = (secFetchSite: string | null): boolean =>
  secFetchSite === "same-origin" || secFetchSite === "same-site" || secFetchSite === "none";

/**
 * Runs `fn` with `address` pinned (a shared mailbox, or with `kind` "own" one of the person's own), or with no pin at
 * all when null (leaving any pin of the caller).
 */
export function withPinnedMailbox<T>(address: string | null, fn: () => T, kind: PinKind = "shared"): T {
  return address === null ? pins.exit(fn) : pins.run({ address, kind }, fn);
}

/** The pinned address of the running request, or null. */
export function pinnedAddress(): string | null {
  return pins.getStore()?.address ?? null;
}

/** The kind of the running request's pin, or null when it has none. */
export function pinnedKind(): PinKind | null {
  return pins.getStore()?.kind ?? null;
}

/** `s` with `others[i]` made the active entry, keeping every other position (so the swap undoes itself). */
function swapActive(s: WebmailSession, i: number): WebmailSession {
  const { others = [], createdAt, version, console: bound, ...active } = s;
  const target = others[i];
  if (!target) return s;
  const next: MailboxTokens[] = [...others];
  next[i] = active;
  return { ...target, createdAt, version, ...(bound ? { console: bound } : {}), others: next };
}

/**
 * The session as the pinned request sees it: the pinned delegated entry active. Unchanged when nothing is pinned or it
 * is active already. Throws `PinnedMailboxMissingError` when the pin names no delegated entry of this session opened
 * for reading and managing (one opened by a send — a send right only — can never be pinned). An own pin shows that own
 * sign-in as the active one (`PinnedMailboxMissingError` when it isn't one of this session's own).
 */
export function pinView(s: WebmailSession): WebmailSession {
  const ctx = pins.getStore();
  if (!ctx) return s;
  if (ctx.kind === "own") {
    // One of the person's own sign-ins only: a delegated entry can never become active through an own pin.
    const own = (m: MailboxTokens) => !m.delegated && m.username.toLowerCase() === ctx.address;
    if (own(s)) return s;
    const j = (s.others ?? []).findIndex(own);
    if (j < 0) throw new PinnedMailboxMissingError("own mailbox not signed in");
    return swapActive(s, j);
  }
  const pinnable = (m: MailboxTokens) =>
    m.delegated?.opened === "full_access" && m.username.toLowerCase() === ctx.address;
  if (s.username.toLowerCase() === ctx.address) {
    if (!pinnable(s)) throw new PinnedMailboxMissingError("pinned mailbox is not open to read");
    return s;
  }
  const i = (s.others ?? []).findIndex(pinnable);
  if (i < 0) throw new PinnedMailboxMissingError("pinned mailbox not open");
  return swapActive(s, i);
}

/**
 * What a pinned request writes: `s` with the real active entry of `stored` (the record this write replaces) active
 * again, so a pinned tab never changes the mailbox other tabs show. If that entry is gone, the mailbox it came through
 * (or the first of the person's own) becomes active, as `dropDelegated` hands over — never the pinned entry.
 */
export function unpinWrite(s: WebmailSession, stored: WebmailSession): WebmailSession {
  const ctx = pins.getStore();
  if (ctx === undefined) return s;
  const pinned = ctx.address;
  const real = stored.username;
  if (s.username === real) return s;
  const others = s.others ?? [];
  let i = others.findIndex((m) => m.username === real);
  if (i < 0) {
    const via = stored.delegated?.via;
    i = others.findIndex((m) => !m.delegated && via !== undefined && m.username.toLowerCase() === via);
    if (i < 0) i = others.findIndex((m) => !m.delegated);
  }
  if (i >= 0) return swapActive(s, i);
  // Nothing else to hand over to: the active entry may stay only if it isn't the pinned shared one (an own pin names
  // one of the person's own mailboxes, which may be the active one).
  if (ctx.kind === "shared" && s.username.toLowerCase() === pinned)
    throw new PinnedMailboxMissingError("no mailbox to hand back to");
  return s;
}
