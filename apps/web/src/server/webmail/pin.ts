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
 */

/** The request header a mailbox-scoped tab sends with every webmail API call. */
export const PIN_HEADER = "x-webmail-shared";
/** The query parameter carrying the same on links (downloads, print, raw source, "Show original"). */
export const PIN_QUERY = "shared";
/** Set on the delegation refusal (404), so a mailbox-scoped tab can tell it from "that message is gone". */
export const REFUSED_HEADER = "x-webmail-refused";

/** The pinned mailbox is not (or no longer) an open delegated entry of this session: the delegation refusal (404). */
export class PinnedMailboxMissingError extends Error {
  override readonly name = "PinnedMailboxMissingError";
}

type PinContext = {
  /** The pinned mailbox address (lowercase). */
  address: string;
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

/** Runs `fn` with `address` pinned, or with no pin at all when null (leaving any pin of the caller). */
export function withPinnedMailbox<T>(address: string | null, fn: () => T): T {
  return address === null ? pins.exit(fn) : pins.run({ address }, fn);
}

/** The pinned address of the running request, or null. */
export function pinnedAddress(): string | null {
  return pins.getStore()?.address ?? null;
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
 * for reading and managing (one opened by a send — a send right only — can never be pinned).
 */
export function pinView(s: WebmailSession): WebmailSession {
  const ctx = pins.getStore();
  if (!ctx) return s;
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
  const pinned = pins.getStore()?.address;
  if (pinned === undefined) return s;
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
  // Nothing else to hand over to: the active entry may stay only if it isn't the pinned one.
  if (s.username.toLowerCase() === pinned) throw new PinnedMailboxMissingError("no mailbox to hand back to");
  return s;
}
