// SPDX-License-Identifier: AGPL-3.0-only
import type { Address } from "@/server/webmail/view";

/** How often the open, visible webmail asks the mail server what changed (one cheap `Email/changes` call). */
export const POLL_MS = 30_000;
/** The longest wait after repeated failures. */
export const MAX_POLL_MS = 5 * 60_000;

/** The wait before the next check: every 30 s, doubling after each failure in a row up to 5 minutes. */
export function pollDelay(failures: number, base = POLL_MS, max = MAX_POLL_MS): number {
  if (failures <= 0) return base;
  return Math.min(max, base * 2 ** Math.min(failures, 10));
}

/** Whether to check now: only while the tab is visible and the browser is online. */
export function shouldPoll(visibility: DocumentVisibilityState, online: boolean): boolean {
  return visibility === "visible" && online;
}

type Created = {
  id: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[] | null;
};

/**
 * The new messages worth a chime: unread, in the Inbox, not in Junk, not a draft and not from your own addresses.
 * Nothing on the first check (that's the mail already there when the page opened).
 */
export function newMailToAnnounce<T extends Created>(
  created: T[],
  ctx: { inboxId: string | undefined; junkId: string | undefined; mine: ReadonlySet<string>; firstCheck: boolean },
): T[] {
  if (ctx.firstCheck || !ctx.inboxId) return [];
  const inbox = ctx.inboxId;
  return created.filter(
    (e) =>
      e.mailboxIds[inbox] === true &&
      !(ctx.junkId && e.mailboxIds[ctx.junkId]) &&
      e.keywords.$seen !== true &&
      e.keywords.$draft !== true &&
      !ctx.mine.has((e.from?.[0]?.email ?? "").toLowerCase()),
  );
}

/** The tab title: "(3) Inbox · AnhourMail" with unread Inbox mail, else "Inbox · AnhourMail" (the view shown). */
export function tabTitle(view: string | null, unread: number, product = "AnhourMail"): string {
  const base = view ? `${view} · ${product}` : product;
  return unread > 0 ? `(${String(unread)}) ${base}` : base;
}

/**
 * A short, soft two-note chime made with Web Audio (no file, no network). Silently does nothing when the browser
 * blocks audio until the person has interacted with the page.
 */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext;
    const ctx = new Ctx();
    if (ctx.state === "suspended") {
      void ctx.close();
      return;
    }
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.12;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.06, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    }
    window.setTimeout(() => void ctx.close(), 800);
  } catch {
    // No audio available: new mail is still shown.
  }
}
