// SPDX-License-Identifier: AGPL-3.0-only
import type { Address } from "@/server/webmail/view";

import { displayName } from "./format";

type Brief = { id: string; keywords: Record<string, boolean> };

/**
 * Which messages of a conversation open expanded: the newest one that isn't an unsent draft (else the newest), and
 * every unread one. The rest show as one-line rows until clicked.
 */
export function defaultExpanded(list: Brief[]): Set<string> {
  const out = new Set<string>();
  const newest = list.filter((e) => e.keywords.$draft !== true).at(-1) ?? list.at(-1);
  if (newest) out.add(newest.id);
  for (const e of list) if (e.keywords.$seen !== true && e.keywords.$draft !== true) out.add(e.id);
  return out;
}

/** Whether an address is one of the signed-in person's own (lowercase set). */
export const isMine = (a: Address | undefined | null, mine: ReadonlySet<string>): boolean =>
  !!a && mine.has(a.email.toLowerCase());

/** The sender's name as shown in a conversation: "me" for your own messages. */
export const senderLabel = (a: Address | undefined | null, mine: ReadonlySet<string>): string =>
  isMine(a, mine) ? "me" : displayName(a);

/** "to me", "to me and 2 others", "to Sam", "to Sam and 1 other" (To and Cc together). */
export function recipientLabel(to: Address[], cc: Address[], mine: ReadonlySet<string>): string {
  const all = [...to, ...cc];
  if (all.length === 0) return "to undisclosed recipients";
  const me = all.find((a) => isMine(a, mine));
  const first = me ?? all[0];
  const others = all.length - 1;
  const name = me ? "me" : displayName(first);
  return others > 0 ? `to ${name} and ${String(others)} other${others === 1 ? "" : "s"}` : `to ${name}`;
}

/**
 * Where "Restore" puts a message from Trash: your own messages back to Sent, everything else to the Inbox (the
 * folder it was deleted from isn't recorded).
 */
export function restoreTarget(
  from: Address[] | null | undefined,
  mine: ReadonlySet<string>,
  roles: { inbox?: string | undefined; sent?: string | undefined },
): string | undefined {
  return isMine(from?.[0], mine) && roles.sent ? roles.sent : roles.inbox;
}

/** Ids from `id` to the end of the conversation (for "Mark unread from here"). */
export function fromHere(list: { id: string }[], id: string): string[] {
  const i = list.findIndex((e) => e.id === id);
  return i === -1 ? [] : list.slice(i).map((e) => e.id);
}
