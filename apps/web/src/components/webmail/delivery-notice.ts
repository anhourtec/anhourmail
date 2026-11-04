// SPDX-License-Identifier: AGPL-3.0-only
import type { Undelivered } from "@/server/webmail/delivery";

export type { Undelivered };

/** At most this many addresses are named in one notice; the rest are counted. */
export const NAMED_ADDRESSES = 5;

/**
 * The notice for recipients a send couldn't be delivered to (05-webmail.md "Delivery problems"): the headline names
 * the address (or how many), and one line per reason lists the addresses with that reason and its short code.
 * `null` when there is nothing to say.
 */
export function undeliveredNotice(list: readonly Undelivered[]): { message: string; detail: string[] } | null {
  if (list.length === 0) return null;
  const [only] = list;
  if (list.length === 1 && only) {
    return { message: `Not delivered to ${only.email}`, detail: [withCode(only.reason, only.code)] };
  }
  const groups = new Map<string, { reason: string; code: string | null; emails: string[] }>();
  for (const u of list) {
    const key = `${u.reason}\0${u.code ?? ""}`;
    const g = groups.get(key) ?? { reason: u.reason, code: u.code, emails: [] };
    g.emails.push(u.email);
    groups.set(key, g);
  }
  let named = 0;
  const detail: string[] = [];
  for (const g of groups.values()) {
    const room = NAMED_ADDRESSES - named;
    if (room <= 0) break;
    const shown = g.emails.slice(0, room);
    named += shown.length;
    detail.push(`${shown.join(", ")}: ${withCode(g.reason, g.code)}`);
  }
  if (list.length > named) detail.push(`And ${String(list.length - named)} more.`);
  return { message: `Not delivered to ${String(list.length)} addresses`, detail };
}

/** The reason with its short code, e.g. "No mailbox with this address exists. (5.1.2)". */
function withCode(reason: string, code: string | null): string {
  return code === null ? reason : `${reason} (${code})`;
}

/** The recipients in `next` not already reported (`shown`, lower-cased), adding them to `shown`. */
export function notYetShown(shown: Set<string>, next: readonly Undelivered[]): Undelivered[] {
  const out: Undelivered[] = [];
  for (const u of next) {
    const key = u.email.toLowerCase();
    if (shown.has(key)) continue;
    shown.add(key);
    out.push(u);
  }
  return out;
}
