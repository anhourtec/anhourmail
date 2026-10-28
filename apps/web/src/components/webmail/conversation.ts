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

/**
 * A change in the mailbox the open conversation may need to show: `all` when it should load again whatever changed
 * (Refresh, or the server couldn't list the changes), else the threads of new messages and the ids of changed or
 * removed ones. `seq` makes each one a new signal.
 */
export type MailChange = {
  seq: number;
  all: boolean;
  threadIds: ReadonlySet<string>;
  emailIds: ReadonlySet<string>;
};

/** Whether `change` touches the conversation `threadId` showing messages `shownIds`. */
export function touchesThread(change: MailChange, threadId: string, shownIds: readonly string[]): boolean {
  return change.all || change.threadIds.has(threadId) || shownIds.some((id) => change.emailIds.has(id));
}

type Shown = Brief & { mailboxIds?: Record<string, boolean> };

/** Whether two loads of a conversation show the same messages in the same state (no re-render needed). */
export function sameThread(a: readonly Shown[], b: readonly Shown[]): boolean {
  if (a.length !== b.length) return false;
  const key = (e: Shown) => JSON.stringify([e.id, e.keywords, e.mailboxIds ?? null]);
  return a.every((e, i) => {
    const other = b[i];
    return other !== undefined && key(e) === key(other);
  });
}

/**
 * Which messages stay expanded when an open conversation loads again: those still there that the person had
 * expanded, plus — among the messages that weren't there before — the ones `defaultExpanded` would open (the newest,
 * unread ones). Messages the person collapsed stay collapsed.
 */
export function mergeExpanded(
  before: readonly Brief[],
  after: readonly Brief[],
  expanded: ReadonlySet<string>,
): Set<string> {
  const known = new Set(before.map((e) => e.id));
  const out = new Set(after.filter((e) => expanded.has(e.id)).map((e) => e.id));
  const fresh = after.filter((e) => !known.has(e.id));
  if (fresh.length === 0) return out;
  for (const id of defaultExpanded([...after])) if (!known.has(id)) out.add(id);
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
